import type { PlayerId } from '../types/common';
import type { ContainerKind, Inventory, InventoryOp } from '../types/inventory';
import type { ItemStack } from '../types/item';
import type { MoveInput, MoveState } from '../sim/movement';

/** Bump when the wire format changes; server rejects mismatched clients. */
export const PROTOCOL_VERSION = 3;

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
  /** Fingerprint of the generated map; the client checks its own generation matches. */
  mapHash: string;
  /** Ids of doors that are currently open. */
  openDoors: number[];
  players: PlayerInfo[];
  inventory: Inventory;
}

/** Things a player can use by looking at them and pressing E. */
export type InteractRequest =
  | { kind: 'door'; id: number }
  /** A map container (furniture / car trunk) by its ContainerSpawn id. */
  | { kind: 'container'; id: number }
  | { kind: 'pickup'; id: string };

/** An item lying in the world. */
export interface GroundItemNet {
  id: string;
  defId: string;
  qty: number;
  p: [number, number, number];
  /** Visual yaw only. */
  rot: number;
}

/** A container the player has open. `key` is used as SlotRef.owner in inventory ops. */
export interface ContainerView {
  key: string;
  kind: ContainerKind;
  title: string;
  slots: (ItemStack | null)[];
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
  doorChanged: (msg: { id: number; open: boolean }) => void;
  /** Full inventory after any change (it's small). */
  inventory: (inv: Inventory) => void;
  containerOpened: (c: ContainerView) => void;
  containerUpdate: (msg: { key: string; slots: (ItemStack | null)[] }) => void;
  containerClosed: (msg: { key: string }) => void;
  /** Interest-managed ground items entering / leaving the player's range. */
  groundItems: (msg: { add: GroundItemNet[]; remove: string[] }) => void;
  /** Short feedback message ("Too heavy", "Inventory full"). */
  notice: (msg: { text: string }) => void;
}

export interface ClientToServerEvents {
  join: (msg: JoinRequest) => void;
  /** Inputs are batched; normally one per tick. */
  input: (inputs: MoveInput[]) => void;
  clockPing: (clientTime: number) => void;
  interact: (req: InteractRequest) => void;
  invOp: (op: InventoryOp) => void;
  closeContainer: () => void;
}
