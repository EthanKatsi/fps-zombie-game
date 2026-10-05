import { CITY } from '../../config/world';
import { mulberry32 } from '../../math/math';
import type { Vec3 } from '../../types/common';
import type { BuildingType, MapBox, MapData } from '../mapData';
import { BUILDING_SPECS, buildBuilding, pick, randRange, rollBuildingSize, type GenContext } from './buildings';

type BlockKind = 'residential' | 'commercial' | 'park' | 'parking' | 'police';

const CAR_COLORS = ['car_red', 'car_blue', 'car_white', 'car_rust', 'car_green', 'car_black'];

/**
 * Calder Point: a square grid of blocks inside a quarantine wall, with a ring road.
 * Each block is split into 2x2 lots. Deterministic for a given seed.
 */
export const generateCity = (seed: number): MapData => {
  const rand = mulberry32(seed);
  const ctx: GenContext = { boxes: [], doors: [], containers: [], buildings: [], dummies: [], navLinks: [], rand };
  const { boxes } = ctx;
  const N = CITY.blocksPerSide;
  const B = CITY.blockSize;
  const S = CITY.streetWidth;
  const SWK = CITY.sidewalkWidth;
  const CURB = CITY.curbHeight;
  const total = N * B + (N + 1) * S;
  const half = total / 2;
  const blockMin = (i: number) => -half + S + i * (B + S);

  // ---- ground + quarantine wall
  boxes.push({ p: [0, -0.5, 0], s: [total + 40, 1, total + 40], m: 'asphalt' });
  const WH = CITY.perimeterWallHeight;
  boxes.push({ p: [0, WH / 2, -half - 0.5], s: [total + 2, WH, 1], m: 'concrete_wall' });
  boxes.push({ p: [0, WH / 2, half + 0.5], s: [total + 2, WH, 1], m: 'concrete_wall' });
  boxes.push({ p: [-half - 0.5, WH / 2, 0], s: [1, WH, total], m: 'concrete_wall' });
  boxes.push({ p: [half + 0.5, WH / 2, 0], s: [1, WH, total], m: 'concrete_wall' });

  // ---- spawn points around the ring road (kept clear of cars)
  const spawnPoints: Vec3[] = [];
  const ring = half - S / 2;
  for (let i = 0; i < CITY.edgeSpawnPoints; i++) {
    const t = (i / CITY.edgeSpawnPoints) * 8 - 4; // walk the square perimeter
    const side = Math.floor((t + 4) / 2);
    const u = ((t + 4) % 2) - 1; // -1..1 along the side
    const along = u * (ring - 6);
    const [x, z] = [[along, -ring], [ring, along], [-along, ring], [-ring, -along]][side];
    spawnPoints.push({ x, y: 0.1, z });
  }

  // ---- assign block kinds
  const cells: [number, number][] = [];
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) cells.push([i, j]);
  for (let k = cells.length - 1; k > 0; k--) {
    const r = Math.floor(rand() * (k + 1));
    [cells[k], cells[r]] = [cells[r], cells[k]];
  }
  const required: BuildingType[] = [];
  for (const [t, n] of CITY.requiredBuildings) for (let k = 0; k < n; k++) required.push(t);
  const commercialNeeded = Math.ceil(required.length / 4);
  const weights = Object.entries(CITY.blockWeights) as [BlockKind, number][];
  const weightSum = weights.reduce((a, [, w]) => a + w, 0);
  const kinds = new Map<string, BlockKind>();
  cells.forEach(([i, j], idx) => {
    let kind: BlockKind;
    if (idx === 0) kind = 'police';
    else if (idx <= commercialNeeded) kind = 'commercial';
    else {
      let r = rand() * weightSum;
      kind = weights.find(([, w]) => (r -= w) < 0)?.[0] ?? 'residential';
    }
    kinds.set(`${i},${j}`, kind);
  });

  // ---- blocks
  const L = (B - 2 * SWK) / 2; // lot size
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const kind = kinds.get(`${i},${j}`)!;
      const x0 = blockMin(i);
      const z0 = blockMin(j);
      buildBlockSurface(boxes, x0, z0, B, SWK, CURB, kind);
      streetLights(boxes, x0, z0, B);

      for (let qx = 0; qx < 2; qx++) {
        for (let qz = 0; qz < 2; qz++) {
          const lx0 = x0 + SWK + qx * L;
          const lz0 = z0 + SWK + qz * L;
          const lot = { x0: lx0, z0: lz0, x1: lx0 + L, z1: lz0 + L, qx, qz };
          let type: BuildingType | null = null;
          if (kind === 'police') type = qx === 0 && qz === 0 ? 'police' : null;
          else if (kind === 'commercial') type = required.shift() ?? pick(rand, ['grocery', 'pharmacy', 'hardware', 'apartment', 'apartment'] as const);
          else if (kind === 'residential') type = rand() < 0.9 ? 'house' : null;

          if (type) placeBuilding(ctx, type, lot, CURB);
          else if (kind === 'police' && qx === 1 && qz === 0) shootingRange(ctx, lot, CURB);
          else if (kind === 'park') parkLot(ctx, lot, CURB);
          else if (kind === 'residential') vacantLot(ctx, lot, CURB);
          else parkingLot(ctx, lot, CURB);
        }
      }
      if (kind === 'park') parkFence(boxes, x0, z0, B, SWK, CURB);
    }
  }

  // ---- streets: lane markings, abandoned cars, debris
  const carSpots: [number, number][] = spawnPoints.map((p) => [p.x, p.z]);
  for (let k = 0; k <= N; k++) {
    const c = -half + S / 2 + k * (B + S);
    for (const axis of ['x', 'z'] as const) {
      // Dashed centre line between intersections.
      for (let i = 0; i < N; i++) {
        const a0 = blockMin(i);
        for (let a = a0 + 2; a + 2.5 < a0 + B - 1; a += 6) {
          const p: [number, number, number] = axis === 'x' ? [a + 1.25, 0.005, c] : [c, 0.005, a + 1.25];
          boxes.push({ p, s: axis === 'x' ? [2.5, 0.01, 0.15] : [0.15, 0.01, 2.5], m: 'paint', col: false, d: true });
        }
      }
      const cars = Math.round((total / 100) * CITY.carsPer100m);
      for (let n = 0; n < cars; n++) {
        const along = randRange(rand, -half + 6, half - 6);
        const lane = (rand() < 0.5 ? -1 : 1) * randRange(rand, 1.5, 4.5);
        const [x, z] = axis === 'x' ? [along, c + lane] : [c + lane, along];
        if (carSpots.some(([px, pz]) => Math.hypot(px - x, pz - z) < 6)) continue;
        carSpots.push([x, z]);
        let yaw = (axis === 'x' ? Math.PI / 2 : 0) + randRange(rand, -0.35, 0.35) + (rand() < 0.5 ? Math.PI : 0);
        if (rand() < 0.12) yaw += Math.PI / 2; // crashed sideways
        addCar(ctx, x, 0, z, yaw);
      }
      const debris = Math.round((total / 100) * CITY.debrisPer100m);
      for (let n = 0; n < debris; n++) {
        const along = randRange(rand, -half + 3, half - 3);
        const off = randRange(rand, -S / 2 + 0.5, S / 2 - 0.5);
        const [x, z] = axis === 'x' ? [along, c + off] : [c + off, along];
        addDebris(boxes, rand, x, 0, z);
      }
    }
  }

  // ---- a few concrete roadblocks at intersections
  for (let n = 0; n < N; n++) {
    const kx = Math.floor(rand() * (N + 1));
    const kz = Math.floor(rand() * (N + 1));
    const cx = -half + S / 2 + kx * (B + S);
    const cz = -half + S / 2 + kz * (B + S);
    if (Math.abs(cx) > ring - 8 || Math.abs(cz) > ring - 8) continue; // keep the ring road open
    for (let b = 0; b < 3; b++) {
      boxes.push({
        p: [cx + randRange(rand, -4, 4), 0.45, cz + randRange(rand, -4, 4)],
        s: [3, 0.9, 0.6],
        r: [0, rand() * Math.PI, 0],
        m: 'concrete_barrier',
      });
    }
  }

  return {
    id: 'city',
    seed,
    halfSize: half,
    boxes,
    doors: ctx.doors,
    buildings: ctx.buildings,
    containers: ctx.containers,
    dummies: ctx.dummies,
    navLinks: ctx.navLinks,
    spawnPoints,
  };
};

