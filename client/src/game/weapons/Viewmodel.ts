import * as THREE from 'three';
import { ITEM_CATEGORY_COLORS, getItemDef } from '@grey/shared';

const mat = (color: number, rough = 0.7, metal = 0.1) => new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
const M = {
  skin: mat(0xb08b6e, 0.9),
  glove: mat(0x2d2a26, 0.95),
  gunmetal: mat(0x2b2e31, 0.5, 0.6),
  steel: mat(0x8a8f94, 0.35, 0.8),
  wood: mat(0x6e4f32, 0.8),
  alu: mat(0xa9adb0, 0.4, 0.7),
  rubber: mat(0x1d1d1d, 0.95),
  red: mat(0x7e1d18, 0.7),
};

const box = (w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) => {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  return mesh;
};
const cyl = (rt: number, rb: number, len: number, m: THREE.Material, x = 0, y = 0, z = 0, alongZ = true) => {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, len, 10), m);
  if (alongZ) mesh.rotation.x = Math.PI / 2;
  mesh.position.set(x, y, z);
  return mesh;
};

interface Model {
  root: THREE.Group;
  /** Muzzle position in model space (guns). */
  muzzle?: THREE.Vector3;
  kind: 'gun' | 'melee' | 'fists' | 'item';
  /** Extra Y offset so the sights line up with the screen center when aiming. */
  sightHeight?: number;
}

