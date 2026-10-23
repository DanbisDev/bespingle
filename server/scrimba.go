package main

import (
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"sort"
	"time"
)

//go:embed scrimba.json
var scrimbaJSON []byte

type scrimbaConfig struct {
	Slots    int      `json:"slots"`
	Attempts int      `json:"attempts"`
	Emojis   []string `json:"emojis"`
}

var scrimbaRules = func() scrimbaConfig {
	var rules scrimbaConfig
	if err := json.Unmarshal(scrimbaJSON, &rules); err != nil {
		panic(err)
	}
	return rules
}()

const (
	scrimbaLifetime           = 2 * time.Hour
	maxScrimbaGames           = 32
	maxScrimbaGamesPerCreator = 3
	maxScrimbaPlayers         = 64
)

type scrimbaGuess struct {
	Emojis []string `json:"emojis,omitempty"`
	Marks  []string `json:"marks"`
}
type scrimbaPlayer struct {
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Guesses []scrimbaGuess `json:"guesses"`
	Done    bool           `json:"done"`
	Won     bool           `json:"won"`
}
type scrimbaGame struct {
	Creator  string
	ID       string
	CarpetID string
	Created  time.Time
	Solution []string
	Players  map[string]*scrimbaPlayer
}
type scrimbaState struct {
	ExpiresAt int64           `json:"expiresAt"`
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	CarpetID  string          `json:"carpetId"`
	Players   []scrimbaPlayer `json:"players"`
	Solution  []string        `json:"solution,omitempty"`
}

// Exact matches consume their emoji first; remaining copies can be yellow once.
func scoreScrimba(guess, solution []string) []string {
	marks := make([]string, len(solution))
	remaining := map[string]int{}
	for i, emoji := range solution {
		if guess[i] == emoji {
			marks[i] = "correct"
		} else {
			remaining[emoji]++
		}
	}
	for i, emoji := range guess {
		if marks[i] == "correct" {
			continue
		}
		marks[i] = "absent"
		if remaining[emoji] > 0 {
			marks[i] = "present"
			remaining[emoji]--
		}
	}
	return marks
}

func (g *scrimbaGame) stateFor(id string) scrimbaState {
	viewer := g.Players[id]
	out := scrimbaState{ExpiresAt: g.Created.Add(scrimbaLifetime).UnixMilli(), Type: "scrimba-state", ID: g.ID, CarpetID: g.CarpetID, Players: []scrimbaPlayer{}}
	if viewer != nil && viewer.Done {
		out.Solution = g.Solution
	}
	for _, p := range g.Players {
		copy := *p
		copy.Guesses = make([]scrimbaGuess, len(p.Guesses))
		for i, guess := range p.Guesses {
			copy.Guesses[i] = scrimbaGuess{Marks: guess.Marks}
			// Redact on the server so unfinished players never receive others' emojis.
			if p.ID == id || viewer != nil && viewer.Done {
				copy.Guesses[i].Emojis = guess.Emojis
			}
		}
		out.Players = append(out.Players, copy)
	}
	sort.Slice(out.Players, func(i, j int) bool { return out.Players[i].ID < out.Players[j].ID })
	return out
}

func (h *hub) publishScrimbaLocked(g *scrimbaGame) {
	dropped := false
	for id := range g.Players {
		if peer := h.clients[id]; peer != nil && peer.player.CarpetID == g.CarpetID {
			if !h.enqueueLocked(peer, marshal(g.stateFor(id))) {
				dropped = true
			}
		}
	}
	if dropped {
		h.broadcastLocked()
	}
}

// Disconnected identities cannot reconnect, so their records are no longer useful.
// Run before capacity checks, including for clients dropped by a full send queue.
func (h *hub) pruneScrimbaLocked() {
	for id, g := range h.scrimba {
		for playerID := range g.Players {
			if h.clients[playerID] == nil {
				delete(g.Players, playerID)
			}
		}
		if len(g.Players) == 0 || h.now().Sub(g.Created) >= scrimbaLifetime {
			delete(h.scrimba, id)
		}
	}
}

