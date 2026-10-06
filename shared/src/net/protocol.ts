import type { PlayerId } from '../types/common';
import type { ContainerKind, Inventory, InventoryOp } from '../types/inventory';
import type { ItemStack } from '../types/item';
import type { SurvivalStats } from '../types/player';
import type { MoveInput, MoveState } from '../sim/movement';
import type { VehicleState } from '../sim/vehicle';
import type { VehicleType } from '../config/vehicles';

/** Bump when the wire format changes; server rejects mismatched clients. */
export const PROTOCOL_VERSION = 12;

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
  /** Item def id held in the active hotbar slot ('' = empty hands). */
  h: string;
  /** Times this player has been hurt (mod 256): clients play a flinch when it changes. */
  hc: number;
  /** Seated in a vehicle: vehicleId * 8 + seat (absent when on foot). */
  v?: number;
}

export const PlayerFlags = {
  crouching: 1,
  grounded: 2,
  sprinting: 4,
  /** Wearing a helmet / body armour (drawn on the character). */
  helmet: 8,
  vest: 16,
  /** Sitting in a vehicle (drawn seated; uses crouch hitboxes). */
  seated: 32,
} as const;

/** A drivable vehicle in a snapshot (interpolated by clients). */
export interface NetVehicle {
  id: number;
  /** Index into VEHICLE_TYPE_ORDER. */
  t: number;
  /** Ground point under the centre. */
  p: [number, number, number];
  yaw: number;
  /** Forward speed (m/s) and steering (-1..1): wheel spin and steer angle. */
  s: number;
  st: number;
  /** Health 0..1, and whether it's a burnt-out wreck. */
  hp: number;
  w: boolean;
  /** Fuel 0..1 of a tank. */
  f: number;
  /** Has a driver (engine running). */
  d: boolean;
}

/** The vehicle the receiving player sits in (the driver reconciles its prediction against it). */
export interface DriveInfo {
  id: number;
  type: VehicleType;
  seat: number;
  state: VehicleState;
}

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
  /** Of those, the ones opened the reversed way (swung away from whoever opened them). */
  reversedDoors: number[];
  players: PlayerInfo[];
  inventory: Inventory;
  stats: NetStats;
  /** Per-session salt for deterministic shot spread (see shotSeed). */
  shotSalt: number;
  /** Ids of shooting-range dummies currently knocked down. */
  dummiesDown: number[];
}

/** Attack with whatever is in the active hotbar slot (fists if nothing usable). */
export interface AttackRequest {
  /** Strictly increasing by 1 per attack; seeds the spread. */
  seq: number;
  /**
   * Seq of the last movement input sent before this attack. The server applies the attack
   * right after that input, so it fires from exactly where the shooter's screen was.
   */
  afterSeq: number;
  /**
   * Server time the shooter was seeing other entities at (their interpolated view).
   * Used for lag compensation: targets are rewound to this moment.
   */
  viewTime: number;
  /** Camera forward at the moment of the shot (unit vector). */
  dir: [number, number, number];
  /** Aiming down sights. */
  aim: boolean;
}

export type HitKind = 'player' | 'dummy' | 'zombie';

/** Where a pellet / swing ended: 0 = nothing, 1 = world, 2 = flesh. */
export type ShotEnd = [number, number, number, 0 | 1 | 2];

/** Visual/audio broadcast of someone else's attack. */
export interface ShotEvent {
  shooter: PlayerId;
  weapon: string;
  /** Muzzle / swing origin. */
  o: [number, number, number];
  ends: ShotEnd[];
}

/** Survival stats as sent to the owning client (stamina travels in MoveState instead). */
export type NetStats = Omit<SurvivalStats, 'stamina'>;

export type DeathCause = 'starvation' | 'dehydration' | 'bleeding' | 'fall' | 'player' | 'zombie' | 'unknown';

export interface DeathInfo {
  cause: DeathCause;
  /** Killer's name for PvP deaths. */
  killer: string | null;
  /** Weapon id the killer used (PvP). */
  weapon?: string;
  headshot?: boolean;
  /** Distance to the killer in metres (PvP). */
  distance?: number;
  /** Milliseconds until the respawn button unlocks. */
  respawnInMs: number;
}

/** Broadcast to everyone when a player dies. */
export interface KillFeedEntry {
  victim: string;
  killer: string | null;
  cause: DeathCause;
  weapon?: string;
  headshot?: boolean;
}

