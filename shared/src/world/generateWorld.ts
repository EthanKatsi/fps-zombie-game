import { CITY, WORLD } from '../config/world';
import { VEHICLE_TYPE_ORDER, type VehicleType } from '../config/vehicles';
import { mulberry32 } from '../math/math';
import type { MapBox, MapData, VehicleSpawn } from './mapData';
import { CITY_GRID, addCar, addDebris, addLeafyTree, generateGrid, type GridResult } from './city/generateCity';
import { buildBuilding, pick, randRange, rollBuildingSize, type GenContext } from './city/buildings';

/**
 * The full world (map id 'world'): downtown (walled, north-east), suburbs (south-east),
 * a big forest in the west with cabins and a campground, connected by highways and dirt
 * roads, with a gas station and army checkpoints at the city gates. Deterministic per seed.
 *
 * Surface heights (all collide): meadow ground top -0.06, forest floor -0.03, roads and the
 * city/suburb slabs 0. The small steps are below every character's / vehicle's step height.
 */

interface Road {
  axis: 'x' | 'z';
  /** Fixed coordinate (z for an 'x' road, x for a 'z' road). */
  c: number;
  from: number;
  to: number;
  width: number;
  dirt: boolean;
}

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const GROUND_Y = -0.06;
const FOREST_Y = -0.03;

