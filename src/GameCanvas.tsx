import { useEffect, useRef } from 'react';
import { drawAvatar, drawGameWorld } from './art';
import { findCarpet, findChair, snapToGrid, world, type Player } from './world';
import type { CancelMove, Move } from './protocol';

interface GameCanvasProps {
  players: Player[];
  selfId: string;
  onMove: Move;
  onCancelMove: CancelMove;
  onDance: () => void;
  serverNow: () => number;
  disabled?: boolean;
}

type Direction = 'up' | 'down' | 'left' | 'right';
type Position = { x: number; y: number; facing: string };
// startsAt is the server time a queued step begins, or null for one that begins on acceptance.
type PendingStep = { id: string; fromX: number; fromY: number; startsAt: number | null };
type Bounce = { id: string; direction: Direction; startedAt: number };
// A withdrawn queued step stays hidden until the server's answer and the state after it arrive.
type Cancel = { startsAt: number; answer?: { accepted: boolean; players: Player[] } };
type StepSource = 'tap' | 'held';

const directions: Record<string, Direction> = {
  KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right',
  ArrowUp: 'up', ArrowLeft: 'left', ArrowDown: 'down', ArrowRight: 'right',
};
const vectors: Record<Direction, readonly [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// Leave room for floating reactions above avatars at the top edge of the world.
const cameraHeadroom = 140;
const bounceDuration = 190;
// The server accepts a queued step in the second half of the current one. Ask
// a little inside that, so a drifting clock is not refused, and well ahead of a
// round trip, so the accepted step is known before the current one ends.
const stepLead = world.grid.stepDurationMs / 2 - 20;
const retryDelay = 30;

function typingInto(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.getAttribute('role') === 'separator'
  );
}

// Steps move at a constant pace, so a queued step continues its predecessor
// without slowing at the tile boundary between them.
function animatedPosition(player: Player, now: number): Position {
  if (player.move?.portal) {
    const progress = portalProgress(player, now);
    return { x: progress < .5 ? player.x : player.move.toX,
      y: progress < .5 ? player.y : player.move.toY, facing: player.facing };
  }
  let x = player.x;
  let y = player.y;
  let facing = player.facing;
  for (const step of [player.move, player.next]) {
    if (!step) break;
    const progress = Math.min(1, (now - step.startedAt) / step.durationMs);
    if (progress <= 0) break;
    facing = step.facing || facing;
    if (progress < 1) return { x: x + (step.toX - x) * progress, y: y + (step.toY - y) * progress, facing };
    x = step.toX;
    y = step.toY;
  }
  return { x, y, facing };
}

/** The tile a player's accepted steps end on. */
function tail(player: Player) {
  const last = player.next ?? player.move;
  return last ? { x: last.toX, y: last.toY } : { x: player.x, y: player.y };
}

function portalProgress(player: Player, now: number): number {
  return player.move ? Math.max(0, Math.min(1, (now - player.move.startedAt) / player.move.durationMs)) : 1;
}

