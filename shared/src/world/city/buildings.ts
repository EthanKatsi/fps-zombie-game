import { CITY } from '../../config/world';
import type { ContainerKind } from '../../types/inventory';
import { addStairs, type Dir } from '../builders';
import type { BuildingInfo, BuildingType, ContainerSpawn, DoorDef, MapBox } from '../mapData';

export interface GenContext {
  boxes: MapBox[];
  doors: DoorDef[];
  containers: ContainerSpawn[];
  buildings: BuildingInfo[];
  rand: () => number;
}

export const pick = <T>(rand: () => number, list: readonly T[]): T => list[Math.floor(rand() * list.length)];
export const randRange = (rand: () => number, a: number, b: number): number => a + (b - a) * rand();
const randInt = (rand: () => number, a: number, b: number): number => a + Math.floor(rand() * (b - a + 1));

// ------------------------------------------------------------------ frame

const DIRS: Record<Dir, [number, number]> = { '+x': [1, 0], '-x': [-1, 0], '+z': [0, 1], '-z': [0, -1] };

/**
 * Local building space: origin at the front-left corner, x across the facade (0..W),
 * z from the front wall (0) to the back wall (D). The front faces local -Z.
 * Rotated by q quarter turns about Y around the building center (cx, cz).
 */
export class Frame {
  private readonly c: number;
  private readonly s: number;

  constructor(
    readonly cx: number,
    readonly cz: number,
    readonly W: number,
    readonly D: number,
    readonly q: 0 | 1 | 2 | 3,
  ) {
    this.c = [1, 0, -1, 0][q];
    this.s = [0, 1, 0, -1][q];
  }

  pt(lx: number, lz: number): [number, number] {
    const x = lx - this.W / 2;
    const z = lz - this.D / 2;
    return [this.cx + x * this.c + z * this.s, this.cz - x * this.s + z * this.c];
  }

  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, m: string, extra?: Partial<MapBox>): MapBox {
    const [wx, wz] = this.pt((x0 + x1) / 2, (z0 + z1) / 2);
    const sx = x1 - x0;
    const sz = z1 - z0;
    const odd = this.q % 2 === 1;
    return { p: [wx, (y0 + y1) / 2, wz], s: [odd ? sz : sx, y1 - y0, odd ? sx : sz], m, ...extra };
  }

  yaw(localYaw: number): number {
    return localYaw + (this.q * Math.PI) / 2;
  }

  dir(local: Dir): Dir {
    const [x, z] = DIRS[local];
    const wx = Math.round(x * this.c + z * this.s);
    const wz = Math.round(-x * this.s + z * this.c);
    return wx === 1 ? '+x' : wx === -1 ? '-x' : wz === 1 ? '+z' : '-z';
  }

  bounds(): [number, number, number, number] {
    const a = this.pt(0, 0);
    const b = this.pt(this.W, this.D);
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
  }
}

// ------------------------------------------------------------------ specs

interface BuildingSpec {
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  exterior: readonly string[];
  floor: string;
  shop: boolean;
  /** Distance from the lot's street edge to the facade. */
  setback: number;
  /** Purposes for the rooms of each floor (front to back); the last entry repeats. */
  rooms: (floor: number, rand: () => number) => string[];
}

