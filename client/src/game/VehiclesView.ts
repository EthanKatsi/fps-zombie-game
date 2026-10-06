import * as THREE from 'three';
import type { Collider, World } from '@dimforge/rapier3d-compat';
import {
  NETWORK,
  VEHICLES,
  VEHICLE_TYPE_ORDER,
  createVehicleCollider,
  lerp,
  lerpAngle,
  placeVehicleCollider,
  seatFeet,
  vehicleBox,
  type ObstacleBox,
  type NetVehicle,
  type Rapier,
  type Vec3,
  type VehicleState,
  type VehicleType,
} from '@grey/shared';

const PAINTS = [0x7a1f1b, 0x1f3550, 0xb8b6ae, 0x1c1d1f, 0x3c4a34, 0x8a8d90, 0x6b4a2a, 0x2c5a6b];

const MAT = {
  glass: new THREE.MeshStandardMaterial({ color: 0x0f1418, roughness: 0.05, metalness: 0.8 }),
  tire: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 }),
  rim: new THREE.MeshStandardMaterial({ color: 0x8b8e90, roughness: 0.35, metalness: 0.8 }),
  trim: new THREE.MeshStandardMaterial({ color: 0x1b1c1d, roughness: 0.6, metalness: 0.2 }),
  chrome: new THREE.MeshStandardMaterial({ color: 0xc8cacc, roughness: 0.15, metalness: 1 }),
  seat: new THREE.MeshStandardMaterial({ color: 0x2a2420, roughness: 0.8 }),
  burnt: new THREE.MeshStandardMaterial({ color: 0x1a1816, roughness: 0.95, metalness: 0.2 }),
  headOn: new THREE.MeshStandardMaterial({ color: 0xfff1d0, emissive: 0xfff1d0, emissiveIntensity: 2.5 }),
  headOff: new THREE.MeshStandardMaterial({ color: 0xd8d4c8, roughness: 0.1, metalness: 0.4 }),
  tailOn: new THREE.MeshStandardMaterial({ color: 0x5a0d0a, emissive: 0xff2010, emissiveIntensity: 1.6 }),
  tailOff: new THREE.MeshStandardMaterial({ color: 0x5a0d0a, roughness: 0.3 }),
};

const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number): THREE.Mesh => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
};

interface Wheel {
  pivot: THREE.Group;
  spin: THREE.Group;
  front: boolean;
  r: number;
}

interface Built {
  root: THREE.Group;
  wheels: Wheel[];
  paint: THREE.Mesh[];
  glass: THREE.Mesh[];
  heads: THREE.Mesh[];
  tails: THREE.Mesh[];
  /** Small tilt group: body roll and pitch for a bit of life. */
  body: THREE.Group;
  paintMat: THREE.Material;
}

const wheel = (b: Built, x: number, z: number, r: number, w: number, front: boolean) => {
  const pivot = new THREE.Group();
  pivot.position.set(x, r, z);
  const spin = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 18), MAT.tire);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  const rim = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w + 0.02, 10), MAT.rim);
  rim.rotation.z = Math.PI / 2;
  spin.add(tire, rim);
  pivot.add(spin);
  b.root.add(pivot);
  b.wheels.push({ pivot, spin, front, r });
};

