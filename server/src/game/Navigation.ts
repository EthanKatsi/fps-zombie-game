import fs from 'node:fs';
import path from 'node:path';
import { Crowd, NavMesh, NavMeshQuery, exportNavMesh, importNavMesh, init as initRecast } from 'recast-navigation';
import { generateTiledNavMesh } from '@recast-navigation/generators';
import { quatFromEulerYXZ, hashMap, type MapData, type Vec3 } from '@grey/shared';

/** Bump when the navmesh build settings change, to invalidate disk caches. */
const NAV_VERSION = 3;

const NAV_CONFIG = {
  cs: 0.2,
  ch: 0.1,
  walkableSlopeAngle: 50,
  walkableHeight: 18, // 1.8 m
  walkableClimb: 4, // 0.4 m
  walkableRadius: 2, // 0.4 m from walls
  tileSize: 64,
  maxSimplificationError: 1.3,
  maxVertsPerPoly: 6,
  detailSampleDist: 6,
  detailSampleMaxError: 1,
  maxEdgeLen: 60,
  minRegionArea: 8,
  mergeRegionArea: 20,
};

let recastReady: Promise<void> | null = null;
export const initNavigation = (): Promise<void> => (recastReady ??= initRecast());

// Box corners and outward-facing (CCW from outside) triangles.
const FACES = [[0, 1, 2], [0, 2, 3], [4, 6, 5], [4, 7, 6], [0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0]];

/** Triangle soup of every collidable map box (rotations applied). */
const triangulate = (map: MapData): { positions: number[]; indices: number[] } => {
  const positions: number[] = [];
  const indices: number[] = [];
  let n = 0;
  for (const b of map.boxes) {
    if (b.col === false) continue;
    const hx = b.s[0] / 2, hy = b.s[1] / 2, hz = b.s[2] / 2;
    const q = b.r ? quatFromEulerYXZ(b.r[0], b.r[1], b.r[2]) : null;
    for (const [x, y, z] of [[-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], [-hx, hy, -hz], [hx, hy, -hz], [hx, hy, hz], [-hx, hy, hz]]) {
      let rx = x, ry = y, rz = z;
      if (q) {
        // v' = q * v * q^-1
        const ix = q.w * x + q.y * z - q.z * y, iy = q.w * y + q.z * x - q.x * z, iz = q.w * z + q.x * y - q.y * x, iw = -q.x * x - q.y * y - q.z * z;
        rx = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
        ry = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
        rz = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
      }
      positions.push(b.p[0] + rx, b.p[1] + ry, b.p[2] + rz);
    }
    for (const f of FACES) indices.push(n + f[0], n + f[1], n + f[2]);
    n += 8;
  }
  return { positions, indices };
};

/** Build (or load from the disk cache) the navmesh for a map. */
export const buildNavMesh = async (map: MapData, cacheDir: string | null): Promise<NavMesh> => {
  await initNavigation();
  const file = cacheDir ? path.join(cacheDir, `navmesh-${map.id}-${map.seed}-${hashMap(map)}-v${NAV_VERSION}.bin`) : null;
  if (file && fs.existsSync(file)) {
    const res = importNavMesh(new Uint8Array(fs.readFileSync(file)));
    if (res.navMesh) {
      console.log(`[nav] loaded cached navmesh ${path.basename(file)}`);
      return res.navMesh;
    }
  }
  const t0 = performance.now();
  const { positions, indices } = triangulate(map);
  const res = generateTiledNavMesh(positions, indices, {
    ...NAV_CONFIG,
    offMeshConnections: map.navLinks.map((l) => ({
      startPosition: { x: l.a[0], y: l.a[1], z: l.a[2] },
      endPosition: { x: l.b[0], y: l.b[1], z: l.b[2] },
      radius: 0.6,
      bidirectional: true,
    })),
  });
  if (!res.success) throw new Error(`navmesh build failed: ${res.error}`);
  console.log(`[nav] built navmesh in ${Math.round(performance.now() - t0)} ms (${indices.length / 3} tris, ${map.navLinks.length} stair links)`);
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, exportNavMesh(res.navMesh));
  }
  return res.navMesh;
};

/** Navmesh queries + the zombie crowd. */
export class Navigation {
  readonly query: NavMeshQuery;
  readonly crowd: Crowd;
  private static readonly EXTENTS = { x: 2, y: 4, z: 2 };

  constructor(readonly navMesh: NavMesh, maxAgents: number) {
    this.query = new NavMeshQuery(navMesh);
    this.crowd = new Crowd(navMesh, { maxAgents, maxAgentRadius: 0.6 });
  }

  /** Closest point on the navmesh, or null if nothing walkable is nearby. */
  closest(p: Vec3, extents = Navigation.EXTENTS): Vec3 | null {
    const r = this.query.findClosestPoint(p, { halfExtents: extents });
    return r.success && r.polyRef ? r.point : null;
  }

  /** Random reachable point within `radius` of `p`. */
  randomAround(p: Vec3, radius: number): Vec3 | null {
    const start = this.query.findNearestPoly(p, { halfExtents: Navigation.EXTENTS });
    if (!start.nearestRef) return null;
    const r = this.query.findRandomPointAroundCircle(start.nearestPoint, radius, { startRef: start.nearestRef });
    return r.success ? r.randomPoint : null;
  }
}
