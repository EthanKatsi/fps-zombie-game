/** Plain-data vector used across the wire and in persistence (no Three.js / Rapier classes). */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type EntityId = string;
export type PlayerId = string;
export type GroupId = string;

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