export const generateWorld = (seed: number): MapData => {
  const rand = mulberry32(seed);
  const H = WORLD.halfSize;
  const out: MapData = {
    id: 'world', seed, halfSize: H,
    boxes: [], doors: [], buildings: [], containers: [], dummies: [], navLinks: [], spawnPoints: [], vehicleSpawns: [],
  };
  const { boxes } = out;

  // ---- ground: meadow everywhere, forest floor over the west
  boxes.push({ p: [0, GROUND_Y - 0.5, 0], s: [H * 2 + 60, 1, H * 2 + 60], m: 'grass' });
  const fx1 = WORLD.forest.maxX;
  boxes.push({ p: [(-H - 30 + fx1) / 2, FOREST_Y - 0.015, 0], s: [fx1 + H + 30, 0.03, H * 2 + 60], m: 'forest_floor' });

  // ---- downtown + suburbs (generated around the origin, then moved into place)
  const [ccx, ccz] = WORLD.city.center;
  const city = generateGrid(rand, seed, { ...CITY_GRID, id: 'world', wall: { height: CITY.perimeterWallHeight, gates: ['w', 's'] }, ringSpawns: 0, wreckage: WORLD.city.wreckage });
  merge(out, city, ccx, ccz);
  const sub = WORLD.suburbs;
  const [scx, scz] = sub.center;
  const suburbs = generateGrid(rand, seed, {
    id: 'world', blocksPerSide: sub.blocksPerSide, blockSize: sub.blockSize, streetWidth: sub.streetWidth,
    sidewalkWidth: CITY.sidewalkWidth, blockWeights: sub.blockWeights, requiredBuildings: sub.requiredBuildings,
    police: false, wall: null, ground: 'asphalt', groundMargin: 4, carsPer100m: sub.carsPer100m, debrisPer100m: 1,
    roadblocks: false, ringSpawns: 12, wreckage: sub.wreckage,
  });
  merge(out, suburbs, scx, scz);

  const cityRect: Rect = { x0: ccx - city.half - CITY_GRID.groundMargin, z0: ccz - city.half - CITY_GRID.groundMargin, x1: ccx + city.half + CITY_GRID.groundMargin, z1: ccz + city.half + CITY_GRID.groundMargin };
  const subRect: Rect = { x0: scx - suburbs.half - 4, z0: scz - suburbs.half - 4, x1: scx + suburbs.half + 4, z1: scz + suburbs.half + 4 };

  // ---- roads (highways connect the city gates, the suburbs and the forest roads)
  const RW = WORLD.roadWidth;
  const DW = WORLD.dirtRoadWidth;
  const roads: Road[] = [
    { axis: 'x', c: 20, from: -H + 40, to: H - 40, width: RW, dirt: false }, // A: east-west highway between city and suburbs
    { axis: 'z', c: ccx, from: cityRect.z1, to: subRect.z0, width: RW, dirt: false }, // B: city south gate -> suburbs
    { axis: 'x', c: ccz, from: -H + 40, to: cityRect.x0, width: RW, dirt: false }, // C: city west gate -> forest
    { axis: 'x', c: scz, from: -300 + DW / 2, to: subRect.x0, width: RW, dirt: false }, // D: suburbs -> forest
    { axis: 'z', c: -300, from: -H + 40, to: H - 40, width: DW, dirt: true }, // E: forest road north-south
    { axis: 'z', c: -520, from: -H + 80, to: 20 - RW / 2, width: DW, dirt: true }, // F: western forest road
    { axis: 'x', c: -480, from: -520 + DW / 2, to: -300 - DW / 2, width: DW, dirt: true }, // G: northern loop
    { axis: 'x', c: 480, from: -560, to: -300 - DW / 2, width: DW, dirt: true }, // K: southern trail
  ];
  layRoads(boxes, roads, rand);

  const ctx: GenContext = { boxes, doors: out.doors, containers: out.containers, buildings: out.buildings, dummies: out.dummies, navLinks: out.navLinks, rand };
  /** Places taken by cars, spawns and props (keeps everything from overlapping). */
  const taken: [number, number, number][] = [...city.carSpots.map(([x, z]) => [x + ccx, z + ccz, 3] as [number, number, number]), ...suburbs.carSpots.map(([x, z]) => [x + scx, z + scz, 3] as [number, number, number])];
  const free = (x: number, z: number, r: number) => taken.every(([tx, tz, tr]) => Math.hypot(tx - x, tz - z) > r + tr);
  const clearings: [number, number, number][] = [];

  // ---- gas station on the highway west of the suburbs
  const gas = gasStation(ctx, -80, 20 - RW / 2);
  clearings.push([gas.x, gas.z, 34]);
  taken.push([gas.x, gas.z, 26]);

  // ---- army checkpoints outside the two city gates
  checkpoint(ctx, cityRect.x0 - 14, ccz, 'x');
  checkpoint(ctx, ccx, cityRect.z1 + 14, 'z');
  taken.push([cityRect.x0 - 14, ccz, 16], [ccx, cityRect.z1 + 14, 16]);
  clearings.push([cityRect.x0 - 14, ccz, 22], [ccx, cityRect.z1 + 14, 22]);

  // ---- abandoned cars along the highways (one lane, so the roads stay drivable)
  for (const r of roads) {
    if (r.dirt) continue;
    const n = Math.round(((r.to - r.from) / 100) * 1.1);
    for (let i = 0; i < n; i++) {
      const along = randRange(rand, r.from + 10, r.to - 10);
      const lane = (rand() < 0.5 ? -1 : 1) * (r.width / 2 - 2.2);
      const [x, z] = r.axis === 'x' ? [along, r.c + lane] : [r.c + lane, along];
      if (!free(x, z, 5) || onRoadCrossing(roads, r, x, z)) continue;
      taken.push([x, z, 3]);
      addCar(ctx, x, 0, z, (r.axis === 'x' ? Math.PI / 2 : 0) + randRange(rand, -0.3, 0.3) + (rand() < 0.5 ? Math.PI : 0), 0.6);
    }
  }

  // ---- forest cabins (clearings beside the dirt roads) and a campground
  const forestRoads = roads.filter((r) => r.dirt);
  const cabins: { x: number; z: number; front: [number, number] }[] = [];
  for (let tries = 0; cabins.length < WORLD.cabins && tries < 200; tries++) {
    const r = pick(rand, forestRoads);
    const along = randRange(rand, r.from + 40, r.to - 40);
    const side = rand() < 0.5 ? -1 : 1;
    const off = r.width / 2 + 16;
    const [x, z] = r.axis === 'x' ? [along, r.c + side * off] : [r.c + side * off, along];
    if (clearings.some(([cx, cz, cr]) => Math.hypot(cx - x, cz - z) < cr + 30)) continue;
    if (roads.some((o) => o !== r && distToRoad(o, x, z) < o.width / 2 + 16)) continue;
    // Face the road: front is local -Z; q=0 faces -Z, 1 faces -X, 2 faces +Z, 3 faces +X.
    const q = (r.axis === 'x' ? (side > 0 ? 0 : 2) : side > 0 ? 1 : 3) as 0 | 1 | 2 | 3;
    const { W, D, floors } = rollBuildingSize(rand, 'house');
    boxes.push({ p: [x, FOREST_Y + 0.05, z], s: [W + 6, 0.1, D + 6], m: 'dirt' });
    buildBuilding(ctx, 'house', x, z, q, W, D, Math.min(floors, 1), 0.2);
    clearings.push([x, z, 22]);
    taken.push([x, z, 14]);
    const front: [number, number] = r.axis === 'x' ? [0, -side] : [-side, 0];
    cabins.push({ x, z, front });
    // Woodpile and a campfire ring in the yard.
    const yx = x + front[0] * (D / 2 + 4) + front[1] * 4, yz = z + front[1] * (D / 2 + 4) - front[0] * 4;
    for (let k = 0; k < 4; k++) boxes.push({ p: [yx, 0.2 + k * 0.32, yz], s: [2.4, 0.3, 0.3], r: [0, Math.PI / 2 * (r.axis === 'x' ? 1 : 0), Math.PI / 2], m: 'bark', d: true });
  }
  const camp = campground(ctx, -300 + DW / 2 + 22, 150);
  clearings.push([camp.x, camp.z, 30]);
  taken.push([camp.x, camp.z, 24]);

  // ---- world edge: a tall fence (with an invisible higher wall so nobody climbs out)
  for (const [axis, c] of [['x', -H], ['x', H], ['z', -H], ['z', H]] as const) {
    const vis: MapBox = axis === 'x' ? { p: [0, 1.5, c], s: [H * 2, 3, 0.15], m: 'fence_metal' } : { p: [c, 1.5, 0], s: [0.15, 3, H * 2], m: 'fence_metal' };
    boxes.push(vis, { ...vis, p: [vis.p[0], 6, vis.p[2]], s: [vis.s[0], 12, vis.s[2]], vis: false, m: 'concrete' });
  }

  // ---- forest + scattered field trees, rocks, logs and undergrowth
  const blocked = (x: number, z: number, margin: number) =>
    Math.abs(x) > H - 4 || Math.abs(z) > H - 4 ||
    inRect(cityRect, x, z, 8 + margin) || inRect(subRect, x, z, 6 + margin) ||
    roads.some((r) => distToRoad(r, x, z) < r.width / 2 + 2.5 + margin) ||
    clearings.some(([cx, cz, cr]) => Math.hypot(cx - x, cz - z) < cr + margin);
  const F = WORLD.forest;
  for (const [cell, fill, region] of [[F.cell, F.fill, 'forest'], [F.fieldCell, F.fieldFill, 'field']] as const) {
    for (let gx = -H; gx < H; gx += cell) {
      for (let gz = -H; gz < H; gz += cell) {
        const x = gx + rand() * cell, z = gz + rand() * cell;
        const inForest = x < fx1;
        if ((region === 'forest') !== inForest) continue;
        const roll = rand();
        if (blocked(x, z, 0)) continue;
        const y = inForest ? FOREST_Y : GROUND_Y;
        if (roll < fill) {
          if (rand() < (inForest ? F.pineShare : 0.25)) addPine(boxes, rand, x, y, z);
          else addLeafyTree(boxes, rand, x, y, z, randRange(rand, 1.2, 1.7));
        } else if (inForest && roll < fill + 0.05) {
          const s = randRange(rand, 1, 2.6);
          boxes.push({ p: [x, y + s * 0.3, z], s: [s * 1.3, s * 0.8, s], r: [0, rand() * Math.PI, 0], m: 'rock' });
        } else if (inForest && roll < fill + 0.08) {
          const len = randRange(rand, 4, 8);
          boxes.push({ p: [x, y + 0.3, z], s: [0.6, len, 0.6], r: [0, rand() * Math.PI, Math.PI / 2], m: 'bark' });
        }
        if (inForest && rand() < 0.45) {
          const s = randRange(rand, 0.8, 1.8);
          const bx = x + randRange(rand, -3, 3), bz = z + randRange(rand, -3, 3);
          if (!blocked(bx, bz, 0)) boxes.push({ p: [bx, y + s * 0.3, bz], s: [s, s * 0.6, s], r: [0, rand() * Math.PI, 0], m: 'bush', col: false, d: true });
        }
      }
    }
  }

  // ---- player spawn points: suburbs ring + road shoulders outside the city
  const outerRoads = roads.filter((r) => !(r.axis === 'z' && r.c === ccx)); // not the short city-gate road
  for (let tries = 0; out.spawnPoints.length < WORLD.spawnPoints + 12 && tries < 2000; tries++) {
    const r = pick(rand, outerRoads);
    const along = randRange(rand, r.from + 15, r.to - 15);
    const off = (rand() < 0.5 ? -1 : 1) * (r.width / 2 + 1.5);
    const [x, z] = r.axis === 'x' ? [along, r.c + off] : [r.c + off, along];
    if (inRect(cityRect, x, z, 60) || !free(x, z, 4) || Math.abs(x) > H - 10 || Math.abs(z) > H - 10) continue;
    taken.push([x, z, 2]);
    out.spawnPoints.push({ x, y: 0.1, z });
  }

  // ---- drivable vehicles
  const V = WORLD.vehicles;
  const rollType = (): VehicleType => {
    const r = rand();
    return r < V.motorcycleShare ? 'motorcycle' : r < V.motorcycleShare + V.pickupShare ? 'pickup' : 'sedan';
  };
  const park = (type: VehicleType, x: number, z: number, yaw: number) => {
    out.vehicleSpawns.push({ type, p: [x, 0.05, z], yaw });
    taken.push([x, z, 3.5]);
  };
  const onGrid = (g: GridResult, cx: number, cz: number, count: number) => {
    for (let tries = 0, n = 0; n < count && tries < 400; tries++) {
      const st = pick(rand, g.streets);
      const along = randRange(rand, st.from + 12, st.to - 12);
      // Not in an intersection: away from every perpendicular street.
      if (g.streets.some((o) => o.axis !== st.axis && Math.abs(o.c - along) < o.width / 2 + 4)) continue;
      const lane = (rand() < 0.5 ? -1 : 1) * (st.width / 2 - 2.2);
      const [lx, lz] = st.axis === 'x' ? [along, st.c + lane] : [st.c + lane, along];
      const x = lx + cx, z = lz + cz;
      if (!free(x, z, 4)) continue;
      park(rollType(), x, z, (st.axis === 'x' ? Math.PI / 2 : 0) + (rand() < 0.5 ? Math.PI : 0));
      n++;
    }
  };
  onGrid(suburbs, scx, scz, V.suburbs);
  onGrid(city, ccx, ccz, V.city);
  for (let tries = 0, n = 0; n < V.roads && tries < 400; tries++) {
    const r = pick(rand, roads.filter((o) => !o.dirt));
    const along = randRange(rand, r.from + 20, r.to - 20);
    const off = (rand() < 0.5 ? -1 : 1) * (r.width / 2 - 2.2); // parked in the outer lane
    const [x, z] = r.axis === 'x' ? [along, r.c + off] : [r.c + off, along];
    if (inRect(cityRect, x, z, 30) || !free(x, z, 4) || roads.some((o) => o !== r && distToRoad(o, x, z) < o.width / 2 + 4)) continue;
    park(rollType(), x, z, (r.axis === 'x' ? Math.PI / 2 : 0) + (rand() < 0.5 ? Math.PI : 0));
    n++;
  }
  for (const c of cabins.slice(0, V.forest)) {
    const x = c.x + c.front[0] * 11 + c.front[1] * 6, z = c.z + c.front[1] * 11 - c.front[0] * 6;
    park(rand() < 0.5 ? 'pickup' : 'motorcycle', x, z, Math.atan2(c.front[0], c.front[1]) + Math.PI / 2);
  }
  park('pickup', camp.x, camp.z - 18, Math.PI / 2);
  park('sedan', gas.x - 17, gas.z - 5, 0);
  park('motorcycle', gas.x + 17, gas.z - 5, 0);
  // Make sure every type exists at least once near the suburbs (they're where new players go).
  for (const t of VEHICLE_TYPE_ORDER) if (!out.vehicleSpawns.some((v) => v.type === t)) onGrid(suburbs, scx, scz, 1);

  return out;
};

