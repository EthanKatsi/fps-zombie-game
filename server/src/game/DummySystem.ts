import { COMBAT, humanoidHitboxes, type DummySpawn, type Hitboxes } from '@grey/shared';
import type { GameIO } from './types';

/** Shooting-range training dummies: take damage, fall over, get back up. */
export class DummySystem {
  private readonly health: number[];
  private readonly upAt: number[];
  private readonly boxes: Hitboxes[];

  constructor(
    readonly spawns: DummySpawn[],
    private readonly io: GameIO,
  ) {
    this.health = spawns.map(() => COMBAT.dummyHealth);
    this.upAt = spawns.map(() => 0);
    this.boxes = spawns.map((d) => humanoidHitboxes({ x: d.p[0], y: d.p[1], z: d.p[2] }, false));
  }

  isDown(id: number): boolean {
    return this.health[id] <= 0;
  }

  downIds(): number[] {
    return this.spawns.filter((d) => this.isDown(d.id)).map((d) => d.id);
  }

  hitboxes(id: number): Hitboxes {
    return this.boxes[id];
  }

  /** Returns true if this hit knocked the dummy down. */
  damage(id: number, amount: number, now: number): boolean {
    if (this.isDown(id)) return false;
    this.health[id] -= amount;
    if (this.health[id] > 0) return false;
    this.upAt[id] = now + COMBAT.dummyRespawnSec * 1000;
    this.io.emit('dummyState', { id, down: true });
    return true;
  }

  update(now: number): void {
    for (const d of this.spawns) {
      if (this.isDown(d.id) && now >= this.upAt[d.id]) {
        this.health[d.id] = COMBAT.dummyHealth;
        this.io.emit('dummyState', { id: d.id, down: false });
      }
    }
  }
}