export const BUILDING_SPECS: Record<BuildingType, BuildingSpec> = {
  house: {
    w: [9, 11], d: [11, 13], floors: [1, 2],
    exterior: ['siding_grey', 'siding_blue', 'siding_green', 'siding_cream', 'brick'],
    floor: 'floor_wood', shop: false, setback: 6,
    rooms: (f) => (f === 0 ? ['living', 'kitchen', 'bath'] : ['bedroom', 'bedroom', 'bath']),
  },
  apartment: {
    w: [14, 16], d: [17, 20], floors: [3, 3],
    exterior: ['brick', 'brick_dark', 'concrete_dark'],
    floor: 'floor_wood', shop: false, setback: 2,
    rooms: (_f, r) => ['living', pick(r, ['kitchen', 'bedroom']), pick(r, ['bedroom', 'bath', 'kitchen'])],
  },
  grocery: {
    w: [18, 20], d: [18, 20], floors: [1, 1],
    exterior: ['concrete', 'stucco'], floor: 'floor_tile', shop: true, setback: 2,
    rooms: () => ['shop_grocery', 'storage'],
  },
  pharmacy: {
    w: [12, 13], d: [14, 16], floors: [1, 1],
    exterior: ['stucco', 'concrete'], floor: 'floor_tile', shop: true, setback: 2,
    rooms: () => ['shop_pharmacy', 'storage'],
  },
  hardware: {
    w: [16, 18], d: [16, 18], floors: [1, 1],
    exterior: ['metal_siding', 'concrete'], floor: 'floor_concrete', shop: true, setback: 2,
    rooms: () => ['shop_hardware', 'storage'],
  },
  gunshop: {
    w: [10, 11], d: [13, 15], floors: [1, 1],
    exterior: ['brick_dark', 'concrete_dark'], floor: 'floor_concrete', shop: true, setback: 2,
    rooms: () => ['shop_gun', 'storage'],
  },
  police: {
    w: [20, 22], d: [22, 23], floors: [2, 2],
    exterior: ['concrete_dark'], floor: 'floor_tile', shop: false, setback: 2,
    rooms: (f) => (f === 0 ? ['lobby', 'office', 'lockers', 'armory'] : ['office', 'office', 'lockers']),
  },
};

const SIGNS: Partial<Record<BuildingType, string>> = {
  grocery: 'sign_green',
  pharmacy: 'sign_white',
  hardware: 'sign_orange',
  gunshop: 'sign_red',
  police: 'sign_blue',
};

// ------------------------------------------------------------------ furniture

interface Furn {
  m: string;
  /** Length along the wall. */
  w: number;
  /** Depth out from the wall. */
  d: number;
  h: number;
  kind?: ContainerKind;
}

const F = {
  couch: { m: 'fabric', w: 2.0, d: 0.9, h: 0.8 },
  cabinet: { m: 'wood', w: 1.0, d: 0.5, h: 1.0, kind: 'cabinet' },
  bookshelf: { m: 'wood', w: 1.0, d: 0.4, h: 1.9, kind: 'shelf' },
  tvstand: { m: 'wood_dark', w: 1.4, d: 0.45, h: 0.5 },
  fridge: { m: 'appliance', w: 0.8, d: 0.7, h: 1.9, kind: 'fridge' },
  counter: { m: 'counter', w: 1.6, d: 0.6, h: 0.9, kind: 'cabinet' },
  stove: { m: 'appliance', w: 0.8, d: 0.6, h: 0.9 },
  bed: { m: 'fabric', w: 2.0, d: 1.5, h: 0.55 },
  wardrobe: { m: 'wood', w: 1.2, d: 0.6, h: 2.0, kind: 'cabinet' },
  desk: { m: 'wood', w: 1.3, d: 0.65, h: 0.75, kind: 'desk' },
  nightstand: { m: 'wood_dark', w: 0.5, d: 0.45, h: 0.6, kind: 'cabinet' },
  bathcab: { m: 'counter', w: 0.7, d: 0.45, h: 0.85, kind: 'cabinet' },
  tub: { m: 'appliance', w: 1.6, d: 0.75, h: 0.55 },
  shelf: { m: 'metal', w: 2.0, d: 0.6, h: 1.9, kind: 'shelf' },
  shopfridge: { m: 'appliance', w: 1.8, d: 0.8, h: 2.0, kind: 'fridge' },
  crate: { m: 'crate', w: 1.0, d: 1.0, h: 1.0, kind: 'crate' },
  gunrack: { m: 'metal_dark', w: 1.5, d: 0.4, h: 2.0, kind: 'locker' },
  locker: { m: 'metal', w: 0.6, d: 0.5, h: 1.9, kind: 'locker' },
  filing: { m: 'metal', w: 0.5, d: 0.6, h: 1.3, kind: 'cabinet' },
  bench: { m: 'wood_dark', w: 2.0, d: 0.5, h: 0.45 },
} satisfies Record<string, Furn>;