// ------------------------------------------------------------------ helpers

const inRect = (r: Rect, x: number, z: number, margin: number) =>
  x > r.x0 - margin && x < r.x1 + margin && z > r.z0 - margin && z < r.z1 + margin;

const distToRoad = (r: Road, x: number, z: number): number => {
  const [a, c] = r.axis === 'x' ? [x, z] : [z, x];
  const along = Math.max(r.from, Math.min(r.to, a));
  return Math.hypot(a - along, c - r.c);
};

const onRoadCrossing = (roads: Road[], self: Road, x: number, z: number) =>
  roads.some((o) => o !== self && o.axis !== self.axis && distToRoad(o, x, z) < o.width / 2 + 6);

/** Road surfaces (collide, top at y=0). Later roads skip where they cross earlier ones. */
const layRoads = (boxes: MapBox[], roads: Road[], rand: () => number) => {
  roads.forEach((r, i) => {
    const cuts = roads
      .slice(0, i)
      .filter((o) => o.axis !== r.axis && o.c > r.from && o.c < r.to && r.c >= o.from - o.width / 2 && r.c <= o.to + o.width / 2)
      .map((o) => [o.c - o.width / 2, o.c + o.width / 2] as [number, number])
      .sort((a, b) => a[0] - b[0]);
    const segs: [number, number][] = [];
    let start = r.from;
    for (const [a, b] of cuts) {
      if (a > start) segs.push([start, a]);
      start = Math.max(start, b);
    }
    if (start < r.to) segs.push([start, r.to]);
    for (const [a, b] of segs) {
      const mid = (a + b) / 2, len = b - a;
      boxes.push(r.axis === 'x'
        ? { p: [mid, -0.03, r.c], s: [len, 0.06, r.width], m: r.dirt ? 'dirt' : 'asphalt' }
        : { p: [r.c, -0.03, mid], s: [r.width, 0.06, len], m: r.dirt ? 'dirt' : 'asphalt' });
      if (r.dirt) continue;
      // Faded centre line.
      for (let t = a + 3; t + 3 < b; t += 9) {
        if (rand() < 0.15) continue;
        boxes.push(r.axis === 'x'
          ? { p: [t + 1.5, 0.005, r.c], s: [3, 0.01, 0.15], m: 'paint', col: false, d: true }
          : { p: [r.c, 0.005, t + 1.5], s: [0.15, 0.01, 3], m: 'paint', col: false, d: true });
      }
    }
  });
};

