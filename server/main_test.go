package main

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func testWorld() world {
	return world{
		Grid:  grid{Size: 48, OriginX: 24, OriginY: 24, StepDurationMs: 240},
		Width: 600, Height: 400, Spawn: point{X: 72, Y: 360},
		Walls: []rect{{X: 285, Y: 20, W: 30, H: 90}},
		Carpets: []carpet{
			{ID: "a", Name: "Small", rect: rect{X: 96, Y: 144, W: 144, H: 144}},
			{ID: "b", Name: "Large", rect: rect{X: 384, Y: 144, W: 144, H: 144}},
		},
		Chairs: []chair{{ID: "chair", X: 120, Y: 216, Facing: "down"}},
	}
}

type testClock struct {
	mu sync.Mutex
	at time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func testHub(t *testing.T, w world) (*hub, *testClock) {
	t.Helper()
	clock := &testClock{at: time.Unix(1700000000, 0)}
	h := newHubWithClock(w, nil, clock.now)
	t.Cleanup(h.close)
	return h, clock
}

func advance(h *hub, clock *testClock, duration time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	clock.mu.Lock()
	clock.at = clock.at.Add(duration)
	clock.mu.Unlock()
	if h.settleMovesLocked(clock.now()) {
		h.broadcastLocked()
	}
}

func snapshot(h *hub, c *client) player {
	h.mu.Lock()
	defer h.mu.Unlock()
	return c.player
}

func unitClient(t *testing.T, h *hub, name string) *client {
	t.Helper()
	c := &client{send: make(chan []byte, 128), done: make(chan struct{})}
	if err := h.handle(c, marshal(map[string]any{"type": "join", "name": name, "avatar": 0})); err != nil {
		t.Fatal(err)
	}
	return c
}

func drain(c *client) {
	for {
		select {
		case <-c.send:
		default:
			return
		}
	}
}

func TestDance(t *testing.T) {
	h, clock := testHub(t, testWorld())
	sender := unitClient(t, h, "Dancer")
	peer := unitClient(t, h, "Observer")
	drain(sender)
	drain(peer)
	toggle := func() {
		t.Helper()
		if err := h.handle(sender, []byte(`{"type":"dance"}`)); err != nil {
			t.Fatal(err)
		}
	}
	toggle()
	for _, c := range []*client{sender, peer} {
		var state stateMessage
		if err := json.Unmarshal(<-c.send, &state); err != nil {
			t.Fatal(err)
		}
		found := false
		for _, p := range state.Players {
			if p.ID == sender.player.ID && p.Dance != nil && p.Dance.StartedAt == clock.now().UnixMilli() {
				found = true
			}
		}
		if !found {
			t.Fatal("dance must reach dancer and observer")
		}
	}
	toggle()
	if snapshot(h, sender).Dance != nil {
		t.Fatal("second press must stop dancing")
	}
	toggle()
	p := snapshot(h, sender)
	result := requestMove(t, h, sender, 1, p.X, p.Y-48, "up")
	if !result.Accepted || snapshot(h, sender).Dance != nil {
		t.Fatal("walking must stop dancing")
	}
	toggle()
	if snapshot(h, sender).Dance != nil {
		t.Fatal("cannot start dancing mid-step")
	}
	for _, message := range []string{`{"type":"dance","from":"spoofed"}`, `{"type":"dance","startedAt":1}`} {
		if err := h.handle(sender, []byte(message)); err == nil {
			t.Fatal("accepted invalid dance message")
		}
	}
	if err := h.handle(&client{}, []byte(`{"type":"dance"}`)); err == nil {
		t.Fatal("dance requires joining")
	}
}

func TestEmojiReactions(t *testing.T) {
	h, clock := testHub(t, testWorld())
	sender := unitClient(t, h, "Sender")
	peer := unitClient(t, h, "Observer")
	drain(sender)
	drain(peer)
	if err := h.handle(sender, []byte(`{"type":"reaction","emoji":"👋"}`)); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*client{sender, peer} {
		select {
		case data := <-c.send:
			var state stateMessage
			if err := json.Unmarshal(data, &state); err != nil {
				t.Fatal(err)
			}
			found := false
			for _, p := range state.Players {
				if p.ID == sender.player.ID && p.Reaction != nil {
					found = p.Reaction.Emoji == "👋" && p.Reaction.StartedAt == clock.now().UnixMilli() && p.Reaction.DurationMs == 3000
				}
			}
			if !found {
				t.Fatal("reaction must reach sender and observers on the open floor")
			}
		default:
			t.Fatal("missing reaction broadcast")
		}
	}
	for _, message := range []string{`{"type":"reaction","emoji":"hello"}`, `{"type":"reaction","emoji":""}`, `{"type":"reaction","emoji":"👍","from":"spoofed"}`} {
		if err := h.handle(sender, []byte(message)); err == nil {
			t.Fatalf("accepted invalid reaction: %s", message)
		}
	}
	if err := h.handle(sender, []byte(`{"type":"reaction","emoji":"👍"}`)); err != nil {
		t.Fatal(err)
	}
	if snapshot(h, sender).Reaction.Emoji != "👋" {
		t.Fatal("rapid reactions should be throttled")
	}
	advance(h, clock, 250*time.Millisecond)
	if err := h.handle(sender, []byte(`{"type":"reaction","emoji":"👍"}`)); err != nil {
		t.Fatal(err)
	}
	if snapshot(h, sender).Reaction.Emoji != "👍" {
		t.Fatal("a new reaction should replace the previous bubble")
	}
	advance(h, clock, 3*time.Second)
	h.mu.Lock()
	players := h.playersLocked()
	h.mu.Unlock()
	for _, p := range players {
		if p.Reaction != nil {
			t.Fatal("expired reactions must not appear in later snapshots")
		}
	}
	if err := h.handle(&client{}, []byte(`{"type":"reaction","emoji":"👋"}`)); err == nil {
		t.Fatal("reactions require joining the office")
	}
}

func requestMove(t *testing.T, h *hub, c *client, requestID uint64, x, y float64, facing string, sprint ...bool) moveResult {
	t.Helper()
	if err := h.handle(c, marshal(map[string]any{"type": "move", "requestId": requestID, "x": x, "y": y, "facing": facing, "sprint": len(sprint) > 0 && sprint[0]})); err != nil {
		t.Fatal(err)
	}
	for {
		select {
		case data := <-c.send:
			var result moveResult
			if err := json.Unmarshal(data, &result); err != nil {
				t.Fatal(err)
			}
			if result.Type == "move-result" && result.RequestID == requestID {
				return result
			}
		default:
			t.Fatalf("no movement result for request %d", requestID)
		}
	}
}

func step(t *testing.T, h *hub, clock *testClock, c *client, x, y float64) {
	t.Helper()
	from := snapshot(h, c)
	facing := "right"
	if x < from.X {
		facing = "left"
	} else if y < from.Y {
		facing = "up"
	} else if y > from.Y {
		facing = "down"
	}
	if result := requestMove(t, h, c, 1, x, y, facing); !result.Accepted {
		t.Fatalf("step (%v,%v) -> (%v,%v) rejected: %s", from.X, from.Y, x, y, result.Reason)
	}
	advance(h, clock, time.Duration(h.world.Grid.StepDurationMs)*time.Millisecond)
}

// Route through actual legal adjacent tiles so media tests exercise the same
// movement rules as the browser rather than bypassing validation by teleport.
func walkTo(t *testing.T, h *hub, clock *testClock, c *client, x, y float64) {
	t.Helper()
	h.mu.Lock()
	start := point{X: c.player.X, Y: c.player.Y}
	target := point{X: x, Y: y}
	queue := []point{start}
	previous := map[point]point{}
	seen := map[point]bool{start: true}
	for i := 0; i < len(queue) && !seen[target]; i++ {
		current := queue[i]
		for _, delta := range []point{{X: h.world.Grid.Size}, {Y: h.world.Grid.Size}, {X: -h.world.Grid.Size}, {Y: -h.world.Grid.Size}} {
			next := point{X: current.X + delta.X, Y: current.Y + delta.Y}
			if !seen[next] && h.world.canMove(current, next) && !h.occupiedLocked(next, c) {
				seen[next], previous[next] = true, current
				queue = append(queue, next)
			}
		}
	}
	h.mu.Unlock()
	if !seen[target] {
		t.Fatalf("no free legal path from %v to %v", start, target)
	}
	path := []point{}
	for current := target; current != start; current = previous[current] {
		path = append(path, current)
	}
	for i := len(path) - 1; i >= 0; i-- {
		step(t, h, clock, c, path[i].X, path[i].Y)
	}
}

func TestCarpetAndChairBoundaries(t *testing.T) {
	w := testWorld()
	for _, tc := range []struct {
		x, y float64
		want string
	}{
		{96, 144, "a"}, {239.99, 287.99, "a"}, {240, 216, ""},
		{120, 288, ""}, {95.99, 216, ""}, {384, 144, "b"}, {72, 360, ""},
	} {
		if got := w.carpetAt(tc.x, tc.y); got != tc.want {
			t.Errorf("carpetAt(%v,%v) = %q, want %q", tc.x, tc.y, got, tc.want)
		}
	}
	if !w.isSeated(120, 216) || w.isSeated(120.01, 216) || w.isSeated(168, 216) {
		t.Fatal("seating must belong to the chair's exact grid tile")
	}
	if w.carpetAt(120, 216) != "a" {
		t.Fatal("chair must not alter carpet membership")
	}
}

func TestWallsBlockSegmentsButFurnitureDoesNot(t *testing.T) {
	w := testWorld()
	for _, tc := range []struct {
		name     string
		from, to point
		want     bool
	}{
		{"through a wall", point{250, 60}, point{350, 60}, false},
		{"feet intersect wall", point{250, 60}, point{280, 60}, false},
		{"tangent to wall", point{277, 30}, point{277, 100}, true},
		{"move away from wall", point{277, 60}, point{260, 60}, true},
		{"through a chair", point{96, 216}, point{144, 216}, true},
		{"outside floor", point{72, 216}, point{3, 216}, false},
		{"nonfinite x", point{72, 216}, point{math.Inf(1), 216}, false},
		{"nonfinite y", point{72, 216}, point{72, math.NaN()}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := w.canMove(tc.from, tc.to); got != tc.want {
				t.Errorf("canMove = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestJoinSpawnsOnDistinctNearestReachableTiles(t *testing.T) {
	h, _ := testHub(t, testWorld())
	a, b, c := unitClient(t, h, "Alice"), unitClient(t, h, "Bob"), unitClient(t, h, "Charlie")
	if p := snapshot(h, a); p.X != 72 || p.Y != 360 {
		t.Fatal("first participant did not use the spawn tile")
	}
	if p := snapshot(h, b); p.X != 120 || p.Y != 360 {
		t.Fatal("second participant did not use the nearest free tile")
	}
	if p := snapshot(h, c); p.X != 24 || p.Y != 360 {
		t.Fatal("third participant did not use the next nearest free tile")
	}
	// The nearest geometrically free tile is across an impassable wall. Joining
	// must stay in the component reachable from spawn, even when it is full.
	w := testWorld()
	w.Width, w.Height, w.Spawn = 144, 96, point{X: 24, Y: 24}
	w.Walls = []rect{{X: 48, Y: 0, W: 48, H: 96}}
	h2, _ := testHub(t, w)
	unitClient(t, h2, "One")
	unitClient(t, h2, "Two")
	full := &client{send: make(chan []byte, 128), done: make(chan struct{})}
	if err := h2.handle(full, []byte(`{"type":"join","name":"Three","avatar":0}`)); err == nil {
		t.Fatal("join escaped the fully occupied reachable component")
	}
}

func TestGridStepStaysAtSourceUntilArrival(t *testing.T) {
	h, clock := testHub(t, testWorld())
	c := unitClient(t, h, "Alice")
	result := requestMove(t, h, c, 5, 72, 312, "up")
	if !result.Accepted || result.Reason != "" {
		t.Fatalf("legal tile step rejected: %+v", result)
	}
	p := snapshot(h, c)
	if p.X != 72 || p.Y != 360 || p.Move == nil || p.Move.ToY != 312 || p.Move.DurationMs != 240 || p.Move.StartedAt != clock.now().UnixMilli() {
		t.Fatalf("incorrect in-flight state: %+v", p)
	}
	advance(h, clock, 239*time.Millisecond)
	if snapshot(h, c).Move == nil {
		t.Fatal("step completed before its animation duration")
	}
	advance(h, clock, time.Millisecond)
	p = snapshot(h, c)
	if p.X != 72 || p.Y != 312 || p.Move != nil {
		t.Fatalf("step did not settle at destination: %+v", p)
	}
	if err := h.handle(c, []byte(`{"type":"move","requestId":0,"x":72,"y":264,"facing":"up"}`)); err == nil {
		t.Fatal("missing positive request ID accepted")
	}
}

func TestSprintTravelsThreeTilesInOneTick(t *testing.T) {
	for _, tc := range []struct {
		facing string
		dx, dy float64
	}{{"up", 0, -48}, {"down", 0, 48}, {"left", -48, 0}, {"right", 48, 0}} {
		t.Run(tc.facing, func(t *testing.T) {
			w := testWorld()
			w.Spawn = point{X: 216, Y: 216}
			h, clock := testHub(t, w)
			c := unitClient(t, h, "Runner")
			if result := requestMove(t, h, c, 1, 216+tc.dx, 216+tc.dy, tc.facing, true); !result.Accepted {
				t.Fatal(result)
			}
			p := snapshot(h, c)
			if p.Move == nil || p.Move.ToX != 216+3*tc.dx || p.Move.ToY != 216+3*tc.dy || p.Move.DurationMs != 240 {
				t.Fatalf("incorrect sprint stride: %+v", p.Move)
			}
			if result := requestMove(t, h, c, 2, 216+tc.dx, 216+tc.dy, tc.facing, true); result.Reason != "busy" {
				t.Fatal("sprint bypassed tick duration")
			}
			advance(h, clock, 239*time.Millisecond)
			if snapshot(h, c).Move == nil {
				t.Fatal("sprint settled before the tick ended")
			}
			advance(h, clock, time.Millisecond)
			p = snapshot(h, c)
			if p.Move != nil || p.X != 216+3*tc.dx || p.Y != 216+3*tc.dy {
				t.Fatalf("incorrect sprint landing: %+v", p)
			}
			// Releasing sprint restores the existing single-tile stride.
			if result := requestMove(t, h, c, 3, p.X-tc.dx, p.Y-tc.dy, map[string]string{"up": "down", "down": "up", "left": "right", "right": "left"}[tc.facing]); !result.Accepted {
				t.Fatal(result)
			}
			p = snapshot(h, c)
			if math.Abs(p.Move.ToX-p.X)+math.Abs(p.Move.ToY-p.Y) != 48 {
				t.Fatal("walking retained sprint distance")
			}
		})
	}
}

func TestSprintStopsBeforeObstacles(t *testing.T) {
	for _, obstacle := range []string{"wall", "player", "boundary"} {
		t.Run(obstacle, func(t *testing.T) {
			w := testWorld()
			w.Spawn = point{X: 216, Y: 216}
			if obstacle == "wall" {
				// The third tile is beyond this thin wall, so endpoint-only
				// collision detection would incorrectly allow the stride.
				w.Walls = []rect{{X: 285, Y: 144, W: 2, H: 144}}
			}
			if obstacle == "boundary" {
				w.Width = 300
			}
			h, _ := testHub(t, w)
			c := unitClient(t, h, "Runner")
			if obstacle == "player" {
				other := unitClient(t, h, "Blocker")
				h.mu.Lock()
				other.player.X, other.player.Y = 312, 216
				h.mu.Unlock()
			}
			if result := requestMove(t, h, c, 1, 264, 216, "right", true); !result.Accepted {
				t.Fatal(result)
			}
			if m := snapshot(h, c).Move; m == nil || m.ToX != 264 || m.ToY != 216 {
				t.Fatalf("sprint did not stop before %s: %+v", obstacle, m)
			}
		})
	}
}

func TestSprintReservesIntermediateTiles(t *testing.T) {
	w := testWorld()
	w.Spawn = point{X: 216, Y: 216}
	h, clock := testHub(t, w)
	a, b := unitClient(t, h, "Runner"), unitClient(t, h, "Crosser")
	h.mu.Lock()
	b.player.X, b.player.Y = 264, 264
	h.mu.Unlock()
	if result := requestMove(t, h, a, 1, 264, 216, "right", true); !result.Accepted {
		t.Fatal(result)
	}
	if result := requestMove(t, h, b, 1, 264, 216, "up", true); result.Accepted || result.Reason != "occupied" {
		t.Fatalf("intermediate sprint tile was not reserved: %+v", result)
	}
	h.mu.Lock()
	for _, x := range []float64{216, 264, 312, 360} {
		if !h.occupiedLocked(point{X: x, Y: 216}, b) {
			t.Errorf("sprint path tile %v was not reserved", x)
		}
	}
	h.mu.Unlock()
	advance(h, clock, 240*time.Millisecond)
	if result := requestMove(t, h, b, 2, 264, 216, "up"); !result.Accepted {
		t.Fatal("intermediate sprint tile remained reserved after arrival")
	}
}

func TestGridRejectsInvalidStepsAndWallCrossing(t *testing.T) {
	h, clock := testHub(t, testWorld())
	c := unitClient(t, h, "Alice")
	for _, tc := range []struct {
		name   string
		x, y   float64
		facing string
	}{
		{"off grid", 73, 312, "up"},
		{"diagonal", 120, 312, "up"},
		{"teleport", 72, 264, "up"},
		{"stationary", 72, 360, "down"},
		{"wrong facing", 72, 312, "right"},
		{"unknown facing", 72, 312, "north"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if result := requestMove(t, h, c, 1, tc.x, tc.y, tc.facing); result.Accepted || result.Reason != "invalid" {
				t.Fatalf("invalid tile move result: %+v", result)
			}
			if p := snapshot(h, c); p.X != 72 || p.Y != 360 || p.Move != nil {
				t.Fatal("rejected move changed authoritative position")
			}
		})
	}
	walkTo(t, h, clock, c, 264, 72)
	if result := requestMove(t, h, c, 2, 312, 72, "right"); result.Accepted || result.Reason != "wall" {
		t.Fatalf("wall crossing result: %+v", result)
	}
	walkTo(t, h, clock, c, 24, 24)
	if result := requestMove(t, h, c, 3, -24, 24, "left"); result.Accepted || result.Reason != "wall" {
		t.Fatalf("office boundary result: %+v", result)
	}
}

func TestOccupiedSourceAndDestinationRemainExclusiveDuringMove(t *testing.T) {
	w := testWorld()
	w.Spawn = point{X: 216, Y: 216}
	h, clock := testHub(t, w)
	a, b := unitClient(t, h, "Alice"), unitClient(t, h, "Bob")
	// Bob is immediately to Alice's right. Swapping into his current tile fails.
	if result := requestMove(t, h, a, 1, 264, 216, "right"); result.Reason != "occupied" || result.Accepted {
		t.Fatalf("occupied destination accepted: %+v", result)
	}
	if result := requestMove(t, h, b, 1, 312, 216, "right"); !result.Accepted {
		t.Fatal(result)
	}
	if result := requestMove(t, h, a, 2, 264, 216, "right"); result.Reason != "occupied" {
		t.Fatal("source tile released before the departing avatar arrived")
	}
	if result := requestMove(t, h, b, 2, 360, 216, "right"); result.Reason != "busy" {
		t.Fatal("second in-flight step was accepted")
	}
	advance(h, clock, 240*time.Millisecond)
	if result := requestMove(t, h, a, 3, 264, 216, "right"); !result.Accepted {
		t.Fatal("source tile remained reserved after arrival")
	}
	// Disconnect immediately releases both the source and destination.
	h.remove(a)
	if result := requestMove(t, h, b, 3, 264, 216, "left"); !result.Accepted {
		t.Fatal("disconnected participant retained its destination reservation")
	}
}

func TestSimultaneousClaimsHaveExactlyOneWinner(t *testing.T) {
	w := testWorld()
	w.Spawn = point{X: 216, Y: 216}
	h, clock := testHub(t, w)
	a, b := unitClient(t, h, "Alice"), unitClient(t, h, "Bob")
	step(t, h, clock, b, 264, 168)
	drain(a)
	drain(b)
	var wg sync.WaitGroup
	errors := make(chan error, 2)
	for i, c := range []*client{a, b} {
		wg.Add(1)
		go func(i int, c *client) {
			defer wg.Done()
			facing := "up"
			if i == 1 {
				facing = "left"
			}
			errors <- h.handle(c, marshal(map[string]any{"type": "move", "requestId": 7, "x": 216, "y": 168, "facing": facing}))
		}(i, c)
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	winners, rejected := 0, 0
	for _, c := range []*client{a, b} {
		for len(c.send) > 0 {
			var result moveResult
			if err := json.Unmarshal(<-c.send, &result); err != nil {
				t.Fatal(err)
			}
			if result.Type == "move-result" && result.RequestID == 7 {
				if result.Accepted {
					winners++
				} else if result.Reason == "occupied" {
					rejected++
				}
			}
		}
	}
	if winners != 1 || rejected != 1 {
		t.Fatalf("simultaneous claims: %d winners, %d occupied rejections", winners, rejected)
	}
	advance(h, clock, 240*time.Millisecond)
	pa, pb := snapshot(h, a), snapshot(h, b)
	if pa.X == pb.X && pa.Y == pb.Y {
		t.Fatal("two participants settled on the same tile")
	}
}

func TestCarpetTransitionsPreserveDevicesAndDisconnectRemovesPlayer(t *testing.T) {
	h, clock := testHub(t, testWorld())
	c := unitClient(t, h, "Alice")
	if p := snapshot(h, c); p.Mic || p.Camera {
		t.Fatal("devices must start off")
	}
	if err := h.handle(c, []byte(`{"type":"media","mic":true,"camera":true}`)); err != nil {
		t.Fatalf("joined player must be able to enable devices outside a carpet: %v", err)
	}
	walkTo(t, h, clock, c, 120, 312)
	if result := requestMove(t, h, c, 4, 120, 264, "up"); !result.Accepted {
		t.Fatal(result)
	}
	if p := snapshot(h, c); p.CarpetID != "" || !p.Mic || !p.Camera {
		t.Fatal("carpet membership changed before arrival or capture was disabled")
	}
	advance(h, clock, 240*time.Millisecond)
	if snapshot(h, c).CarpetID != "a" {
		t.Fatal("arrival did not update carpet membership")
	}
	walkTo(t, h, clock, c, 120, 216)
	if p := snapshot(h, c); !p.Seated || p.CarpetID != "a" || !p.Mic || !p.Camera {
		t.Fatal("entering a carpet and sitting must preserve enabled devices")
	}
	walkTo(t, h, clock, c, 168, 216)
	walkTo(t, h, clock, c, 408, 216)
	if p := snapshot(h, c); p.CarpetID != "b" || !p.Mic || !p.Camera {
		t.Fatal("carpet transition must preserve both devices")
	}
	walkTo(t, h, clock, c, 312, 216)
	if p := snapshot(h, c); p.CarpetID != "" || !p.Mic || !p.Camera {
		t.Fatal("leaving a carpet must preserve both devices")
	}
	if err := h.handle(c, []byte(`{"type":"media","mic":false,"camera":true}`)); err != nil {
		t.Fatal(err)
	}
	walkTo(t, h, clock, c, 120, 216)
	if p := snapshot(h, c); p.Mic || !p.Camera {
		t.Fatal("entering a carpet must preserve independently disabled microphone")
	}
	if err := h.handle(c, []byte(`{"type":"media","mic":false,"camera":false}`)); err != nil {
		t.Fatal(err)
	}
	walkTo(t, h, clock, c, 312, 216)
	walkTo(t, h, clock, c, 408, 216)
	if p := snapshot(h, c); p.Mic || p.Camera {
		t.Fatal("manually disabled devices must stay off through carpet transitions")
	}
	h.remove(c)
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) != 0 {
		t.Fatal("disconnected participant was retained")
	}
}

func TestSignalsAreOnlySetupAndOnlyWithinSharedCarpet(t *testing.T) {
	h, clock := testHub(t, testWorld())
	a, b := unitClient(t, h, "Alice"), unitClient(t, h, "Bob")
	walkTo(t, h, clock, a, 120, 216)
	walkTo(t, h, clock, b, 408, 216)
	drain(a)
	drain(b)
	pa, pb := snapshot(h, a), snapshot(h, b)
	sig := signalMessage{Type: "signal", To: pb.ID, SessionID: "test-session", Candidate: &iceCandidate{Candidate: "candidate:1 1 udp 1 127.0.0.1 1234 typ host"}}
	if err := h.handle(a, marshal(sig)); err == nil {
		t.Fatal("cross-carpet signal was accepted")
	}
	if len(b.send) != 0 {
		t.Fatal("cross-carpet signal was forwarded")
	}
	walkTo(t, h, clock, b, 168, 216)
	drain(a)
	drain(b)
	if err := h.handle(a, marshal(sig)); err != nil {
		t.Fatal(err)
	}
	var forwarded serverSignal
	if err := json.Unmarshal(<-b.send, &forwarded); err != nil {
		t.Fatal(err)
	}
	if forwarded.From != pa.ID || forwarded.To != pb.ID || forwarded.SessionID != sig.SessionID {
		t.Fatalf("incorrect signaling envelope: %+v", forwarded)
	}
	spoof := map[string]any{"type": "signal", "to": pb.ID, "sessionId": "test", "from": pb.ID, "candidate": sig.Candidate}
	if err := h.handle(a, marshal(spoof)); err == nil {
		t.Fatal("sender spoofing was accepted")
	}
	if err := h.handle(a, []byte(`{"type":"video","payload":"encoded media"}`)); err == nil {
		t.Fatal("media packet type was accepted")
	}
	for _, sdp := range []string{"encoded media", "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n"} {
		if err := validateSignal(signalMessage{To: pb.ID, SessionID: "test", Description: &description{Type: "offer", SDP: sdp}}); err == nil {
			t.Fatal("non-audio/video SDP was accepted")
		}
	}
}

func TestWebSocketJoinSignalDepartureAndOrigin(t *testing.T) {
	w := testWorld()
	w.Grid.StepDurationMs = 1
	h := newHub(w, []string{"http://localhost:5555"})
	server := httptest.NewServer(h.handler())
	t.Cleanup(server.Close)
	t.Cleanup(h.close)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	if conn, response, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": []string{"https://untrusted.example"}}); err == nil {
		conn.Close()
		t.Fatal("untrusted origin was accepted")
	} else if response.StatusCode != http.StatusForbidden {
		t.Fatalf("origin response = %v", response.StatusCode)
	}
	dial := func(name string) (*websocket.Conn, string) {
		t.Helper()
		conn, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": []string{"http://localhost:5555"}})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.Close() })
		if err := conn.WriteJSON(map[string]any{"type": "join", "name": name, "avatar": 1}); err != nil {
			t.Fatal(err)
		}
		var welcome stateMessage
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		if err := conn.ReadJSON(&welcome); err != nil {
			t.Fatal(err)
		}
		if welcome.Type != "welcome" || welcome.SelfID == "" || welcome.ServerNow == 0 {
			t.Fatalf("bad welcome: %+v", welcome)
		}
		return conn, welcome.SelfID
	}
	readUntil := func(conn *websocket.Conn, predicate func(map[string]json.RawMessage) bool) map[string]json.RawMessage {
		t.Helper()
		_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		for {
			var msg map[string]json.RawMessage
			if err := conn.ReadJSON(&msg); err != nil {
				t.Fatal(err)
			}
			if predicate(msg) {
				return msg
			}
		}
	}
	stateWith := func(id, carpetID string, count int) func(map[string]json.RawMessage) bool {
		return func(msg map[string]json.RawMessage) bool {
			if string(msg["type"]) != `"state"` {
				return false
			}
			var players []player
			if err := json.Unmarshal(msg["players"], &players); err != nil {
				t.Fatal(err)
			}
			if len(players) != count {
				return false
			}
			for _, p := range players {
				if p.ID == id && p.CarpetID == carpetID && p.Move == nil {
					return true
				}
			}
			return false
		}
	}
	requestID := uint64(0)
	socketStep := func(conn *websocket.Conn, id string, x, y float64, facing string) {
		t.Helper()
		requestID++
		if err := conn.WriteJSON(map[string]any{"type": "move", "requestId": requestID, "x": x, "y": y, "facing": facing}); err != nil {
			t.Fatal(err)
		}
		readUntil(conn, func(msg map[string]json.RawMessage) bool {
			if string(msg["type"]) != `"move-result"` {
				return false
			}
			var accepted bool
			_ = json.Unmarshal(msg["accepted"], &accepted)
			if !accepted {
				t.Fatalf("legal WebSocket step rejected: %s", msg["reason"])
			}
			return true
		})
		readUntil(conn, func(msg map[string]json.RawMessage) bool {
			var players []player
			_ = json.Unmarshal(msg["players"], &players)
			for _, p := range players {
				if p.ID == id && p.X == x && p.Y == y && p.Move == nil {
					return true
				}
			}
			return false
		})
	}
	a, aID := dial("Alice")
	b, bID := dial("Bob")
	for y := 312.0; y >= 216; y -= 48 {
		socketStep(a, aID, 72, y, "up")
	}
	socketStep(a, aID, 120, 216, "right")
	socketStep(b, bID, 168, 360, "right")
	for y := 312.0; y >= 216; y -= 48 {
		socketStep(b, bID, 168, y, "up")
	}
	readUntil(a, stateWith(bID, "a", 2))
	if err := a.WriteJSON(signalMessage{Type: "signal", To: bID, SessionID: "integration", Description: &description{Type: "offer", SDP: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"}}); err != nil {
		t.Fatal(err)
	}
	msg := readUntil(b, func(msg map[string]json.RawMessage) bool { return string(msg["type"]) == `"signal"` })
	if string(msg["from"]) != `"`+aID+`"` {
		t.Fatal("server did not author signaling sender ID")
	}
	for _, y := range []float64{264, 312} {
		socketStep(a, aID, 120, y, "down")
	}
	if err := a.WriteJSON(signalMessage{Type: "signal", To: bID, SessionID: "integration", Candidate: &iceCandidate{Candidate: "candidate:1 1 udp 1 127.0.0.1 9999 typ host"}}); err != nil {
		t.Fatal(err)
	}
	readUntil(a, func(msg map[string]json.RawMessage) bool { return string(msg["type"]) == `"error"` })
	a.Close()
	readUntil(b, stateWith(bID, "a", 1))
}

func TestWebSocketRejectsBinaryMedia(t *testing.T) {
	h := newHub(testWorld(), []string{"http://localhost:5555"})
	server := httptest.NewServer(h.handler())
	t.Cleanup(server.Close)
	t.Cleanup(h.close)
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/ws", http.Header{"Origin": []string{"http://localhost:5555"}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.WriteMessage(websocket.BinaryMessage, []byte{0x80, 0x01, 0x02}); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = conn.ReadMessage()
	if err == nil {
		t.Fatal("binary frame was accepted")
	}
	if !websocket.IsCloseError(err, websocket.CloseUnsupportedData) {
		t.Fatalf("binary frame close = %v", err)
	}
}

func TestProductionFrontendServing(t *testing.T) {
	directory := t.TempDir()
	files := map[string]string{
		"index.html":               "<!doctype html><title>Bespingle</title>",
		"assets/index-CQAb12_3.js": "console.log('Bespingle');",
		"assets/unhashed.css":      "body { margin: 0; }",
		"api/hidden":               "this file must not replace an API response",
		"ws/hidden":                "this file must not replace a WebSocket response",
	}
	for name, data := range files {
		if err := os.MkdirAll(filepath.Dir(filepath.Join(directory, name)), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, name), []byte(data), 0644); err != nil {
			t.Fatal(err)
		}
	}
	frontend, err := newFrontendHandler(directory)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = frontend.root.Close() })
	h, _ := testHub(t, testWorld())
	handler := h.handlerWithFrontend(frontend)
	for _, tc := range []struct {
		method, path string
		status       int
		body, cache  string
	}{
		{"GET", "/", 200, files["index.html"], "no-cache"},
		{"HEAD", "/", 200, "", "no-cache"},
		{"GET", "/index.html", 200, files["index.html"], "no-cache"},
		{"GET", "/assets/index-CQAb12_3.js", 200, files["assets/index-CQAb12_3.js"], "public, max-age=31536000, immutable"},
		{"GET", "/assets/unhashed.css", 200, files["assets/unhashed.css"], "no-cache"},
		{"GET", "/assets/missing.js", 404, "", ""},
		{"GET", "/assets/", 404, "", ""},
		{"GET", "/unknown-route", 404, "", ""},
		{"GET", "/api", 404, "", ""},
		{"GET", "/api/hidden", 404, "", ""},
		{"GET", "/api/health/extra", 404, "", ""},
		{"GET", "/ws/hidden", 404, "", ""},
		{"POST", "/assets/index-CQAb12_3.js", 405, "", ""},
		{"GET", "/api/health", 200, "{\"status\":\"ok\"}\n", ""},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(tc.method, tc.path, nil))
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, tc.status, recorder.Body)
			}
			if tc.status == http.StatusOK && recorder.Body.String() != tc.body {
				t.Fatalf("body = %q, want %q", recorder.Body.String(), tc.body)
			}
			if got := recorder.Header().Get("Cache-Control"); got != tc.cache {
				t.Errorf("Cache-Control = %q, want %q", got, tc.cache)
			}
		})
	}
}

