import { mulberry32 } from '../math/math';
import { addStairs } from './builders';
import type { MapBox, MapData } from './mapData';

/**
 * Milestone 1 test map: a fenced lot with crates, a ramp, stairs up to a rooftop,
 * a low tunnel to test crouching, and some wrecked "cars". Replaced by the city
 * generator in milestone 2.
 */
export const generateTestMap = (seed = 1337): MapData => {
  const rand = mulberry32(seed);
  const boxes: MapBox[] = [];
  const half = 60;

  // Ground slab (top surface at y = 0)
  boxes.push({ p: [0, -0.5, 0], s: [half * 2, 1, half * 2], m: 'asphalt' });

  // Perimeter wall / fence
  const wallH = 3;
  boxes.push({ p: [0, wallH / 2, -half], s: [half * 2, wallH, 0.4], m: 'concrete' });
  boxes.push({ p: [0, wallH / 2, half], s: [half * 2, wallH, 0.4], m: 'concrete' });
  boxes.push({ p: [-half, wallH / 2, 0], s: [0.4, wallH, half * 2], m: 'concrete' });
  boxes.push({ p: [half, wallH / 2, 0], s: [0.4, wallH, half * 2], m: 'concrete' });

  // A blocky "building" with a staircase to its roof
  const bx = 20, bz = -20, bw = 12, bh = 6, bd = 10;
  boxes.push({ p: [bx, bh / 2, bz], s: [bw, bh, bd], m: 'brick' });
  // Stairs along the west wall climbing towards -Z; the top lands level with the roof.
  addStairs(boxes, { x: bx - bw / 2 - 1, y: 0, z: -10.6, dir: '-z', width: 2, height: bh, steps: 15, m: 'concrete' });

  // Ramp onto a platform
  const rampLen = 8, rampAngle = 0.3;
  boxes.push({
    p: [-15, Math.sin(rampAngle) * rampLen / 2 - 0.1, 10],
    s: [4, 0.2, rampLen],
    r: [rampAngle, 0, 0],
    m: 'wood',
  });
  const platH = Math.sin(rampAngle) * rampLen;
  boxes.push({
    p: [-15, platH / 2, 10 - Math.cos(rampAngle) * rampLen / 2 - 3],
    s: [6, platH, 6],
    m: 'concrete',
  });

  // Crouch tunnel: two side walls + a low roof (1.3 m clearance)
  boxes.push({ p: [0, 1, 25], s: [0.4, 2, 6], m: 'concrete' });
  boxes.push({ p: [2, 1, 25], s: [0.4, 2, 6], m: 'concrete' });
  boxes.push({ p: [1, 1.5, 25], s: [2.4, 0.4, 6], m: 'concrete' });

  // Scattered crates and wrecked cars
  for (let i = 0; i < 25; i++) {
    const x = (rand() * 2 - 1) * (half - 6);
    const z = (rand() * 2 - 1) * (half - 6);
    if (Math.hypot(x - bx, z - bz) < 12 || Math.hypot(x, z) < 6) continue;
    if (Math.abs(x) < 10 && z < 0 && z > -19) continue; // firing lane + dummy row
    if (rand() < 0.5) {
      const s = 0.8 + rand() * 0.8;
      boxes.push({ p: [x, s / 2, z], s: [s, s, s], r: [0, rand() * Math.PI, 0], m: 'crate' });
    } else {
      boxes.push({ p: [x, 0.7, z], s: [1.9, 1.4, 4.3], r: [0, rand() * Math.PI, 0], m: 'car' });
    }
  }

  const spawnPoints = [
    { x: 0, y: 0.1, z: 0 },
    { x: 5, y: 0.1, z: 5 },
    { x: -5, y: 0.1, z: 5 },
    { x: 5, y: 0.1, z: -5 },
    { x: -5, y: 0.1, z: -5 },
  ];

  // A few dummies in a row north of the spawn area, facing it.
  const dummies = [-6, -3, 0, 3, 6].map((x, i) => ({ id: i, p: [x, 0, -14] as [number, number, number], yaw: Math.PI }));
  // The one staircase climbs towards -Z from z=-10.6 up to the roof (x > 14).
  const navLinks = [{ a: [13, 0, -10.2] as [number, number, number], b: [15.2, bh, -16.4] as [number, number, number] }];
  return { id: 'testmap', seed, halfSize: half, boxes, doors: [], buildings: [], containers: [], dummies, navLinks, spawnPoints };
};