/** Procedural low-poly first-person models. Guns point down -Z. */
const buildModel = (defId: string | null): Model => {
  const g = new THREE.Group();
  const hand = (x: number, y: number, z: number) => g.add(box(0.07, 0.07, 0.11, M.glove, x, y, z));
  switch (defId) {
    case 'pistol':
      g.add(box(0.035, 0.04, 0.2, M.gunmetal, 0, 0.03, -0.02));
      g.add(box(0.03, 0.1, 0.045, M.rubber, 0, -0.035, 0.05));
      hand(0, -0.04, 0.06);
      return { root: g, muzzle: new THREE.Vector3(0, 0.03, -0.13), kind: 'gun', sightHeight: 0.055 };
    case 'shotgun':
      g.add(cyl(0.017, 0.017, 0.62, M.gunmetal, 0, 0.035, -0.3));
      g.add(cyl(0.022, 0.022, 0.2, M.wood, 0, 0.0, -0.3));
      g.add(box(0.045, 0.07, 0.22, M.gunmetal, 0, 0.02, 0.04));
      g.add(box(0.04, 0.09, 0.3, M.wood, 0, -0.02, 0.3));
      hand(0, -0.03, -0.3);
      hand(0, -0.04, 0.12);
      return { root: g, muzzle: new THREE.Vector3(0, 0.035, -0.62), kind: 'gun', sightHeight: 0.06 };
    case 'rifle':
      g.add(cyl(0.012, 0.014, 0.6, M.gunmetal, 0, 0.03, -0.32));
      g.add(box(0.045, 0.06, 0.25, M.wood, 0, 0.01, 0.0));
      g.add(box(0.04, 0.09, 0.3, M.wood, 0, -0.01, 0.3));
      g.add(cyl(0.024, 0.024, 0.26, M.rubber, 0, 0.085, -0.02));
      hand(0, -0.03, -0.2);
      hand(0, -0.04, 0.12);
      return { root: g, muzzle: new THREE.Vector3(0, 0.03, -0.63), kind: 'gun', sightHeight: 0.085 };
    case 'sniper_rifle':
      g.add(cyl(0.013, 0.016, 0.78, M.gunmetal, 0, 0.03, -0.42)); // long heavy barrel
      g.add(cyl(0.022, 0.022, 0.07, M.gunmetal, 0, 0.03, -0.83)); // muzzle brake
      g.add(box(0.05, 0.065, 0.3, M.rubber, 0, 0.01, -0.02)); // receiver / fore-end
      g.add(box(0.045, 0.1, 0.32, M.rubber, 0, -0.015, 0.3)); // stock
      g.add(box(0.035, 0.06, 0.07, M.gunmetal, 0, -0.06, 0.02)); // magazine
      g.add(cyl(0.03, 0.03, 0.34, M.gunmetal, 0, 0.1, -0.04)); // scope tube
      g.add(cyl(0.036, 0.03, 0.06, M.gunmetal, 0, 0.1, -0.23)); // objective bell
      g.add(box(0.012, 0.012, 0.05, M.steel, 0.045, 0.03, 0.08)); // bolt handle
      hand(0, -0.04, -0.22);
      hand(0, -0.05, 0.12);
      return { root: g, muzzle: new THREE.Vector3(0, 0.03, -0.87), kind: 'gun', sightHeight: 0.1 };
    case 'assault_rifle':
      g.add(box(0.045, 0.07, 0.3, M.gunmetal, 0, 0.02, 0.0)); // receiver
      g.add(box(0.05, 0.06, 0.26, M.rubber, 0, 0.02, -0.27)); // handguard
      g.add(cyl(0.011, 0.011, 0.18, M.gunmetal, 0, 0.025, -0.48)); // barrel
      g.add(box(0.035, 0.13, 0.06, M.gunmetal, 0, -0.07, -0.06)); // magazine
      g.add(box(0.04, 0.08, 0.22, M.rubber, 0, -0.005, 0.25)); // stock
      g.add(box(0.03, 0.035, 0.06, M.rubber, 0, 0.075, -0.02)); // red-dot housing
      hand(0, -0.04, -0.25);
      hand(0, -0.05, 0.1);
      return { root: g, muzzle: new THREE.Vector3(0, 0.025, -0.58), kind: 'gun', sightHeight: 0.085 };
    case 'crossbow':
      g.add(box(0.05, 0.05, 0.6, M.wood, 0, 0, -0.05));
      g.add(box(0.55, 0.025, 0.04, M.gunmetal, 0, 0.02, -0.32));
      g.add(box(0.5, 0.004, 0.004, M.rubber, 0, 0.03, -0.24));
      const bolt = box(0.012, 0.012, 0.45, M.alu, 0, 0.04, -0.2);
      bolt.name = 'bolt';
      g.add(bolt);
      hand(0, -0.04, -0.15);
      hand(0, -0.04, 0.15);
      return { root: g, muzzle: new THREE.Vector3(0, 0.04, -0.4), kind: 'gun', sightHeight: 0.06 };
    case 'bat':
      g.add(cyl(0.022, 0.04, 0.8, M.alu, 0, 0.35, 0, false));
      hand(0, -0.02, 0);
      return { root: g, kind: 'melee' };
    case 'crowbar':
      g.add(box(0.025, 0.7, 0.025, M.red, 0, 0.3, 0));
      g.add(box(0.025, 0.025, 0.1, M.red, 0, 0.64, -0.05));
      hand(0, -0.02, 0);
      return { root: g, kind: 'melee' };
    case 'machete':
      g.add(box(0.03, 0.14, 0.03, M.rubber, 0, 0.0, 0));
      g.add(box(0.006, 0.5, 0.06, M.steel, 0, 0.32, -0.01));
      hand(0, -0.02, 0);
      return { root: g, kind: 'melee' };
    case 'axe':
      g.add(cyl(0.02, 0.022, 0.75, M.wood, 0, 0.3, 0, false));
      g.add(box(0.03, 0.12, 0.2, M.red, 0, 0.62, -0.06));
      hand(0, -0.02, 0);
      return { root: g, kind: 'melee' };
    case null: {
      // Fists: two hands.
      g.add(box(0.09, 0.09, 0.14, M.skin, -0.32, -0.02, 0.05));
      g.add(box(0.09, 0.09, 0.14, M.skin, 0, 0, 0));
      return { root: g, kind: 'fists' };
    }
    default: {
      const def = getItemDef(defId);
      const color = new THREE.Color(def ? ITEM_CATEGORY_COLORS[def.category] : '#888');
      g.add(box(0.1, 0.12, 0.08, new THREE.MeshStandardMaterial({ color, roughness: 0.6 }), 0, 0.04, 0));
      hand(0, -0.03, 0.02);
      return { root: g, kind: 'item' };
    }
  }
};

const HIP = new THREE.Vector3(0.24, -0.24, -0.42);
const MELEE_HIP = new THREE.Vector3(0.28, -0.32, -0.5);

/**
 * First-person weapon/hand model, rendered in its own scene on top of the world (so it
 * never clips into walls). All animation is procedural.
 */