/** Pine: trunk (collides) and three stacked cones. */
const addPine = (boxes: MapBox[], rand: () => number, x: number, y: number, z: number) => {
  const h = randRange(rand, 8, 15);
  const r = randRange(rand, 1.8, 2.8) * (h / 11);
  const tr = randRange(rand, 0.28, 0.42);
  boxes.push({ p: [x, y + h * 0.4, z], s: [tr * 2, h * 0.8, tr * 2], m: 'bark' });
  const yaw = rand() * Math.PI;
  boxes.push({ p: [x, y + h * 0.42, z], s: [r * 2, h * 0.42, r * 2], r: [0, yaw, 0], m: 'pine', col: false });
  boxes.push({ p: [x, y + h * 0.64, z], s: [r * 1.5, h * 0.36, r * 1.5], r: [0, yaw + 1, 0], m: 'pine', col: false });
  boxes.push({ p: [x, y + h * 0.84, z], s: [r * 0.95, h * 0.3, r * 0.95], r: [0, yaw + 2, 0], m: 'pine', col: false });
};

/** Moves a generated grid into place and appends it, renumbering ids. */
const merge = (dst: MapData, g: GridResult, dx: number, dz: number) => {
  const src = g.map;
  const bOff = dst.buildings.length, dOff = dst.doors.length, cOff = dst.containers.length, uOff = dst.dummies.length;
  const t = (p: [number, number, number]): [number, number, number] => [p[0] + dx, p[1], p[2] + dz];
  for (const b of src.boxes) dst.boxes.push({ ...b, p: t(b.p) });
  for (const d of src.doors) dst.doors.push({ ...d, id: d.id + dOff, hinge: t(d.hinge), buildingId: d.buildingId + bOff });
  for (const c of src.containers) dst.containers.push({ ...c, id: c.id + cOff, p: t(c.p), buildingId: c.buildingId === null ? null : c.buildingId + bOff });
  for (const b of src.buildings) {
    dst.buildings.push({
      ...b, id: b.id + bOff,
      bounds: [b.bounds[0] + dx, b.bounds[1] + dz, b.bounds[2] + dx, b.bounds[3] + dz],
      center: [b.center[0] + dx, b.center[1] + dz],
    });
  }
  for (const u of src.dummies) dst.dummies.push({ ...u, id: u.id + uOff, p: t(u.p) });
  for (const l of src.navLinks) dst.navLinks.push({ a: t(l.a), b: t(l.b) });
  for (const s of src.spawnPoints) dst.spawnPoints.push({ x: s.x + dx, y: s.y, z: s.z + dz });
};

