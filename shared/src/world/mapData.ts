import type { Vec3 } from '../types/common';
import type { ContainerKind } from '../types/inventory';
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
  /** Material key for the client renderer (see client palette). */
  m: string;
  /** Set false for visual-only pieces (e.g. stair steps covered by a ramp collider). */
  col?: boolean;
  /** Set false for invisible collision-only pieces. */
  vis?: boolean;
  /** Detail piece (interiors, furniture, small props): hidden at a distance by the client LOD. */
  d?: boolean;
}

export type BuildingType =
  | 'house'
  | 'apartment'
  | 'grocery'
  | 'pharmacy'
  | 'hardware'
  | 'gunshop'
  | 'police';

export interface BuildingInfo {
  id: number;
  type: BuildingType;
  /** World-space axis-aligned bounds [minX, minZ, maxX, maxZ]. */
  bounds: [number, number, number, number];
  floors: number;
  /** Ground floor height (top of slab). */
  floorY: number;
  /** Building center, local size (W across the facade, D deep) and quarter-turn rotation. */
  center: [number, number];
  size: [number, number];
  rot: 0 | 1 | 2 | 3;
}

/** A hinged door. The panel extends from the hinge along yaw (direction (cos a, 0, -sin a)). */
export interface DoorDef {
  id: number;
  /** Hinge position at the bottom of the door. */
  hinge: [number, number, number];
  width: number;
  height: number;
  /** Panel yaw when closed. */
  yaw: number;
  /** Rotation direction when opening (+1 / -1 quarter turn). */
  swing: 1 | -1;
  buildingId: number;
  startsOpen: boolean;
}

/** A lootable furniture piece / car trunk placed by the generator (made interactive in M3). */
export interface ContainerSpawn {
  id: number;
  kind: ContainerKind;
  /** Center of the furniture box. */
  p: [number, number, number];
  /** World axis-aligned size of the furniture box; absent for car trunks (use a radius). */
  s?: [number, number, number];
  /** Loot table id, e.g. 'grocery_shelf' or 'street_car_trunk'. */
  lootTable: string;
  buildingId: number | null;
}

export interface MapData {
  id: string;
  seed: number;
  /** Half-extent of the playable square, centered on the origin. */
  halfSize: number;
  boxes: MapBox[];
  doors: DoorDef[];
  buildings: BuildingInfo[];
  containers: ContainerSpawn[];
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

/**
 * Cheap fingerprint of the generated map. The server sends its hash so a client whose
 * generator diverged (different version, float differences) can be detected immediately.
 */
export const hashMap = (map: MapData): string => {
  let h = 0x811c9dc5;
  const mix = (n: number) => {
    // Quantize to centimetres so last-bit float differences don't matter.
    let v = Math.round(n * 100) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193);
      v >>>= 8;
    }
  };
  mix(map.boxes.length);
  for (const b of map.boxes) {
    mix(b.p[0]); mix(b.p[1]); mix(b.p[2]);
    mix(b.s[0]); mix(b.s[1]); mix(b.s[2]);
  }
  mix(map.doors.length);
  for (const d of map.doors) {
    mix(d.hinge[0]); mix(d.hinge[2]); mix(d.yaw);
  }
  mix(map.containers.length);
  return (h >>> 0).toString(16).padStart(8, '0');
};