// ------------------------------------------------------------------ helpers

interface Lot {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  qx: number;
  qz: number;
}

const buildBlockSurface = (boxes: MapBox[], x0: number, z0: number, B: number, sw: number, h: number, kind: BlockKind) => {
  const y = h / 2;
  // Sidewalk ring
  boxes.push({ p: [x0 + B / 2, y, z0 + sw / 2], s: [B, h, sw], m: 'sidewalk' });
  boxes.push({ p: [x0 + B / 2, y, z0 + B - sw / 2], s: [B, h, sw], m: 'sidewalk' });
  boxes.push({ p: [x0 + sw / 2, y, z0 + B / 2], s: [sw, h, B - 2 * sw], m: 'sidewalk' });
  boxes.push({ p: [x0 + B - sw / 2, y, z0 + B / 2], s: [sw, h, B - 2 * sw], m: 'sidewalk' });
  const inner = kind === 'park' || kind === 'residential' ? 'grass' : kind === 'parking' ? 'lot_asphalt' : 'pavement';
  boxes.push({ p: [x0 + B / 2, y, z0 + B / 2], s: [B - 2 * sw, h, B - 2 * sw], m: inner });
};

const streetLights = (boxes: MapBox[], x0: number, z0: number, B: number) => {
  for (const [x, z] of [[x0 + 0.8, z0 + 0.8], [x0 + B - 0.8, z0 + 0.8], [x0 + 0.8, z0 + B - 0.8], [x0 + B - 0.8, z0 + B - 0.8]]) {
    boxes.push({ p: [x, 2.6, z], s: [0.16, 5.2, 0.16], m: 'metal_dark' });
    boxes.push({ p: [x, 5.15, z], s: [0.5, 0.12, 0.5], m: 'metal_dark', col: false });
  }
};

