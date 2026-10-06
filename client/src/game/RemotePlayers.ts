import * as THREE from 'three';
import { ITEM_CATEGORY_COLORS, MOVEMENT, NETWORK, PlayerFlags, getItemDef, lerp, lerpAngle, type NetPlayer } from '@grey/shared';
import { Humanoid, type CharacterBody, type HumanoidLook } from './anim/Humanoid';
import type { ModelLibrary } from './models/ModelLibrary';
import type { VehiclesView } from './VehiclesView';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
}

/** Survivor outfits: varied per player id so people are recognisable at a glance. */
const JACKETS = [0x4b5135, 0x5a4632, 0x2f3a4a, 0x55524a, 0x6b2f27, 0x3c4a3f];
const PANTS = [0x2c3a52, 0x5a5242, 0x2f2f2f, 0x47402f];
const SKINS = [0xc69c7d, 0xa77b5a, 0x8a5d3e, 0xe0b899, 0x6e4a32];
const pickFor = (list: number[], id: string, salt: number) => {
  let h = salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return list[(h >>> 0) % list.length];
};
const mat = (c: number, rough = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: rough });

/** Clothing/skin/hair chosen from the player id (same on every client). */
const lookForPlayer = (id: string): HumanoidLook => ({
  skin: mat(pickFor(SKINS, id, 3), 0.75),
  shirt: mat(pickFor(JACKETS, id, 7), 0.9),
  pants: mat(pickFor(PANTS, id, 11), 0.9),
  shoes: mat(0x1d1a17, 0.7),
  hair: pickFor([0, 1, 2, 3, 4], id, 13),
});

/** Third-person held item: a rough shape per category. */
const makeHeld = (defId: string): THREE.Object3D | null => {
  const def = getItemDef(defId);
  if (!def) return null;
  const color = new THREE.Color(ITEM_CATEGORY_COLORS[def.category]);
  const ranged = def.category === 'ranged';
  const m = new THREE.MeshStandardMaterial({ color: ranged ? 0x2b2e31 : color, roughness: 0.6, metalness: ranged ? 0.5 : 0 });
  let geo: THREE.BufferGeometry;
  if (ranged) geo = new THREE.BoxGeometry(0.06, 0.09, defId === 'pistol' ? 0.22 : defId === 'sniper_rifle' ? 1.1 : 0.75);
  else if (def.category === 'melee') geo = new THREE.BoxGeometry(0.05, 0.05, 0.7);
  else geo = new THREE.BoxGeometry(0.12, 0.12, 0.12);
  const mesh = new THREE.Mesh(geo, m);
  mesh.castShadow = true;
  return mesh;
};

const makeNameTag = (name: string): THREE.Sprite => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 30px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 128, 32);
  ctx.fillStyle = '#e8e3d4';
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
};

class RemotePlayer {
  readonly root = new THREE.Group();
  private readonly body: CharacterBody;
  private readonly ownMaterials: THREE.Material[];
  private readonly tag: THREE.Sprite;
  private buffer: Sample[] = [];
  private crouchBlend = 0;
  /** Held weapon anchor at chest height (follows the aim pitch). */
  private readonly hand = new THREE.Group();
  private heldId = '';
  private heldMesh: THREE.Object3D | null = null;
  private attackT = 0;
  private last: { x: number; z: number } | null = null;
  private hits = -1;

  constructor(readonly id: string, name: string, models: ModelLibrary | null) {
    const look = lookForPlayer(id);
    this.ownMaterials = [look.skin, look.shirt, look.pants, look.shoes];
    this.body = models?.createPlayer() ?? new Humanoid(look, { zombie: false, limp: 0, hunch: 0, reach: 0, flail: false });
    this.root.add(this.body.root);
    this.tag = makeNameTag(name);
    this.root.add(this.tag);
    this.hand.position.set(0.18, 1.3, -0.3);
    this.root.add(this.hand);
  }

  setHeld(defId: string): void {
    if (defId === this.heldId) return;
    this.heldId = defId;
    if (this.heldMesh) this.hand.remove(this.heldMesh);
    this.heldMesh = defId ? makeHeld(defId) : null;
    if (this.heldMesh) {
      // Items point forward (-Z in local space, same as the body facing).
      this.heldMesh.position.z = -0.2;
      this.hand.add(this.heldMesh);
    }
  }

  /** Quick swing/recoil jolt of the held item when this player attacks. */
  playAttack(): void {
    this.attackT = 1;
  }