func (h *hub) startScrimbaLocked(c *client) error {
	if h.scrimba == nil {
		h.scrimba = map[string]*scrimbaGame{}
	}
	h.pruneScrimbaLocked()
	created := 0
	for _, g := range h.scrimba {
		if g.Creator == c.player.ID {
			if creator := g.Players[c.player.ID]; creator != nil && !creator.Done {
				created++
			}
			if h.now().Sub(g.Created) < 10*time.Second {
				return errors.New("wait a moment before starting another Scrimba")
			}
		}
	}
	if created >= maxScrimbaGamesPerCreator {
		return errors.New("finish one of your three active Scrimba games before starting another")
	}
	if len(h.scrimba) >= maxScrimbaGames {
		// Finished boards remain inspectable until capacity is needed for a new game.
		var oldest *scrimbaGame
		for _, game := range h.scrimba {
			finished := true
			for _, p := range game.Players {
				if !p.Done {
					finished = false
					break
				}
			}
			if finished && (oldest == nil || game.Created.Before(oldest.Created)) {
				oldest = game
			}
		}
		if oldest != nil {
			delete(h.scrimba, oldest.ID)
		}
	}
	if len(h.scrimba) >= maxScrimbaGames {
		return errors.New("too many active Scrimba games; join an existing game or try again later")
	}
	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return errors.New("could not start Scrimba")
	}
	g := &scrimbaGame{Creator: c.player.ID, ID: hex.EncodeToString(id), CarpetID: c.player.CarpetID, Created: h.now(), Players: map[string]*scrimbaPlayer{}, Solution: make([]string, scrimbaRules.Slots)}
	choices := append([]string(nil), scrimbaRules.Emojis...)
	for i := range g.Solution {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(choices))))
		if err != nil {
			return errors.New("could not create Scrimba puzzle")
		}
		index := int(n.Int64())
		g.Solution[i] = choices[index]
		choices = append(choices[:index], choices[index+1:]...)
	}
	g.Players[c.player.ID] = &scrimbaPlayer{ID: c.player.ID, Name: c.player.Name, Guesses: []scrimbaGuess{}}
	h.scrimba[g.ID] = g
	out := marshal(struct {
		Type      string `json:"type"`
		CarpetID  string `json:"carpetId"`
		From      string `json:"from"`
		Name      string `json:"name"`
		Text      string `json:"text"`
		ScrimbaID string `json:"scrimbaId"`
	}{"chat", g.CarpetID, c.player.ID, c.player.Name, c.player.Name + " has started a game of Scrimba. Click here to join", g.ID})
	dropped := false
	for _, peer := range h.clients {
		if peer.player.CarpetID == g.CarpetID && !h.enqueueLocked(peer, out) {
			dropped = true
		}
	}
	if dropped {
		h.broadcastLocked()
	}
	h.publishScrimbaLocked(g)
	return nil
}

func (h *hub) handleScrimbaLocked(c *client, data []byte) error {
	var msg struct {
		Type   string   `json:"type"`
		ID     string   `json:"id"`
		Emojis []string `json:"emojis"`
		Turn   int      `json:"turn"`
	}
	if err := strictDecode(data, &msg); err != nil {
		return errors.New("invalid Scrimba event")
	}
	h.pruneScrimbaLocked()
	g := h.scrimba[msg.ID]
	if g == nil || h.now().Sub(g.Created) >= scrimbaLifetime {
		return errors.New("this Scrimba has expired; type /scrimba to start a new game")
	}
	if c.player.CarpetID == "" || c.player.CarpetID != g.CarpetID {
		return errors.New("return to this game's carpet to play Scrimba")
	}
	p := g.Players[c.player.ID]
	if msg.Type == "scrimba-join" {
		if p == nil {
			if len(g.Players) >= maxScrimbaPlayers {
				return errors.New("this Scrimba game is full")
			}
			g.Players[c.player.ID] = &scrimbaPlayer{ID: c.player.ID, Name: c.player.Name, Guesses: []scrimbaGuess{}}
		}
	} else {
		if p == nil || p.Done || msg.Turn != len(p.Guesses) {
			return errors.New("this Scrimba guess is no longer available")
		}
		if len(msg.Emojis) != scrimbaRules.Slots {
			return errors.New("choose five emojis for your guess")
		}
		absent := map[string]bool{}
		for _, previous := range p.Guesses {
			for i, mark := range previous.Marks {
				if mark == "absent" {
					absent[previous.Emojis[i]] = true
				}
			}
		}
		seen := map[string]bool{}
		for _, emoji := range msg.Emojis {
			if absent[emoji] {
				return errors.New("this emoji is already confirmed not in the puzzle")
			}
			if seen[emoji] {
				return errors.New("each emoji can only appear once in a guess")
			}
			seen[emoji] = true
			valid := false
			for _, choice := range scrimbaRules.Emojis {
				if emoji == choice {
					valid = true
					break
				}
			}
			if !valid {
				return errors.New("choose emojis from the Scrimba keyboard")
			}
		}
		marks := scoreScrimba(msg.Emojis, g.Solution)
		p.Won = true
		for _, mark := range marks {
			if mark != "correct" {
				p.Won = false
			}
		}
		p.Name = c.player.Name
		p.Guesses = append(p.Guesses, scrimbaGuess{Emojis: msg.Emojis, Marks: marks})
		p.Done = p.Won || len(p.Guesses) == scrimbaRules.Attempts
	}
	h.publishScrimbaLocked(g)
	return nil
}
