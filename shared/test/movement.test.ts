import { test } from 'node:test';
import assert from 'node:assert/strict';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  Buttons,
  CharacterMotor,
  TICK_DT,
  buildMapColliders,
  createMoveState,
  generateTestMap,
  type MoveInput,
  type MoveState,
} from '../src/index';

await RAPIER.init();

const makeWorld = () => {
  const world = new RAPIER.World({ x: 0, y: 0, z: 0 });
  buildMapColliders(RAPIER, world, generateTestMap());
  world.step();
  return world;
};

const run = (motor: CharacterMotor, s: MoveState, inputs: MoveInput[]): MoveState => {
  for (const i of inputs) s = motor.step(s, i, TICK_DT);
  return s;
};

const inputs = (n: number, f: Partial<MoveInput>): MoveInput[] =>
  Array.from({ length: n }, (_, k) => ({ seq: k, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0, ...f }));

test('player falls onto the ground and stands on it', () => {
  const world = makeWorld();
  const s0 = createMoveState({ x: 0, y: 3, z: 0 });
  const motor = new CharacterMotor(RAPIER, world, s0);
  const s = run(motor, s0, inputs(60, {}));
  assert.ok(s.grounded, 'should be grounded');
  assert.ok(Math.abs(s.pos.y) < 0.1, `feet near y=0, got ${s.pos.y}`);
});

test('walking forward moves along -Z at roughly walk speed', () => {
  const world = makeWorld();
  let s = createMoveState({ x: 0, y: 0.05, z: 0 });
  const motor = new CharacterMotor(RAPIER, world, s);
  s = run(motor, s, inputs(10, {}));
  const z0 = s.pos.z;
  s = run(motor, s, inputs(30, { mz: 1 }));
  assert.ok(s.pos.z < z0 - 3, `moved forward, dz=${s.pos.z - z0}`);
});

test('jump leaves the ground and costs stamina', () => {
  const world = makeWorld();
  let s = createMoveState({ x: 0, y: 0.05, z: 0 });
  const motor = new CharacterMotor(RAPIER, world, s);
  s = run(motor, s, inputs(10, {}));
  s = run(motor, s, inputs(5, { b: Buttons.jump }));
  assert.ok(s.pos.y > 0.3, `in the air, y=${s.pos.y}`);
  assert.ok(s.stamina < 100);
});

test('replaying the same inputs from the same state is deterministic', () => {
  const seq = [
    ...inputs(20, { mz: 1, b: Buttons.sprint }),
    ...inputs(10, { mx: 1, yaw: 1.2, b: Buttons.jump }),
    ...inputs(20, { mz: -1, yaw: 2.5, b: Buttons.crouch }),
  ];
  const a = (() => {
    const w = makeWorld();
    const s = createMoveState({ x: 3, y: 0.05, z: 3 });
    return run(new CharacterMotor(RAPIER, w, s), s, seq);
  })();
  const b = (() => {
    const w = makeWorld();
    const s = createMoveState({ x: 3, y: 0.05, z: 3 });
    return run(new CharacterMotor(RAPIER, w, s), s, seq);
  })();
  assert.deepEqual(a, b);
});

test('cannot stand up under the crouch tunnel roof', () => {
  const world = makeWorld();
  let s = createMoveState({ x: 1, y: 0.05, z: 25 });
  s.crouching = true;
  const motor = new CharacterMotor(RAPIER, world, s);
  s = run(motor, s, inputs(10, {}));
  assert.ok(s.crouching, 'still crouching under low roof');
});

test('stairs lead up to the rooftop', () => {
  const world = makeWorld();
  // Bottom of the staircase, facing -Z
  let s = createMoveState({ x: 13, y: 0.05, z: -9.5 });
  const motor = new CharacterMotor(RAPIER, world, s);
  s = run(motor, s, inputs(5, {}));
  let maxY = 0;
  for (const i of inputs(150, { mz: 1 })) {
    s = motor.step(s, i, TICK_DT);
    maxY = Math.max(maxY, s.pos.y);
  }
  assert.ok(maxY > 5.5, `climbed stairs, peak y=${maxY.toFixed(2)}`);
});