  /** World position of the held item's tip (muzzle flash source). */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, -0.55);
    this.hand.updateWorldMatrix(true, false);
    return out.applyMatrix4(this.hand.matrixWorld);
  }

  push(n: NetPlayer, t: number): void {
    this.buffer.push({
      t,
      x: n.p[0],
      y: n.p[1],
      z: n.p[2],
      yaw: n.yaw,
      pitch: n.pitch,
      crouch: (n.f & PlayerFlags.crouching) !== 0,
    });
    this.seat = n.v ?? -1;
    this.setHeld(n.h ?? '');
    this.body.setArmor?.((n.f & PlayerFlags.helmet) !== 0, (n.f & PlayerFlags.vest) !== 0);
    if (this.hits >= 0 && n.hc !== this.hits) this.body.hit();
    this.hits = n.hc;
    if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);
  }

  /** vehicleId * 8 + seat while seated, else -1. */
  private seat = -1;

  /** Render `renderTime` (server ms) by interpolating between the bracketing snapshots. */
  update(renderTime: number, dt: number, vehicles?: VehiclesView): void {
    const b = this.buffer;
    if (b.length === 0) return;
    let s: Sample;
    if (renderTime <= b[0].t) {
      s = b[0];
    } else if (renderTime >= b[b.length - 1].t) {
      s = b[b.length - 1]; // no extrapolation: hold the latest known pose
    } else {
      let i = 0;
      while (i < b.length - 2 && b[i + 1].t < renderTime) i++;
      const a = b[i], c = b[i + 1];
      const k = (renderTime - a.t) / Math.max(1, c.t - a.t);
      s = {
        t: renderTime,
        x: lerp(a.x, c.x, k),
        y: lerp(a.y, c.y, k),
        z: lerp(a.z, c.z, k),
        yaw: lerpAngle(a.yaw, c.yaw, k),
        pitch: lerp(a.pitch, c.pitch, k),
        crouch: k < 0.5 ? a.crouch : c.crouch,
      };
      // Drop samples we've fully passed (keep one behind for interpolation).
      if (i > 0) b.splice(0, i);
    }

    this.crouchBlend += ((s.crouch ? 1 : 0) - this.crouchBlend) * (1 - Math.exp(-dt * 12));
    const height = lerp(MOVEMENT.standHeight, MOVEMENT.crouchHeight, this.crouchBlend);
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;
    // Seated: stick to the seat of the (separately interpolated) vehicle, facing its way.
    if (this.seat >= 0 && vehicles) {
      const vid = this.seat >> 3, seat = this.seat & 7;
      const feet = vehicles.seatFeet(vid, seat);
      const pose = vehicles.pose(vid);
      if (feet && pose) {
        this.root.position.set(feet.x, feet.y, feet.z);
        this.root.rotation.y = pose.yaw;
        const def = this.heldId ? getItemDef(this.heldId) : undefined;
        const gun = seat > 0 && def?.category === 'ranged';
        this.body.update({ localDx: 0, localDz: 0, dt, crouch: 0, aimPitch: s.pitch, holding: gun ? 'gun' : 'none', attacking: false, dead: false, seated: true });
        this.hand.visible = gun;
        this.tag.position.y = 1.55;
        this.last = { x: feet.x, z: feet.z };
        return;
      }
    }
    this.hand.visible = true;

    // Body animation from this frame's movement in the player's own frame.
    const dx = this.last ? s.x - this.last.x : 0;
    const dz = this.last ? s.z - this.last.z : 0;
    this.last = { x: s.x, z: s.z };
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    const def = this.heldId ? getItemDef(this.heldId) : undefined;
    this.attackT = Math.max(0, this.attackT - dt * 5);
    this.body.update({
      localDx: dx * -fz + dz * fx,
      localDz: -(dx * fx + dz * fz),
      dt,
      crouch: this.crouchBlend,
      aimPitch: s.pitch,
      holding: !def ? 'none' : def.category === 'ranged' ? 'gun' : def.category === 'melee' ? 'melee' : 'item',
      attacking: this.attackT > 0.3,
      dead: false,
    });

    this.tag.position.y = height + 0.35;
    this.hand.position.y = height - 0.5;
    this.hand.rotation.x = s.pitch * 0.9 + this.attackT * (def?.category === 'melee' ? 1.2 : 0.25);
  }

  dispose(): void {
    // Body geometry is shared between all humanoids: only free what this player owns.
    for (const m of this.ownMaterials) m.dispose();
    (this.tag.material as THREE.SpriteMaterial).map?.dispose();
    this.tag.material.dispose();
    if (this.heldMesh instanceof THREE.Mesh) {
      this.heldMesh.geometry.dispose();
      (this.heldMesh.material as THREE.Material).dispose();
    }
  }
}

/**
 * Your own body, shown in the third-person and facing camera views. Driven directly by the
 * predicted local state (no interpolation buffer), with the same humanoid animation.
 */