/** Procedural models. Local -Z is the front, y = 0 the ground. */
const build = (type: VehicleType, paintHex: number): Built => {
  const paint = new THREE.MeshStandardMaterial({ color: paintHex, roughness: 0.32, metalness: 0.55 });
  const b: Built = { root: new THREE.Group(), wheels: [], paint: [], glass: [], heads: [], tails: [], body: new THREE.Group(), paintMat: paint };
  b.root.add(b.body);
  const P = (m: THREE.Mesh) => (b.paint.push(m), b.body.add(m), m);
  const G = (m: THREE.Mesh) => (b.glass.push(m), b.body.add(m), m);
  const T = (m: THREE.Mesh) => (b.body.add(m), m);
  const d = VEHICLES[type];
  const [W, , L] = d.size;
  if (type === 'sedan') {
    P(box(W, 0.6, L, paint, 0, 0.62, 0));
    P(box(W * 0.98, 0.12, L * 0.3, paint, 0, 0.96, -L * 0.33)); // hood
    G(box(W * 0.86, 0.5, L * 0.46, MAT.glass, 0, 1.17, 0.18));
    P(box(W * 0.84, 0.06, L * 0.42, paint, 0, 1.44, 0.2)); // roof
    T(box(W + 0.04, 0.22, 0.18, MAT.trim, 0, 0.45, -L / 2)); // bumpers
    T(box(W + 0.04, 0.22, 0.18, MAT.trim, 0, 0.45, L / 2));
    for (const x of [-0.62, 0.62]) {
      b.heads.push(T(box(0.38, 0.14, 0.05, MAT.headOff, x, 0.75, -L / 2 - 0.01)));
      b.tails.push(T(box(0.34, 0.14, 0.05, MAT.tailOff, x, 0.78, L / 2 + 0.01)));
      T(box(0.06, 0.08, 0.16, MAT.chrome, x > 0 ? W / 2 + 0.03 : -W / 2 - 0.03, 1.02, -0.5)); // mirrors
    }
    for (const [x, z, f] of [[-1, -1, true], [1, -1, true], [-1, 1, false], [1, 1, false]] as const) wheel(b, x * (W / 2 - 0.12), z * (L / 2 - 0.85), 0.34, 0.24, f);
  } else if (type === 'pickup') {
    P(box(W, 0.7, L, paint, 0, 0.82, 0));
    G(box(W * 0.9, 0.6, 1.9, MAT.glass, 0, 1.47, -0.45));
    P(box(W * 0.88, 0.07, 1.8, paint, 0, 1.8, -0.42));
    // Open bed at the back.
    for (const x of [-1, 1]) P(box(0.08, 0.42, 2.3, paint, x * (W / 2 - 0.04), 1.38, 1.35));
    P(box(W, 0.42, 0.08, paint, 0, 1.38, L / 2 - 0.04));
    T(box(W * 0.95, 0.04, 2.25, MAT.trim, 0, 1.18, 1.35));
    T(box(W + 0.06, 0.26, 0.2, MAT.chrome, 0, 0.55, -L / 2));
    T(box(W + 0.06, 0.26, 0.2, MAT.trim, 0, 0.55, L / 2));
    for (const x of [-0.7, 0.7]) {
      b.heads.push(T(box(0.4, 0.16, 0.05, MAT.headOff, x, 0.98, -L / 2 - 0.01)));
      b.tails.push(T(box(0.18, 0.3, 0.05, MAT.tailOff, x * 1.3, 1.1, L / 2 + 0.01)));
    }
    for (const [x, z, f] of [[-1, -1, true], [1, -1, true], [-1, 1, false], [1, 1, false]] as const) wheel(b, x * (W / 2 - 0.1), z * (L / 2 - 1.0), 0.42, 0.3, f);
  } else {
    // Motorcycle
    P(box(0.34, 0.24, 0.55, paint, 0, 0.88, -0.28)); // tank
    T(box(0.18, 0.28, 1.15, MAT.trim, 0, 0.6, 0.02)); // frame / engine
    T(box(0.3, 0.26, 0.4, MAT.chrome, 0, 0.5, -0.05)); // engine block
    T(box(0.3, 0.1, 0.75, MAT.seat, 0, 0.92, 0.28)); // seat
    P(box(0.22, 0.12, 0.5, paint, 0, 0.82, 0.78)); // rear fender
    T(box(0.06, 0.6, 0.06, MAT.chrome, 0, 0.72, -0.72)).rotation.x = -0.35; // fork
    T(box(0.72, 0.04, 0.04, MAT.chrome, 0, 1.08, -0.6)); // handlebar
    b.heads.push(T(box(0.18, 0.16, 0.08, MAT.headOff, 0, 1.0, -0.82)));
    b.tails.push(T(box(0.14, 0.06, 0.04, MAT.tailOff, 0, 0.88, 1.04)));
    T(box(0.08, 0.08, 0.5, MAT.chrome, 0.16, 0.38, 0.45)); // exhaust
    wheel(b, 0, -0.74, 0.33, 0.12, true);
    wheel(b, 0, 0.74, 0.33, 0.14, false);
  }
  return b;
};

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
  st: number;
}