/** Things a player can use by looking at them and pressing E. */
export type InteractRequest =
  | { kind: 'door'; id: number }
  /** A map container (furniture / car trunk) by its ContainerSpawn id. */
  | { kind: 'container'; id: number }
  | { kind: 'pickup'; id: string }
  /** Get into a vehicle (driver seat if free), or out of the one you're in. */
  | { kind: 'vehicle'; id: number }
  | { kind: 'exitVehicle' }
  /** Pour the gas can in your hand into a vehicle. */
  | { kind: 'refuel'; id: number }
  /** Fill the gas can in your hand at a gas station pump (MapData.fuelPumps index). */
  | { kind: 'pump'; id: number };

/** An item lying in the world. */
export interface GroundItemNet {
  id: string;
  /** Item definition id, or 'loot_bag' for a death bag (a container you search). */
  defId: string;
  /** Death bags only: "<name>'s bag". */
  title?: string;
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

/** Compact zombie for clients (interest-managed). */
export interface NetZombie {
  id: number;
  /** Index into ZOMBIE_TYPE_ORDER. */
  t: number;
  p: [number, number, number];
  yaw: number;
  /** ZombieAnim value. */
  s: number;
  /** Times this zombie has been hit (mod 256): clients play a flinch when it changes. */
  hc: number;
}

export interface Snapshot {
  tick: number;
  serverTime: number;
  /** Highest input seq the server has applied for the receiving player. */
  ack: number;
  you: MoveState;
  /** Set while you are in a vehicle. */
  drive: DriveInfo | null;
  players: NetPlayer[];
  zombies: NetZombie[];
  vehicles: NetVehicle[];
}

export interface ServerToClientEvents {
  joinAccepted: (msg: JoinAccepted) => void;
  joinRejected: (msg: { reason: string }) => void;
  snapshot: (msg: Snapshot) => void;
  playerJoined: (msg: PlayerInfo) => void;
  playerLeft: (msg: { id: PlayerId }) => void;
  clockPong: (clientTime: number, serverTime: number) => void;
  doorChanged: (msg: { id: number; open: boolean; dir: 1 | -1 }) => void;
  /** Full inventory after any change (it's small). */
  inventory: (inv: Inventory) => void;
  containerOpened: (c: ContainerView) => void;
  containerUpdate: (msg: { key: string; slots: (ItemStack | null)[] }) => void;
  containerClosed: (msg: { key: string }) => void;
  /** Interest-managed ground items entering / leaving the player's range. */
  groundItems: (msg: { add: GroundItemNet[]; remove: string[] }) => void;
  /** Short feedback message ("Too heavy", "Inventory full"). */
  notice: (msg: { text: string }) => void;
  /** Own survival stats, sent when they change. */
  stats: (s: NetStats) => void;
  /** `from` = attacker position, for the damage direction indicator. */
  damaged: (msg: { amount: number; cause: DeathCause; from?: [number, number, number] }) => void;
  died: (info: DeathInfo) => void;
  respawned: (msg: { state: MoveState; inventory: Inventory; stats: NetStats }) => void;
  /** Eating / bandaging etc. in progress. */
  useStarted: (msg: { defId: string; durationMs: number }) => void;
  useEnded: (msg: { completed: boolean }) => void;
  /** Your attack hit something. */
  hitConfirm: (msg: { kind: HitKind; head: boolean; kill: boolean }) => void;
  /** Ammo / condition of a weapon after firing (cheaper than a full inventory). */
  weaponState: (msg: { uid: string; loaded: number; durability?: number }) => void;
  reloadStarted: (msg: { durationMs: number }) => void;
  reloadEnded: (msg: { completed: boolean }) => void;
  shotFired: (e: ShotEvent) => void;
  projectile: (msg: { id: string; owner: PlayerId; p: [number, number, number]; v: [number, number, number] }) => void;
  projectileEnd: (msg: { id: string; p: [number, number, number]; hit: 0 | 1 | 2 }) => void;
  dummyState: (msg: { id: number; down: boolean }) => void;
  killFeed: (e: KillFeedEntry) => void;
}

export interface ClientToServerEvents {
  join: (msg: JoinRequest) => void;
  /** Inputs are batched; normally one per tick. */
  input: (inputs: MoveInput[]) => void;
  clockPing: (clientTime: number) => void;
  interact: (req: InteractRequest) => void;
  invOp: (op: InventoryOp) => void;
  closeContainer: () => void;
  respawn: () => void;
  cancelUse: () => void;
  attack: (req: AttackRequest) => void;
  reload: () => void;
}
