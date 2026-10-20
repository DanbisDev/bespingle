import { useEffect, useRef } from 'react';
import { drawAvatar, drawGameWorld } from './art';
import { findCarpet, findChair, world, type Player } from './world';
import type { Move } from './protocol';

interface GameCanvasProps {
  players: Player[];
  selfId: string;
  onMove: Move;
  serverNow: () => number;
  disabled?: boolean;
}

type Direction = 'up' | 'down' | 'left' | 'right';
type Position = { x: number; y: number; facing: string };
type PendingStep = { id: string; fromX: number; fromY: number; toX: number; toY: number };
type Bounce = { id: string; direction: Direction; startedAt: number };

const directions: Record<string, Direction> = { KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right' };
const vectors: Record<Direction, readonly [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// Tall sprites and their labels may extend above the walkable world.
const cameraHeadroom = 32;
const bounceDuration = 190;

function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}

function animatedPosition(player: Player, now: number): Position {
  if (!player.move) return { x: player.x, y: player.y, facing: player.facing };
  const progress = Math.max(0, Math.min(1, (now - player.move.startedAt) / player.move.durationMs));
  const eased = progress * progress * (3 - 2 * progress);
  return {
    x: player.x + (player.move.toX - player.x) * eased,
    y: player.y + (player.move.toY - player.y) * eased,
    facing: player.facing,
  };
}

function nameplate(ctx: CanvasRenderingContext2D, player: Player, x: number, y: number, self: boolean) {
  const visibleName = player.name.length > 20 ? `${player.name.slice(0, 19)}…` : player.name;
  const label = `${visibleName}${self ? ' · you' : ''}`;
  ctx.font = '600 11px ui-monospace, monospace';
  const statusSpace = player.mic ? 12 : 0;
  const width = Math.ceil(ctx.measureText(label).width) + 14 + statusSpace;
  const left = Math.round(Math.max(4, Math.min(world.width - width - 4, x - width / 2)));
  const top = Math.round(y - 84);
  ctx.fillStyle = self ? '#263c32ed' : '#292d2be0';
  ctx.fillRect(left, top, width, 19);
  ctx.fillStyle = self ? '#a6c8a3' : '#b2b7a4';
  ctx.fillRect(left, top + 18, width, 1);
  ctx.fillStyle = self ? '#e1f0cf' : '#f0e6ce';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, left + 7 + statusSpace, top + 9);
  if (player.mic) {
    // Keep microphone status inside the nameplate, clear of every avatar pose.
    ctx.fillStyle = '#a3cc8d';
    ctx.fillRect(left + 8, top + 7, 3, 5);
    ctx.fillRect(left + 7, top + 8, 5, 3);
  }
}

