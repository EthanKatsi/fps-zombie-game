import type { Vec3 } from '@grey/shared';

export interface NoiseEvent {
  pos: Vec3;
  /** Audible radius (m). */
  radius: number;
  at: number;
}

/**
 * Loud things that happened recently (gunshots, swings). Zombies (milestone 6) query this to
 * investigate sounds; gunshots are heard from far away, melee barely at all.
 */
export class NoiseSystem {
  private events: NoiseEvent[] = [];

  emit(pos: Vec3, radius: number, now: number): void {
    if (radius <= 0) return;
    this.events.push({ pos: { ...pos }, radius, at: now });
  }

  /** Noises emitted since `since` (ms, performance.now clock). */
  since(since: number): NoiseEvent[] {
    return this.events.filter((e) => e.at >= since);
  }

  /** Drop events older than maxAgeMs. */
  prune(now: number, maxAgeMs = 5000): void {
    if (this.events.length && this.events[0].at < now - maxAgeMs) {
      this.events = this.events.filter((e) => e.at >= now - maxAgeMs);
    }
  }
}
