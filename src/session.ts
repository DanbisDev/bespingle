import type { Join } from './protocol';

type Facing = NonNullable<Join['facing']>;
/** The last tile this browser stood on, as the server placed it. */
export type Tile = { x: number; y: number; facing: Facing };
/**
 * Shared by every tab of this browser and kept across visits. Being in the
 * office is what lets a page load rejoin without the join form. Only the tab
 * holding the office lock writes it; other fields stored alongside are kept.
 */
export type SessionRecord = { inOffice: boolean; tile: Tile | null };

const storageKey = 'bespingle_session';
const facings: readonly string[] = ['up', 'down', 'left', 'right'];

function stored(): Record<string, unknown> {
  try {
    const data = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch { return {}; }
}

export function asTile(value: unknown): Tile | null {
  const tile = value as Partial<Tile> | null;
  if (!tile || !Number.isFinite(tile.x) || !Number.isFinite(tile.y) || !facings.includes(tile.facing as string)) return null;
  return { x: tile.x!, y: tile.y!, facing: tile.facing! };
}

export function readSession(): SessionRecord {
  const data = stored();
  return { inOffice: data.inOffice === true, tile: asTile(data.tile) };
}

export function saveSession(update: Partial<SessionRecord>) {
  try { localStorage.setItem(storageKey, JSON.stringify({ ...stored(), ...update })); } catch { /* Private modes may refuse storage. */ }
}

// One tab per browser holds the office: it alone may rejoin from the record
// and write it. The browser releases a Web Lock when its tab closes, crashes
// or reloads, so a hold never outlives the page. The lock is per page rather
// than per hook, so React's development remount keeps it.
const lockName = 'bespingle-office';
let generation = 0;
let state: 'none' | 'pending' | 'held' = 'none';
let pending: Promise<boolean> = Promise.resolve(false);
let releaseHeld = () => {};
let abortPending = () => {};

export const holdsOffice = () => state === 'held';

/** Takes the office lock, now if free or else once it is (wait). Resolves whether this page holds it. */
export function claimOffice(wait: boolean): Promise<boolean> {
  if (state === 'held') return Promise.resolve(true);
  if (state === 'pending') return pending;
  if (!navigator.locks) {
    state = 'held';
    return Promise.resolve(true);
  }
  const claim = ++generation;
  const controller = new AbortController();
  abortPending = () => controller.abort();
  state = 'pending';
  pending = new Promise<boolean>((resolve) => {
    navigator.locks.request(lockName, wait ? { signal: controller.signal } : { ifAvailable: true }, (lock) => {
      if (!lock || claim !== generation) {
        if (claim === generation) state = 'none';
        resolve(false);
        return;
      }
      state = 'held';
      resolve(true);
      return new Promise<void>((release) => { releaseHeld = release; });
    }).catch(() => {
      if (claim === generation) state = 'none';
      resolve(false);
    });
  });
  return pending;
}

export function releaseOffice() {
  generation++;
  state = 'none';
  abortPending();
  releaseHeld();
  abortPending = releaseHeld = () => {};
}
