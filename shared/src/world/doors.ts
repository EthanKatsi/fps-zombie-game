import type { Collider, World } from '@dimforge/rapier3d-compat';
import { quatFromEulerYXZ } from '../math/math';
import { WORLD_GROUPS } from '../sim/collision';
import type { Rapier } from '../sim/movement';
import type { DoorDef } from './mapData';

export const DOOR_THICKNESS = 0.06;
/** Max distance from the eye to the door's center to use it (server validates). */
export const DOOR_USE_RANGE = 2.6;

/**
 * World pose of a door panel (center + yaw). openAmount 0 = closed, 1 = open the default way,
 * -1 = open the other way (doors swing away from whoever opens them).
 */
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
export const doorSweepBlocked = (d: DoorDef, px: number, pz: number, r: number, dir: 1 | -1 = 1): boolean => {
  const dx = px - d.hinge[0];
  const dz = pz - d.hinge[2];
  const dist = Math.hypot(dx, dz);
  if (dist > d.width + r) return false;
  if (dist < r + DOOR_THICKNESS) return true;
  // Angle of the player around the hinge, measured like door yaw: dir = (cos a, -sin a).
  const a = Math.atan2(-dz, dx);
  const start = d.yaw;
  const end = d.yaw + d.swing * dir * (Math.PI / 2);
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

/** Does the door panel at `openAmount` (-1..1) overlap a vertical capsule at (px, pz)? */
export const doorPanelHits = (d: DoorDef, openAmount: number, px: number, pz: number, r: number): boolean => {
  const yaw = d.yaw + d.swing * (Math.PI / 2) * openAmount;
  const vx = Math.cos(yaw), vz = -Math.sin(yaw);
  const dx = px - d.hinge[0], dz = pz - d.hinge[2];
  const t = Math.max(0, Math.min(d.width, dx * vx + dz * vz));
  return Math.hypot(dx - vx * t, dz - vz * t) < r + DOOR_THICKNESS / 2;
};

/** Which way (1 / -1) a door should open to swing away from someone standing at (px, pz). */
export const doorAwayDir = (d: DoorDef, px: number, pz: number): 1 | -1 => {
  const yaw = d.yaw + d.swing * (Math.PI / 2); // panel direction when opened the default way
  const side = (px - d.hinge[0]) * Math.cos(yaw) + (pz - d.hinge[2]) * -Math.sin(yaw);
  return side > 0 ? -1 : 1;
};

/** Door colliders for one physics world; the same class runs on client and server. */
export class DoorColliders {
  private readonly colliders: Collider[] = [];
  /** Collider handle -> door id, for raycast interaction. */
  readonly byHandle = new Map<number, number>();
  readonly open: boolean[];
  /** Which way each door is (or was last) opened: 1 = default swing, -1 = reversed. */
  readonly dir: (1 | -1)[];

  constructor(
    R: Rapier,
    private readonly world: World,
    private readonly doors: DoorDef[],
  ) {
    this.open = doors.map((d) => d.startsOpen);
    this.dir = doors.map(() => 1);
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
  set(id: number, open: boolean, dir: 1 | -1 = this.dir[id] ?? 1): void {
    const d = this.doors[id];
    const c = this.colliders[id];
    if (!d || !c) return;
    this.open[id] = open;
    this.dir[id] = dir;
    const pose = doorPose(d, open ? dir : 0);
    c.setTranslation({ x: pose.x, y: pose.y, z: pose.z });
    c.setRotation(quatFromEulerYXZ(0, pose.yaw, 0));
  }

  openIds(): number[] {
    const ids: number[] = [];
    this.open.forEach((o, i) => o && ids.push(i));
    return ids;
  }

  /** Open doors that swung the non-default way. */
  reversedIds(): number[] {
    const ids: number[] = [];
    this.open.forEach((o, i) => o && this.dir[i] === -1 && ids.push(i));
    return ids;
  }
}
