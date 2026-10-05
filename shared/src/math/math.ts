export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const degToRad = (d: number): number => (d * Math.PI) / 180;

/** Wrap an angle to (-PI, PI]. */
export const wrapAngle = (a: number): number => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

/** Shortest-path angle interpolation. */
export const lerpAngle = (a: number, b: number, t: number): number => a + wrapAngle(b - a) * t;

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Euler (radians, 'YXZ' order: yaw, then pitch in the yawed frame) to quaternion.
 * Matches THREE.Euler(x, y, z, 'YXZ'), which the client uses for map pieces.
 */
export const quatFromEulerYXZ = (x: number, y: number, z: number): Quat => {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2);
  const s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
};

/** Small deterministic PRNG (mulberry32) for seeded world generation. */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