/** What lines the side walls of each room purpose. */
const SIDE_POOLS: Record<string, Furn[]> = {
  living: [F.couch, F.cabinet, F.bookshelf, F.tvstand],
  kitchen: [F.fridge, F.counter, F.stove, F.counter],
  bedroom: [F.bed, F.wardrobe, F.desk, F.nightstand],
  bath: [F.bathcab, F.tub],
  shop_grocery: [F.shopfridge, F.shopfridge, F.shelf],
  shop_pharmacy: [F.shelf, F.shelf, F.cabinet],
  shop_hardware: [F.shelf, F.shelf, F.crate],
  shop_gun: [F.gunrack, F.gunrack, F.shelf],
  storage: [F.shelf, F.crate, F.crate],
  lobby: [F.bench, F.filing],
  office: [F.desk, F.filing, F.desk],
  lockers: [F.locker, F.locker, F.locker, F.bench],
  armory: [F.gunrack, F.locker, F.crate],
};

// ------------------------------------------------------------------ builder

interface Opening {
  a: number;
  b: number;
  y0: number;
  y1: number;
  kind: 'door' | 'window' | 'gap';
  /** Door swing: +1/-1 quarter turn (see DoorDef). */
  swing?: 1 | -1;
  open?: boolean;
  /** Hinge on the high end of the opening instead of the low end. */
  hingeRight?: boolean;
}

export const WALL_T = CITY.wallThickness;
const T = WALL_T;
const IT = 0.15;
/** Local z where each flight of stairs starts (front edge of the first step). Leaves a walkway along the front wall. */
export const STAIR_Z0 = T + 1.6;
const SLAB = 0.2;

