import type { Vec3 } from '@grey/shared';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  crouch: boolean;
}

/**
 * Recent positions of an entity on the server clock, for lag compensation: "where was this
 * target at time t?" (linearly interpolated, clamped to the recorded range).
 */
export class PositionHistory {
  private readonly buf: Sample[] = [];

  constructor(private readonly keepMs: number) {}

  push(t: number, pos: Vec3, crouch = false): void {
    this.buf.push({ t, x: pos.x, y: pos.y, z: pos.z, crouch });
    const cutoff = t - this.keepMs;
    let drop = 0;
    while (drop < this.buf.length - 2 && this.buf[drop].t < cutoff) drop++;
    if (drop) this.buf.splice(0, drop);
  }

  /** Teleports (respawn, admin) shouldn't be interpolated across. */
  clear(): void {
    this.buf.length = 0;
  }

  sample(t: number): { pos: Vec3; crouch: boolean } | null {
    const b = this.buf;
    if (!b.length) return null;
    if (t <= b[0].t) return { pos: { x: b[0].x, y: b[0].y, z: b[0].z }, crouch: b[0].crouch };
    const last = b[b.length - 1];
    if (t >= last.t) return { pos: { x: last.x, y: last.y, z: last.z }, crouch: last.crouch };
    // Newest-first scan: rewinds are short, so the bracket is near the end.
    let i = b.length - 2;
    while (i > 0 && b[i].t > t) i--;
    const a = b[i], c = b[i + 1];
    const k = (t - a.t) / Math.max(1e-6, c.t - a.t);
    return {
      pos: { x: a.x + (c.x - a.x) * k, y: a.y + (c.y - a.y) * k, z: a.z + (c.z - a.z) * k },
      crouch: k < 0.5 ? a.crouch : c.crouch,
    };
  }
}
