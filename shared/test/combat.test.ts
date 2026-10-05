import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ITEMS,
  WEAPONS,
  aimDirection,
  humanoidHitboxes,
  pelletDirections,
  rayHitboxes,
  shotSeed,
  spreadDegrees,
  weaponForItem,
} from '../src/index';

test('every weapon item maps to a weapon definition, and empty hands are fists', () => {
  for (const def of Object.values(ITEMS)) if (def.weaponId) assert.ok(WEAPONS[def.weaponId], def.id);
  assert.equal(weaponForItem(null).id, 'fists');
  assert.equal(weaponForItem('canned_beans').id, 'fists');
  assert.equal(weaponForItem('shotgun').id, 'shotgun');
});

test('pellets are deterministic per seed and stay inside the cone', () => {
  const dir = aimDirection(0.7, 0.1);
  const a = pelletDirections(dir, 5, 8, shotSeed(1234, 7));
  const b = pelletDirections(dir, 5, 8, shotSeed(1234, 7));
  const c = pelletDirections(dir, 5, 8, shotSeed(1234, 8));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  for (const p of a) {
    const angle = (Math.acos(Math.min(1, p.x * dir.x + p.y * dir.y + p.z * dir.z)) * 180) / Math.PI;
    assert.ok(angle <= 5.0001, `pellet within 5 deg (${angle.toFixed(2)})`);
  }
});

test('spread grows when moving and airborne, shrinks when aiming and crouching', () => {
  const pistol = WEAPONS.pistol;
  const still = { vel: { x: 0, y: 0, z: 0 }, crouching: false, grounded: true };
  const moving = { ...still, vel: { x: 4.2, y: 0, z: 0 } };
  assert.ok(spreadDegrees(pistol, moving, false) > spreadDegrees(pistol, still, false));
  assert.ok(spreadDegrees(pistol, still, true) < spreadDegrees(pistol, still, false));
  assert.ok(spreadDegrees(pistol, { ...still, grounded: false }, true) > spreadDegrees(pistol, still, true));
  assert.ok(spreadDegrees(pistol, { ...still, crouching: true }, false) < spreadDegrees(pistol, still, false));
});

test('rays hit heads and bodies of humanoid hitboxes', () => {
  const hb = humanoidHitboxes({ x: 0, y: 0, z: -10 }, false);
  const eyeLevel = { x: 0, y: hb.head.c.y, z: 0 };
  const head = rayHitboxes(eyeLevel, { x: 0, y: 0, z: -1 }, 100, hb);
  assert.ok(head?.head, 'head shot');
  const chest = rayHitboxes({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 }, 100, hb);
  assert.ok(chest && !chest.head && Math.abs(chest.t - 9.7) < 0.05, `body shot at ${chest?.t}`);
  const miss = rayHitboxes({ x: 1, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 }, 100, hb);
  assert.equal(miss, null);
  const outOfRange = rayHitboxes({ x: 0, y: 1.1, z: 0 }, { x: 0, y: 0, z: -1 }, 5, hb);
  assert.equal(outOfRange, null);
  const crouched = humanoidHitboxes({ x: 0, y: 0, z: -10 }, true);
  assert.equal(rayHitboxes(eyeLevel, { x: 0, y: 0, z: -1 }, 100, crouched), null, 'shot passes over a crouching target');
});
