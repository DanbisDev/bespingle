import type { Player } from './world';

export type Signal = {
  type: 'signal';
  from?: string;
  to: string;
  sessionId: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
};

export type MoveResult = {
  type: 'move-result';
  requestId: number;
  accepted: boolean;
  reason?: 'occupied' | 'wall' | 'busy' | 'invalid' | 'disconnected' | 'timeout';
};

export type Move = (x: number, y: number, facing: string, sprint?: boolean, portal?: boolean) => Promise<MoveResult>;
/** Withdraws a queued step that has not started; accepted reports whether one was withdrawn. */
export type CancelMove = () => Promise<MoveResult>;

export type ChatMessage = {
  type: 'chat';
  carpetId: string;
  from: string;
  name: string;
  text: string;
};

/**
 * x, y and facing ask for a tile, all three or none. The server places the
 * person there only if it is free; otherwise it searches from it, or places
 * them as a fresh join when the request is unusable.
 */
export type Join = {
  type: 'join';
  name: string;
  avatar: number;
  customAvatar?: string;
  x?: number;
  y?: number;
  facing?: 'up' | 'down' | 'left' | 'right';
};

export type ServerMessage =
  /** build is absent when the server is not serving a built frontend; compare it with pageBuild(). */
  | { type: 'welcome'; selfId: string; build?: string; players: Player[]; serverNow: number }
  | { type: 'state'; players: Player[]; serverNow: number }
  | MoveResult
  | ChatMessage
  | Signal
  | { type: 'error'; message: string };

export type Send = (message: Record<string, unknown> | Signal) => void;
