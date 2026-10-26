package main

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"
)

func TestScrimbaScoring(t *testing.T) {
	for _, test := range []struct{ guess, solution, want []string }{
		{[]string{"a", "a", "a", "b", "b"}, []string{"b", "a", "c", "a", "d"}, []string{"present", "correct", "absent", "present", "absent"}},
		{[]string{"a", "b", "c", "d", "e"}, []string{"a", "b", "c", "d", "e"}, []string{"correct", "correct", "correct", "correct", "correct"}},
		{[]string{"x", "x", "x", "x", "x"}, []string{"a", "b", "c", "d", "e"}, []string{"absent", "absent", "absent", "absent", "absent"}},
	} {
		if got := scoreScrimba(test.guess, test.solution); !reflect.DeepEqual(got, test.want) {
			t.Errorf("score = %v, want %v", got, test.want)
		}
	}
}

func scrimbaEvents(c *client) []scrimbaState {
	out := []scrimbaState{}
	for {
		select {
		case data := <-c.send:
			var state scrimbaState
			if err := json.Unmarshal(data, &state); err == nil && state.Type == "scrimba-state" {
				out = append(out, state)
			}
		default:
			return out
		}
	}
}

func TestScrimbaFlow(t *testing.T) {
	h, clock := testHub(t, testWorld())
	alice := unitClient(t, h, "Alice")
	walkTo(t, h, clock, alice, 120, 168)
	bob := unitClient(t, h, "Bob")
	walkTo(t, h, clock, bob, 168, 168)
	outsider := unitClient(t, h, "Outside")
	for _, c := range []*client{alice, bob, outsider} {
		drain(c)
	}
	command := func(c *client, msg map[string]any) error { return h.handle(c, marshal(msg)) }
	start := map[string]any{"type": "chat", "carpetId": "a", "text": " /scrimba "}
	if err := command(alice, start); err != nil {
		t.Fatal(err)
	}
	// The invitation is an ordinary live chat event with an actionable game ID.
	var invitation struct{ Type, Text, ScrimbaID string }
	if err := json.Unmarshal(<-bob.send, &invitation); err != nil {
		t.Fatal(err)
	}
	if invitation.Type != "chat" || invitation.ScrimbaID == "" || invitation.Text != "Alice has started a game of Scrimba. Click here to join" {
		t.Fatalf("bad invitation: %+v", invitation)
	}
	id := invitation.ScrimbaID
	states := scrimbaEvents(alice)
	if len(states) != 1 || len(states[0].Players) != 1 {
		t.Fatalf("starter didn't open a board: %+v", states)
	}
	if len(chatMessages(outsider)) != 0 {
		t.Fatal("invitation leaked outside carpet")
	}
	if err := command(outsider, map[string]any{"type": "scrimba-join", "id": id}); err == nil {
		t.Fatal("outsider joined")
	}
	if err := command(bob, map[string]any{"type": "scrimba-join", "id": id}); err != nil {
		t.Fatal(err)
	}
	h.mu.Lock()
	g := h.scrimba[id]
	generatedSolution := append([]string(nil), g.Solution...)
	g.Solution = []string{"🍎", "🍋", "🍇", "🍒", "🥝"}
	h.mu.Unlock()
	unique := map[string]bool{}
	for _, emoji := range generatedSolution {
		if unique[emoji] {
			t.Fatal("generated solution repeats an emoji")
		}
		unique[emoji] = true
	}
	drain(alice)
	drain(bob)
	guess := func(c *client, emojis []string, turn int) error {
		return command(c, map[string]any{"type": "scrimba-guess", "id": id, "emojis": emojis, "turn": turn})
	}
	if err := guess(alice, []string{"🍋", "🍎", "🍇", "🍒", "🥝"}, 0); err != nil {
		t.Fatal(err)
	}
	states = scrimbaEvents(bob)
	if len(states) != 1 {
		t.Fatalf("missing shared state: %v", states)
	}
	for _, p := range states[0].Players {
		if p.ID == alice.player.ID {
			if len(p.Guesses) != 1 || len(p.Guesses[0].Emojis) != 0 || !reflect.DeepEqual(p.Guesses[0].Marks, []string{"present", "present", "correct", "correct", "correct"}) {
				t.Fatalf("bad redaction: %+v", p)
			}
		} else if len(p.Guesses) != 0 {
			t.Fatal("players' guesses are not independent")
		}
	}
	if len(states[0].Solution) != 0 {
		t.Fatal("unfinished viewer received solution")
	}
	if err := guess(alice, g.Solution, 0); err == nil {
		t.Fatal("accepted replayed turn")
	}
	if err := guess(bob, []string{"🍎", "🍎", "🍇", "🍒", "🥝"}, 0); err == nil {
		t.Fatal("accepted duplicate emojis")
	}
	if len(g.Players[bob.player.ID].Guesses) != 0 {
		t.Fatal("invalid guess consumed a turn")
	}
	if err := guess(bob, []string{"🍎"}, 0); err == nil {
		t.Fatal("accepted short guess")
	}
	if err := guess(bob, []string{"?", "?", "?", "?", "?"}, 0); err == nil {
		t.Fatal("accepted invalid emoji")
	}
	if err := guess(alice, g.Solution, 1); err != nil {
		t.Fatal(err)
	}
	states = scrimbaEvents(bob)
	for _, p := range states[len(states)-1].Players {
		if p.ID == alice.player.ID && len(p.Guesses[1].Emojis) != 0 {
			t.Fatal("winner's emojis revealed early")
		}
	}
	if err := guess(alice, g.Solution, 2); err == nil {
		t.Fatal("winner guessed again")
	}
	// A late join and repeated join see current state, without resetting guesses.
	late := unitClient(t, h, "Late")
	walkTo(t, h, clock, late, 216, 168)
	if err := command(late, map[string]any{"type": "scrimba-join", "id": id}); err != nil {
		t.Fatal(err)
	}
	lateStates := scrimbaEvents(late)
	if len(lateStates) != 1 || len(lateStates[0].Players) != 3 {
		t.Fatal("late join missing current state")
	}
	if err := guess(late, []string{"🔥", "⭐", "🌈", "💎", "🌻"}, 0); err != nil {
		t.Fatal(err)
	}
	if err := guess(late, []string{"🔥", "🍎", "🍇", "🍒", "🥝"}, 1); err == nil {
		t.Fatal("accepted confirmed absent emoji")
	}
	if len(g.Players[late.player.ID].Guesses) != 1 {
		t.Fatal("rejected absent emoji consumed a turn")
	}
	for i := 0; i < 6; i++ {
		if err := guess(bob, []string{"🍋", "🍎", "🍇", "🍒", "🥝"}, i); err != nil {
			t.Fatal(err)
		}
	}
	states = scrimbaEvents(bob)
	final := states[len(states)-1]
	if !reflect.DeepEqual(final.Solution, g.Solution) {
		t.Fatal("completion didn't reveal common solution")
	}
	for _, p := range final.Players {
		if p.ID == alice.player.ID && len(p.Guesses[0].Emojis) != 5 {
			t.Fatal("completed viewer cannot inspect guesses")
		}
		if p.ID == bob.player.ID && (!p.Done || p.Won || len(p.Guesses) != 6) {
			t.Fatal("six misses must finish board")
		}
	}
	if err := command(bob, map[string]any{"type": "scrimba-join", "id": id}); err != nil {
		t.Fatal(err)
	}
	if len(g.Players[bob.player.ID].Guesses) != 6 {
		t.Fatal("rejoining reset progress")
	}
	advance(h, clock, scrimbaLifetime+time.Second)
	if err := command(alice, map[string]any{"type": "scrimba-join", "id": id}); err == nil {
		t.Fatal("expired game still joinable")
	}
	if err := command(alice, start); err != nil {
		t.Fatal(err)
	}
	if len(h.scrimba) != 1 {
		t.Fatal("expired games weren't removed")
	}
}