func TestProductionFrontendConfigurationAndConfinement(t *testing.T) {
	directory := t.TempDir()
	if _, err := newFrontendHandler(filepath.Join(directory, "missing")); err == nil {
		t.Fatal("missing STATIC_DIR must fail at startup")
	}
	if _, err := newFrontendHandler(directory); err == nil {
		t.Fatal("missing index.html must fail at startup")
	}
	if err := os.Mkdir(filepath.Join(directory, "index.html"), 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := newFrontendHandler(directory); err == nil {
		t.Fatal("directory named index.html must fail at startup")
	}
	if err := os.Remove(filepath.Join(directory, "index.html")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "index.html"), []byte("Bespingle"), 0644); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret outside static root"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(directory, "escape.txt")); err != nil {
		t.Fatal(err)
	}
	frontend, err := newFrontendHandler(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer frontend.root.Close()
	for _, path := range []string{"/../secret.txt", "/%2e%2e/secret.txt", "/escape.txt"} {
		recorder := httptest.NewRecorder()
		frontend.ServeHTTP(recorder, httptest.NewRequest("GET", path, nil))
		if recorder.Code != http.StatusNotFound || strings.Contains(recorder.Body.String(), "secret outside") {
			t.Fatalf("path %q escaped static root: %d %s", path, recorder.Code, recorder.Body)
		}
	}
}

func TestAllowedOriginsConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, configured, domain string
		want                     []string
	}{
		{"development", "", "", []string{"http://localhost:5555", "http://127.0.0.1:5555"}},
		{"Railway", "", "bespingle-production.up.railway.app", []string{"https://bespingle-production.up.railway.app"}},
		{"custom domains", "https://office.example.com, https://office.example.org", "bespingle.up.railway.app", []string{"https://office.example.com", "https://office.example.org", "https://bespingle.up.railway.app"}},
		{"local container", "http://127.0.0.1:5577", "", []string{"http://127.0.0.1:5577"}},
		{"deduplicated", "https://bespingle.up.railway.app,https://bespingle.up.railway.app", "bespingle.up.railway.app", []string{"https://bespingle.up.railway.app"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			origins, err := allowedOrigins(tc.configured, tc.domain)
			if err != nil || strings.Join(origins, ",") != strings.Join(tc.want, ",") {
				t.Fatalf("allowedOrigins = %v, %v; want %v", origins, err, tc.want)
			}
		})
	}
	for _, configured := range []string{"*", "https://*.example.com", "https://office.example.com/", "https://office.example.com/path", "https://office.example.com?query", "https://office.example.com?", "https://office.example.com#fragment", "https://office.example.com#", "https://user:password@office.example.com", "office.example.com", "https://office.example.com,", " "} {
		if _, err := allowedOrigins(configured, ""); err == nil {
			t.Errorf("invalid allowed origin %q was accepted", configured)
		}
	}
	for _, domain := range []string{"https://office.example.com", "office.example.com/path", "office.example.com:443", "office.example.com?query", "user@office.example.com", "*.example.com", "office.example.com "} {
		if _, err := allowedOrigins("", domain); err == nil {
			t.Errorf("invalid Railway domain %q was accepted", domain)
		}
	}
}

