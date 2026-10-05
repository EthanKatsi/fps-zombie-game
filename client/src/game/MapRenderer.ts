import * as THREE from 'three';
import { RENDER, doorPose, type DoorDef, type MapBox, type MapData } from '@grey/shared';

/** Placeholder palette - flat, desaturated, post-apocalyptic. Keys are MapBox.m values. */
const PALETTE: Record<string, number> = {
  asphalt: 0x2b2c2a, lot_asphalt: 0x353633, sidewalk: 0x77756d, pavement: 0x6a6862, grass: 0x4a5236,
  concrete: 0x7a7870, concrete_wall: 0x5f5d57, concrete_dark: 0x55534e, concrete_barrier: 0x8a877d,
  brick: 0x6b3b2e, brick_dark: 0x4e2c24, stucco: 0x9a9284, metal_siding: 0x6d7478,
  siding_grey: 0x7c7f7a, siding_blue: 0x56677a, siding_green: 0x5d6b55, siding_cream: 0x9c9479,
  floor_wood: 0x5e4630, floor_tile: 0x8b8a83, floor_concrete: 0x6b6a65, plaster: 0x9b968a,
  roof: 0x3a3a38, stairs: 0x6e6a62, wood: 0x6e5236, wood_dark: 0x4a3826, fabric: 0x5a4d45,
  appliance: 0xb5b3aa, counter: 0x7d7468, metal: 0x7f8487, metal_dark: 0x3e4245, crate: 0x7d6440,
  glasscase: 0x9fb4b8, glass: 0x8fa7ad, fence_wood: 0x6b573f, fence_metal: 0x55595a,
  bark: 0x3f3226, leaves: 0x3f4a2c, bush: 0x404a2d, paint: 0xb8b39a, trash: 0x1f2120, debris: 0x5a554c,
  car_red: 0x6e2a24, car_blue: 0x2f3f55, car_white: 0xa9a79f, car_rust: 0x7a4a2c, car_green: 0x3e4d3a,
  car_black: 0x1d1e1f, car_glass: 0x262b2e,
  sign_green: 0x2f6b3a, sign_white: 0xd6d4cb, sign_orange: 0xb3631d, sign_red: 0x8e1f1a, sign_blue: 0x29466e,
  door: 0x5b4632, sandbag: 0x8a7d5c, police_blue: 0x1f3f8a, light_red: 0xb3261e,
};
const MISSING = 0xff00ff;

/** Deterministic +-8% brightness jitter so repeated pieces don't look copy-pasted. */
const jitter = (i: number): number => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  return 0.92 + ((h >>> 0) % 1000) / 1000 * 0.16;
};

const unitBox = new THREE.BoxGeometry(1, 1, 1);
const opaqueMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
const glassMat = new THREE.MeshStandardMaterial({
  color: 0xffffff, roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.32, depthWrite: false,
});

const tmp = {
  m: new THREE.Matrix4(),
  p: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  s: new THREE.Vector3(),
  e: new THREE.Euler(0, 0, 0, 'YXZ'),
  c: new THREE.Color(),
};