const placeBuilding = (ctx: GenContext, type: BuildingType, lot: Lot, curb: number) => {
  const { W, D, floors } = rollBuildingSize(ctx.rand, type);
  const spec = BUILDING_SPECS[type];
  const cx = (lot.x0 + lot.x1) / 2;
  // Face the street on the lot's outer Z edge: qz=0 faces -Z (q=0), qz=1 faces +Z (q=2).
  const cz = lot.qz === 0 ? lot.z0 + spec.setback + D / 2 : lot.z1 - spec.setback - D / 2;
  const q = lot.qz === 0 ? 0 : 2;
  buildBuilding(ctx, type, cx, cz, q, W, D, floors, curb + 0.2);

  if (type === 'house') yardFence(ctx.boxes, lot, curb);
  else if (type !== 'police') {
    // Commercial lots: a couple of cars behind the building, if there's room.
    const free = lot.z1 - lot.z0 - spec.setback - D;
    if (free >= 4) {
      const backZ = lot.qz === 0 ? lot.z1 - free / 2 : lot.z0 + free / 2;
      for (let n = 0; n < 2; n++) {
        if (ctx.rand() < 0.5) continue;
        const x = n === 0 ? lot.x0 + 4 : lot.x1 - 4;
        addCar(ctx, x, curb, backZ, Math.PI / 2 + randRange(ctx.rand, -0.15, 0.15));
      }
    }
  }
};