export const buildBuilding = (
  ctx: GenContext,
  type: BuildingType,
  cx: number,
  cz: number,
  q: 0 | 1 | 2 | 3,
  W: number,
  D: number,
  floors: number,
  groundY: number,
): BuildingInfo => {
  const { boxes, rand } = ctx;
  const spec = BUILDING_SPECS[type];
  const fr = new Frame(cx, cz, W, D, q);
  const id = ctx.buildings.length;
  const FH = CITY.floorHeight;
  const ext = pick(rand, spec.exterior);
  const SW = CITY.stairWidth;
  const stairZ0 = STAIR_Z0;
  const zoneEnd = stairZ0 + FH + 0.05; // stairs are 45 degrees: run == rise
  const stairSide = (f: number): 'left' | 'right' => (f % 2 === 0 ? 'left' : 'right');
  const strip = (side: 'left' | 'right'): [number, number] => (side === 'left' ? [T, T + SW] : [W - T - SW, W - T]);
  const push = (b: MapBox) => boxes.push(b);

  /** Emit a door panel definition for an opening in a wall along local X or Z. */
  const addDoor = (axis: 'x' | 'z', o: Opening, wallCenter: number, y: number, exterior: boolean) => {
    const width = o.b - o.a - 0.02;
    const h = o.hingeRight ? o.b - 0.01 : o.a + 0.01;
    const [hx, hz] = axis === 'x' ? fr.pt(h, wallCenter) : fr.pt(wallCenter, h);
    // Local panel yaw, direction = (cos a, -sin a): +x is 0, -x is PI, +z is -PI/2, -z is PI/2.
    const localYaw = axis === 'x' ? (o.hingeRight ? Math.PI : 0) : o.hingeRight ? Math.PI / 2 : -Math.PI / 2;
    ctx.doors.push({
      id: ctx.doors.length,
      hinge: [hx, y, hz],
      width,
      height: o.y1 - o.y0 - 0.02,
      yaw: fr.yaw(localYaw),
      swing: o.swing ?? -1,
      buildingId: id,
      startsOpen: o.open ?? rand() < (exterior ? 0.4 : CITY.doorOpenChance),
    });
  };

  /**
   * A wall with rectangular openings, as solid segments + lintels + sills (+ glass).
   * axis 'x': runs along local X between x=from..to, occupying z in [f0, f1].
   */
  const wall = (
    axis: 'x' | 'z', f0: number, f1: number, from: number, to: number,
    yb: number, h: number, openings: Opening[], m: string, detail: boolean, exterior: boolean,
  ) => {
    const seg = (a: number, b: number, y0: number, y1: number, mm = m, extra?: Partial<MapBox>) => {
      if (b - a < 0.01 || y1 - y0 < 0.01) return;
      push(axis === 'x'
        ? fr.box(a, b, yb + y0, yb + y1, f0, f1, mm, { d: detail || undefined, ...extra })
        : fr.box(f0, f1, yb + y0, yb + y1, a, b, mm, { d: detail || undefined, ...extra }));
    };
    let cursor = from;
    for (const o of [...openings].sort((p, q2) => p.a - q2.a)) {
      seg(cursor, o.a, 0, h);
      seg(o.a, o.b, 0, o.y0);
      seg(o.a, o.b, o.y1, h);
      if (o.kind === 'window') {
        const c = (f0 + f1) / 2;
        push(axis === 'x'
          ? fr.box(o.a, o.b, yb + o.y0, yb + o.y1, c - 0.02, c + 0.02, 'glass')
          : fr.box(c - 0.02, c + 0.02, yb + o.y0, yb + o.y1, o.a, o.b, 'glass'));
      } else if (o.kind === 'door') {
        addDoor(axis, o, (f0 + f1) / 2, yb, exterior);
      }
      cursor = o.b;
    }
    seg(cursor, to, 0, h);
  };

  /** Windows spaced along [from, to], skipping existing openings. */
  const windows = (from: number, to: number, existing: Opening[], big: boolean): Opening[] => {
    const out: Opening[] = [];
    const w = big ? 2.6 : 1.2;
    const spacing = big ? 3.4 : 3.0;
    for (let a = from + 0.8; a + w <= to - 0.8; a += spacing) {
      const b = a + w;
      if (existing.some((o) => a < o.b + 0.4 && b > o.a - 0.4)) continue;
      if (!big && rand() > 0.75) continue;
      const broken = rand() < 0.25;
      out.push({ a, b, y0: big ? 0.5 : 1.0, y1: big ? 2.5 : 2.2, kind: broken ? 'gap' : 'window' });
    }
    return out;
  };

  const doorAt = (center: number, swing: 1 | -1, open?: boolean, hingeRight?: boolean): Opening => ({
    a: center - CITY.doorWidth / 2,
    b: center + CITY.doorWidth / 2,
    y0: 0,
    y1: CITY.doorHeight,
    kind: 'door',
    swing,
    open,
    hingeRight,
  });

  const placeSide = (side: 'left' | 'right', z0: number, z1: number, y: number, pool: Furn[]) => {
    let z = z0 + 0.2;
    for (let guard = 0; guard < 20; guard++) {
      const f = pick(rand, pool);
      if (z + f.w > z1 - 0.2) break;
      const x0 = side === 'left' ? T : W - T - f.d;
      push(fr.box(x0, x0 + f.d, y, y + f.h, z, z + f.w, f.m, { d: true }));
      if (f.kind) addContainer(f.kind, x0 + f.d / 2, y + f.h / 2, z + f.w / 2, f.d, f.h, f.w);
      z += f.w + 0.15 + rand() * 0.9;
    }
  };

  /** Register lootable furniture; (sx, sy, sz) is its local box size. */
  const addContainer = (kind: ContainerKind, lx: number, y: number, lz: number, sx: number, sy: number, sz: number) => {
    const [x, z] = fr.pt(lx, lz);
    const s: [number, number, number] = fr.q % 2 === 1 ? [sz, sy, sx] : [sx, sy, sz];
    ctx.containers.push({ id: ctx.containers.length, kind, p: [x, y, z], s, lootTable: `${type}_${kind}`, buildingId: id });
  };

  /** Free-standing double-sided shelf rows / display cases through a shop's sales floor. */
  const shopRows = (z0: number, z1: number, y: number, purpose: string) => {
    const fractions = W >= 16 ? [0.3, 0.5, 0.7] : W >= 12 ? [0.35, 0.65] : [0.5];
    const gun = purpose === 'shop_gun';
    for (const fx of fractions) {
      const cxRow = W * fx;
      for (let z = z0 + 3; z + 2 <= z1 - 1.6; z += 4) {
        const len = Math.min(3, z1 - 1.6 - z);
        const m = gun ? 'glasscase' : 'metal';
        const h = gun ? 1.0 : 1.6;
        push(fr.box(cxRow - 0.5, cxRow + 0.5, y, y + h, z, z + len, m, { d: true }));
        addContainer(gun ? 'cabinet' : 'shelf', cxRow, y + h / 2, z + len / 2, 1.0, h, len);
      }
    }
    // Checkout counter near the entrance.
    const cx0 = W - T - 3.2;
    push(fr.box(cx0, cx0 + 2.4, y, y + 1.0, z0 + 1.0, z0 + 1.8, 'counter', { d: true }));
    addContainer('cabinet', cx0 + 1.2, y + 0.5, z0 + 1.4, 2.4, 1.0, 0.8);
  };

  /** A floor/roof slab whose top is at y, with a stairwell hole over the given side's stair strip. */
  const slabWithHole = (y: number, side: 'left' | 'right', m: string, railDetail: boolean) => {
    const [hx0, hx1] = strip(side);
    const hz0 = stairZ0 - 0.3;
    const hz1 = zoneEnd;
    const y0 = y - SLAB;
    push(fr.box(0, W, y0, y, 0, hz0, m));
    push(fr.box(0, W, y0, y, hz1, D, m));
    if (hx0 > 0) push(fr.box(0, hx0, y0, y, hz0, hz1, m));
    if (hx1 < W) push(fr.box(hx1, W, y0, y, hz0, hz1, m));
    // Railings around the open stairwell.
    const railX = side === 'left' ? hx1 : hx0 - 0.08;
    push(fr.box(railX, railX + 0.08, y, y + 1.0, hz0, hz1, 'metal_dark', { d: railDetail || undefined }));
    push(fr.box(hx0, hx1, y, y + 1.0, hz0, hz0 + 0.08, 'metal_dark', { d: railDetail || undefined }));
  };

  // ---- floors
  const multi = floors > 1;
  /** Multi-floor buildings get one more flight from the top floor up through a roof hatch. */
  const roofAccess = multi;
  const flights = roofAccess ? floors : floors - 1;
  for (let f = 0; f < floors; f++) {
    const y = groundY + f * FH;
    const h = FH - SLAB;

    // Slab (with a stairwell hole above the stairs from the floor below).
    if (f === 0) push(fr.box(0, W, 0, y, 0, D, spec.floor));
    else slabWithHole(y, stairSide(f - 1), spec.floor, true);

    // Exterior walls.
    // Front door hinges on the right and swings inwards, so when open it never blocks the
    // walkway to the ground-floor stairs (always on the left).
    const front: Opening[] = f === 0 ? [doorAt(W / 2, 1, undefined, true)] : [];
    const back: Opening[] = f === 0 ? [doorAt(randRange(rand, W * 0.3, W * 0.7), 1)] : [];
    front.push(...windows(0, W, front, spec.shop && f === 0));
    back.push(...windows(0, W, back, false));
    wall('x', 0, T, 0, W, y, h, front, ext, false, true);
    wall('x', D - T, D, 0, W, y, h, back, ext, false, true);
    wall('z', 0, T, T, D - T, y, h, windows(T, D - T, [], false), ext, false, true);
    wall('z', W - T, W, T, D - T, y, h, windows(T, D - T, [], false), ext, false, true);

    // Stairs up to the next floor (switchback sides each floor).
    const sidesBlocked = new Set<string>();
    if (f < flights) sidesBlocked.add(stairSide(f));
    if (f > 0) sidesBlocked.add(stairSide(f - 1));
    if (f < flights) {
      const [sx0, sx1] = strip(stairSide(f));
      const [wx, wz] = fr.pt((sx0 + sx1) / 2, stairZ0);
      const before = boxes.length;
      addStairs(boxes, { x: wx, y, z: wz, dir: fr.dir('+z'), width: SW, height: FH, steps: 16, m: 'stairs' });
      for (let i = before; i < boxes.length; i++) boxes[i].d = true;
    }

    // Interior cross walls split the floor into rooms, front to back.
    const purposes = spec.rooms(f, rand);
    const cuts: number[] = [];
    if (spec.shop) {
      cuts.push(Math.round(D * 0.72 * 2) / 2);
    } else {
      let c = (multi ? zoneEnd + 1.6 : T + 4) + randRange(rand, 0.5, 2);
      while (c < D - T - 3.5 && cuts.length < purposes.length - 1) {
        cuts.push(c);
        c += randRange(rand, 4, 6);
      }
    }
    for (const c of cuts) {
      const door = doorAt(randRange(rand, W * 0.3, W * 0.7), rand() < 0.5 ? -1 : 1);
      wall('x', c - IT / 2, c + IT / 2, T, W - T, y, h, [door], 'plaster', true, false);
    }

    // Furnish rooms.
    const bounds = [T, ...cuts.map((c) => c), D - T];
    for (let r = 0; r < bounds.length - 1; r++) {
      const purpose = purposes[Math.min(r, purposes.length - 1)];
      const z0 = bounds[r] + (r > 0 ? IT / 2 : 0);
      const z1 = bounds[r + 1] - (r < bounds.length - 2 ? IT / 2 : 0);
      const pool = SIDE_POOLS[purpose] ?? SIDE_POOLS.living;
      for (const side of ['left', 'right'] as const) {
        // Keep a clear landing where stairs arrive / depart.
        const start = r === 0 && sidesBlocked.has(side) ? zoneEnd + 1.4 : spec.shop && r === 0 ? z0 + 2.8 : z0;
        placeSide(side, start, z1, y, pool);
      }
      if (purpose.startsWith('shop_')) shopRows(z0, z1, y, purpose);
    }
  }

  // ---- roof (with a hatch over the last flight when the building has roof access)
  const top = groundY + floors * FH;
  if (roofAccess) slabWithHole(top, stairSide(floors - 1), 'roof', false);
  else push(fr.box(0, W, top - SLAB, top, 0, D, 'roof'));
  push(fr.box(0, W, top, top + 0.6, 0, 0.2, ext));
  push(fr.box(0, W, top, top + 0.6, D - 0.2, D, ext));
  push(fr.box(0, 0.2, top, top + 0.6, 0.2, D - 0.2, ext));
  push(fr.box(W - 0.2, W, top, top + 0.6, 0.2, D - 0.2, ext));

  // ---- storefront sign
  const sign = SIGNS[type];
  if (sign) {
    const sw = Math.min(W * 0.6, 8);
    push(fr.box(W / 2 - sw / 2, W / 2 + sw / 2, groundY + 2.35, groundY + 3.0, -0.15, 0, sign, { col: false }));
  }

  const info: BuildingInfo = {
    id, type, bounds: fr.bounds(), floors, floorY: groundY, center: [cx, cz], size: [W, D], rot: q,
  };
  ctx.buildings.push(info);
  return info;
};

export const rollBuildingSize = (rand: () => number, type: BuildingType) => {
  const s = BUILDING_SPECS[type];
  return {
    W: randInt(rand, s.w[0], s.w[1]),
    D: randInt(rand, s.d[0], s.d[1]),
    floors: randInt(rand, s.floors[0], s.floors[1]),
  };
};
