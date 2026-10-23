package main

import (
	"bytes"
	"context"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// worldJSON is shared with the frontend. It describes geometry, never user data.
//
//go:embed world.json
var worldJSON []byte

const (
	avatarRadius   = 8.0
	maxMessageSize = 64 * 1024
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = 25 * time.Second
)

type point struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type rect struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`
}

type carpet struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	rect
	Color string `json:"color"`
}

type chair struct {
	ID     string  `json:"id"`
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Facing string  `json:"facing"`
}

type grid struct {
	Size           float64 `json:"size"`
	OriginX        float64 `json:"originX"`
	OriginY        float64 `json:"originY"`
	StepDurationMs int64   `json:"stepDurationMs"`
}

type world struct {
	Grid    grid     `json:"grid"`
	Width   float64  `json:"width"`
	Height  float64  `json:"height"`
	Spawn   point    `json:"spawn"`
	Walls   []rect   `json:"walls"`
	Carpets []carpet `json:"carpets"`
	Chairs  []chair  `json:"chairs"`
}

func (w world) carpetAt(x, y float64) string {
	for _, c := range w.Carpets {
		// Half-open edges make adjacent carpets unambiguous.
		if x >= c.X && x < c.X+c.W && y >= c.Y && y < c.Y+c.H {
			return c.ID
		}
	}
	return ""
}

func (w world) isSeated(x, y float64) bool {
	position, ok := w.gridPoint(point{X: x, Y: y})
	if !ok {
		return false
	}
	for _, c := range w.Chairs {
		seat, valid := w.gridPoint(point{X: c.X, Y: c.Y})
		if valid && position == seat {
			return true
		}
	}
	return false
}

func (w world) validGrid() bool {
	return finite(w.Grid.Size) && w.Grid.Size > 0 && finite(w.Grid.OriginX) && finite(w.Grid.OriginY) && w.Grid.StepDurationMs > 0 && w.Grid.StepDurationMs <= 5000
}

// Normalize every accepted anchor so near-equal floating-point coordinates
// cannot create different occupancy keys for the same tile.
func (w world) gridPoint(p point) (point, bool) {
	if !w.validGrid() || !finite(p.X) || !finite(p.Y) {
		return point{}, false
	}
	x := w.Grid.OriginX + math.Round((p.X-w.Grid.OriginX)/w.Grid.Size)*w.Grid.Size
	y := w.Grid.OriginY + math.Round((p.Y-w.Grid.OriginY)/w.Grid.Size)*w.Grid.Size
	return point{X: x, Y: y}, math.Abs(p.X-x) < 0.000001 && math.Abs(p.Y-y) < 0.000001
}

func (w world) validStep(from, to point, facing string) bool {
	dx, dy := to.X-from.X, to.Y-from.Y
	switch facing {
	case "up":
		return dx == 0 && dy == -w.Grid.Size
	case "down":
		return dx == 0 && dy == w.Grid.Size
	case "left":
		return dx == -w.Grid.Size && dy == 0
	case "right":
		return dx == w.Grid.Size && dy == 0
	}
	return false
}

func (w world) canMove(from, to point) bool {
	if !finite(to.X) || !finite(to.Y) || to.X < avatarRadius || to.X > w.Width-avatarRadius || to.Y < avatarRadius || to.Y > w.Height-avatarRadius {
		return false
	}
	for _, wall := range w.Walls {
		if crossesRect(from, to, rect{X: wall.X - avatarRadius, Y: wall.Y - avatarRadius, W: wall.W + 2*avatarRadius, H: wall.H + 2*avatarRadius}) {
			return false
		}
	}
	return true
}

// Test the entire movement segment, not just its endpoint, so a large move
// cannot pass through a wall. The expanded rectangle accounts for avatar feet.
func crossesRect(from, to point, r rect) bool {
	enter, leave := math.Inf(-1), math.Inf(1)
	for _, axis := range [][4]float64{{from.X, to.X - from.X, r.X, r.X + r.W}, {from.Y, to.Y - from.Y, r.Y, r.Y + r.H}} {
		origin, delta, lower, upper := axis[0], axis[1], axis[2], axis[3]
		if delta == 0 {
			if origin <= lower || origin >= upper {
				return false
			}
			continue
		}
		a, b := (lower-origin)/delta, (upper-origin)/delta
		if a > b {
			a, b = b, a
		}
		enter, leave = math.Max(enter, a), math.Min(leave, b)
	}
	return enter < leave && leave > 0 && enter < 1
}

func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

const portalDurationMs int64 = 1400

type movement struct {
	Portal     string  `json:"portal,omitempty"`
	ToX        float64 `json:"toX"`
	ToY        float64 `json:"toY"`
	Facing     string  `json:"facing"`
	StartedAt  int64   `json:"startedAt"`
	DurationMs int64   `json:"durationMs"`
}

type reaction struct {
	Emoji      string `json:"emoji"`
	StartedAt  int64  `json:"startedAt"`
	DurationMs int64  `json:"durationMs"`
}

type dance struct {
	StartedAt int64 `json:"startedAt"`
}

type player struct {
	Dance    *dance    `json:"dance,omitempty"`
	Reaction *reaction `json:"reaction,omitempty"`
	Move     *movement `json:"move,omitempty"`
	// Next is at most one step accepted ahead of Move. It starts exactly when
	// Move ends, from Move's destination, so a held key never pauses.
	Next         *movement `json:"next,omitempty"`
	ID           string    `json:"id"`
	Name         string    `json:"name"`
	Avatar       int       `json:"avatar"`
	CustomAvatar string    `json:"customAvatar,omitempty"`
	X            float64   `json:"x"`
	Y            float64   `json:"y"`
	Facing       string    `json:"facing"`
	Seated       bool      `json:"seated"`
	CarpetID     string    `json:"carpetId"`
	Mic          bool      `json:"mic"`
	Camera       bool      `json:"camera"`
	Screen       bool      `json:"screen"`
}

type description struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type iceCandidate struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type signalMessage struct {
	Type        string        `json:"type"`
	To          string        `json:"to"`
	SessionID   string        `json:"sessionId"`
	Description *description  `json:"description,omitempty"`
	Candidate   *iceCandidate `json:"candidate,omitempty"`
}

type serverSignal struct {
	signalMessage
	From string `json:"from"`
}

type stateMessage struct {
	Type      string   `json:"type"`
	SelfID    string   `json:"selfId,omitempty"`
	Players   []player `json:"players"`
	ServerNow int64    `json:"serverNow"`
}

type moveResult struct {
	Type      string `json:"type"`
	RequestID uint64 `json:"requestId"`
	Accepted  bool   `json:"accepted"`
	Reason    string `json:"reason,omitempty"`
}

type client struct {
	conn     *websocket.Conn
	send     chan []byte
	done     chan struct{}
	stopOnce sync.Once
	player   player
}

func (c *client) stop() {
	c.stopOnce.Do(func() {
		close(c.done)
		if c.conn != nil {
			_ = c.conn.Close()
		}
	})
}

type hub struct {
	avatars  *avatarService
	mu       sync.Mutex
	now      func() time.Time
	world    world
	clients  map[string]*client
	origins  map[string]bool
	dirty    bool
	done     chan struct{}
	stopOnce sync.Once
}

func newHub(w world, origins []string) *hub {
	return newHubWithClock(w, origins, time.Now)
}

func newHubWithClock(w world, origins []string, now func() time.Time) *hub {
	h := &hub{avatars: newAvatarService(nil), world: w, now: now, clients: make(map[string]*client), origins: make(map[string]bool), done: make(chan struct{})}
	for _, origin := range origins {
		h.origins[origin] = true
	}
	go h.broadcastLoop()
	return h
}

func (h *hub) broadcastLoop() {
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-h.done:
			return
		case <-ticker.C:
			h.mu.Lock()
			h.settleMovesLocked(h.now())
			if h.dirty {
				h.broadcastLocked()
			}
			h.mu.Unlock()
		}
	}
}

func marshal(v any) []byte {
	data, err := json.Marshal(v)
	if err != nil {
		panic(err)
	} // All outbound types and numbers are validated.
	return data
}

// The mutex owns membership and queueing; only each client's writer writes
// WebSocket data. A slow reader is disconnected instead of blocking the office.
func (h *hub) enqueueLocked(c *client, data []byte) bool {
	select {
	case <-c.done:
		delete(h.clients, c.player.ID)
		return false
	default:
	}
	select {
	case c.send <- data:
		return true
	default:
		delete(h.clients, c.player.ID)
		c.stop()
		return false
	}
}

func (h *hub) playersLocked() []player {
	players := make([]player, 0, len(h.clients))
	for _, c := range h.clients {
		if r := c.player.Reaction; r != nil && h.now().UnixMilli() >= r.StartedAt+r.DurationMs {
			c.player.Reaction = nil
		}
		players = append(players, c.player)
	}
	sort.Slice(players, func(i, j int) bool { return players[i].ID < players[j].ID })
	return players
}

func (h *hub) broadcastLocked() {
	h.dirty = false
	for {
		data := marshal(stateMessage{Type: "state", Players: h.playersLocked(), ServerNow: h.now().UnixMilli()})
		dropped := false
		for _, c := range h.clients {
			if !h.enqueueLocked(c, data) {
				dropped = true
			}
		}
		if !dropped {
			return
		}
	}
}

func (h *hub) occupiedLocked(position point, except *client) bool {
	return h.occupiedAtLocked(position, except, h.now().UnixMilli())
}

// Walking reserves its full path; portals reserve only their endpoints.
// Current tiles and every tile on an in-flight or queued walking path are exclusive.
// Keeping the source occupied until arrival also prevents swaps and followers
// walking through an avatar while it is still crossing the edge of its old
// tile. A claim beginning at server time at, such as a queued step, may use
// the tiles an in-flight step leaves behind once that step has ended. Its
// destination and every queued tile stay reserved: a queued step can still be
// cancelled, leaving the avatar on the in-flight destination.
func (h *hub) occupiedAtLocked(position point, except *client, at int64) bool {
	for _, c := range h.clients {
		if c == except {
			continue
		}
		tail := point{X: c.player.X, Y: c.player.Y}
		if m := c.player.Move; m != nil {
			to := point{X: m.ToX, Y: m.ToY}
			if position == to || at < m.StartedAt+m.DurationMs && (position == tail || m.Portal == "" && onPath(tail, to, position)) {
				return true
			}
			tail = to
		}
		if position == tail {
			return true
		}
		if n := c.player.Next; n != nil && onPath(tail, point{X: n.ToX, Y: n.ToY}, position) {
			return true
		}
	}
	return false
}

// Moves are axis aligned. Reserve intermediate sprint tiles too so another
// player cannot enter or cross the path before arrival.
func onPath(from, to, position point) bool {
	return from.X == to.X && position.X == from.X && position.Y >= math.Min(from.Y, to.Y) && position.Y <= math.Max(from.Y, to.Y) ||
		from.Y == to.Y && position.Y == from.Y && position.X >= math.Min(from.X, to.X) && position.X <= math.Max(from.X, to.X)
}

func (h *hub) settleMovesLocked(now time.Time) bool {
	changed := false
	for _, c := range h.clients {
		// A queued step's start is pinned to the previous end, so a late tick
		// may land several steps at once, each in order.
		for m := c.player.Move; m != nil && now.UnixMilli() >= m.StartedAt+m.DurationMs; m = c.player.Move {
			c.player.X, c.player.Y = m.ToX, m.ToY
			previousCarpet := c.player.CarpetID
			c.player.CarpetID = h.world.carpetAt(m.ToX, m.ToY)
			if previousCarpet != c.player.CarpetID {
				c.player.Screen = false
			}
			c.player.Seated = h.world.isSeated(m.ToX, m.ToY)
			c.player.Move, c.player.Next = c.player.Next, nil
			if c.player.Move != nil {
				c.player.Facing = c.player.Move.Facing
			}
			changed = true
		}
	}
	if changed {
		h.dirty = true
	}
	return changed
}

func (h *hub) spawnLocked() (point, bool) {
	start, valid := h.world.gridPoint(h.world.Spawn)
	if !valid || !h.world.canMove(start, start) {
		return point{}, false
	}
	queue := []point{start}
	visited := map[point]bool{start: true}
	// Breadth-first search finds the nearest reachable free tile, with a stable
	// direction order so crowded joins remain predictable.
	for i := 0; i < len(queue); i++ {
		current := queue[i]
		if !h.occupiedLocked(current, nil) {
			return current, true
		}
		for _, delta := range []point{{X: h.world.Grid.Size}, {Y: h.world.Grid.Size}, {X: -h.world.Grid.Size}, {Y: -h.world.Grid.Size}} {
			next := point{X: current.X + delta.X, Y: current.Y + delta.Y}
			if !visited[next] && h.world.canMove(current, next) {
				visited[next] = true
				queue = append(queue, next)
			}
		}
	}
	return point{}, false
}

func (h *hub) moveResultLocked(c *client, requestID uint64, accepted bool, reason string) {
	if !h.enqueueLocked(c, marshal(moveResult{Type: "move-result", RequestID: requestID, Accepted: accepted, Reason: reason})) {
		h.broadcastLocked()
	}
}

func (h *hub) remove(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	c.stop()
	if h.clients[c.player.ID] == c {
		delete(h.clients, c.player.ID)
		h.broadcastLocked()
	}
}

func (h *hub) close() {
	h.stopOnce.Do(func() { close(h.done) })
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		c.stop()
	}
	h.clients = make(map[string]*client)
}

func strictDecode(data []byte, out any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(out); err != nil {
		return err
	}
	if decoder.Decode(new(any)) != io.EOF {
		return errors.New("expected a single JSON object")
	}
	return nil
}

func validateProfile(name string, avatar *int) (string, error) {
	name = strings.TrimSpace(name)
	if !utf8.ValidString(name) || name == "" || utf8.RuneCountInString(name) > 32 {
		return "", errors.New("display name must contain 1–32 characters")
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return "", errors.New("display name cannot contain control characters")
		}
	}
	if avatar == nil || *avatar < 0 || *avatar > 5 {
		return "", errors.New("choose an avatar from 0 through 5")
	}
	return name, nil
}

func validFacing(facing string) bool {
	return facing == "up" || facing == "down" || facing == "left" || facing == "right"
}

func (h *hub) handle(c *client, data []byte) error {
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return errors.New("invalid JSON message")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	// Process arrivals before membership-sensitive commands, including SDP and
	// ICE, and deliver their carpet update before any resulting signaling.
	if h.settleMovesLocked(h.now()) {
		h.broadcastLocked()
	}
	if c.player.ID == "" && envelope.Type != "join" {
		return errors.New("join before sending office messages")
	}
	if c.player.ID != "" && h.clients[c.player.ID] != c {
		return errors.New("connection is closed")
	}
	switch envelope.Type {
	case "join", "profile":
		var msg struct {
			Type         string `json:"type"`
			Name         string `json:"name"`
			Avatar       *int   `json:"avatar"`
			CustomAvatar string `json:"customAvatar,omitempty"`
		}
		if err := strictDecode(data, &msg); err != nil {
			return errors.New("invalid profile message")
		}
		if msg.CustomAvatar != "" && !avatarIDPattern.MatchString(msg.CustomAvatar) {
			return errors.New("invalid custom avatar")
		}
		name, err := validateProfile(msg.Name, msg.Avatar)
		if err != nil {
			return err
		}
		if msg.Type == "join" {
			if c.player.ID != "" {
				return errors.New("already joined")
			}
			spawn, available := h.spawnLocked()
			if !available {
				return errors.New("the office has no free reachable tile")
			}
			id := make([]byte, 16)
			if _, err := rand.Read(id); err != nil {
				return errors.New("could not create participant ID")
			}
			c.player = player{ID: hex.EncodeToString(id), Name: name, Avatar: *msg.Avatar, CustomAvatar: msg.CustomAvatar, X: spawn.X, Y: spawn.Y, Facing: "down", CarpetID: h.world.carpetAt(spawn.X, spawn.Y), Seated: h.world.isSeated(spawn.X, spawn.Y)}
			h.clients[c.player.ID] = c
			h.enqueueLocked(c, marshal(stateMessage{Type: "welcome", SelfID: c.player.ID, Players: h.playersLocked(), ServerNow: h.now().UnixMilli()}))
		} else {
			c.player.Name, c.player.Avatar, c.player.CustomAvatar = name, *msg.Avatar, msg.CustomAvatar
		}
		h.broadcastLocked()
	case "move":
		var msg struct {
			Type      string   `json:"type"`
			RequestID uint64   `json:"requestId"`
			X         *float64 `json:"x"`
			Y         *float64 `json:"y"`
			Facing    string   `json:"facing"`
			Sprint    bool     `json:"sprint"`
			Portal    bool     `json:"portal"`
		}
		if err := strictDecode(data, &msg); err != nil || msg.RequestID == 0 || msg.RequestID > 9007199254740991 || msg.X == nil || msg.Y == nil {
			return errors.New("invalid movement message")
		}
		from := point{X: c.player.X, Y: c.player.Y}
		startedAt := h.now().UnixMilli()
		if m := c.player.Move; m != nil {
			// Accept one step ahead, in the second half of the current one,
			// starting from its destination exactly when it ends. A client can
			// never be more than one stride ahead of the server's clock.
			end := m.StartedAt + m.DurationMs
			if msg.Portal || m.Portal != "" || c.player.Next != nil || end-startedAt > h.world.Grid.StepDurationMs/2 {
				h.moveResultLocked(c, msg.RequestID, false, "busy")
				return nil
			}
			from, startedAt = point{X: m.ToX, Y: m.ToY}, end
		}
		to, onGrid := h.world.gridPoint(point{X: *msg.X, Y: *msg.Y})
		if msg.Portal {
			if !onGrid || from == to {
				h.moveResultLocked(c, msg.RequestID, false, "invalid")
				return nil
			}
			// Portals bypass the intervening floor, but must land on a legal tile.
			if !h.world.canMove(to, to) {
				h.moveResultLocked(c, msg.RequestID, false, "wall")
				return nil
			}
			var partner *client
			for _, peer := range h.clients {
				if peer != c && (point{X: peer.player.X, Y: peer.player.Y}) == to && peer.player.Move == nil {
					partner = peer
				}
			}
			if partner == nil && h.occupiedLocked(to, c) {
				h.moveResultLocked(c, msg.RequestID, false, "occupied")
				return nil
			}
			startedAt := h.now().UnixMilli()
			c.player.Dance = nil
			c.player.Move = &movement{ToX: to.X, ToY: to.Y, StartedAt: startedAt, DurationMs: portalDurationMs, Facing: c.player.Facing, Portal: "orange"}
			if partner != nil {
				partner.player.Dance = nil
				partner.player.Move = &movement{ToX: from.X, ToY: from.Y, StartedAt: startedAt, DurationMs: portalDurationMs, Facing: partner.player.Facing, Portal: "blue"}
			}
			h.moveResultLocked(c, msg.RequestID, true, "")
			h.broadcastLocked()
			return nil
		}
		if !onGrid || !h.world.validStep(from, to, msg.Facing) {
			h.moveResultLocked(c, msg.RequestID, false, "invalid")
			return nil
		}
		if !h.world.canMove(from, to) {
			h.moveResultLocked(c, msg.RequestID, false, "wall")
			return nil
		}
		if h.occupiedAtLocked(to, c, startedAt) {
			h.moveResultLocked(c, msg.RequestID, false, "occupied")
			return nil
		}
		if msg.Sprint {
			// Clients still request an adjacent tile. Only the server extends
			// the stride, checking each tile and stopping before an obstacle.
			dx, dy := to.X-from.X, to.Y-from.Y
			for tiles := 1; tiles < 3; tiles++ {
				next := point{X: to.X + dx, Y: to.Y + dy}
				if !h.world.canMove(to, next) || h.occupiedAtLocked(next, c, startedAt) {
					break
				}
				to = next
			}
		}
		c.player.Dance = nil
		step := &movement{ToX: to.X, ToY: to.Y, Facing: msg.Facing, StartedAt: startedAt, DurationMs: h.world.Grid.StepDurationMs}
		if c.player.Move != nil {
			c.player.Next = step
		} else {
			c.player.Facing, c.player.Move = msg.Facing, step
		}
		h.moveResultLocked(c, msg.RequestID, true, "")
		h.broadcastLocked()
	case "move-cancel":
		// Releasing a held key withdraws a queued step that has not started.
		// An in-flight step always finishes, so the avatar stops on a tile.
		var msg struct {
			Type      string `json:"type"`
			RequestID uint64 `json:"requestId"`
		}
		if err := strictDecode(data, &msg); err != nil || msg.RequestID == 0 || msg.RequestID > 9007199254740991 {
			return errors.New("invalid movement message")
		}
		dropped := c.player.Next != nil
		c.player.Next = nil
		h.moveResultLocked(c, msg.RequestID, dropped, "")
		if dropped {
			h.broadcastLocked()
		}
	case "dance":
		var msg struct {
			Type string `json:"type"`
		}
		if err := strictDecode(data, &msg); err != nil {
			return errors.New("invalid dance message")
		}
		if c.player.Move != nil {
			return nil
		}
		if c.player.Dance == nil {
			c.player.Dance = &dance{StartedAt: h.now().UnixMilli()}
		} else {
			c.player.Dance = nil
		}
		h.broadcastLocked()
	case "reaction":
		var msg struct {
			Type  string `json:"type"`
			Emoji string `json:"emoji"`
		}
		if err := strictDecode(data, &msg); err != nil {
			return errors.New("invalid reaction message")
		}
		switch msg.Emoji {
		case "👋", "👍", "❤️", "😂", "🎉", "🤔":
		default:
			return errors.New("choose an emoji from the reaction bar")
		}
		now := h.now().UnixMilli()
		if r := c.player.Reaction; r != nil && now-r.StartedAt < 250 {
			return nil
		}
		c.player.Reaction = &reaction{Emoji: msg.Emoji, StartedAt: now, DurationMs: 3000}
		h.broadcastLocked()
	case "media":
		var msg struct {
			Type   string `json:"type"`
			Mic    *bool  `json:"mic"`
			Camera *bool  `json:"camera"`
			Screen bool   `json:"screen"`
		}
		if err := strictDecode(data, &msg); err != nil || msg.Mic == nil || msg.Camera == nil {
			return errors.New("invalid media status message")
		}
		c.player.Mic, c.player.Camera = *msg.Mic, *msg.Camera
		c.player.Screen = msg.Screen && c.player.CarpetID != ""
		h.broadcastLocked()
	case "chat":
		var msg struct {
			Type     string `json:"type"`
			CarpetID string `json:"carpetId"`
			Text     string `json:"text"`
		}
		if err := strictDecode(data, &msg); err != nil {
			return errors.New("invalid chat message")
		}
		msg.Text = strings.TrimSpace(msg.Text)
		if !utf8.ValidString(msg.Text) || msg.Text == "" || utf8.RuneCountInString(msg.Text) > 1000 || strings.IndexFunc(msg.Text, unicode.IsControl) >= 0 {
			return errors.New("chat messages must contain 1–1000 characters without control characters")
		}
		if c.player.CarpetID == "" || msg.CarpetID != c.player.CarpetID {
			return errors.New("join this carpet before sending chat messages")
		}
		// Fan out once to current members, including the sender. No history is
		// retained or included in state/welcome messages for later arrivals.
		out := marshal(struct {
			Type     string `json:"type"`
			CarpetID string `json:"carpetId"`
			From     string `json:"from"`
			Name     string `json:"name"`
			Text     string `json:"text"`
		}{"chat", c.player.CarpetID, c.player.ID, c.player.Name, msg.Text})
		dropped := false
		for _, peer := range h.clients {
			if peer.player.CarpetID == c.player.CarpetID && !h.enqueueLocked(peer, out) {
				dropped = true
			}
		}
		if dropped {
			h.broadcastLocked()
		}
	case "signal":
		var msg signalMessage
		if err := strictDecode(data, &msg); err != nil {
			return errors.New("invalid signaling message")
		}
		if err := validateSignal(msg); err != nil {
			return err
		}
		peer := h.clients[msg.To]
		if peer == nil || peer == c || c.player.CarpetID == "" || peer.player.CarpetID != c.player.CarpetID {
			return errors.New("signaling requires two participants on the same carpet")
		}
		if !h.enqueueLocked(peer, marshal(serverSignal{signalMessage: msg, From: c.player.ID})) {
			h.broadcastLocked()
		}
	default:
		return errors.New("unsupported message type")
	}
	return nil
}

func validateSignal(msg signalMessage) error {
	if len(msg.To) != 32 || len(msg.SessionID) == 0 || len(msg.SessionID) > 128 {
		return errors.New("invalid signaling participant or session")
	}
	for _, r := range msg.SessionID {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("-_:.", r)) {
			return errors.New("invalid signaling session")
		}
	}
	if (msg.Description == nil) == (msg.Candidate == nil) {
		return errors.New("send exactly one SDP description or ICE candidate")
	}
	if d := msg.Description; d != nil {
		if (d.Type != "offer" && d.Type != "answer") || len(d.SDP) > 48*1024 || !strings.HasPrefix(d.SDP, "v=0\r\n") {
			return errors.New("invalid SDP description")
		}
		mediaLines := 0
		for _, line := range strings.Split(d.SDP, "\r\n") {
			if strings.HasPrefix(line, "m=") {
				if !strings.HasPrefix(line, "m=audio ") && !strings.HasPrefix(line, "m=video ") {
					return errors.New("only audio/video WebRTC setup is supported")
				}
				mediaLines++
			}
		}
		if mediaLines == 0 || mediaLines > 3 {
			return errors.New("SDP must describe audio or video")
		}
	}
	if c := msg.Candidate; c != nil {
		if len(c.Candidate) > 2048 || c.Candidate != "" && !strings.HasPrefix(c.Candidate, "candidate:") || strings.ContainsAny(c.Candidate, "\r\n") {
			return errors.New("invalid ICE candidate")
		}
		if c.SDPMid != nil && len(*c.SDPMid) > 64 || c.UsernameFragment != nil && len(*c.UsernameFragment) > 256 {
			return errors.New("invalid ICE metadata")
		}
	}
	return nil
}

func (h *hub) serveWS(w http.ResponseWriter, r *http.Request) {
	upgrader := websocket.Upgrader{
		ReadBufferSize: 4096, WriteBufferSize: 4096,
		CheckOrigin: func(r *http.Request) bool { return h.origins[r.Header.Get("Origin")] },
	}
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn, send: make(chan []byte, 128), done: make(chan struct{})}
	defer h.remove(c)
	conn.SetReadLimit(maxMessageSize)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(pongWait)) })
	go c.writeLoop()
	for {
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return
		}
		if messageType != websocket.TextMessage || !utf8.Valid(data) {
			_ = conn.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseUnsupportedData, "only UTF-8 JSON setup messages are accepted"), time.Now().Add(writeWait))
			return
		}
		if err := h.handle(c, data); err != nil {
			h.mu.Lock()
			h.enqueueLocked(c, marshal(struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			}{Type: "error", Message: err.Error()}))
			h.mu.Unlock()
		}
		if c.player.ID != "" {
			_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		}
	}
}

func (c *client) writeLoop() {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()
	defer c.stop()
	for {
		select {
		case <-c.done:
			return
		case data := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// Vite includes a content hash in built asset names. Only those files can be
// cached indefinitely; HTML must be revalidated to discover each deployment.
var hashedAssetName = regexp.MustCompile(`-[A-Za-z0-9_-]{8,}\.[^.]+$`)

type frontendHandler struct {
	root *os.Root
}

func newFrontendHandler(directory string) (*frontendHandler, error) {
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, fmt.Errorf("open STATIC_DIR: %w", err)
	}
	index, err := root.Stat("index.html")
	if err != nil || !index.Mode().IsRegular() {
		_ = root.Close()
		if err == nil {
			err = errors.New("index.html is not a regular file")
		}
		return nil, fmt.Errorf("read STATIC_DIR/index.html: %w", err)
	}
	return &frontendHandler{root: root}, nil
}

func (f *frontendHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/")
	if r.URL.Path == "/" {
		name = "index.html"
	}
	// The app currently has a single frontend route: /. Missing files and
	// unknown routes stay 404 rather than silently returning an HTML page.
	if !fs.ValidPath(name) {
		http.NotFound(w, r)
		return
	}
	file, err := f.root.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	if strings.HasPrefix(name, "assets/") && hashedAssetName.MatchString(name) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, name, info.ModTime(), file)
}

func allowedOrigins(configured, railwayDomain string) ([]string, error) {
	origins := []string{}
	if configured == "" && railwayDomain == "" {
		return []string{"http://localhost:5555", "http://127.0.0.1:5555"}, nil
	}
	if configured != "" {
		for _, origin := range strings.Split(configured, ",") {
			origins = append(origins, strings.TrimSpace(origin))
		}
	}
	if railwayDomain != "" {
		if strings.ContainsAny(railwayDomain, ":/?#@\\") || strings.IndexFunc(railwayDomain, unicode.IsSpace) >= 0 {
			return nil, errors.New("RAILWAY_PUBLIC_DOMAIN must contain only a hostname")
		}
		origins = append(origins, "https://"+railwayDomain)
	}
	unique := make([]string, 0, len(origins))
	seen := make(map[string]bool)
	for _, origin := range origins {
		u, err := url.Parse(origin)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.String() != origin || strings.ContainsAny(u.Host, "*\\") || strings.IndexFunc(u.Host, unicode.IsSpace) >= 0 {
			return nil, fmt.Errorf("invalid allowed origin %q: expected an exact http(s) origin without a path", origin)
		}
		if !seen[origin] {
			unique, seen[origin] = append(unique, origin), true
		}
	}
	return unique, nil
}

func (h *hub) handler() http.Handler {
	return h.handlerWithFrontend(nil)
}

func (h *hub) handlerWithFrontend(frontend http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /ws", h.serveWS)
	mux.Handle("/mcp", h.avatarOrigin(h.avatars.mcpHandler()))
	mux.Handle("POST /api/avatar-session", h.avatarOrigin(http.HandlerFunc(h.avatars.session)))
	mux.Handle("GET /api/avatar-session", h.avatarOrigin(http.HandlerFunc(h.avatars.session)))
	mux.HandleFunc("GET /api/avatars/{id}", h.avatars.image)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("{\"status\":\"ok\"}\n"))
	})
	mux.HandleFunc("GET /api/world", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(worldJSON)
	})
	if frontend != nil {
		mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api" || strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/ws" || strings.HasPrefix(r.URL.Path, "/ws/") {
				http.NotFound(w, r)
				return
			}
			frontend.ServeHTTP(w, r)
		}))
	}
	return mux
}

func main() {
	var office world
	if err := json.Unmarshal(worldJSON, &office); err != nil {
		log.Fatalf("read embedded office: %v", err)
	}
	if _, onGrid := office.gridPoint(office.Spawn); !finite(office.Width) || !finite(office.Height) || office.Width <= 0 || office.Height <= 0 || !onGrid || !office.canMove(office.Spawn, office.Spawn) {
		log.Fatal("invalid office grid, geometry, or spawn point")
	}
	origins, err := allowedOrigins(os.Getenv("ALLOWED_ORIGINS"), os.Getenv("RAILWAY_PUBLIC_DOMAIN"))
	if err != nil {
		log.Fatal(err)
	}
	var frontend *frontendHandler
	if directory := os.Getenv("STATIC_DIR"); directory != "" {
		frontend, err = newFrontendHandler(directory)
		if err != nil {
			log.Fatal(err)
		}
		defer frontend.root.Close()
	}
	store, err := avatarStorageFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	h := newHub(office, origins)
	h.avatars = newAvatarService(store)
	handler := h.handler()
	if frontend != nil {
		handler = h.handlerWithFrontend(frontend)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "6666"
	}
	host := os.Getenv("HOST")
	if host == "" {
		host = "127.0.0.1"
	}
	server := &http.Server{Addr: net.JoinHostPort(host, port), Handler: handler, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		h.close()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("office coordination listening at http://%s (no media relay)", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(fmt.Errorf("listen: %w", err))
	}
}
