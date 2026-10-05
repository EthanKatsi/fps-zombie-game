import type { Vec3 } from '../types/common';
import type { Rapier } from '../sim/movement';
import type { World } from '@dimforge/rapier3d-compat';
import { quatFromEulerYXZ } from '../math/math';
import { WORLD_GROUPS } from '../sim/collision';

/**
 * Map description shared by client (visuals + prediction colliders) and server (authority).
 * Generated deterministically from a seed, so only {id, seed} needs to go over the wire.
 */
export interface MapBox {
  /** Center position. */
  p: [number, number, number];
  /** Full size (width, height, depth). */
  s: [number, number, number];
  /** Optional euler rotation (radians, 'YXZ' order). */
  r?: [number, number, number];
  /** Material key for the client renderer (see client materials). */
  m: string;
  /** Set false for visual-only pieces (e.g. stair steps covered by a ramp collider). */
  col?: boolean;
  /** Set false for invisible collision-only pieces. */
  vis?: boolean;
}

export interface MapData {
  id: string;
  seed: number;
  /** Half-extent of the playable square, centered on the origin. */
  halfSize: number;
  boxes: MapBox[];
  spawnPoints: Vec3[];
}

/** Create fixed colliders for every map box. Call world.step() once afterwards. */
export const buildMapColliders = (R: Rapier, world: World, map: MapData): void => {
  for (const b of map.boxes) {
    if (b.col === false) continue;
    const desc = R.ColliderDesc.cuboid(b.s[0] / 2, b.s[1] / 2, b.s[2] / 2)
      .setTranslation(b.p[0], b.p[1], b.p[2])
      .setCollisionGroups(WORLD_GROUPS);
    if (b.r) desc.setRotation(quatFromEulerYXZ(b.r[0], b.r[1], b.r[2]));
    world.createCollider(desc);
  }
};
