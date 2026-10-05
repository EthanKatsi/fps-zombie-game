import type { MapBox } from './mapData';

export type Dir = '+x' | '-x' | '+z' | '-z';

/** Yaw that turns local -Z (our "forward") into the given world direction. */
export const yawForDir = (d: Dir): number =>
  d === '-z' ? 0 : d === '+z' ? Math.PI : d === '-x' ? Math.PI / 2 : -Math.PI / 2;

const dirVec = (d: Dir): [number, number] =>
  d === '-z' ? [0, -1] : d === '+z' ? [0, 1] : d === '-x' ? [-1, 0] : [1, 0];

export interface StairsOpts {
  /** Front edge of the first step (center of its width), at floor height y. */
  x: number;
  y: number;
  z: number;
  /** Direction the stairs climb towards. */
  dir: Dir;
  width: number;
  /** Total rise. */
  height: number;
  steps: number;
  m: string;
}

/**
 * Visual-only solid steps plus one invisible ramp collider through the step nosings.
 * Character controllers glide up ramps smoothly; per-step autostepping is jittery.
 * Steps are 45 degrees (depth == rise), within MOVEMENT.maxSlopeDeg.
 */
export const addStairs = (boxes: MapBox[], o: StairsOpts): void => {
  const stepH = o.height / o.steps;
  const stepD = stepH;
  const [dx, dz] = dirVec(o.dir);
  const yaw = yawForDir(o.dir);

  for (let i = 0; i < o.steps; i++) {
    const u = (i + 0.5) * stepD;
    const h = (i + 1) * stepH;
    boxes.push({
      p: [o.x + dx * u, o.y + h / 2, o.z + dz * u],
      s: [o.width, h, stepD],
      r: [0, yaw, 0],
      m: o.m,
      col: false,
    });
  }

  // Ramp top surface runs from (u=-stepD, y) to (u=(steps-1)*stepD, y+height).
  const run = o.steps * stepD;
  const len = Math.hypot(run, o.height);
  const theta = Math.atan2(o.height, run);
  const t = 0.2;
  const uc = -stepD + run / 2 + (t / 2) * Math.sin(theta);
  const yc = o.y + o.height / 2 - (t / 2) * Math.cos(theta);
  boxes.push({
    p: [o.x + dx * uc, yc, o.z + dz * uc],
    s: [o.width, t, len],
    r: [theta, yaw, 0],
    m: o.m,
    vis: false,
  });
};