class VehicleMesh {
  readonly built: Built;
  readonly collider: Collider;
  private buffer: Sample[] = [];
  /** Latest rendered pose (seats of remote passengers attach to it). */
  readonly pose: VehicleState;
  info: NetVehicle;
  private wreckShown = false;

  constructor(R: Rapier, world: World, readonly id: number, readonly type: VehicleType, n: NetVehicle) {
    this.built = build(type, PAINTS[id % PAINTS.length]);
    this.info = n;
    this.pose = { pos: { x: n.p[0], y: n.p[1], z: n.p[2] }, yaw: n.yaw, speed: n.s, vy: 0, grounded: true, steer: n.st, fuel: 0 };
    this.collider = createVehicleCollider(R, world, type, this.pose);
  }

  push(n: NetVehicle, t: number): void {
    this.info = n;
    this.buffer.push({ t, x: n.p[0], y: n.p[1], z: n.p[2], yaw: n.yaw, s: n.s, st: n.st });
    if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
  }

  /** Interpolate the snapshot buffer at `renderTime`; returns whether the collider moved. */
  interpolate(renderTime: number): boolean {
    const b = this.buffer;
    if (!b.length) return false;
    let s: Sample;
    if (renderTime <= b[0].t) s = b[0];
    else if (renderTime >= b[b.length - 1].t) s = b[b.length - 1];
    else {
      let i = 0;
      while (i < b.length - 2 && b[i + 1].t < renderTime) i++;
      const a = b[i], c = b[i + 1];
      const k = (renderTime - a.t) / Math.max(1, c.t - a.t);
      s = { t: renderTime, x: lerp(a.x, c.x, k), y: lerp(a.y, c.y, k), z: lerp(a.z, c.z, k), yaw: lerpAngle(a.yaw, c.yaw, k), s: lerp(a.s, c.s, k), st: lerp(a.st, c.st, k) };
      if (i > 0) b.splice(0, i);
    }
    const p = this.pose;
    const moved = Math.abs(p.pos.x - s.x) + Math.abs(p.pos.y - s.y) + Math.abs(p.pos.z - s.z) + Math.abs(p.yaw - s.yaw) > 1e-4;
    p.pos = { x: s.x, y: s.y, z: s.z };
    p.yaw = s.yaw;
    p.speed = s.s;
    p.steer = s.st;
    return moved;
  }

  /** Place the model at the current pose and animate wheels / lights. */
  render(dt: number): void {
    const { root, wheels, body } = this.built;
    const p = this.pose;
    root.position.set(p.pos.x, p.pos.y, p.pos.z);
    root.rotation.y = p.yaw;
    for (const w of wheels) {
      w.spin.rotation.x -= (p.speed * dt) / w.r;
      if (w.front) w.pivot.rotation.y = p.steer * 0.5;
    }
    // A little body roll into turns and squat under acceleration.
    const roll = THREE.MathUtils.clamp(p.steer * p.speed * 0.006, -0.06, 0.06);
    body.rotation.z += (roll - body.rotation.z) * Math.min(1, dt * 6);
    // Lights are on while someone drives; wrecks are burnt black.
    const lit = this.info.d && !this.info.w;
    for (const h of this.built.heads) h.material = lit ? MAT.headOn : MAT.headOff;
    for (const t of this.built.tails) t.material = lit ? MAT.tailOn : MAT.tailOff;
    if (this.info.w !== this.wreckShown) {
      this.wreckShown = this.info.w;
      for (const m of this.built.paint) m.material = this.info.w ? MAT.burnt : this.built.paintMat;
      for (const m of this.built.glass) m.material = this.info.w ? MAT.burnt : MAT.glass;
    }
  }
}

