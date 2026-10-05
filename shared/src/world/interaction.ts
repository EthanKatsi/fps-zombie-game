import type { ContainerSpawn } from './mapData';

const CELL = 8;
/** Car trunks have no box; a look-hit within this radius of the trunk point counts. */
export const TRUNK_RADIUS = 1.4;

/**
 * Spatial index over the map's container spawns. Used by the client to resolve
 * "what am I looking at" from a ray hit point, and by the server to validate that a
 * line-of-sight ray really ends on the container (and not on a wall in front of it).
 */
export class ContainerIndex {
  private readonly grid = new Map<string, ContainerSpawn[]>();

  constructor(readonly spawns: ContainerSpawn[]) {
    for (const c of spawns) {
      const key = `${Math.floor(c.p[0] / CELL)},${Math.floor(c.p[2] / CELL)}`;
      const list = this.grid.get(key) ?? [];
      list.push(c);
      this.grid.set(key, list);
    }
  }

  /** Is a world point on (or within `pad` of) this container's surface/volume? */
  static contains(c: ContainerSpawn, x: number, y: number, z: number, pad = 0.08): boolean {
    if (!c.s) {
      return Math.hypot(x - c.p[0], z - c.p[2]) <= TRUNK_RADIUS && y > c.p[1] - 1.2 && y < c.p[1] + 1.2;
    }
    return (
      Math.abs(x - c.p[0]) <= c.s[0] / 2 + pad &&
      Math.abs(y - c.p[1]) <= c.s[1] / 2 + pad &&
      Math.abs(z - c.p[2]) <= c.s[2] / 2 + pad
    );
  }

  /** Container whose volume contains the point (closest center wins). */
  atPoint(x: number, y: number, z: number): ContainerSpawn | null {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    let best: ContainerSpawn | null = null;
    let bestD = Infinity;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const c of this.grid.get(`${cx + i},${cz + j}`) ?? []) {
          if (!ContainerIndex.contains(c, x, y, z)) continue;
          const d = Math.hypot(x - c.p[0], y - c.p[1], z - c.p[2]);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
      }
    }
    return best;
  }
}
