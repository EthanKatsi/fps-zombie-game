import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  CITY,
  CharacterMotor,
  DoorColliders,
  MOVEMENT,
  PLAYER_GROUPS,
  TICK_DT,
  buildMapColliders,
  createMoveState,
  generateCity,
  hashMap,
  type MapData,
  type MoveInput,
  type MoveState,
} from '../src/index';
import { Frame, STAIR_Z0, WALL_T } from '../src/world/city/buildings';

await RAPIER.init();

const SEED = 1337;
let t0 = performance.now();
const city = generateCity(SEED);
const genMs = performance.now() - t0;

const makeWorld = (map: MapData) => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  buildMapColliders(RAPIER, world, map);
  const doors = new DoorColliders(RAPIER, world, map.doors);
  world.step();
  return { world, doors };
};

t0 = performance.now();
const { world, doors } = makeWorld(city);
const physicsMs = performance.now() - t0;

const walk = (motor: CharacterMotor, s: MoveState, n: number, f: Partial<MoveInput>) => {
  for (let i = 0; i < n; i++) s = motor.step(s, { seq: i, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, ...f }, TICK_DT);
  return s;
};

test('city stats and timing', () => {
  const counts: Record<string, number> = {};
  for (const b of city.buildings) counts[b.type] = (counts[b.type] ?? 0) + 1;
  console.log(
    `  boxes=${city.boxes.length} doors=${city.doors.length} containers=${city.containers.length} ` +
      `buildings=${JSON.stringify(counts)} gen=${genMs.toFixed(0)}ms physics=${physicsMs.toFixed(0)}ms`,
  );
  for (const [type, n] of CITY.requiredBuildings) assert.ok((counts[type] ?? 0) >= n, `has ${n} ${type}`);
  assert.equal(counts.police, 1);
  assert.ok(genMs < 1500, 'generation is fast');
});

test('generation is deterministic', () => {
  assert.equal(hashMap(generateCity(SEED)), hashMap(city));
  assert.notEqual(hashMap(generateCity(SEED + 1)), hashMap(city));
});

test('every spawn point is free of geometry', () => {
  const shape = new RAPIER.Capsule(MOVEMENT.standHeight / 2 - MOVEMENT.radius, MOVEMENT.radius);
  for (const p of city.spawnPoints) {
    const hit = world.intersectionWithShape(
      { x: p.x, y: p.y + MOVEMENT.standHeight / 2 + 0.05, z: p.z }, { x: 0, y: 0, z: 0, w: 1 }, shape,
      undefined, PLAYER_GROUPS,
    );
    assert.equal(hit, null, `spawn ${JSON.stringify(p)} blocked`);
  }
});

const twoStoryHouse = city.buildings.find((b) => b.type === 'house' && b.floors === 2)!;
const frameOf = (b: typeof twoStoryHouse) => new Frame(b.center[0], b.center[1], b.size[0], b.size[1], b.rot);
const frontDoor = city.doors.find((d) => d.buildingId === twoStoryHouse.id)!;

/** Yaw that makes the player walk along local +z (into the building) for this frame. */
const inwardYaw = (fr: Frame) => {
  const [ax, az] = fr.pt(0, 0);
  const [bx, bz] = fr.pt(0, 1);
  return Math.atan2(-(bx - ax), -(bz - az));
};

test('a closed front door blocks entry, an open one lets you in', () => {
  const fr = frameOf(twoStoryHouse);
  const yaw = inwardYaw(fr);
  const [W] = twoStoryHouse.size;
  const run = (open: boolean) => {
    doors.set(frontDoor.id, open);
    world.step();
    const [x, z] = fr.pt(W / 2, -1.5); // just outside the front door
    let s = createMoveState({ x, y: CITY.curbHeight + 0.05, z }, yaw);
    const motor = new CharacterMotor(RAPIER, world, s);
    s = walk(motor, s, 90, { mz: 1, yaw });
    motor.dispose();
    // Distance travelled into the building along local +z.
    const [ox, oz] = fr.pt(W / 2, 0);
    const [ix, iz] = fr.pt(W / 2, 1);
    return (s.pos.x - ox) * (ix - ox) + (s.pos.z - oz) * (iz - oz);
  };
  assert.ok(run(false) < 0, 'stays outside when closed');
  assert.ok(run(true) > 2, 'gets inside when open');
});