func TestScrimbaCapacityAndCleanup(t *testing.T) {
	h, clock := testHub(t, testWorld())
	alice := unitClient(t, h, "Alice")
	walkTo(t, h, clock, alice, 120, 168)
	bob := unitClient(t, h, "Bob")
	walkTo(t, h, clock, bob, 168, 168)
	start := func(c *client) error {
		return h.handle(c, marshal(map[string]any{"type": "chat", "carpetId": "a", "text": "/scrimba"}))
	}
	for i := 0; i < maxScrimbaGamesPerCreator; i++ {
		if err := start(alice); err != nil {
			t.Fatal(err)
		}
		advance(h, clock, 11*time.Second)
		drain(alice)
		drain(bob)
	}
	if err := start(alice); err == nil {
		t.Fatal("creator exhausted global capacity")
	}
	if err := start(bob); err != nil {
		t.Fatalf("another creator cannot start: %v", err)
	}
	// Old connections must not continue consuming the global game quota.
	h.mu.Lock()
	for i := len(h.scrimba); i < maxScrimbaGames; i++ {
		id := fmt.Sprintf("abandoned-%d", i)
		h.scrimba[id] = &scrimbaGame{ID: id, Created: clock.now(), Players: map[string]*scrimbaPlayer{"disconnected": {ID: "disconnected"}}}
	}
	h.mu.Unlock()
	advance(h, clock, 11*time.Second)
	drain(alice)
	drain(bob)
	if err := start(bob); err != nil {
		t.Fatalf("abandoned games block new games: %v", err)
	}
	if len(h.scrimba) != maxScrimbaGamesPerCreator+2 {
		t.Fatal("abandoned games were retained")
	}
	// Completing a board must allow the creator to keep playing new games.
	h.mu.Lock()
	for _, game := range h.scrimba {
		if game.Creator == alice.player.ID {
			game.Players[alice.player.ID].Done = true
			break
		}
	}
	h.mu.Unlock()
	if err := start(alice); err != nil {
		t.Fatalf("completed board still consumes creator limit: %v", err)
	}
	h.mu.Lock()
	for i := len(h.scrimba); i < maxScrimbaGames; i++ {
		id := fmt.Sprintf("finished-%d", i)
		h.scrimba[id] = &scrimbaGame{ID: id, Created: clock.now(), Players: map[string]*scrimbaPlayer{alice.player.ID: {ID: alice.player.ID, Done: true}}}
	}
	h.mu.Unlock()
	advance(h, clock, 11*time.Second)
	drain(alice)
	drain(bob)
	if err := start(bob); err != nil {
		t.Fatalf("finished boards block a new game: %v", err)
	}
	if len(h.scrimba) != maxScrimbaGames {
		t.Fatal("global memory limit not preserved")
	}
}

