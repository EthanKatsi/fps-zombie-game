import type { PlayerId, Vec3 } from './common';

export type ZombieType = 'walker' | 'runner' | 'bloater';

export type ZombieAIState = 'idle' | 'wander' | 'investigate' | 'chase' | 'attack' | 'dead';

/** Static per-type stats, defined in config/zombies.ts. */
export interface ZombieTypeDef {
  type: ZombieType;
  health: number;
  walkSpeed: number;
  chaseSpeed: number;
  attackDamage: number;
  attackRange: number;
  attackCooldownMs: number;
  /** Delay between starting the lunge and the hit landing (dodgeable). */
  attackWindupMs: number;
  visionRange: number;
  /** Full cone angle in degrees. */
  visionFov: number;
  hearingMultiplier: number;
  headshotMultiplier: number;
  /** Body size relative to a player (hitboxes + visuals). */
  scale: number;
  /** Relative spawn frequency. */
  spawnWeight: number;
}

/** Server-side zombie entity. Only a subset is sent over the wire (NetZombie). */
export interface Zombie {
  id: number;
  type: ZombieType;
  position: Vec3;
  yaw: number;
  health: number;
  state: ZombieAIState;
  targetPlayerId: PlayerId | null;
  /** Last heard/seen position to investigate. */
  interestPoint: Vec3 | null;
}

/** Animation state sent to clients. */
export const ZombieAnim = {
  idle: 0,
  walk: 1,
  run: 2,
  attack: 3,
  dead: 4,
} as const;