/** Highway gas station: canopy over pumps and a small shop behind them (north of the road). */
const gasStation = (ctx: GenContext, x: number, roadEdgeZ: number) => {
  const { boxes, rand } = ctx;
  const z = roadEdgeZ - 22; // centre of the lot
  boxes.push({ p: [x, -0.03, z], s: [44, 0.06, 44], m: 'lot_asphalt' });
  // Canopy on four posts over two pump islands.
  for (const [px, pz] of [[-8, 6], [8, 6], [-8, 16], [8, 16]]) boxes.push({ p: [x + px, 2.4, z + pz], s: [0.35, 4.8, 0.35], m: 'metal' });
  boxes.push({ p: [x, 4.95, z + 11], s: [22, 0.5, 14], m: 'sign_white' });
  boxes.push({ p: [x, 5.25, z + 11], s: [22.2, 0.2, 14.2], m: 'sign_red', col: false });
  for (const px of [-4, 4]) {
    boxes.push({ p: [x + px, 0.12, z + 11], s: [1.2, 0.24, 7], m: 'concrete' });
    for (const pz of [-2, 2]) boxes.push({ p: [x + px, 0.95, z + 11 + pz], s: [0.7, 1.5, 0.5], m: 'appliance' });
  }
  // Shop at the back, facing the road (+Z).
  buildBuilding(ctx, 'grocery', x, z - 9, 2, 16, 12, 1, 0.2);
  if (rand() < 0.8) addCar(ctx, x + 15, 0, z + 14, Math.PI / 2 + randRange(rand, -0.2, 0.2), 0.5);
  return { x, z };
};