export class LocalAvatar {
  readonly root = new THREE.Group();
  private readonly body: CharacterBody;
  private readonly hand = new THREE.Group();
  private heldId = '';
  private heldMesh: THREE.Object3D | null = null;
  private attackT = 0;
  private crouchBlend = 0;
  private last: { x: number; z: number } | null = null;

  constructor(id: string, models: ModelLibrary | null = null) {
    this.body = models?.createPlayer() ?? new Humanoid(lookForPlayer(id), { zombie: false, limp: 0, hunch: 0, reach: 0, flail: false });
    this.root.add(this.body.root);
    this.hand.position.set(0.18, 1.3, -0.3);
    this.root.add(this.hand);
    this.root.visible = false;
  }

  setArmor(helmet: boolean, vest: boolean): void {
    this.body.setArmor?.(helmet, vest);
  }

  setHeld(defId: string): void {
    if (defId === this.heldId) return;
    this.heldId = defId;
    if (this.heldMesh) this.hand.remove(this.heldMesh);
    this.heldMesh = defId ? makeHeld(defId) : null;
    if (this.heldMesh) {
      this.heldMesh.position.z = -0.2;
      this.hand.add(this.heldMesh);
    }
  }

  playAttack(): void {
    this.attackT = 1;
  }

  hit(): void {
    this.body.hit();
  }

  /** World position of the held item's tip (tracers in third person). */
  muzzle(out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, -0.55);
    this.hand.updateWorldMatrix(true, false);
    return out.applyMatrix4(this.hand.matrixWorld);
  }

  update(feet: THREE.Vector3, yaw: number, pitch: number, crouching: boolean, dead: boolean, dt: number, seat?: { yaw: number; gun: boolean }): void {
    this.root.position.copy(feet);
    this.root.rotation.y = yaw;
    if (seat) {
      this.root.rotation.y = seat.yaw;
      this.body.update({ localDx: 0, localDz: 0, dt, crouch: 0, aimPitch: pitch, holding: seat.gun ? 'gun' : 'none', attacking: false, dead, seated: true });
      this.hand.visible = seat.gun;
      this.last = { x: feet.x, z: feet.z };
      return;
    }
    this.crouchBlend += ((crouching ? 1 : 0) - this.crouchBlend) * (1 - Math.exp(-dt * 12));
    const height = lerp(MOVEMENT.standHeight, MOVEMENT.crouchHeight, this.crouchBlend);
    const dx = this.last ? feet.x - this.last.x : 0;
    const dz = this.last ? feet.z - this.last.z : 0;
    this.last = { x: feet.x, z: feet.z };
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const def = this.heldId ? getItemDef(this.heldId) : undefined;
    this.attackT = Math.max(0, this.attackT - dt * 5);
    this.body.update({
      localDx: dx * -fz + dz * fx,
      localDz: -(dx * fx + dz * fz),
      dt,
      crouch: this.crouchBlend,
      aimPitch: pitch,
      holding: !def ? 'none' : def.category === 'ranged' ? 'gun' : def.category === 'melee' ? 'melee' : 'item',
      attacking: this.attackT > 0.3,
      dead,
    });
    this.hand.visible = !dead;
    this.hand.position.y = height - 0.5;
    this.hand.rotation.x = pitch * 0.9 + this.attackT * (def?.category === 'melee' ? 1.2 : 0.25);
  }
}

/** Other players: snapshot buffering + entity interpolation, rendered in the past. */
export class RemotePlayers {
  private readonly players = new Map<string, RemotePlayer>();
  private readonly names = new Map<string, string>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly localId: string,
    private readonly models: ModelLibrary | null = null,
  ) {}

  setName(id: string, name: string): void {
    this.names.set(id, name);
  }

  remove(id: string): void {
    this.names.delete(id);
    this.despawn(id);
  }

  private despawn(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.root);
    p.dispose();
    this.players.delete(id);
  }

  /** Apply one snapshot's player list. Players missing from it left our interest area. */
  onSnapshot(list: NetPlayer[], serverTime: number): void {
    const seen = new Set<string>();
    for (const n of list) {
      if (n.id === this.localId) continue;
      seen.add(n.id);
      let p = this.players.get(n.id);
      if (!p) {
        p = new RemotePlayer(n.id, this.names.get(n.id) ?? '???', this.models);
        this.players.set(n.id, p);
        this.scene.add(p.root);
      }
      p.push(n, serverTime);
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.despawn(id);
  }

  update(serverNow: number, dt: number, vehicles?: VehiclesView): void {
    const renderTime = serverNow - NETWORK.interpolationDelayMs;
    for (const p of this.players.values()) p.update(renderTime, dt, vehicles);
  }

  get(id: string): RemotePlayer | undefined {
    return this.players.get(id);
  }

  get count(): number {
    return this.players.size;
  }
}
