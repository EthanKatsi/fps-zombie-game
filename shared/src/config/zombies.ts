import type { ZombieType, ZombieTypeDef } from '../types/zombie';

/**
 * Zombie balance. Speeds are m/s (players walk 4.2, sprint 7.0).
 * Runners are faster than a walking player but slower than a sprinting one.
 */
export const ZOMBIE_TYPES: Record<ZombieType, ZombieTypeDef> = {
  walker: {
    type: 'walker', health: 80, walkSpeed: 0.8, chaseSpeed: 2.7,
    attackDamage: 12, attackRange: 1.5, attackCooldownMs: 1300, attackWindupMs: 450,
    visionRange: 28, visionFov: 120, hearingMultiplier: 1.0, headshotMultiplier: 2.5,
    scale: 1.0, spawnWeight: 70,
  },
  runner: {
    type: 'runner', health: 55, walkSpeed: 1.2, chaseSpeed: 5.6,
    attackDamage: 9, attackRange: 1.4, attackCooldownMs: 900, attackWindupMs: 300,
    visionRange: 36, visionFov: 140, hearingMultiplier: 1.2, headshotMultiplier: 2.5,
    scale: 0.95, spawnWeight: 20,
  },
  bloater: {
    type: 'bloater', health: 260, walkSpeed: 0.6, chaseSpeed: 1.9,
    attackDamage: 26, attackRange: 1.8, attackCooldownMs: 1800, attackWindupMs: 650,
    visionRange: 20, visionFov: 100, hearingMultiplier: 0.8, headshotMultiplier: 1.6,
    scale: 1.25, spawnWeight: 10,
  },
};

export const ZOMBIE_TYPE_ORDER: ZombieType[] = ['walker', 'runner', 'bloater'];

export const ZOMBIES = {
  /** Hard cap on zombies alive in the world. */
  maxTotal: 180,
  /** Target zombies within `populationRadius` of each player (before density/night multipliers). */
  perPlayer: 22,
  populationRadius: 100,
  /** New zombies appear this far from players (out of immediate sight). */
  spawnMinDist: 35,
  spawnMaxDist: 85,
  /** Seconds between spawn attempts per player. */
  spawnIntervalSec: 1.2,
  /** Zombies with no player within this distance for `despawnAfterSec` are removed. */
  despawnDist: 140,
  despawnAfterSec: 20,
  /** Multiplier on the population target at night (day/night cycle). */
  nightMultiplier: 1.8,
  /** Each nearby apartment/shop adds this much density; houses half of it. Clamped to [min,max]. */
  densityPerBuilding: 0.12,
  densityMin: 0.6,
  densityMax: 1.8,

  /** AI decision rate. */
  thinkIntervalMs: 250,
  /** Players this close are noticed even from behind. */
  proximitySense: 3,
  /** Vision range multiplier when the player is crouching. */
  crouchVisionMultiplier: 0.6,
  /** Give up the chase after not seeing the target for this long (then search the last spot). */
  loseTargetSec: 6,
  investigateSec: 14,
  wanderRadius: 16,
  /** Chance per think to pick a new wander point while idle. */
  wanderChance: 0.04,
  /** Chance a zombie hit makes you bleed. */
  bleedChance: 0.15,
  /** Corpses stay visible this long. */
  corpseSec: 8,
  /** Chance a killed zombie drops something (loot table 'zombie_drop'). */
  dropChance: 0.25,
  /** Zombies are sent to clients within this radius. */
  interestRadius: 110,
} as const;
