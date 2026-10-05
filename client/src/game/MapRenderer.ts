import * as THREE from 'three';
import { RENDER, doorPose, type DoorDef, type MapBox, type MapData } from '@grey/shared';
import { surfaceAttributes } from '../render/worldMaterial';

/**
 * Base colours (albedo) per MapBox.m key. The world material multiplies these with the
 * procedural surface detail (brick, concrete, wood...) for that key.
 */
const PALETTE: Record<string, number> = {
  asphalt: 0x3a3b38, lot_asphalt: 0x41423e, sidewalk: 0x8a877e, pavement: 0x7a776f, grass: 0x55603c,
  concrete: 0x8a877e, concrete_wall: 0x6f6c65, concrete_dark: 0x605d57, concrete_barrier: 0x97948a,
  brick: 0x7a4232, brick_dark: 0x5a3328, stucco: 0xa79f90, metal_siding: 0x76807f,
  siding_grey: 0x878a84, siding_blue: 0x5f7184, siding_green: 0x66745c, siding_cream: 0xaaa184,
  floor_wood: 0x6a4f35, floor_tile: 0x9b998f, floor_concrete: 0x77756e, plaster: 0xaaa497,
  roof: 0x45443f, stairs: 0x7a766e, wood: 0x7a5b3c, wood_dark: 0x543f2b, fabric: 0x6a5a50,
  appliance: 0xbdbab0, counter: 0x8a8174, metal: 0x8a8f92, metal_dark: 0x474b4e, crate: 0x8a6e46,
  glasscase: 0xa9bcc0, glass: 0x9fb4b9, fence_wood: 0x75603f, fence_metal: 0x5f6364,
  bark: 0x4a3b2c, leaves: 0x4b5a31, bush: 0x4c5832, paint: 0xc4bfa6, trash: 0x2a2c2b, debris: 0x67625a,
  car_red: 0x7a2e27, car_blue: 0x34465f, car_white: 0xb3b1a9, car_rust: 0x84512f, car_green: 0x45573f,
  car_black: 0x222324, car_glass: 0x1c2125,
  sign_green: 0x2f6b3a, sign_white: 0xd6d4cb, sign_orange: 0xb3631d, sign_red: 0x8e1f1a, sign_blue: 0x29466e,
  door: 0x5f4a35, sandbag: 0x8f8360, police_blue: 0x1f3f8a, light_red: 0xb3261e,
};
const MISSING = 0xff00ff;

/** Deterministic +-8% brightness jitter so repeated pieces don't look copy-pasted. */
const jitter = (i: number): number => {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  return 0.92 + ((h >>> 0) % 1000) / 1000 * 0.16;
};

type Shape = 'box' | 'blob' | 'trunk';
/** Foliage renders as lumpy blobs and trunks as cylinders; everything else is a box. */
const shapeOf = (m: string): Shape => (m === 'leaves' || m === 'bush' ? 'blob' : m === 'bark' ? 'trunk' : 'box');
const SHAPES: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  blob: new THREE.IcosahedronGeometry(0.5, 2),
  trunk: new THREE.CylinderGeometry(0.42, 0.5, 1, 9),
};
// Make the foliage blobs irregular (deterministic per vertex).
{
  const pos = SHAPES.blob.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const k = 0.82 + 0.3 * Math.abs(Math.sin(v.x * 9.1 + v.y * 7.3) * Math.cos(v.z * 8.7 - v.y * 5.1));
    v.multiplyScalar(k);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  SHAPES.blob.computeVertexNormals();
}

const tmp = {
  m: new THREE.Matrix4(),
  p: new THREE.Vector3(),
  q: new THREE.Quaternion(),
  s: new THREE.Vector3(),
  e: new THREE.Euler(0, 0, 0, 'YXZ'),
  c: new THREE.Color(),
};

const buildInstanced = (boxes: MapBox[], shape: Shape, mat: THREE.Material, shadows: boolean, salt: number): THREE.InstancedMesh => {
  // Each mesh gets its own geometry copy to carry its per-instance surface attributes.
  const geo = SHAPES[shape].clone();
  const attrs = surfaceAttributes(boxes.map((b) => b.m));
  geo.setAttribute('aTex', attrs.tex);
  geo.setAttribute('aSurf', attrs.surf);
  const mesh = new THREE.InstancedMesh(geo, mat, boxes.length);
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
 * within a chunk into main / detail / glass instanced meshes per shape. Detail pieces
 * (interiors, furniture, props) are hidden beyond RENDER.detailDistance.
 */
export class MapRenderer {
  readonly root = new THREE.Group();
  private readonly chunks: Chunk[] = [];
  private readonly glassMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.04, metalness: 0.85, transparent: true, opacity: 0.42, depthWrite: false,
  });

  constructor(map: MapData, worldMat: THREE.Material) {
    const size = RENDER.chunkSize;
    type Bucket = { main: Map<Shape, MapBox[]>; detail: Map<Shape, MapBox[]>; glass: MapBox[] };
    const buckets = new Map<string, Bucket>();
    const global: MapBox[] = [];
    const push = (m: Map<Shape, MapBox[]>, b: MapBox) => {
      const s = shapeOf(b.m);
      const list = m.get(s) ?? [];
      list.push(b);
      m.set(s, list);
    };

    for (const b of map.boxes) {
      if (b.vis === false) continue;
      // Huge pieces (ground, perimeter wall) don't belong to a single chunk.
      if (Math.max(b.s[0], b.s[2]) > size) {
        global.push(b);
        continue;
      }
      const key = `${Math.floor(b.p[0] / size)},${Math.floor(b.p[2] / size)}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = { main: new Map(), detail: new Map(), glass: [] }));
      if (b.m === 'glass') bucket.glass.push(b);
      else push(b.d ? bucket.detail : bucket.main, b);
    }

    const ground = buildInstanced(global, 'box', worldMat, false, 0);
    ground.frustumCulled = false;
    this.root.add(ground);

    let salt = 1;
    for (const [key, bucket] of buckets) {
      const [cx, cz] = key.split(',').map(Number);
      const chunkGroup = new THREE.Group();
      chunkGroup.name = `chunk ${key}`;
      for (const [shape, list] of bucket.main) chunkGroup.add(buildInstanced(list, shape, worldMat, true, (salt += 7919)));
      if (bucket.glass.length) {
        const glass = buildInstanced(bucket.glass, 'box', this.glassMat, false, (salt += 7919));
        glass.receiveShadow = false;
        glass.renderOrder = 1;
        chunkGroup.add(glass);
      }
      const detail = new THREE.Group();
      for (const [shape, list] of bucket.detail) detail.add(buildInstanced(list, shape, worldMat, true, (salt += 7919)));
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

  constructor(private readonly doors: DoorDef[], open: boolean[], worldMat: THREE.Material) {
    const geo = SHAPES.box.clone();
    const attrs = surfaceAttributes(doors.map(() => 'door'));
    geo.setAttribute('aTex', attrs.tex);
    geo.setAttribute('aSurf', attrs.surf);
    this.mesh = new THREE.InstancedMesh(geo, worldMat, Math.max(1, doors.length));
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
