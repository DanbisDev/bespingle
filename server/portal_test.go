package main

import (
	"encoding/json"
	"testing"
	"time"
)

func requestPortal(t *testing.T, h *hub, c *client, x, y float64) moveResult {
	t.Helper()
	drain(c)
	if err := h.handle(c, marshal(map[string]any{"type": "move", "requestId": 99, "x": x, "y": y, "portal": true})); err != nil {
		t.Fatal(err)
	}
	for len(c.send) > 0 {
		var result moveResult
		if err := json.Unmarshal(<-c.send, &result); err != nil {
			t.Fatal(err)
		}
		if result.Type == "move-result" {
			return result
		}
	}
	t.Fatal("no portal result")
	return moveResult{}
}

func TestPortalSwapIsSynchronizedAndReserved(t *testing.T) {
	h, clock := testHub(t, testWorld())
	a, b, c := unitClient(t, h, "Alice"), unitClient(t, h, "Bob"), unitClient(t, h, "Charlie")
	from, to := snapshot(h, a), snapshot(h, b)
	if result := requestPortal(t, h, a, to.X, to.Y); !result.Accepted {
		t.Fatal(result)
	}
	pa, pb := snapshot(h, a), snapshot(h, b)
	if pa.Move.Portal != "orange" || pb.Move.Portal != "blue" || pa.Move.StartedAt != pb.Move.StartedAt || pa.Move.DurationMs != pb.Move.DurationMs {
		t.Fatal("swap animations differ", pa.Move, pb.Move)
	}
	if result := requestPortal(t, h, c, from.X, from.Y); result.Accepted {
		t.Fatal("reserved swap source accepted")
	}
	if result := requestPortal(t, h, b, 216, 360); result.Reason != "busy" {
		t.Fatal("swapping partner can move", result)
	}
	advance(h, clock, time.Duration(portalDurationMs-1)*time.Millisecond)
	if snapshot(h, a).X != from.X || snapshot(h, b).X != to.X {
		t.Fatal("swap landed early")
	}
	advance(h, clock, time.Millisecond)
	pa, pb = snapshot(h, a), snapshot(h, b)
	if pa.X != to.X || pa.Y != to.Y || pb.X != from.X || pb.Y != from.Y || pa.Move != nil || pb.Move != nil {
		t.Fatal("swap did not land together", pa, pb)
	}
}

func TestPortalLandingValidationAndMembership(t *testing.T) {
	h, clock := testHub(t, testWorld())
	a := unitClient(t, h, "Alice")
	for _, target := range []point{{X: 312, Y: 72}, {X: -24, Y: 72}, {X: 73, Y: 360}, {X: 72, Y: 360}} {
		if result := requestPortal(t, h, a, target.X, target.Y); result.Accepted {
			t.Fatal("invalid portal accepted", target)
		}
	}
	if result := requestPortal(t, h, a, 120, 216); !result.Accepted {
		t.Fatal(result)
	}
	if snapshot(h, a).CarpetID != "" || snapshot(h, a).Seated {
		t.Fatal("membership changed before landing")
	}
	advance(h, clock, time.Duration(portalDurationMs)*time.Millisecond)
	if p := snapshot(h, a); p.CarpetID != "a" || !p.Seated {
		t.Fatal("portal landing did not update carpet and seat", p)
	}
	// A portal can cross a wall and reserves only its endpoints.
	if result := requestPortal(t, h, a, 408, 216); !result.Accepted {
		t.Fatal(result)
	}
	h.mu.Lock()
	blocked := h.occupiedLocked(point{X: 264, Y: 216}, nil)
	h.mu.Unlock()
	if blocked {
		t.Fatal("portal reserved intervening floor")
	}
	advance(h, clock, time.Duration(portalDurationMs)*time.Millisecond)
	if snapshot(h, a).CarpetID != "b" {
		t.Fatal("portal did not transfer carpet membership")
	}
}

func TestPortalCannotTargetWalkingPlayerOrReservation(t *testing.T) {
	h, _ := testHub(t, testWorld())
	a, b := unitClient(t, h, "Alice"), unitClient(t, h, "Bob")
	if result := requestMove(t, h, b, 1, 168, 360, "right"); !result.Accepted {
		t.Fatal(result)
	}
	for _, x := range []float64{120, 168} {
		if result := requestPortal(t, h, a, x, 360); result.Accepted {
			t.Fatal("portal targeted in-flight tile", x)
		}
	}
}

func TestPortalCanCrossWall(t *testing.T) {
	h, clock := testHub(t, testWorld())
	a := unitClient(t, h, "Alice")
	if result := requestPortal(t, h, a, 264, 72); !result.Accepted {
		t.Fatal(result)
	}
	advance(h, clock, time.Duration(portalDurationMs)*time.Millisecond)
	if h.world.canMove(point{X: 264, Y: 72}, point{X: 360, Y: 72}) {
		t.Fatal("test path must cross a wall")
	}
	if result := requestPortal(t, h, a, 360, 72); !result.Accepted {
		t.Fatal("portal cannot cross a wall", result)
	}
	advance(h, clock, time.Duration(portalDurationMs)*time.Millisecond)
	if p := snapshot(h, a); p.X != 360 || p.Y != 72 {
		t.Fatal("portal did not land across wall", p)
	}
}

func TestPortalCannotReplaceWalkingOrQueueAfterPortal(t *testing.T) {
	t.Run("walking", func(t *testing.T) {
		h, clock := testHub(t, testWorld())
		a := unitClient(t, h, "Alice")
		if result := requestMove(t, h, a, 1, 120, 360, "right"); !result.Accepted {
			t.Fatal(result)
		}
		advance(h, clock, 140*time.Millisecond)
		if result := requestPortal(t, h, a, 408, 216); result.Reason != "busy" {
			t.Fatal("portal replaced in-flight walk", result)
		}
		if result := requestMove(t, h, a, 2, 168, 360, "right"); !result.Accepted {
			t.Fatal(result)
		}
		if result := requestPortal(t, h, a, 408, 216); result.Reason != "busy" {
			t.Fatal("portal replaced queued walk", result)
		}
		advance(h, clock, 340*time.Millisecond)
		if p := snapshot(h, a); p.X != 168 || p.Move != nil || p.Next != nil {
			t.Fatal("walking queue changed", p)
		}
	})
	t.Run("portal", func(t *testing.T) {
		h, clock := testHub(t, testWorld())
		a := unitClient(t, h, "Alice")
		if result := requestPortal(t, h, a, 408, 216); !result.Accepted {
			t.Fatal(result)
		}
		// Even during the final queueing window, portal travel cannot queue a walk
		// or replace itself with a second portal before it lands.
		advance(h, clock, time.Duration(portalDurationMs-100)*time.Millisecond)
		if result := requestMove(t, h, a, 1, 456, 216, "right"); result.Reason != "busy" {
			t.Fatal("walk queued behind portal", result)
		}
		if result := requestPortal(t, h, a, 120, 216); result.Reason != "busy" {
			t.Fatal("portal replaced portal", result)
		}
		advance(h, clock, 100*time.Millisecond)
		if p := snapshot(h, a); p.X != 408 || p.Y != 216 || p.Move != nil || p.Next != nil {
			t.Fatal("portal landing changed", p)
		}
	})
}