func TestRailwayWebSocketOriginIsExact(t *testing.T) {
	origins, err := allowedOrigins("", "bespingle.up.railway.app")
	if err != nil {
		t.Fatal(err)
	}
	h := newHub(testWorld(), origins)
	defer h.close()
	server := httptest.NewServer(h.handler())
	defer server.Close()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	for _, origin := range []string{"https://attacker.example", "https://bespingle.up.railway.app.attacker.example", "http://bespingle.up.railway.app", "http://localhost:5555", ""} {
		header := http.Header{"Origin": []string{origin}, "X-Forwarded-Host": []string{"bespingle.up.railway.app"}, "X-Forwarded-Proto": []string{"https"}}
		conn, response, err := websocket.DefaultDialer.Dial(url, header)
		if conn != nil {
			conn.Close()
		}
		if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
			t.Fatalf("untrusted origin %q was accepted or returned unexpected error: %v %v", origin, response, err)
		}
		response.Body.Close()
	}
	conn, response, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": []string{"https://bespingle.up.railway.app"}})
	if err != nil {
		if response != nil {
			body, _ := io.ReadAll(response.Body)
			t.Fatalf("Railway origin rejected: %v: %s", err, body)
		}
		t.Fatal(err)
	}
	conn.Close()
}

func chatMessages(c *client) []map[string]any {
	var messages []map[string]any
	for {
		select {
		case data := <-c.send:
			var msg map[string]any
			_ = json.Unmarshal(data, &msg)
			if msg["type"] == "chat" {
				messages = append(messages, msg)
			}
		default:
			return messages
		}
	}
}

