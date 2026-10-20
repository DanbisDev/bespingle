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

export type Move = (x: number, y: number, facing: string) => Promise<MoveResult>;

export type ServerMessage =
  | { type: 'welcome'; selfId: string; players: Player[]; serverNow: number }
  | { type: 'state'; players: Player[]; serverNow: number }
  | MoveResult
  | Signal
  | { type: 'error'; message: string };

export type Send = (message: Record<string, unknown> | Signal) => void;