/** Abandoned army checkpoint astride a gate road: sandbag walls, a barrier chicane, tents and a truck. */
const checkpoint = (ctx: GenContext, x: number, z: number, roadAxis: 'x' | 'z') => {
  const { boxes, rand } = ctx;
  // u = along the road, v = across it.
  const P = (u: number, v: number): [number, number] => (roadAxis === 'x' ? [x + u, z + v] : [x + v, z + u]);
  const S = (su: number, sv: number): [number, number] => (roadAxis === 'x' ? [su, sv] : [sv, su]);
  for (const side of [-1, 1]) {
    const [bx, bz] = P(0, side * 8.5);
    const [sx, sz] = S(16, 1.2);
    boxes.push({ p: [bx, 0.6, bz], s: [sx, 1.2, sz], m: 'sandbag' });
    // Tent beside the road.
    const [tx, tz] = P(randRange(rand, -4, 4), side * 15);
    const [tsx, tsz] = S(6, 4);
    boxes.push({ p: [tx, 1.2, tz], s: [tsx, 2.4, tsz], m: 'tent' });
  }
  // Chicane: barriers alternately blocking each half of the road (a car can weave through).
  for (const [u, v] of [[-6, -2.5], [6, 2.5]]) {
    const [bx, bz] = P(u, v);
    const [sx, sz] = S(0.6, 6);
    boxes.push({ p: [bx, 0.45, bz], s: [sx, 0.9, sz], m: 'concrete_barrier' });
  }
  // Army truck parked on the shoulder.
  const [tx, tz] = P(-4, 11.5);
  const yaw = roadAxis === 'x' ? Math.PI / 2 : 0;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  boxes.push({ p: [tx, 1.1, tz], s: [2.4, 1.6, 7], r: [0, yaw, 0], m: 'military' });
  boxes.push({ p: [tx + fx * 2.4, 2.2, tz + fz * 2.4], s: [2.3, 1.2, 2], r: [0, yaw, 0], m: 'military' });
  boxes.push({ p: [tx - fx * 1.2, 2.6, tz - fz * 1.2], s: [2.5, 1.8, 4.6], r: [0, yaw, 0], m: 'tent' });
  for (let i = 0; i < 6; i++) {
    const [dx, dz] = P(randRange(rand, -10, 10), randRange(rand, -7, 7));
    addDebris(boxes, rand, dx, 0, dz);
  }
};