function drawPortal(ctx: CanvasRenderingContext2D, x: number, y: number, color: 'orange' | 'blue', progress: number) {
  const opening = Math.min(1, progress / .18, (1 - progress) / .15);
  if (opening <= 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(opening, opening);
  ctx.shadowColor = color === 'orange' ? '#ff8b24' : '#36b9ff';
  ctx.shadowBlur = 15;
  ctx.fillStyle = '#090d20';
  ctx.strokeStyle = ctx.shadowColor;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(0, 0, 21, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = color === 'orange' ? '#ffe1a0' : '#c4f4ff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(0, 0, 17, 5, 0, progress * Math.PI * 8, progress * Math.PI * 8 + Math.PI * 1.3);
  ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const angle = progress * Math.PI * 4 + i * Math.PI * 2 / 7;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fillRect(Math.cos(angle) * 24 - 1, Math.sin(angle) * 10 - 2, 2, 2);
  }
  ctx.restore();
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

function reactionBubble(ctx: CanvasRenderingContext2D, player: Player, x: number, y: number, now: number) {
  const reaction = player.reaction;
  if (!reaction) return;
  const age = now - reaction.startedAt;
  if (age < 0 || age >= reaction.durationMs) return;
  const progress = age / reaction.durationMs;
  const center = Math.max(28, Math.min(world.width - 28, x));
  const top = y - 138 - progress * 18;
  const scale = Math.min(1, age / 140) * (1 + Math.sin(Math.min(1, age / 280) * Math.PI) * .12);
  ctx.save();
  ctx.globalAlpha = Math.min(1, (reaction.durationMs - age) / 500);
  ctx.translate(center, top + 23);
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff7e9';
  ctx.strokeStyle = '#66776c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(-25, -23, 50, 46, 12);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-5, 22);
  ctx.lineTo(0, 29);
  ctx.lineTo(6, 22);
  ctx.fill();
  ctx.stroke();
  ctx.font = '28px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(reaction.emoji, 0, 1);
  ctx.restore();
}

export function GameCanvas({ players, selfId, onMove, onCancelMove, onDance, serverNow, disabled = false }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const playersRef = useRef(players);
  const selfIdRef = useRef(selfId);
  const onMoveRef = useRef(onMove);
  const onCancelMoveRef = useRef(onCancelMove);
  const onDanceRef = useRef(onDance);
  const serverNowRef = useRef(serverNow);
  const disabledRef = useRef(disabled);
  const keysRef = useRef(new Set<string>());
  const queuedDirectionRef = useRef<Direction | null>(null);
  const pendingRef = useRef<PendingStep | null>(null);
  // Server start time of a queued step asked for by a held key. Releasing the
  // key before it starts withdraws it, so the avatar stops on the current tile.
  const heldStepRef = useRef<number | null>(null);
  const cancelRef = useRef<Cancel | null>(null);
  const retryAtRef = useRef(0);
  const bounceRef = useRef<Bounce | null>(null);
  const bounceCountRef = useRef(0);
  const ownFacingRef = useRef('down');

  playersRef.current = players;
  selfIdRef.current = selfId;
  onMoveRef.current = onMove;
  onCancelMoveRef.current = onCancelMove;
  onDanceRef.current = onDance;
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
    heldStepRef.current = null;
    cancelRef.current = null;
    retryAtRef.current = 0;
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
    // The camera the last frame was drawn with, for mapping the pointer onto the world.
    const camera = { x: 0, y: 0, zoom: 1 };
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
      if ((event.code === 'ShiftLeft' || event.code === 'ShiftRight') && !disabledRef.current && !typingInto(event.target)) {
        keysRef.current.add(event.code);
        return;
      }
      if (event.code === 'KeyZ' && !disabledRef.current && !typingInto(event.target) && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        if (!event.repeat && !keysRef.current.has(event.code)) onDanceRef.current();
        keysRef.current.add(event.code);
        return;
      }
      const direction = directions[event.code];
      if (!direction || disabledRef.current || typingInto(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      if (keysRef.current.has(event.code)) return;
      keysRef.current.add(event.code);
      // Keep a quick tap until the next frame; browser key repeat never queues extra steps.
      queuedDirectionRef.current = direction;
    }

    function onKeyUp(event: KeyboardEvent) {
      keysRef.current.delete(event.code);
    }

    function onVisibilityChange() {
      if (document.hidden) clearKeys();
    }

    // Ask for one step in a direction from the tile the player's accepted
    // steps end on. While a step is in flight this queues the next one to
    // start exactly when it ends; a held key repeats this every step.
    function requestStep(player: Player, direction: Direction, sprint: boolean, source: StepSource) {
      const [dx, dy] = vectors[direction];
      const from = tail(player);
      const to = { x: from.x + dx * world.grid.size, y: from.y + dy * world.grid.size };
      const end = player.move ? player.move.startedAt + player.move.durationMs : 0;
      const pending = { id: player.id, fromX: from.x, fromY: from.y, startsAt: end > serverNowRef.current() ? end : null };
      pendingRef.current = pending;
      heldStepRef.current = source === 'held' && pending.startsAt !== null ? pending.startsAt : null;
      ownFacingRef.current = direction;
      // Animate only an accepted step. Two simultaneous claims cannot visually pass through each other.
      void onMoveRef.current(to.x, to.y, direction, sprint).then((result) => {
        if (!active || pendingRef.current !== pending || selfIdRef.current !== pending.id) return;
        if (!result.accepted) {
          pendingRef.current = null;
          if (heldStepRef.current === pending.startsAt) heldStepRef.current = null;
          if (result.reason === 'occupied' || result.reason === 'wall') {
            // A refused queued step bounces once the current step lands.
            const wait = pending.startsAt === null ? 0 : Math.max(0, pending.startsAt - serverNowRef.current());
            bounceRef.current = { id: player.id, direction, startedAt: performance.now() + wait };
            bounceCountRef.current++;
          } else {
            retryAtRef.current = performance.now() + retryDelay;
          }
        }
      });
    }

    function onDoubleClick(event: MouseEvent) {
      if (!canvas || disabledRef.current) return;
      const self = playersRef.current.find((player) => player.id === selfIdRef.current);
      if (!self || self.move || self.next || pendingRef.current || cancelRef.current) return;
      event.preventDefault();
      const bounds = canvas.getBoundingClientRect();
      const target = snapToGrid(
        (event.clientX - bounds.left - camera.x) / camera.zoom,
        (event.clientY - bounds.top - camera.y) / camera.zoom,
      );
      if (target.x === self.x && target.y === self.y) return;
      clearKeys();
      bounceRef.current = null;
      const pending = { id: self.id, fromX: self.x, fromY: self.y, startsAt: null };
      pendingRef.current = pending;
      void onMoveRef.current(target.x, target.y, self.facing, false, true).then((result) => {
        if (active && pendingRef.current === pending && !result.accepted) pendingRef.current = null;
      });
    }

    function cancelHeldStep(startsAt: number) {
      const cancel: Cancel = { startsAt };
      cancelRef.current = cancel;
      heldStepRef.current = null;
      pendingRef.current = null;
      void onCancelMoveRef.current().then((result) => {
        if (cancelRef.current === cancel) cancel.answer = { accepted: result.accepted, players: playersRef.current };
      });
    }

    // Hide a queued step being withdrawn, so it never starts on this screen.
    function withoutCancelled(player: Player): Player {
      const cancel = cancelRef.current;
      return cancel && player.next?.startedAt === cancel.startsAt ? { ...player, next: undefined } : player;
    }

    function render(now: number) {
      if (!canvas || !ctx) return;
      const time = serverNowRef.current();
      const reported = playersRef.current.find((player) => player.id === selfIdRef.current);
      const heldKeys = [...keysRef.current].filter((key) => directions[key]);
      const heldStep = heldStepRef.current;
      if (heldStep !== null && time >= heldStep) heldStepRef.current = null;
      else if (heldStep !== null && (!heldKeys.length || disabledRef.current)) cancelHeldStep(heldStep);
      const cancel = cancelRef.current;
      if (cancel?.answer && reported && (!cancel.answer.accepted || playersRef.current !== cancel.answer.players) && reported.next?.startedAt !== cancel.startsAt) {
        cancelRef.current = null;
      }
      const self = reported && withoutCancelled(reported);
      const pending = pendingRef.current;
      if (pending && self) {
        const end = tail(self);
        if (end.x !== pending.fromX || end.y !== pending.fromY) pendingRef.current = null;
      }
      if (bounceRef.current && (bounceRef.current.id !== self?.id || now - bounceRef.current.startedAt >= bounceDuration)) bounceRef.current = null;
      if (self && !disabledRef.current && !pendingRef.current && !bounceRef.current && !cancelRef.current && now >= retryAtRef.current && !self.next && !self.move?.portal &&
        (!self.move || time >= self.move.startedAt + self.move.durationMs - stepLead)) {
        const held = heldKeys.length ? directions[heldKeys[heldKeys.length - 1]] : null;
        const tapped = queuedDirectionRef.current;
        const direction = tapped ?? held;
        if (direction) {
          queuedDirectionRef.current = null;
          const sprint = (keysRef.current.has('ShiftLeft') || keysRef.current.has('ShiftRight'));
          requestStep(self, direction, sprint, tapped ? 'tap' : 'held');
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
      camera.x = cameraX;
      camera.y = cameraY;
      camera.zoom = zoom;
      canvas.dataset.zoom = zoom.toFixed(4);
      canvas.dataset.cameraX = cameraX.toFixed(2);
      canvas.dataset.cameraY = cameraY.toFixed(2);
      canvas.dataset.bounceCount = String(bounceCountRef.current);
      canvas.dataset.bouncing = String(Boolean(bounceRef.current));
      canvas.dataset.moving = String(Boolean(self?.move));
      canvas.dataset.portaling = String(Boolean(self?.move?.portal));
      canvas.dataset.dancing = String(Boolean(self?.dance));

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

      // The initiator owns the pair; a swapping partner uses the same two rings.
      for (const player of playersRef.current) {
        const move = player.move;
        if (!move?.portal) continue;
        if (move.portal === 'blue' && playersRef.current.some((peer) => peer.move?.portal === 'orange' &&
          peer.move.startedAt === move.startedAt && peer.x === move.toX && peer.y === move.toY)) continue;
        const progress = portalProgress(player, time);
        drawPortal(ctx, player.x, player.y, move.portal, progress);
        drawPortal(ctx, move.toX, move.toY, move.portal === 'orange' ? 'blue' : 'orange', progress);
      }

      const peers: Record<string, [number, number]> = {};
      const positioned = playersRef.current.map((player) => {
        if (player.id === selfIdRef.current) player = withoutCancelled(player);
        const position = animatedPosition(player, time);
        if (player.id !== selfIdRef.current) peers[player.id] = [Number(position.x.toFixed(2)), Number(position.y.toFixed(2))];
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
      canvas.dataset.peers = JSON.stringify(peers);

      for (const { player, position } of positioned) {
        const isSelf = player.id === selfIdRef.current;
        const portaling = Boolean(player.move?.portal);
        const progress = portalProgress(player, time);
        const walking = Boolean(player.move) && !portaling;
        const seat = !player.move ? findChair(player.x, player.y) : undefined;
        const dancing = !player.move && Boolean(player.dance);
        const seated = !player.move && !dancing && player.seated && Boolean(seat);
        ctx.save();
        if (portaling) {
          // Clip at floor level: feet disappear first while falling, head first on exit.
          ctx.beginPath();
          ctx.rect(position.x - 70, position.y - 180, 140, 182);
          ctx.clip();
          const fall = progress < .2 ? 0 : progress < .5 ? (progress - .2) / .3
            : progress < .85 ? 1 - (progress - .5) / .35 : 0;
          ctx.translate(position.x, position.y + fall * 85);
          ctx.scale(1 - fall * .25, 1);
          ctx.translate(-position.x, -position.y);
        }
        if (isSelf && !portaling) {
          ctx.fillStyle = '#ddedb844';
          ctx.fillRect(Math.round(position.x - 12), Math.round(position.y - 3), 24, 5);
          ctx.fillStyle = '#d3e5a9';
          ctx.fillRect(Math.round(position.x - 8), Math.round(position.y + 2), 16, 2);
        }
        drawAvatar(ctx, position.x, position.y, player.avatar, seated && seat ? seat.facing : position.facing, seated, walking ? Math.floor(now / 120) % 2 + 1 : 0, 1, dancing ? Math.floor(Math.max(0, time - player.dance!.startedAt) / 160) % 4 + 1 : 0, player.customAvatar);
        ctx.restore();
        ctx.save();
        if (portaling) ctx.globalAlpha = progress < .5 ? Math.max(0, 1 - progress / .3) : Math.max(0, (progress - .75) / .25);
        nameplate(ctx, player, position.x, position.y, isSelf);
        ctx.restore();
      }
      // Draw bubbles last so nearby avatars cannot obscure them.
      for (const { player, position } of positioned) {
        if (!player.move?.portal) reactionBubble(ctx, player, position.x, position.y, time);
      }
      ctx.restore();
      animation = requestAnimationFrame(render);
    }

    canvas.addEventListener('dblclick', onDoubleClick);
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
      canvas.removeEventListener('dblclick', onDoubleClick);
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
        aria-label="Game area. Double-click a tile to summon orange and blue portals and travel; target another player to swap places. Use W A S D or arrow keys to move one tile at a time; hold a key to keep walking. Hold Shift to sprint up to three tiles per tick. Press Z to dance or stop dancing; walking stops dancing. Scroll to zoom. Occupied tiles make you bounce back. Enter a carpet to join its conversation; leave it to disconnect. Furniture is walk-through. Walls block movement."
        data-testid="game-canvas" data-player-count={players.length}
        onPointerDown={(event) => event.currentTarget.focus({ preventScroll: true })}
        style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', outline: 'none' }}>
        An interactive game area with three conversation carpets. Double-click to travel through portals or swap with another player. Use W A S D or arrow keys to move by tiles, hold Shift to sprint, press Z to dance, and scroll to zoom.
      </canvas>
    </div>
  );
}

export default GameCanvas;