func TestCarpetChatLiveDelivery(t *testing.T) {
	h, clock := testHub(t, testWorld())
	alice := unitClient(t, h, "Alice")
	walkTo(t, h, clock, alice, 120, 168)
	bob := unitClient(t, h, "Bob")
	walkTo(t, h, clock, bob, 168, 168)
	other := unitClient(t, h, "Other carpet")
	walkTo(t, h, clock, other, 408, 168)
	floor := unitClient(t, h, "Open floor")
	for _, c := range []*client{alice, bob, other, floor} {
		drain(c)
	}
	sendChat := func(c *client, carpetID, text string) error {
		return h.handle(c, marshal(map[string]any{"type": "chat", "carpetId": carpetID, "text": text}))
	}
	if err := sendChat(alice, "a", " hello 👋 "); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*client{alice, bob} {
		messages := chatMessages(c)
		if len(messages) != 1 || messages[0]["text"] != "hello 👋" || messages[0]["from"] != alice.player.ID || messages[0]["name"] != "Alice" || messages[0]["carpetId"] != "a" {
			t.Fatalf("wrong chat delivery: %v", messages)
		}
	}
	for _, c := range []*client{other, floor} {
		if len(chatMessages(c)) != 0 {
			t.Fatal("message leaked outside the carpet")
		}
	}
	late := unitClient(t, h, "Late arrival")
	walkTo(t, h, clock, late, 216, 168)
	if len(chatMessages(late)) != 0 {
		t.Fatal("late arrival received history")
	}
	walkTo(t, h, clock, bob, 168, 312)
	if err := sendChat(bob, "a", "stale send"); err == nil {
		t.Fatal("send after leaving should fail")
	}
	if err := sendChat(alice, "a", "after Bob left"); err != nil {
		t.Fatal(err)
	}
	if len(chatMessages(bob)) != 0 || len(chatMessages(late)) != 1 {
		t.Fatal("delivery did not follow current carpet membership")
	}
}