const yardFence = (boxes: MapBox[], lot: Lot, curb: number) => {
  const h = 1.0;
  const y = curb + h / 2;
  const inset = 0.3;
  const x0 = lot.x0 + inset, x1 = lot.x1 - inset;
  const frontZ = lot.qz === 0 ? lot.z0 + inset : lot.z1 - inset;
  const backZ = lot.qz === 0 ? lot.z1 - inset : lot.z0 + inset;
  const gap = 3;
  const mid = (x0 + x1) / 2;
  const seg = (a: number, b: number, z: number) =>
    boxes.push({ p: [(a + b) / 2, y, z], s: [b - a, h, 0.08], m: 'fence_wood', d: true });
  const side = (x: number) =>
    boxes.push({ p: [x, y, (frontZ + backZ) / 2], s: [0.08, h, Math.abs(backZ - frontZ)], m: 'fence_wood', d: true });
  seg(x0, mid - gap / 2, frontZ);
  seg(mid + gap / 2, x1, frontZ);
  // Shared side fences are only built once (by the left lot).
  if (lot.qx === 0) {
    side(x0);
    side(x1);
  } else {
    side(x1);
  }
};

const parkLot = (ctx: GenContext, lot: Lot, curb: number) => {
  const { boxes, rand } = ctx;
  const trees = 3 + Math.floor(rand() * 4);
  for (let n = 0; n < trees; n++) {
    const x = randRange(rand, lot.x0 + 2, lot.x1 - 2);
    const z = randRange(rand, lot.z0 + 2, lot.z1 - 2);
    const th = randRange(rand, 2.5, 4);
    boxes.push({ p: [x, curb + th / 2, z], s: [0.4, th, 0.4], m: 'bark' });
    const cs = randRange(rand, 2.4, 3.6);
    boxes.push({ p: [x, curb + th + cs * 0.35, z], s: [cs, cs * 0.8, cs], r: [0, rand() * Math.PI, 0], m: 'leaves', col: false });
    boxes.push({ p: [x, curb + th + cs * 0.85, z], s: [cs * 0.6, cs * 0.5, cs * 0.6], r: [0, rand() * Math.PI, 0], m: 'leaves', col: false });
  }
  if (rand() < 0.7) {
    const x = randRange(rand, lot.x0 + 3, lot.x1 - 3);
    const z = randRange(rand, lot.z0 + 3, lot.z1 - 3);
    boxes.push({ p: [x, curb + 0.25, z], s: [2, 0.5, 0.5], r: [0, rand() * Math.PI, 0], m: 'wood_dark', d: true });
  }
  for (let n = 0; n < 3; n++) {
    const x = randRange(rand, lot.x0 + 1, lot.x1 - 1);
    const z = randRange(rand, lot.z0 + 1, lot.z1 - 1);
    const s = randRange(rand, 0.8, 1.6);
    boxes.push({ p: [x, curb + s * 0.3, z], s: [s, s * 0.6, s], r: [0, rand() * Math.PI, 0], m: 'bush', col: false, d: true });
  }
};

const parkFence = (boxes: MapBox[], x0: number, z0: number, B: number, sw: number, curb: number) => {
  const h = 1.0;
  const y = curb + h / 2;
  const a = x0 + sw, b = x0 + B - sw, c = z0 + sw, d = z0 + B - sw;
  const gap = 4;
  const mx = (a + b) / 2, mz = (c + d) / 2;
  const fx = (x1: number, x2: number, z: number) =>
    boxes.push({ p: [(x1 + x2) / 2, y, z], s: [x2 - x1, h, 0.08], m: 'fence_metal', d: true });
  const fz = (x: number, z1: number, z2: number) =>
    boxes.push({ p: [x, y, (z1 + z2) / 2], s: [0.08, h, z2 - z1], m: 'fence_metal', d: true });
  fx(a, mx - gap / 2, c); fx(mx + gap / 2, b, c);
  fx(a, mx - gap / 2, d); fx(mx + gap / 2, b, d);
  fz(a, c, mz - gap / 2); fz(a, mz + gap / 2, d);
  fz(b, c, mz - gap / 2); fz(b, mz + gap / 2, d);
};

