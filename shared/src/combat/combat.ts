import { COMBAT, getWeaponDef } from '../config/weapons';
import { getItemDef } from '../config/items';
import { MOVEMENT } from '../config/movement';
import { mulberry32 } from '../math/math';
import type { Vec3 } from '../types/common';
import type { WeaponDef } from '../types/weapon';
import type { MoveState } from '../sim/movement';

/** The weapon used when attacking with the given held item (fists when empty / not a weapon). */
export const weaponForItem = (defId: string | null | undefined): WeaponDef => {
  const id = defId ? getItemDef(defId)?.weaponId : undefined;
  return getWeaponDef(id) ?? getWeaponDef('fists')!;
};

/** Current cone spread (degrees) for a ranged weapon given the shooter's movement state. */
export const spreadDegrees = (w: WeaponDef, s: Pick<MoveState, 'vel' | 'crouching' | 'grounded'>, aiming: boolean): number => {
  let deg = aiming ? (w.spreadAds ?? 0) : (w.spreadHip ?? 0);
  const speed = Math.hypot(s.vel.x, s.vel.z);
  deg += (w.spreadMoving ?? 0) * Math.min(1, speed / COMBAT.movingSpeedForFullSpread) * (aiming ? 0.5 : 1);
  if (!s.grounded) deg += COMBAT.airborneSpreadExtra;
  if (s.crouching) deg *= COMBAT.crouchSpreadMultiplier;
  return deg;
};

/**
 * Seed for a shot's random spread. Shots are numbered by the client (strictly +1 each time),
 * and the server hands out a per-session salt, so both sides compute identical pellets while
 * the client can't shop for lucky seeds.
 */
export const shotSeed = (salt: number, seq: number): number => (salt ^ Math.imul(seq + 1, 0x9e3779b1)) >>> 0;

const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};

/** Directions of each pellet: uniformly distributed inside a cone of `spreadDeg` around `dir`. */
export const pelletDirections = (dir: Vec3, spreadDeg: number, pellets: number, seed: number): Vec3[] => {
  const d = normalize(dir);
  const rand = mulberry32(seed);
  // Orthonormal basis (u, v) perpendicular to d.
  const helper = Math.abs(d.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const u = normalize({ x: helper.y * d.z - helper.z * d.y, y: helper.z * d.x - helper.x * d.z, z: helper.x * d.y - helper.y * d.x });
  const v = { x: d.y * u.z - d.z * u.y, y: d.z * u.x - d.x * u.z, z: d.x * u.y - d.y * u.x };
  const maxRad = (spreadDeg * Math.PI) / 180;
  const out: Vec3[] = [];
  for (let i = 0; i < pellets; i++) {
    const theta = maxRad * Math.sqrt(rand());
    const phi = rand() * Math.PI * 2;
    const st = Math.sin(theta), ct = Math.cos(theta);
    const cp = Math.cos(phi), sp = Math.sin(phi);
    out.push(normalize({
      x: d.x * ct + (u.x * cp + v.x * sp) * st,
      y: d.y * ct + (u.y * cp + v.y * sp) * st,
      z: d.z * ct + (u.z * cp + v.z * sp) * st,
    }));
  }
  return out;
};

/** Aim direction from camera yaw/pitch (Three.js convention: yaw 0 looks down -Z). */
export const aimDirection = (yaw: number, pitch: number): Vec3 => ({
  x: -Math.sin(yaw) * Math.cos(pitch),
  y: Math.sin(pitch),
  z: -Math.cos(yaw) * Math.cos(pitch),
});

// ------------------------------------------------------------------ hitboxes

export interface Hitboxes {
  /** Head sphere. */
  head: { c: Vec3; r: number };
  /** Body capsule: segment a-b with radius r. */
  body: { a: Vec3; b: Vec3; r: number };
}

/** Humanoid hitboxes from a feet position (players, dummies; zombies scale these). */
export const humanoidHitboxes = (feet: Vec3, crouching: boolean, scale = 1): Hitboxes => {
  const h = (crouching ? MOVEMENT.crouchHeight : MOVEMENT.standHeight) * scale;
  const headR = 0.16 * scale;
  const headY = h - headR - 0.02;
  return {
    head: { c: { x: feet.x, y: feet.y + headY, z: feet.z }, r: headR },
    body: {
      a: { x: feet.x, y: feet.y + 0.3 * scale, z: feet.z },
      b: { x: feet.x, y: feet.y + headY - headR - 0.2 * scale, z: feet.z },
      r: 0.3 * scale,
    },
  };
};

/** Ray-sphere: distance along the (unit) ray, or null. */
export const raySphere = (o: Vec3, d: Vec3, c: Vec3, r: number): number | null => {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - cc;
  if (disc < 0) return null;
  const t = -b - Math.sqrt(disc);
  if (t >= 0) return t;
  return cc <= 0 ? 0 : null; // origin inside
};

/**
 * Ray vs capsule (segment a-b, radius r). Finds the segment point closest to the ray's line and
 * intersects the ray with a sphere there; falls back to the end caps. Accurate to a few cm,
 * which is plenty for hit detection.
 */
export const rayCapsule = (o: Vec3, d: Vec3, a: Vec3, b: Vec3, r: number): number | null => {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ao = { x: o.x - a.x, y: o.y - a.y, z: o.z - a.z };
  const abab = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const abd = ab.x * d.x + ab.y * d.y + ab.z * d.z;
  const abao = ab.x * ao.x + ab.y * ao.y + ab.z * ao.z;
  const dao = d.x * ao.x + d.y * ao.y + d.z * ao.z;
  const denom = abab - abd * abd;
  const s = denom > 1e-9 ? Math.max(0, Math.min(1, (abao - abd * dao) / denom)) : 0;
  const p = { x: a.x + ab.x * s, y: a.y + ab.y * s, z: a.z + ab.z * s };
  const t = raySphere(o, d, p, r);
  if (t !== null) return t;
  const ta = raySphere(o, d, a, r);
  const tb = raySphere(o, d, b, r);
  return ta === null ? tb : tb === null ? ta : Math.min(ta, tb);
};

/** Closest hit of a ray on a hitbox set (head wins ties). */
export const rayHitboxes = (o: Vec3, d: Vec3, maxT: number, hb: Hitboxes): { t: number; head: boolean } | null => {
  const th = raySphere(o, d, hb.head.c, hb.head.r);
  const tb = rayCapsule(o, d, hb.body.a, hb.body.b, hb.body.r);
  let best: { t: number; head: boolean } | null = null;
  if (th !== null && th <= maxT) best = { t: th, head: true };
  if (tb !== null && tb <= maxT && (!best || tb < best.t - 0.02)) best = { t: tb, head: false };
  return best;
};
