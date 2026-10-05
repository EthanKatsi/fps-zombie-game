import * as THREE from 'three';
import { NETWORK, ZOMBIE_TYPES, ZOMBIE_TYPE_ORDER, ZombieAnim, lerp, lerpAngle, type NetZombie, type ZombieType } from '@grey/shared';
import { Humanoid, type CharacterBody, type HumanoidLook, type HumanoidStyle } from './anim/Humanoid';
import type { ModelLibrary } from './models/ModelLibrary';

const mat = (c: number, rough = 0.9) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });

/** Rotting skin per type and a few filthy clothing colours to vary the crowd. */
const SKIN: Record<ZombieType, number> = { walker: 0x8b927a, runner: 0x9a8e7c, bloater: 0xa29f74 };
const SHIRTS = [0x4a3b2c, 0x3d4648, 0x5a2a24, 0x5b5a4a, 0x3a3f33, 0x6b6257, 0x2f3540];
const PANTS = [0x2f3338, 0x3a3a34, 0x3b352c, 0x41403a, 0x252a30];
const materials = new Map<string, THREE.Material>();
const cached = (key: string, make: () => THREE.Material) => {
  let m = materials.get(key);
  if (!m) materials.set(key, (m = make()));
  return m;
};

const lookFor = (type: ZombieType, id: number): HumanoidLook => ({
  skin: cached(`skin:${type}`, () => mat(SKIN[type], 0.85)),
  shirt: cached(`shirt:${id % SHIRTS.length}`, () => mat(SHIRTS[id % SHIRTS.length], 0.95)),
  pants: cached(`pants:${id % PANTS.length}`, () => mat(PANTS[id % PANTS.length], 0.95)),
  shoes: cached('shoes', () => mat(0x1e1c1a, 0.8)),
  girth: type === 'bloater' ? 1.7 : type === 'runner' ? 0.88 : 1,
});

const styleFor = (type: ZombieType, id: number): HumanoidStyle => {
  const r = ((id * 2654435761) >>> 0) / 4294967296;
  if (type === 'runner') return { zombie: true, limp: 0, hunch: 0.25, reach: 1.0, flail: true };
  if (type === 'bloater') return { zombie: true, limp: 0.3, hunch: 0.05, reach: 1.1, flail: false };
  return { zombie: true, limp: r * 0.7, hunch: 0.12 + r * 0.15, reach: 1.25 + r * 0.25, flail: false };
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
  readonly body: CharacterBody;
  private buffer: Sample[] = [];
  private last: { x: number; z: number } | null = null;
  private hits = -1;

  constructor(readonly id: number, readonly type: ZombieType, models: ModelLibrary | null) {
    const scale = ZOMBIE_TYPES[type].scale;
    const model = models?.createZombie(id, scale) ?? null;
    if (model) {
      this.body = model;
    } else {
      this.body = new Humanoid(lookFor(type, id), styleFor(type, id));
      this.body.root.scale.setScalar(scale);
    }
  }

  get root(): THREE.Group {
    return this.body.root;
  }

  push(n: NetZombie, t: number): void {
    this.buffer.push({ t, x: n.p[0], y: n.p[1], z: n.p[2], yaw: n.yaw, s: n.s });
    if (this.buffer.length > 30) this.buffer.splice(0, this.buffer.length - 30);
    if (this.hits >= 0 && n.hc !== this.hits) this.body.hit();
    this.hits = n.hc;
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
    const root = this.body.root;
    root.position.set(s.x, s.y, s.z);
    root.rotation.y = s.yaw;

    // Movement this frame in the zombie's own frame (drives the gait without foot sliding).
    const dx = this.last ? s.x - this.last.x : 0;
    const dz = this.last ? s.z - this.last.z : 0;
    this.last = { x: s.x, z: s.z };
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const forward = dx * fx + dz * fz;
    const right = dx * -fz + dz * fx;
    const scale = ZOMBIE_TYPES[this.type].scale;
    this.body.update({
      localDx: right / scale,
      localDz: -forward / scale,
      dt,
      crouch: 0,
      aimPitch: 0,
      holding: 'none',
      attacking: s.s === ZombieAnim.attack,
      dead: s.s === ZombieAnim.dead,
    });
  }
}

/** Server-simulated zombies, interpolated like remote players, procedurally animated. */
export class ZombiesView {
  private readonly zombies = new Map<number, ZombieMesh>();

  constructor(private readonly scene: THREE.Scene, private readonly models: ModelLibrary | null = null) {}

  onSnapshot(list: NetZombie[], serverTime: number): void {
    const seen = new Set<number>();
    for (const n of list) {
      seen.add(n.id);
      let z = this.zombies.get(n.id);
      if (!z) {
        z = new ZombieMesh(n.id, ZOMBIE_TYPE_ORDER[n.t] ?? 'walker', this.models);
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
