import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NETWORK, ZOMBIE_TYPES, ZOMBIE_TYPE_ORDER, ZombieAnim, lerp, lerpAngle, type NetZombie, type ZombieType } from '@grey/shared';

interface Look {
  skin: number;
  shirt: number;
  pants: number;
  /** Torso width multiplier (bloaters are fat). */
  girth: number;
}

const LOOKS: Record<ZombieType, Look> = {
  walker: { skin: 0x7d8a6c, shirt: 0x4a3b2c, pants: 0x2f3338, girth: 1 },
  runner: { skin: 0x8f8170, shirt: 0x5a2a24, pants: 0x3a3a34, girth: 0.85 },
  bloater: { skin: 0x9c9a68, shirt: 0x5b5a4a, pants: 0x3b352c, girth: 1.7 },
};

const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 });

/** Shared geometry/material per zombie type. Body = torso + head merged (one draw call). */
const KITS = new Map<ZombieType, { body: THREE.BufferGeometry; limb: THREE.BufferGeometry; leg: THREE.BufferGeometry; skin: THREE.Material; shirt: THREE.Material; pants: THREE.Material }>();
const kitFor = (type: ZombieType) => {
  let kit = KITS.get(type);
  if (kit) return kit;
  const l = LOOKS[type];
  const torso = new THREE.BoxGeometry(0.42 * l.girth, 0.62, 0.26 * l.girth).translate(0, 1.18, 0);
  const head = new THREE.BoxGeometry(0.24, 0.27, 0.25).translate(0, 1.64, -0.04);
  // Torso uses the shirt color via groups: simpler to colour the whole body as shirt and give heads skin.
  const body = mergeGeometries([torso, head], true)!;
  kit = {
    body,
    limb: new THREE.BoxGeometry(0.11, 0.62, 0.11).translate(0, -0.29, 0), // arm hangs from its pivot
    leg: new THREE.BoxGeometry(0.15, 0.84, 0.15).translate(0, -0.42, 0), // leg hangs from the hip
    skin: mat(l.skin),
    shirt: mat(l.shirt),
    pants: mat(l.pants),
  };
  KITS.set(type, kit);
  return kit;
};

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  s: number;
}

class ZombieMesh {
  readonly root = new THREE.Group();
  private readonly pose = new THREE.Group(); // tilts for the lunge / death fall
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private buffer: Sample[] = [];
  private phase = Math.random() * 10;
  private fall = 0;
  private lunge = 0;
  private readonly sway = Math.random() * 0.3 - 0.15;

  constructor(readonly id: number, readonly type: ZombieType) {
    const kit = kitFor(type);
    const scale = ZOMBIE_TYPES[type].scale;
    const girth = LOOKS[type].girth;
    const body = new THREE.Mesh(kit.body, [kit.shirt, kit.skin]);
    body.castShadow = true;
    this.pose.add(body);
    const arm = (g: THREE.Group, x: number) => {
      g.position.set(x * (0.24 * girth + 0.04), 1.45, 0);
      g.add(new THREE.Mesh(kit.limb, kit.skin));
      this.pose.add(g);
    };
    arm(this.armL, -1);
    arm(this.armR, 1);
    const leg = (g: THREE.Group, x: number) => {
      g.position.set(x * 0.1 * girth, 0.86, 0);
      g.add(new THREE.Mesh(kit.leg, kit.pants));
      this.pose.add(g);
    };
    leg(this.legL, -1);
    leg(this.legR, 1);
    this.root.add(this.pose);
    this.root.scale.setScalar(scale);
  }

  push(n: NetZombie, t: number): void {
    this.buffer.push({ t, x: n.p[0], y: n.p[1], z: n.p[2], yaw: n.yaw, s: n.s });
    if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
  }

  update(renderTime: number, dt: number): void {
    const b = this.buffer;
    if (!b.length) return;
    let s: Sample;
    if (renderTime <= b[0].t) s = b[0];
    else if (renderTime >= b[b.length - 1].t) s = b[b.length - 1];
    else {
      let i = 0;
      while (i < b.length - 2 && b[i + 1].t < renderTime) i++;
      const a = b[i], c = b[i + 1];
      const k = (renderTime - a.t) / Math.max(1, c.t - a.t);
      s = { t: renderTime, x: lerp(a.x, c.x, k), y: lerp(a.y, c.y, k), z: lerp(a.z, c.z, k), yaw: lerpAngle(a.yaw, c.yaw, k), s: k < 0.5 ? a.s : c.s };
      if (i > 0) b.splice(0, i);
    }
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;

    // --- procedural animation
    const dead = s.s === ZombieAnim.dead;
    const moving = s.s === ZombieAnim.walk || s.s === ZombieAnim.run;
    const speed = s.s === ZombieAnim.run ? 11 : 4.5;
    if (moving) this.phase += dt * speed;
    const swing = moving ? Math.sin(this.phase) * (s.s === ZombieAnim.run ? 0.9 : 0.45) : 0;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;

    // Arms reach forward (the classic pose), runners pump them, attacks swipe down.
    this.lunge += ((s.s === ZombieAnim.attack ? 1 : 0) - this.lunge) * (1 - Math.exp(-dt * 10));
    const reach = s.s === ZombieAnim.run ? 0.9 + Math.sin(this.phase) * 0.5 : 1.35;
    const idleBob = Math.sin(performance.now() / 600 + this.phase) * 0.06;
    this.armL.rotation.x = reach + idleBob + this.lunge * 0.6 - (moving ? swing * 0.2 : 0);
    this.armR.rotation.x = reach - idleBob + this.lunge * 0.6 + (moving ? swing * 0.2 : 0);
    this.armL.rotation.z = -0.08;
    this.armR.rotation.z = 0.08;

    // Lean: forward when lunging, a permanent drunken sway; fall backwards when dead.
    this.fall = dead ? Math.min(1, this.fall + dt * 2.2) : 0;
    this.pose.rotation.x = -this.lunge * 0.35 + (dead ? this.fall * 1.45 : 0.08);
    this.pose.rotation.z = dead ? 0 : this.sway + Math.sin(this.phase * 0.5) * 0.04;
    this.pose.position.y = dead ? -this.fall * 0.15 : Math.abs(Math.sin(this.phase)) * (moving ? 0.03 : 0);
  }
}

/** Server-simulated zombies, interpolated like remote players. */
export class ZombiesView {
  private readonly zombies = new Map<number, ZombieMesh>();

  constructor(private readonly scene: THREE.Scene) {}

  onSnapshot(list: NetZombie[], serverTime: number): void {
    const seen = new Set<number>();
    for (const n of list) {
      seen.add(n.id);
      let z = this.zombies.get(n.id);
      if (!z) {
        z = new ZombieMesh(n.id, ZOMBIE_TYPE_ORDER[n.t] ?? 'walker');
        this.zombies.set(n.id, z);
        this.scene.add(z.root);
      }
      z.push(n, serverTime);
    }
    for (const [id, z] of this.zombies) {
      if (seen.has(id)) continue;
      this.scene.remove(z.root);
      this.zombies.delete(id);
    }
  }

  update(serverNow: number, dt: number): void {
    const t = serverNow - NETWORK.interpolationDelayMs;
    for (const z of this.zombies.values()) z.update(t, dt);
  }

  get count(): number {
    return this.zombies.size;
  }
}