test('stairs inside a two-story house reach the upper floor', () => {
  const fr = frameOf(twoStoryHouse);
  const yaw = inwardYaw(fr);
  const lx = WALL_T + CITY.stairWidth / 2;
  const [x, z] = fr.pt(lx, STAIR_Z0 - 0.6);
  let s = createMoveState({ x, y: twoStoryHouse.floorY + 0.05, z }, yaw);
  const motor = new CharacterMotor(RAPIER, world, s);
  s = walk(motor, s, 10, { yaw });
  s = walk(motor, s, 100, { mz: 1, yaw });
  motor.dispose();
  const upper = twoStoryHouse.floorY + CITY.floorHeight;
  assert.ok(Math.abs(s.pos.y - upper) < 0.15, `on the upper floor: y=${s.pos.y.toFixed(2)} expected ${upper}`);
});

for (const kind of ['house', 'apartment', 'police'] as const) test(`you can walk from the street door of a ${kind} up to its roof`, () => {
  const apt = city.buildings.find((b) => b.type === kind && b.floors > 1)!;
  const fr = frameOf(apt);
  const [W, D] = apt.size;
  const FH = CITY.floorHeight;
  const zoneEnd = STAIR_Z0 + FH + 0.05;
  const stripX = (f: number) => (f % 2 === 0 ? WALL_T + CITY.stairWidth / 2 : W - WALL_T - CITY.stairWidth / 2);
  // Make sure the doors on our route are open.
  for (const d of city.doors) if (d.buildingId === apt.id) doors.set(d.id, true);
  world.step();

  // Route in local coordinates: in through the front door, then for each flight walk around to its
  // foot (front of the building), climb, and step off onto the landing.
  const route: [number, number][] = [[W / 2, -1.5], [W / 2, 2.6]];
  for (let f = 0; f < apt.floors; f++) {
    route.push([W / 2, STAIR_Z0 - 0.8], [stripX(f), STAIR_Z0 - 0.8], [stripX(f), zoneEnd + 0.7], [W / 2, zoneEnd + 0.7]);
  }
  let [sx, sz] = fr.pt(route[0][0], route[0][1]);
  let s = createMoveState({ x: sx, y: CITY.curbHeight + 0.05, z: sz });
  const motor = new CharacterMotor(RAPIER, world, s);
  for (const [lx, lz] of route.slice(1)) {
    const [tx, tz] = fr.pt(lx, lz);
    for (let i = 0; i < 300; i++) {
      const dx = tx - s.pos.x, dz = tz - s.pos.z;
      if (Math.hypot(dx, dz) < 0.25) break;
      s = motor.step(s, { seq: i, mx: 0, mz: 1, yaw: Math.atan2(-dx, -dz), pitch: 0, b: 0 }, TICK_DT);
    }
    const [ex, ez] = fr.pt(lx, lz);
    assert.ok(Math.hypot(ex - s.pos.x, ez - s.pos.z) < 0.6, `stuck before waypoint (${lx.toFixed(1)}, ${lz.toFixed(1)}) at y=${s.pos.y.toFixed(2)}`);
  }
  motor.dispose();
  const roof = apt.floorY + apt.floors * FH;
  assert.ok(Math.abs(s.pos.y - roof) < 0.2, `on the roof: y=${s.pos.y.toFixed(2)} expected ${roof.toFixed(2)}`);
  void D;
});

test('walking from the road onto a curb keeps speed', () => {
  // Find a straight run from the ring road onto the first block's sidewalk.
  const half = city.halfSize;
  const S = CITY.streetWidth;
  const bx = -half + S + 20; // middle-ish of the first block's edge, avoiding corner lamps
  let s = createMoveState({ x: bx, y: 0.05, z: -half + S - 4 });
  const motor = new CharacterMotor(RAPIER, world, s);
  s = walk(motor, s, 10, {});
  const zStart = s.pos.z;
  // Walk +Z (yaw = PI faces +Z) for 1.5 s: road -> curb -> sidewalk.
  s = walk(motor, s, 45, { mz: 1, yaw: Math.PI });
  motor.dispose();
  assert.ok(s.pos.y > CITY.curbHeight - 0.05, `stepped up onto the curb, y=${s.pos.y.toFixed(2)}`);
  assert.ok(s.pos.z - zStart > 5.2, `kept moving: ${(s.pos.z - zStart).toFixed(2)} m`);
});
