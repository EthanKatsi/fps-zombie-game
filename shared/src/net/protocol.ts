import type { PlayerId } from '../types/common';
import type { MoveInput, MoveState } from '../sim/movement';

/** Bump when the wire format changes; server rejects mismatched clients. */
export const PROTOCOL_VERSION = 1;

// ---------- Client -> Server ----------

export interface JoinRequest {
  protocol: number;
  username: string;
  /** Reserved for real auth later (JWT / session token). Ignored by the guest provider. */
  token?: string;
}

/** Compact player summary for other clients. Positions are feet position. */
export interface NetPlayer {
  id: PlayerId;
  p: [number, number, number];
  yaw: number;
  pitch: number;
  /** Bit flags, see PlayerFlags. */
  f: number;
}

export const PlayerFlags = {
  crouching: 1,
  grounded: 2,
  sprinting: 4,
} as const;

export interface JoinAccepted {
  playerId: PlayerId;
  username: string;
  tick: number;
  serverTime: number;
  state: MoveState;
  /** Map identity so client builds the same collision world as the server. */
  mapId: string;
  mapSeed: number;
  players: PlayerInfo[];
}

export interface PlayerInfo {
  id: PlayerId;
  username: string;
}

export interface Snapshot {
  tick: number;
  serverTime: number;
  /** Highest input seq the server has applied for the receiving player. */
  ack: number;
  you: MoveState;
  players: NetPlayer[];
}

export interface ServerToClientEvents {
  joinAccepted: (msg: JoinAccepted) => void;
  joinRejected: (msg: { reason: string }) => void;
  snapshot: (msg: Snapshot) => void;
  playerJoined: (msg: PlayerInfo) => void;
  playerLeft: (msg: { id: PlayerId }) => void;
  clockPong: (clientTime: number, serverTime: number) => void;
}

export interface ClientToServerEvents {
  join: (msg: JoinRequest) => void;
  /** Inputs are batched; normally one per tick. */
  input: (inputs: MoveInput[]) => void;
  clockPing: (clientTime: number) => void;
}
