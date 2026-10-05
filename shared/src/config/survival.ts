/**
 * Survival balance. Stamina is part of the movement simulation (sprint/jump) so it is
 * predicted on the client; hunger/thirst/health are fully server-side (milestone 4).
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
  health: { max: 100 },
  hunger: { max: 100, drainPerMin: 1.2 },
  thirst: { max: 100, drainPerMin: 1.8 },
  /** Carry capacity in kg. */
  maxCarryWeight: 30,
} as const;