/** Drivable vehicles from snapshots: interpolated meshes plus colliders in the prediction world. */
export class VehiclesView {
  private readonly vehicles = new Map<number, VehicleMesh>();
  readonly byHandle = new Map<number, number>();

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    private readonly scene: THREE.Scene,
  ) {}

  onSnapshot(list: NetVehicle[], serverTime: number): void {
    const seen = new Set<number>();
    for (const n of list) {
      seen.add(n.id);
      let v = this.vehicles.get(n.id);
      if (!v) {
        v = new VehicleMesh(this.R, this.world, n.id, VEHICLE_TYPE_ORDER[n.t] ?? 'sedan', n);
        this.vehicles.set(n.id, v);
        this.byHandle.set(v.collider.handle, n.id);
        this.scene.add(v.built.root);
      }
      v.push(n, serverTime);
    }
    for (const [id, v] of this.vehicles) {
      if (seen.has(id)) continue;
      this.scene.remove(v.built.root);
      this.byHandle.delete(v.collider.handle);
      this.world.removeCollider(v.collider, false);
      this.vehicles.delete(id);
    }
  }

  /**
   * Interpolate vehicles, except `drivenId` (the vehicle the local player drives: its pose and
   * collider come from the prediction).
   */
  interpolate(serverNow: number, drivenId: number | null): void {
    const t = serverNow - NETWORK.interpolationDelayMs;
    for (const v of this.vehicles.values()) {
      if (v.id === drivenId) continue;
      if (v.interpolate(t)) placeVehicleCollider(v.collider, v.type, v.pose);
    }
  }

  /** Footprints of the vehicles we know about, for push-out collisions. */
  boxes(except: number | null): ObstacleBox[] {
    const out: ObstacleBox[] = [];
    for (const v of this.vehicles.values()) if (v.id !== except) out.push(vehicleBox(v.id, v.type, v.pose));
    return out;
  }

  /** Ray vs vehicle boxes (the "Drive" prompt): nearest vehicle hit within maxT, or null. */
  pick(o: { x: number; y: number; z: number }, d: { x: number; y: number; z: number }, maxT: number): { id: number; t: number } | null {
    let best: { id: number; t: number } | null = null;
    for (const b of this.boxes(null)) {
      // Into the box's frame (x across, z along, y up).
      const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
      const ox = o.x - b.x, oz = o.z - b.z;
      const lo = { x: ox * c - oz * s, y: o.y, z: -(ox * s + oz * c) };
      const ld = { x: d.x * c - d.z * s, y: d.y, z: -(d.x * s + d.z * c) };
      let t0 = 0, t1 = maxT;
      const slab = (p: number, v: number, lo_: number, hi: number) => {
        if (Math.abs(v) < 1e-9) return p >= lo_ && p <= hi;
        let a = (lo_ - p) / v, bb = (hi - p) / v;
        if (a > bb) [a, bb] = [bb, a];
        t0 = Math.max(t0, a);
        t1 = Math.min(t1, bb);
        return t0 <= t1;
      };
      if (slab(lo.x, ld.x, -b.hx, b.hx) && slab(lo.z, ld.z, -b.hz, b.hz) && slab(lo.y, ld.y, b.y0, b.y1)) {
        if (!best || t0 < best.t) best = { id: b.id, t: t0 };
      }
    }
    return best;
  }

  /** Draw every vehicle; `local` overrides the pose of the one we're driving. */
  render(dt: number, local: { id: number; state: VehicleState } | null): void {
    for (const v of this.vehicles.values()) {
      if (local && local.id === v.id) {
        Object.assign(v.pose, { pos: { ...local.state.pos }, yaw: local.state.yaw, speed: local.state.speed, steer: local.state.steer });
      }
      v.render(dt);
    }
  }

  collider(id: number): Collider | undefined {
    return this.vehicles.get(id)?.collider;
  }

  info(id: number): { type: VehicleType; net: NetVehicle } | undefined {
    const v = this.vehicles.get(id);
    return v ? { type: v.type, net: v.info } : undefined;
  }

  /** Rendered pose of a vehicle (remote passengers / your own seat when riding along). */
  pose(id: number): VehicleState | undefined {
    return this.vehicles.get(id)?.pose;
  }

  /** Feet position of an occupant of a vehicle seat, at the rendered pose. */
  seatFeet(id: number, seat: number): Vec3 | undefined {
    const v = this.vehicles.get(id);
    return v ? seatFeet(v.type, v.pose, seat) : undefined;
  }

  get count(): number {
    return this.vehicles.size;
  }
}
