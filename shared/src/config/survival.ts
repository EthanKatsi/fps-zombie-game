/**
 * Survival balance. Stamina is part of the movement simulation (sprint/jump) so it is
 * predicted on the client; health/hunger/thirst/bleeding are fully server-side.
 */
export const SURVIVAL = {
  stamina: {
    max: 100,
    sprintDrainPerSec: 14,
    jumpCost: 12,
    regenPerSec: 20,
    /** Seconds after spending stamina before it starts regenerating. */
    regenDelay: 1.0,
    /** Need at least this much to start sprinting. */
    minToSprint: 10,
  },
  health: {
    max: 100,
    /** Passive regeneration while well fed and watered (and not bleeding). */
    regenPerSec: 0.2,
    regenMinHunger: 70,
    regenMinThirst: 70,
  },
  hunger: {
    max: 100,
    /** Points lost per minute (100 -> 0 in ~80 min). */
    drainPerMin: 1.25,
    sprintMultiplier: 1.6,
    /** Damage per second while starving (hunger at 0). */
    starvingDamagePerSec: 0.5,
  },
  thirst: {
    max: 100,
    /** Points lost per minute (100 -> 0 in ~55 min). */
    drainPerMin: 1.8,
    sprintMultiplier: 2.0,
    /** Damage per second while dehydrated (thirst at 0). */
    dehydratedDamagePerSec: 0.8,
  },
  bleeding: {
    damagePerSec: 0.7,
  },
  fall: {
    /** Landing speed (m/s) that starts hurting. Gravity 22 -> about a 3.8 m drop. */
    minImpactSpeed: 13,
    /** Damage per m/s above the threshold. 6 m drop ~ 30 dmg, 10 m ~ 70, 14 m+ is lethal. */
    damagePerSpeed: 9,
    /** Falls dealing at least this much start bleeding. */
    bleedAtDamage: 25,
  },
  respawn: {
    /** Seconds on the death screen before respawning is allowed. */
    delaySec: 5,
    hunger: 80,
    thirst: 80,
  },
  /** Death bags disappear after this many minutes (or when emptied). */
  lootBagDespawnMin: 30,
} as const;
