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
  visionRange: number;
  /** Full cone angle in degrees. */
  visionFov: number;
  hearingMultiplier: number;
  headshotMultiplier: number;
}

/** Server-side zombie entity. Only a subset is sent over the wire (NetZombie). */
export interface Zombie {
  id: string;
  type: ZombieType;
  position: Vec3;
  yaw: number;
  health: number;
  state: ZombieAIState;
  targetPlayerId: PlayerId | null;
  /** Last heard/seen position to investigate. */
  interestPoint: Vec3 | null;
  path: Vec3[];
}
