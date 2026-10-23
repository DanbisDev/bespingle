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
  scrimbaId?: string;
  carpetId: string;
  from: string;
  name: string;
  text: string;
};

export type ScrimbaGuess = { emojis?: string[]; marks: ('correct' | 'present' | 'absent')[] };
export type ScrimbaPlayer = { id: string; name: string; guesses: ScrimbaGuess[]; done: boolean; won: boolean };
export type ScrimbaState = { type: 'scrimba-state'; expiresAt: number; id: string; carpetId: string; players: ScrimbaPlayer[]; solution?: string[] };

export type ServerMessage =
  | { type: 'welcome'; selfId: string; players: Player[]; serverNow: number }
  | { type: 'state'; players: Player[]; serverNow: number }
  | MoveResult
  | ChatMessage
  | ScrimbaState
  | Signal
  | { type: 'error'; message: string };

export type Send = (message: Record<string, unknown> | Signal) => void;
