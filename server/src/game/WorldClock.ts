/**
 * In-game time of day. Milestone 11 adds lighting / the sky on top of this; for now it
 * drives the zombie night multiplier.
 */
export const DAY_NIGHT = {
  /** Real minutes for a full 24h in-game day. */
  cycleMinutes: 48,
  /** In-game hour the server starts at. */
  startHour: 9,
  nightStartsHour: 20,
  nightEndsHour: 6,
} as const;

export class WorldClock {
  private readonly startedAt = performance.now();

  /** Current in-game hour, 0..24. */
  hour(now = performance.now()): number {
    const elapsedMin = (now - this.startedAt) / 60_000;
    return (DAY_NIGHT.startHour + (elapsedMin / DAY_NIGHT.cycleMinutes) * 24) % 24;
  }

  isNight(now = performance.now()): boolean {
    const h = this.hour(now);
    return h >= DAY_NIGHT.nightStartsHour || h < DAY_NIGHT.nightEndsHour;
  }
}
