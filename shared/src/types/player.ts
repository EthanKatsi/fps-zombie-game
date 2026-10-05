import type { GroupId, PlayerId, Vec3 } from './common';
import type { Inventory } from './inventory';

/** Survival stats, server-authoritative. Ranges come from config/survival.ts. */
export interface SurvivalStats {
  health: number;
  hunger: number;
  thirst: number;
  stamina: number;
  bleeding: boolean;
}

/** Persisted player record (DB row shape, see server/src/db). */
export interface PlayerRecord {
  id: PlayerId;
  username: string;
  position: Vec3;
  yaw: number;
  stats: SurvivalStats;
  inventory: Inventory;
  groupId: GroupId | null;
  /** Structure id of the bed this player respawns at, if any. */
  spawnBedId: string | null;
  kills: number;
  deaths: number;
  createdAt: number;
  lastSeenAt: number;
}

/** Live, non-persisted player data the server tracks per connection. */
export interface PlayerRuntime {
  id: PlayerId;
  username: string;
  alive: boolean;
  lastInputSeq: number;
  /** For lag compensation: ring buffer of recent positions keyed by server time. */
  history: { t: number; pos: Vec3; crouching: boolean }[];
}
