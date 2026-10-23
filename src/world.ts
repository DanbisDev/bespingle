import worldData from '../server/world.json';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Carpet extends Rect {
  id: string;
  name: string;
  color: string;
}

export interface Chair {
  id: string;
  x: number;
  y: number;
  facing: 'up' | 'down' | 'left' | 'right';
}

export interface Decoration extends Rect {
  type: string;
  color?: string;
}

export interface Grid {
  size: number;
  originX: number;
  originY: number;
  stepDurationMs: number;
}

export interface Move {
  portal?: 'orange' | 'blue';
  toX: number;
  toY: number;
  facing: string;
  startedAt: number;
  durationMs: number;
}

type Point = { x: number; y: number };

export interface World {
  width: number;
  height: number;
  grid: Grid;
  spawn: { x: number; y: number };
  walls: Rect[];
  carpets: Carpet[];
  chairs: Chair[];
  decorations: Decoration[];
}

export interface Player {
  dance?: { startedAt: number };
  reaction?: { emoji: string; startedAt: number; durationMs: number };
  id: string;
  name: string;
  avatar: number;
  customAvatar?: string;
  x: number;
  y: number;
  facing: string;
  seated: boolean;
  carpetId: string;
  mic: boolean;
  camera: boolean;
  screen?: boolean;
  move?: Move;
  /** At most one step queued behind move, starting exactly when move ends. */
  next?: Move;
}

export const world: World = worldData as World;

export const AVATARS = [
  { name: 'Fern', color: '#71a18a' },
  { name: 'Ember', color: '#d88b63' },
  { name: 'Blue', color: '#78a8c4' },
  { name: 'Plum', color: '#a38ac5' },
  { name: 'Sunny', color: '#d9b768' },
  { name: 'Rose', color: '#c886a0' },
] as const;

export function findCarpet(x: number, y: number): Carpet | undefined {
  return world.carpets.find((carpet) => (
    x >= carpet.x && x < carpet.x + carpet.w &&
    y >= carpet.y && y < carpet.y + carpet.h
  ));
}

/** Tile centers stay anchored to the same invisible grid in both clients and Go. */
export function snapToGrid(x: number, y: number): Point {
  const { size, originX, originY } = world.grid;
  return {
    x: originX + Math.round((x - originX) / size) * size,
    y: originY + Math.round((y - originY) / size) * size,
  };
}

export function sameTile(a: Point, b: Point): boolean {
  const first = snapToGrid(a.x, a.y);
  const second = snapToGrid(b.x, b.y);
  return first.x === second.x && first.y === second.y;
}

/** Seating belongs to an exact chair tile, rather than a radius around its art. */
export function findChair(x: number, y: number): Chair | undefined {
  return world.chairs.find((chair) => Math.abs(x - chair.x) < 1e-6 && Math.abs(y - chair.y) < 1e-6);
}

/** Only walls and office boundaries collide. The feet have an eight-pixel radius. */
export function isBlocked(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 8 || y < 8 || x > world.width - 8 || y > world.height - 8) return true;
  return world.walls.some((wall) => (
    x + 8 > wall.x && x - 8 < wall.x + wall.w &&
    y + 8 > wall.y && y - 8 < wall.y + wall.h
  ));
}

/** Check the complete step so the hidden grid cannot skip a thin wall. */
export function isStepBlocked(from: Point, to: Point): boolean {
  if (isBlocked(from.x, from.y) || isBlocked(to.x, to.y)) return true;
  return world.walls.some((wall) => {
    let enter = -Infinity;
    let leave = Infinity;
    const axes = [
      [from.x, to.x - from.x, wall.x - 8, wall.x + wall.w + 8],
      [from.y, to.y - from.y, wall.y - 8, wall.y + wall.h + 8],
    ];
    for (const [origin, delta, lower, upper] of axes) {
      if (delta === 0) {
        if (origin <= lower || origin >= upper) return false;
        continue;
      }
      const a = (lower - origin) / delta;
      const b = (upper - origin) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
    }
    return enter < leave && leave > 0 && enter < 1;
  });
}

const tileKey = (point: Point) => `${point.x},${point.y}`;

/** Every tile another avatar stands on or has an accepted step across, including sprint strides. */
export function occupiedTiles(players: Player[], exceptId: string): Set<string> {
  const tiles = new Set<string>();
  for (const player of players) {
    if (player.id === exceptId) continue;
    let from = { x: player.x, y: player.y };
    tiles.add(tileKey(from));
    for (const step of [player.move, player.next]) {
      if (!step) break;
      const to = { x: step.toX, y: step.toY };
      const count = Math.round((Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / world.grid.size);
      for (let i = 1; i <= count; i++) {
        tiles.add(tileKey({ x: from.x + (to.x - from.x) * i / count, y: from.y + (to.y - from.y) * i / count }));
      }
      from = to;
    }
  }
  return tiles;
}

// The same stable neighbour order as the server's spawn search.
function neighbours(point: Point): Point[] {
  const { size } = world.grid;
  return [[size, 0], [0, size], [-size, 0], [0, -size]].map(([dx, dy]) => ({ x: point.x + dx, y: point.y + dy }));
}

/** Breadth-first search over free tiles, mapping each reachable tile to the one it is entered from. */
function reachable(from: Point, occupied: Set<string>): Map<string, Point | null> {
  const parents = new Map<string, Point | null>([[tileKey(from), null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    for (const next of neighbours(queue[i])) {
      const key = tileKey(next);
      if (parents.has(key) || occupied.has(key) || isStepBlocked(queue[i], next)) continue;
      parents.set(key, queue[i]);
      queue.push(next);
    }
  }
  return parents;
}

function pathTo(parents: Map<string, Point | null>, to: Point): Point[] {
  const path: Point[] = [];
  for (let tile: Point | null | undefined = to; tile; tile = parents.get(tileKey(tile))) path.unshift(tile);
  return path;
}

/** The shortest walk between two tiles, both ends included, or null when none exists. */
export function findRoute(from: Point, to: Point, occupied: Set<string>): Point[] | null {
  const parents = reachable(from, occupied);
  return parents.has(tileKey(to)) ? pathTo(parents, to) : null;
}

/**
 * The walk toward a pointed-at spot. It ends on the clicked tile when that can
 * be reached, otherwise on the nearest reachable tile found by searching
 * outward from it, so it is only [from] when nothing else can be reached.
 */
export function planWalk(from: Point, target: Point, occupied: Set<string>): Point[] {
  const { size, originX, originY } = world.grid;
  const parents = reachable(from, occupied);
  const maxX = originX + Math.floor((world.width - originX) / size) * size;
  const maxY = originY + Math.floor((world.height - originY) / size) * size;
  const inside = (point: Point) => point.x >= originX && point.x <= maxX && point.y >= originY && point.y <= maxY;
  const snapped = snapToGrid(target.x, target.y);
  const start = { x: Math.max(originX, Math.min(maxX, snapped.x)), y: Math.max(originY, Math.min(maxY, snapped.y)) };
  const seen = new Set([tileKey(start)]);
  const queue = [start];
  for (let i = 0; i < queue.length; i++) {
    if (parents.has(tileKey(queue[i]))) return pathTo(parents, queue[i]);
    for (const next of neighbours(queue[i])) {
      if (!inside(next) || seen.has(tileKey(next))) continue;
      seen.add(tileKey(next));
      queue.push(next);
    }
  }
  return [from];
}