/** Police training range: a firing line and a row of dummies behind sandbags. */
const shootingRange = (ctx: GenContext, lot: Lot, curb: number) => {
  const { boxes } = ctx;
  const cx = (lot.x0 + lot.x1) / 2;
  const nearZ = lot.qz === 0 ? lot.z0 + 3 : lot.z1 - 3; // firing line by the street
  const farZ = lot.qz === 0 ? lot.z1 - 4 : lot.z0 + 4; // targets at the back
  const facing = lot.qz === 0 ? Math.PI : 0; // dummies face the firing line
  // Firing line bench and a backstop wall behind the targets.
  boxes.push({ p: [cx, curb + 0.5, nearZ], s: [lot.x1 - lot.x0 - 6, 1.0, 0.6], m: 'concrete_barrier' });
  const backZ = lot.qz === 0 ? lot.z1 - 1.5 : lot.z0 + 1.5;
  boxes.push({ p: [cx, curb + 1.75, backZ], s: [lot.x1 - lot.x0 - 2, 3.5, 0.6], m: 'sandbag' });
  for (let i = 0; i < 5; i++) {
    const x = lot.x0 + 4 + i * ((lot.x1 - lot.x0 - 8) / 4);
    const z = farZ + (i % 2 === 0 ? 0 : (lot.qz === 0 ? -4 : 4));
    ctx.dummies.push({ id: ctx.dummies.length, p: [x, curb, z], yaw: facing });
  }
};

const vacantLot = (ctx: GenContext, lot: Lot, curb: number) => {
  for (let n = 0; n < 8; n++) {
    addDebris(ctx.boxes, ctx.rand, randRange(ctx.rand, lot.x0 + 2, lot.x1 - 2), curb, randRange(ctx.rand, lot.z0 + 2, lot.z1 - 2));
  }
  if (ctx.rand() < 0.5) addCar(ctx, (lot.x0 + lot.x1) / 2, curb, (lot.z0 + lot.z1) / 2, ctx.rand() * Math.PI);
};

const parkingLot = (ctx: GenContext, lot: Lot, curb: number) => {
  const { boxes, rand } = ctx;
  for (let row = 0; row < 2; row++) {
    const z = lot.z0 + 6 + row * 11;
    for (let x = lot.x0 + 2.5; x < lot.x1 - 2; x += 3) {
      boxes.push({ p: [x - 1.5, curb + 0.005, z], s: [0.12, 0.01, 5], m: 'paint', col: false, d: true });
      if (rand() < 0.45) addCar(ctx, x, curb, z + randRange(rand, -0.3, 0.3), randRange(rand, -0.1, 0.1) + (rand() < 0.5 ? Math.PI : 0));
    }
  }
};

/** Car: body + cabin. yaw 0 means the car's length runs along Z. */
const addCar = (ctx: GenContext, x: number, y: number, z: number, yaw: number) => {
  const { boxes, rand } = ctx;
  const m = pick(rand, CAR_COLORS);
  boxes.push({ p: [x, y + 0.7, z], s: [1.9, 0.8, 4.4], r: [0, yaw, 0], m });
  // Cabin sits slightly towards the rear.
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  boxes.push({ p: [x + fx * 0.2, y + 1.38, z + fz * 0.2], s: [1.7, 0.56, 2.3], r: [0, yaw, 0], m: 'car_glass' });
  if (rand() < CITY.carTrunkChance) {
    ctx.containers.push({
      id: ctx.containers.length,
      kind: 'car_trunk',
      p: [x + fx * 1.8, y + 0.9, z + fz * 1.8],
      lootTable: 'street_car_trunk',
      buildingId: null,
    });
  }
};

const addDebris = (boxes: MapBox[], rand: () => number, x: number, y: number, z: number) => {
  const kind = rand();
  if (kind < 0.5) {
    const s = randRange(rand, 0.25, 0.6);
    boxes.push({ p: [x, y + s / 2, z], s: [s * 1.3, s, s], r: [0, rand() * Math.PI, 0], m: 'trash', col: false, d: true });
  } else if (kind < 0.8) {
    boxes.push({ p: [x, y + 0.06, z], s: [randRange(rand, 1, 2.5), 0.12, randRange(rand, 0.3, 1)], r: [0, rand() * Math.PI, 0], m: 'debris', col: false, d: true });
  } else {
    const s = randRange(rand, 0.6, 1.0);
    boxes.push({ p: [x, y + s / 2, z], s: [s, s, s], r: [0, rand() * Math.PI, 0], m: 'crate', d: true });
  }
};