func TestScrimbaParticipantLimitAndDisconnect(t *testing.T) {
	h, clock := testHub(t, testWorld())
	alice := unitClient(t, h, "Alice")
	walkTo(t, h, clock, alice, 120, 168)
	bob := unitClient(t, h, "Bob")
	walkTo(t, h, clock, bob, 168, 168)
	if err := h.handle(alice, marshal(map[string]any{"type": "chat", "carpetId": "a", "text": "/scrimba"})); err != nil {
		t.Fatal(err)
	}
	var game *scrimbaGame
	h.mu.Lock()
	for _, g := range h.scrimba {
		game = g
	}
	for i := 1; i < maxScrimbaPlayers; i++ {
		id := fmt.Sprintf("retained-%d", i)
		h.clients[id] = &client{send: make(chan []byte, 128), done: make(chan struct{}), player: player{ID: id}}
		game.Players[id] = &scrimbaPlayer{ID: id}
	}
	h.mu.Unlock()
	join := func() error { return h.handle(bob, marshal(map[string]any{"type": "scrimba-join", "id": game.ID})) }
	if err := join(); err == nil {
		t.Fatal("participant limit not enforced")
	}
	// Simulate a full send queue removing a connection without remove().
	h.mu.Lock()
	dropped := h.clients["retained-1"]
	delete(h.clients, "retained-1")
	dropped.stop()
	h.mu.Unlock()
	if err := join(); err != nil {
		t.Fatalf("disconnected participant blocks joining: %v", err)
	}
	if len(game.Players) != maxScrimbaPlayers {
		t.Fatal("roster grew beyond limit")
	}
	h.remove(bob)
	if game.Players[bob.player.ID] != nil {
		t.Fatal("disconnected identity retained")
	}
	if game.Players[alice.player.ID] == nil {
		t.Fatal("connected player's progress was removed")
	}
}