/** Campground: tents around a fire pit, picnic tables and supply crates (lootable). */
const campground = (ctx: GenContext, x: number, z: number) => {
  const { boxes, rand } = ctx;
  boxes.push({ p: [x, FOREST_Y + 0.05, z], s: [40, 0.1, 40], m: 'dirt' });
  boxes.push({ p: [x, 0.25, z], s: [2, 0.3, 2], m: 'rock', col: false });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + randRange(rand, -0.2, 0.2);
    const r = randRange(rand, 9, 13);
    const tx = x + Math.cos(a) * r, tz = z + Math.sin(a) * r;
    boxes.push({ p: [tx, 0.9, tz], s: [3, 1.8, 3.6], r: [0, -a, 0], m: 'tent' });
    if (i % 2 === 0) {
      const cx = x + Math.cos(a + 0.35) * (r - 3), cz = z + Math.sin(a + 0.35) * (r - 3);
      boxes.push({ p: [cx, 0.45, cz], s: [0.9, 0.9, 0.9], m: 'crate' });
      ctx.containers.push({ id: ctx.containers.length, kind: 'crate', p: [cx, 0.45, cz], s: [0.9, 0.9, 0.9], lootTable: 'street_car_trunk', buildingId: null });
    }
  }
  for (const [px, pz] of [[-5, -6], [6, 5]]) {
    boxes.push({ p: [x + px, 0.75, z + pz], s: [2.2, 0.08, 0.9], m: 'wood', d: true });
    boxes.push({ p: [x + px, 0.4, z + pz], s: [2.2, 0.06, 0.3], m: 'wood', d: true, col: false });
  }
  return { x, z };
};