export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.01, 10);
  private readonly pivot = new THREE.Group();
  private model: Model = buildModel(null);
  private heldId: string | null | undefined = undefined;
  private time = 0;
  private equipT = 1;
  private kick = 0;
  private swing: { t: number; windup: number; total: number; side: number } | null = null;
  private reload: { t: number; duration: number } | null = null;
  private use: { t: number; duration: number } | null = null;
  private ads = 0;
  /** Spring-damped weapon sway (lags behind mouse look). */
  private swayX = 0;
  private swayY = 0;
  private swayVX = 0;
  private swayVY = 0;
  private sprint = 0;
  visible = true;

  constructor() {
    this.scene.add(new THREE.HemisphereLight(0xd0d2c8, 0x3a342c, 1.3));
    const key = new THREE.DirectionalLight(0xfff1dc, 1.4);
    key.position.set(1, 2, 1);
    this.scene.add(key);
    this.scene.add(this.pivot);
    this.pivot.add(this.model.root);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Swap the model when the held item changes (plays the raise animation). */
  hold(defId: string | null): void {
    if (defId === this.heldId) return;
    this.heldId = defId;
    this.pivot.remove(this.model.root);
    this.model = buildModel(defId);
    this.pivot.add(this.model.root);
    this.equipT = 0;
    this.swing = null;
    this.reload = null;
    this.use = null;
  }

  playSwing(windupMs: number, rate: number): void {
    const total = Math.max(windupMs / 1000 + 0.15, 1 / rate);
    this.swing = { t: 0, windup: windupMs / 1000, total, side: Math.random() < 0.5 ? 1 : -1 };
  }

  playFire(): void {
    this.kick = 1;
  }

  playReload(ms: number): void {
    this.reload = { t: 0, duration: ms / 1000 };
  }

  stopReload(): void {
    this.reload = null;
  }

  playUse(ms: number): void {
    this.use = { t: 0, duration: ms / 1000 };
  }

  stopUse(): void {
    this.use = null;
  }

  /** Crossbow: show/hide the loaded bolt. */
  setLoaded(loaded: boolean): void {
    const bolt = this.model.root.getObjectByName('bolt');
    if (bolt) bolt.visible = loaded;
  }

  /** World-space muzzle position for tracers / flashes, given the main camera. */
  muzzleWorld(mainCamera: THREE.Camera, out: THREE.Vector3): THREE.Vector3 {
    if (!this.model.muzzle) return out.set(0, 0, -0.5).applyMatrix4(mainCamera.matrixWorld);
    this.pivot.updateMatrixWorld();
    // Model space -> viewmodel camera space -> main camera space (they share the origin).
    out.copy(this.model.muzzle).applyMatrix4(this.model.root.matrixWorld);
    return out.applyMatrix4(mainCamera.matrixWorld);
  }

  get isGun(): boolean {
    return this.model.kind === 'gun';
  }

  /**
   * @param speed horizontal speed (m/s)
   * @param look  view rotation this frame (yaw, pitch deltas in radians) for sway
   * @param stepPhase footstep phase from LocalPlayer (bob synced to steps)
   * @param sprinting running pose
   * @param landDip 0..1 landing impulse
   */
  update(
    dt: number,
    speed: number,
    aiming: boolean,
    look: { dyaw: number; dpitch: number } = { dyaw: 0, dpitch: 0 },
    stepPhase = this.time * 9,
    sprinting = false,
    landDip = 0,
  ): void {
    this.time += dt;
    this.equipT = Math.min(1, this.equipT + dt / 0.3);
    this.kick = Math.max(0, this.kick - dt * 8);
    this.ads += ((aiming ? 1 : 0) - this.ads) * (1 - Math.exp(-dt * 14));

    const melee = this.model.kind === 'melee' || this.model.kind === 'fists';
    const hip = melee ? MELEE_HIP : HIP;
    // Sights sit just under the screen center, far enough out that the gun doesn't fill the view.
    const adsPos = new THREE.Vector3(0, -(this.model.sightHeight ?? 0.06) - 0.004, -0.45);
    const pos = hip.clone().lerp(adsPos, this.ads);
    const rot = new THREE.Euler(0, 0, 0, 'YXZ');

    // Sway: the weapon lags behind fast turns, then springs back (less when aiming).
    const swayGain = 1 - this.ads * 0.75;
    const k = 120, damp = 14;
    const tx = THREE.MathUtils.clamp(-look.dyaw * 1.6, -0.08, 0.08) * swayGain;
    const ty = THREE.MathUtils.clamp(look.dpitch * 1.6, -0.08, 0.08) * swayGain;
    this.swayVX += ((tx - this.swayX) * k - this.swayVX * damp) * dt;
    this.swayVY += ((ty - this.swayY) * k - this.swayVY * damp) * dt;
    this.swayX += this.swayVX * dt;
    this.swayY += this.swayVY * dt;
    pos.x += this.swayX * 0.5;
    pos.y += this.swayY * 0.5;
    rot.y += this.swayX * 1.2;
    rot.x += this.swayY * 1.2;
    rot.z += this.swayX * 1.5;

    // Footstep bob: a figure-eight synced to the actual steps (reduced while aiming).
    const bobAmt = Math.min(1, speed / 4.2) * (1 - this.ads * 0.85) * (1 + this.sprint * 0.6);
    pos.x += Math.sin(stepPhase) * 0.014 * bobAmt;
    pos.y += -Math.abs(Math.cos(stepPhase)) * 0.018 * bobAmt;
    rot.z += Math.sin(stepPhase) * 0.02 * bobAmt;

    // Idle breathing.
    const breathe = (1 - Math.min(1, speed / 2)) * (1 - this.ads * 0.8);
    pos.y += Math.sin(this.time * 1.7) * 0.004 * breathe;
    rot.x += Math.sin(this.time * 1.7 + 0.6) * 0.008 * breathe;

    // Landing dip.
    pos.y -= Math.sin(Math.min(1, landDip) * Math.PI) * 0.06;

    // Raise on equip.
    const e = 1 - this.equipT;
    pos.y -= e * e * 0.35;
    rot.x -= e * 0.6;

    if (melee) rot.set(rot.x + 0.25, rot.y - 0.15, rot.z - 0.35, 'YXZ');

    // Sprint pose: guns tilted down and across the body, melee weapons raised.
    this.sprint += ((sprinting && !aiming ? 1 : 0) - this.sprint) * (1 - Math.exp(-dt * 8));
    if (this.model.kind === 'gun') {
      rot.y += this.sprint * 0.75;
      rot.x -= this.sprint * 0.35;
      pos.x -= this.sprint * 0.06;
      pos.y -= this.sprint * 0.05;
    } else {
      rot.x += this.sprint * 0.25;
      pos.y += this.sprint * 0.03;
    }

    // Fire kick.
    pos.z += this.kick * 0.07;
    rot.x += this.kick * 0.12;

    // Melee swing: wind back, then sweep across and down.
    if (this.swing) {
      const s = this.swing;
      s.t += dt;
      if (s.t < s.windup) {
        const k = s.t / s.windup;
        rot.z += 0.6 * k * s.side;
        rot.x -= 0.5 * k;
        pos.x += 0.08 * k * s.side;
      } else {
        const k = Math.min(1, (s.t - s.windup) / Math.max(0.05, s.total - s.windup));
        const arc = Math.sin(k * Math.PI);
        rot.z += (0.6 - 1.6 * k) * s.side;
        rot.x += -0.5 + 1.2 * arc;
        pos.x -= 0.25 * arc * s.side;
        pos.z -= 0.15 * arc;
      }
      if (s.t >= s.total) this.swing = null;
    }

    // Reload / use: dip and tilt.
    const dip = this.reload ?? this.use;
    if (dip) {
      dip.t += dt;
      const k = Math.min(1, dip.t / dip.duration);
      const a = Math.sin(k * Math.PI);
      pos.y -= a * (this.use ? -0.05 : 0.16);
      pos.x -= a * (this.use ? 0.2 : 0);
      rot.z += a * (this.use ? 0.2 : 0.7);
      rot.x += a * (this.use ? 0.5 : 0);
      if (k >= 1) {
        if (this.reload === dip) this.reload = null;
        else this.use = null;
      }
    }

    this.pivot.position.copy(pos);
    this.pivot.rotation.copy(rot);
    this.pivot.visible = this.visible;
  }
}
