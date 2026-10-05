import type { Collider, World } from '@dimforge/rapier3d-compat';
import { quatFromEulerYXZ } from '../math/math';
import { WORLD_GROUPS } from '../sim/collision';
import type { Rapier } from '../sim/movement';
import type { DoorDef } from './mapData';

export const DOOR_THICKNESS = 0.06;
/** Max distance from the eye to the door's center to use it (server validates). */
export const DOOR_USE_RANGE = 2.6;

/** World pose of a door panel (center + yaw). */
export const doorPose = (d: DoorDef, openAmount: number): { x: number; y: number; z: number; yaw: number } => {
  const yaw = d.yaw + d.swing * (Math.PI / 2) * openAmount;
  const half = d.width / 2;
  return {
    x: d.hinge[0] + Math.cos(yaw) * half,
    y: d.hinge[1] + d.height / 2,
    z: d.hinge[2] - Math.sin(yaw) * half,
    yaw,
  };
};

/**
 * Does a vertical capsule at (px, pz) with radius r overlap the door panel's sweep
 * between closed and open? Used to stop a door from closing/opening into someone.
 */
export const doorSweepBlocked = (d: DoorDef, px: number, pz: number, r: number): boolean => {
  const dx = px - d.hinge[0];
  const dz = pz - d.hinge[2];
  const dist = Math.hypot(dx, dz);
  if (dist > d.width + r) return false;
  if (dist < r + DOOR_THICKNESS) return true;
  // Angle of the player around the hinge, measured like door yaw: dir = (cos a, -sin a).
  const a = Math.atan2(-dz, dx);
  const start = d.yaw;
  const end = d.yaw + d.swing * (Math.PI / 2);
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  // Angular margin so we also catch the capsule's width.
  const margin = Math.asin(Math.min(1, (r + DOOR_THICKNESS) / Math.max(dist, 1e-3)));
  for (const k of [-1, 0, 1]) {
    const aa = a + k * Math.PI * 2;
    if (aa >= lo - margin && aa <= hi + margin) return true;
  }
  return false;
};

/** Door colliders for one physics world; the same class runs on client and server. */
export class DoorColliders {
  private readonly colliders: Collider[] = [];
  /** Collider handle -> door id, for raycast interaction. */
  readonly byHandle = new Map<number, number>();
  readonly open: boolean[];

  constructor(
    R: Rapier,
    private readonly world: World,
    private readonly doors: DoorDef[],
  ) {
    this.open = doors.map((d) => d.startsOpen);
    for (const d of doors) {
      const pose = doorPose(d, d.startsOpen ? 1 : 0);
      const desc = R.ColliderDesc.cuboid(d.width / 2, d.height / 2, DOOR_THICKNESS / 2)
        .setTranslation(pose.x, pose.y, pose.z)
        .setRotation(quatFromEulerYXZ(0, pose.yaw, 0))
        .setCollisionGroups(WORLD_GROUPS);
      const c = world.createCollider(desc);
      this.colliders.push(c);
      this.byHandle.set(c.handle, d.id);
    }
  }

  /** Move a door's collider. Call world.step() afterwards so scene queries see it. */
  set(id: number, open: boolean): void {
    const d = this.doors[id];
    const c = this.colliders[id];
    if (!d || !c) return;
    this.open[id] = open;
    const pose = doorPose(d, open ? 1 : 0);
    c.setTranslation({ x: pose.x, y: pose.y, z: pose.z });
    c.setRotation(quatFromEulerYXZ(0, pose.yaw, 0));
  }

  openIds(): number[] {
    const ids: number[] = [];
    this.open.forEach((o, i) => o && ids.push(i));
    return ids;
  }
}