const buildInstanced = (boxes: MapBox[], mat: THREE.Material, shadows: boolean, salt: number): THREE.InstancedMesh => {
  const mesh = new THREE.InstancedMesh(unitBox, mat, boxes.length);
  boxes.forEach((b, i) => {
    tmp.p.set(b.p[0], b.p[1], b.p[2]);
    tmp.e.set(b.r?.[0] ?? 0, b.r?.[1] ?? 0, b.r?.[2] ?? 0, 'YXZ');
    tmp.q.setFromEuler(tmp.e);
    tmp.s.set(b.s[0], b.s[1], b.s[2]);
    mesh.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s));
    tmp.c.setHex(PALETTE[b.m] ?? MISSING).multiplyScalar(jitter(i + salt));
    mesh.setColorAt(i, tmp.c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  return mesh;
};

interface Chunk {
  center: THREE.Vector3;
  detail: THREE.Group;
}

/**
 * Static city visuals. Boxes are bucketed into chunks (frustum culling granularity), and
 * within a chunk into main / detail / glass instanced meshes (~3 draw calls per chunk).
 * Detail pieces (interiors, furniture, props) are hidden beyond RENDER.detailDistance.
 */
export class MapRenderer {
  readonly root = new THREE.Group();
  private readonly chunks: Chunk[] = [];

  constructor(map: MapData) {
    const size = RENDER.chunkSize;
    type Bucket = { main: MapBox[]; detail: MapBox[]; glass: MapBox[] };
    const buckets = new Map<string, Bucket>();
    const global: MapBox[] = [];

    for (const b of map.boxes) {
      if (b.vis === false) continue;
      // Huge pieces (ground, perimeter wall) don't belong to a single chunk.
      if (Math.max(b.s[0], b.s[2]) > size) {
        global.push(b);
        continue;
      }
      const key = `${Math.floor(b.p[0] / size)},${Math.floor(b.p[2] / size)}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { main: [], detail: [], glass: [] }));
      if (b.m === 'glass') bucket.glass.push(b);
      else if (b.d) bucket.detail.push(b);
      else bucket.main.push(b);
    }

    const ground = buildInstanced(global, opaqueMat, false, 0);
    ground.frustumCulled = false;
    this.root.add(ground);

    let salt = 1;
    for (const [key, bucket] of buckets) {
      const [cx, cz] = key.split(',').map(Number);
      const chunkGroup = new THREE.Group();
      chunkGroup.name = `chunk ${key}`;
      if (bucket.main.length) chunkGroup.add(buildInstanced(bucket.main, opaqueMat, true, (salt += 7919)));
      if (bucket.glass.length) {
        const glass = buildInstanced(bucket.glass, glassMat, false, (salt += 7919));
        glass.receiveShadow = false;
        glass.renderOrder = 1;
        chunkGroup.add(glass);
      }
      const detail = new THREE.Group();
      if (bucket.detail.length) detail.add(buildInstanced(bucket.detail, opaqueMat, true, (salt += 7919)));
      chunkGroup.add(detail);
      this.root.add(chunkGroup);
      this.chunks.push({ center: new THREE.Vector3((cx + 0.5) * size, 0, (cz + 0.5) * size), detail });
    }
  }

  /** Distance-based detail LOD. Cheap enough to call every frame. */
  update(camera: THREE.Vector3): void {
    const maxD = RENDER.detailDistance + RENDER.chunkSize * 0.7;
    const maxD2 = maxD * maxD;
    for (const c of this.chunks) {
      const dx = c.center.x - camera.x;
      const dz = c.center.z - camera.z;
      c.detail.visible = dx * dx + dz * dz < maxD2;
    }
  }

  get chunkCount(): number {
    return this.chunks.length;
  }
}

/** All doors as one instanced mesh; swings are animated by rewriting instance matrices. */
export class DoorRenderer {
  readonly mesh: THREE.InstancedMesh;
  private readonly amount: number[];
  private readonly target: number[];
  private readonly animating = new Set<number>();

  constructor(private readonly doors: DoorDef[], open: boolean[]) {
    this.mesh = new THREE.InstancedMesh(unitBox, opaqueMat, Math.max(1, doors.length));
    this.mesh.count = doors.length;
    this.amount = open.map((o) => (o ? 1 : 0));
    this.target = [...this.amount];
    doors.forEach((d, i) => {
      this.writeMatrix(i);
      this.mesh.setColorAt(i, tmp.c.setHex(PALETTE.door).multiplyScalar(jitter(i * 31)));
    });
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false; // spans the whole city; tiny geometry anyway
  }

  private writeMatrix(i: number): void {
    const d = this.doors[i];
    // Ease in/out so the swing doesn't look linear.
    const a = this.amount[i];
    const eased = a * a * (3 - 2 * a);
    const pose = doorPose(d, eased);
    tmp.p.set(pose.x, pose.y, pose.z);
    tmp.e.set(0, pose.yaw, 0, 'YXZ');
    tmp.q.setFromEuler(tmp.e);
    tmp.s.set(d.width, d.height, 0.06);
    this.mesh.setMatrixAt(i, tmp.m.compose(tmp.p, tmp.q, tmp.s));
  }

  setOpen(id: number, open: boolean): void {
    this.target[id] = open ? 1 : 0;
    this.animating.add(id);
  }

  update(dt: number): void {
    if (this.animating.size === 0) return;
    const step = dt / 0.4; // 0.4 s swing
    for (const id of this.animating) {
      const t = this.target[id];
      const a = this.amount[id];
      const next = t > a ? Math.min(t, a + step) : Math.max(t, a - step);
      this.amount[id] = next;
      this.writeMatrix(id);
      if (next === t) this.animating.delete(id);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
