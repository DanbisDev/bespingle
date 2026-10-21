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
  toX: number;
  toY: number;
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