export function GameCanvas({ players, selfId, onMove, serverNow, disabled = false }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const playersRef = useRef(players);
  const selfIdRef = useRef(selfId);
  const onMoveRef = useRef(onMove);
  const serverNowRef = useRef(serverNow);
  const disabledRef = useRef(disabled);
  const keysRef = useRef(new Set<string>());
  const queuedDirectionRef = useRef<Direction | null>(null);
  const pendingRef = useRef<PendingStep | null>(null);
  const bounceRef = useRef<Bounce | null>(null);
  const bounceCountRef = useRef(0);
  const ownFacingRef = useRef('down');

  playersRef.current = players;
  selfIdRef.current = selfId;
  onMoveRef.current = onMove;
  serverNowRef.current = serverNow;
  disabledRef.current = disabled;

  useEffect(() => {
    if (disabled) {
      keysRef.current.clear();
      queuedDirectionRef.current = null;
    }
  }, [disabled]);

  useEffect(() => {
    keysRef.current.clear();
    queuedDirectionRef.current = null;
    pendingRef.current = null;
    bounceRef.current = null;
    bounceCountRef.current = 0;
    ownFacingRef.current = 'down';
  }, [selfId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (!canvas || !ctx || !viewport) return;

    const background = document.createElement('canvas');
    background.width = world.width;
    background.height = world.height;
    const backgroundContext = background.getContext('2d');
    if (!backgroundContext) return;
    drawGameWorld(backgroundContext);

    let animation = 0;
    let active = true;
    const view = { width: world.width, height: world.height, dpr: 1, zoom: 1, userZoom: false };

    function zoomBounds() {
      const fit = Math.min(view.width / world.width, view.height / (world.height + cameraHeadroom));
      const fill = Math.max(view.width / world.width, view.height / world.height);
      return { min: fit, max: Math.max(4, fill * 3), fill };
    }

    function resize() {
      if (!canvas || !viewport) return;
      const bounds = viewport.getBoundingClientRect();
      view.width = Math.max(1, Math.round(bounds.width));
      view.height = Math.max(1, Math.round(bounds.height));
      view.dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(view.width * view.dpr);
      canvas.height = Math.round(view.height * view.dpr);
      const limits = zoomBounds();
      view.zoom = view.userZoom ? Math.max(limits.min, Math.min(limits.max, view.zoom)) : limits.fill;
    }

    function onWheel(event: WheelEvent) {
      if (disabledRef.current) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.height : 1;
      const delta = Math.max(-600, Math.min(600, event.deltaY * unit));
      const limits = zoomBounds();
      view.zoom = Math.max(limits.min, Math.min(limits.max, view.zoom * Math.exp(-delta * 0.0015)));
      view.userZoom = true;
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();
    viewport.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', resize);

    function clearKeys() {
      keysRef.current.clear();
      queuedDirectionRef.current = null;
    }

    function onKeyDown(event: KeyboardEvent) {
      const direction = directions[event.code];
      if (!direction || disabledRef.current || typingInto(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (keysRef.current.has(event.code)) return;
      keysRef.current.add(event.code);
      // Keep a quick tap until the next frame; browser key repeat never queues extra steps.
      queuedDirectionRef.current = direction;
    }

    function onKeyUp(event: KeyboardEvent) {
      if (directions[event.code]) keysRef.current.delete(event.code);
    }

    function onVisibilityChange() {
      if (document.hidden) clearKeys();
    }

    function requestStep(player: Player, direction: Direction) {
      const [dx, dy] = vectors[direction];
      const pending = {
        id: player.id, fromX: player.x, fromY: player.y,
        toX: player.x + dx * world.grid.size, toY: player.y + dy * world.grid.size,
      };
      pendingRef.current = pending;
      ownFacingRef.current = direction;
      // Animate only an accepted step. Two simultaneous claims cannot visually pass through each other.
      void onMoveRef.current(pending.toX, pending.toY, direction).then((result) => {
        if (!active || pendingRef.current !== pending || selfIdRef.current !== pending.id) return;
        if (!result.accepted) {
          pendingRef.current = null;
          if (result.reason === 'occupied' || result.reason === 'wall') {
            bounceRef.current = { id: player.id, direction, startedAt: performance.now() };
            bounceCountRef.current++;
          }
        }
      });
    }

    function render(now: number) {
      if (!canvas || !ctx) return;
      const time = serverNowRef.current();
      const self = playersRef.current.find((player) => player.id === selfIdRef.current);
      const pending = pendingRef.current;
      if (pending && self && (self.move || self.x !== pending.fromX || self.y !== pending.fromY)) pendingRef.current = null;
      if (bounceRef.current && (bounceRef.current.id !== self?.id || now - bounceRef.current.startedAt >= bounceDuration)) bounceRef.current = null;
      if (self && !disabledRef.current && !self.move && !pendingRef.current && !bounceRef.current) {
        const heldKeys = [...keysRef.current];
        const held = heldKeys.length ? directions[heldKeys[heldKeys.length - 1]] : null;
        const direction = queuedDirectionRef.current ?? held;
        if (direction) {
          queuedDirectionRef.current = null;
          requestStep(self, direction);
        }
      }

      const focus = self ? animatedPosition(self, time) : { x: world.width / 2, y: world.height / 2 + 32 };
      const zoom = view.zoom;
      const scaledWidth = world.width * zoom;
      const scaledHeight = (world.height + cameraHeadroom) * zoom;
      const offsetX = scaledWidth <= view.width ? (view.width - scaledWidth) / 2
        : Math.min(0, Math.max(view.width - scaledWidth, view.width / 2 - focus.x * zoom));
      const offsetY = scaledHeight <= view.height ? (view.height - scaledHeight) / 2 + cameraHeadroom * zoom
        : Math.min(cameraHeadroom * zoom, Math.max(view.height - world.height * zoom, view.height / 2 - (focus.y - 32) * zoom));
      const cameraX = Math.round(offsetX * view.dpr) / view.dpr;
      const cameraY = Math.round(offsetY * view.dpr) / view.dpr;
      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.fillStyle = '#0b1019';
      ctx.fillRect(0, 0, view.width, view.height);
      ctx.save();
      ctx.translate(cameraX, cameraY);
      ctx.scale(zoom, zoom);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(background, 0, 0);
      canvas.dataset.zoom = zoom.toFixed(4);
      canvas.dataset.cameraX = cameraX.toFixed(2);
      canvas.dataset.cameraY = cameraY.toFixed(2);
      canvas.dataset.bounceCount = String(bounceCountRef.current);
      canvas.dataset.bouncing = String(Boolean(bounceRef.current));
      canvas.dataset.moving = String(Boolean(self?.move));

      if (self) {
        canvas.dataset.x = String(self.x);
        canvas.dataset.y = String(self.y);
        canvas.dataset.tileCol = String(Math.round((self.x - world.grid.originX) / world.grid.size));
        canvas.dataset.tileRow = String(Math.round((self.y - world.grid.originY) / world.grid.size));
        canvas.dataset.carpet = self.carpetId;
        canvas.dataset.seated = String(self.seated);
      } else {
        for (const key of ['x', 'y', 'renderX', 'renderY', 'tileCol', 'tileRow', 'carpet', 'seated', 'facing']) delete canvas.dataset[key];
      }

      const currentCarpet = self ? findCarpet(self.x, self.y) : undefined;
      if (currentCarpet) {
        const { x, y, w, h } = currentCarpet;
        ctx.fillStyle = '#dce7ba';
        for (const [cornerX, cornerY, directionX, directionY] of [
          [x - 2, y - 2, 1, 1], [x + w, y - 2, -1, 1],
          [x - 2, y + h, 1, -1], [x + w, y + h, -1, -1],
        ]) {
          ctx.fillRect(cornerX + (directionX < 0 ? -12 : 0), cornerY, 14, 2);
          ctx.fillRect(cornerX, cornerY + (directionY < 0 ? -12 : 0), 2, 14);
        }
      }

      const positioned = playersRef.current.map((player) => {
        const position = animatedPosition(player, time);
        if (player.id === selfIdRef.current) {
          if (!player.move) position.facing = ownFacingRef.current;
          const bounce = bounceRef.current;
          if (bounce) {
            const progress = Math.max(0, Math.min(1, (now - bounce.startedAt) / bounceDuration));
            const distance = Math.sin(progress * Math.PI) * 7;
            const [dx, dy] = vectors[bounce.direction];
            position.x += dx * distance;
            position.y += dy * distance;
          }
          canvas.dataset.renderX = position.x.toFixed(2);
          canvas.dataset.renderY = position.y.toFixed(2);
          canvas.dataset.facing = position.facing;
        }
        return { player, position };
      }).sort((a, b) => a.position.y - b.position.y);

      for (const { player, position } of positioned) {
        const isSelf = player.id === selfIdRef.current;
        const walking = Boolean(player.move);
        const seat = !walking ? findChair(player.x, player.y) : undefined;
        const seated = !walking && player.seated && Boolean(seat);
        if (isSelf) {
          ctx.fillStyle = '#ddedb844';
          ctx.fillRect(Math.round(position.x - 12), Math.round(position.y - 3), 24, 5);
          ctx.fillStyle = '#d3e5a9';
          ctx.fillRect(Math.round(position.x - 8), Math.round(position.y + 2), 16, 2);
        }
        drawAvatar(ctx, position.x, position.y, player.avatar, seated && seat ? seat.facing : position.facing, seated, walking ? Math.floor(now / 120) % 2 + 1 : 0);
        nameplate(ctx, player, position.x, position.y, isSelf);
      }
      ctx.restore();
      animation = requestAnimationFrame(render);
    }

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', clearKeys);
    document.addEventListener('visibilitychange', onVisibilityChange);
    animation = requestAnimationFrame(render);
    return () => {
      active = false;
      cancelAnimationFrame(animation);
      resizeObserver.disconnect();
      viewport.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', clearKeys);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      clearKeys();
    };
  }, []);

  return (
    <div ref={viewportRef} className="game-world" data-testid="game-world" style={{ position: 'absolute', inset: 0, minHeight: 0, overflow: 'hidden' }}>
      <canvas ref={canvasRef} tabIndex={0} role="img"
        aria-label="Game area. Use W A S D to move one tile at a time; hold a key to keep walking. Scroll to zoom. Occupied tiles make you bounce back. Enter a carpet to join its conversation; leave it to disconnect. Furniture is walk-through. Walls block movement."
        data-testid="game-canvas" data-player-count={players.length}
        onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
        style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', outline: 'none' }}>
        An interactive game area with three conversation carpets. Use W A S D to move by tiles and scroll to zoom.
      </canvas>
    </div>
  );
}

export default GameCanvas;