func TestCarpetChatValidation(t *testing.T) {
	h, clock := testHub(t, testWorld())
	c := unitClient(t, h, "Alice")
	walkTo(t, h, clock, c, 120, 168)
	for _, msg := range []map[string]any{
		{"type": "chat", "carpetId": "b", "text": "wrong carpet"},
		{"type": "chat", "text": "missing carpet"},
		{"type": "chat", "carpetId": "a", "text": "  "},
		{"type": "chat", "carpetId": "a", "text": strings.Repeat("x", 1001)},
		{"type": "chat", "carpetId": "a", "text": "bad\x00text"},
		{"type": "chat", "carpetId": "a", "text": "hello", "from": "spoofed"},
	} {
		if err := h.handle(c, marshal(msg)); err == nil {
			t.Errorf("accepted invalid chat: %v", msg)
		}
	}
	if err := h.handle(c, marshal(map[string]any{"type": "chat", "carpetId": "a", "text": strings.Repeat("👋", 1000)})); err != nil {
		t.Fatalf("valid Unicode message rejected: %v", err)
	}
}

func TestScreenSharingMembershipAndSignaling(t *testing.T) {
	h, clock := testHub(t, testWorld())
	c := unitClient(t, h, "Presenter")
	status := []byte(`{"type":"media","mic":true,"camera":true,"screen":true}`)
	if err := h.handle(c, status); err != nil {
		t.Fatal(err)
	}
	if snapshot(h, c).Screen {
		t.Fatal("screen sharing cannot be advertised on the open floor")
	}
	walkTo(t, h, clock, c, 120, 216)
	if err := h.handle(c, status); err != nil {
		t.Fatal(err)
	}
	if !snapshot(h, c).Screen {
		t.Fatal("screen sharing status missing on carpet")
	}
	walkTo(t, h, clock, c, 168, 216)
	if !snapshot(h, c).Screen {
		t.Fatal("movement within a carpet stopped sharing")
	}
	walkTo(t, h, clock, c, 312, 216)
	if p := snapshot(h, c); p.Screen || !p.Mic || !p.Camera {
		t.Fatal("leaving carpet must clear screen sharing and preserve devices")
	}
	sdp := "v=0\r\n" + strings.Repeat("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n", 2) + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n"
	msg := signalMessage{Type: "signal", To: strings.Repeat("a", 32), SessionID: "screen", Description: &description{Type: "offer", SDP: sdp}}
	if err := validateSignal(msg); err != nil {
		t.Fatalf("camera, screen, and audio offer rejected: %v", err)
	}
	msg.Description.SDP += "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n"
	if err := validateSignal(msg); err == nil {
		t.Fatal("more than three media sections accepted")
	}
}
