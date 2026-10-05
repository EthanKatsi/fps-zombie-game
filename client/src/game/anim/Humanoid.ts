import * as THREE from 'three';

export interface HumanoidLook {
  skin: THREE.Material;
  shirt: THREE.Material;
  pants: THREE.Material;
  shoes: THREE.Material;
  /** Torso width multiplier (bloaters are fat). */
  girth?: number;
  /** Hair colour index (survivors). */
  hair?: number;
}

export interface HumanoidStyle {
  zombie: boolean;
  /** 0..1: one leg drags (zombies). */
  limp: number;
  /** Forward hunch of the spine (radians). */
  hunch: number;
  /** Zombie arms reaching forward (radians at the shoulder). */
  reach: number;
  /** Runners flail their arms instead of reaching. */
  flail: boolean;
}

export interface AnimInput {
  /** Horizontal displacement this frame in the character's local frame (+z = backwards). */
  localDx: number;
  localDz: number;
  dt: number;
  crouch: number; // 0..1
  /** View pitch (players): head + arms follow it. */
  aimPitch: number;
  /** 'gun' = two-handed hold, 'melee' = one hand, 'item' = held low. */
  holding: 'none' | 'gun' | 'melee' | 'item';
  attacking: boolean;
  dead: boolean;
}

const capsule = (r: number, len: number) => new THREE.CapsuleGeometry(r, len, 4, 10);
const GEO = {
  torso: capsule(0.16, 0.26),
  head: new THREE.SphereGeometry(0.115, 16, 12),
  upperArm: capsule(0.052, 0.2),
  lowerArm: capsule(0.045, 0.19),
  hand: new THREE.SphereGeometry(0.05, 8, 6),
  upperLeg: capsule(0.072, 0.3),
  lowerLeg: capsule(0.058, 0.32),
  foot: new THREE.BoxGeometry(0.1, 0.07, 0.24),
  neck: capsule(0.05, 0.06),
  eye: new THREE.SphereGeometry(0.024, 8, 6),
  mouth: new THREE.BoxGeometry(0.07, 0.035, 0.03),
  hair: new THREE.SphereGeometry(0.122, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55),
  nose: new THREE.BoxGeometry(0.025, 0.04, 0.04),
};
const DARK = new THREE.MeshStandardMaterial({ color: 0x120d0b, roughness: 1 });
const HAIR = [0x2a2018, 0x4a3a28, 0x15120f, 0x6b5a45, 0x3a3a38].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 }));

/** Critically-damped spring towards a target (smooth, no overshoot). */
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

/**
 * Procedurally animated, jointed humanoid (no skeletal assets needed). The gait phase is
 * driven by distance travelled, so feet don't slide; hips bob and sway, the torso
 * counter-rotates, arms swing opposite the legs, knees bend through the swing phase.
 */
export class Humanoid {
  readonly root = new THREE.Group();
  /** Anchor in the right hand for held items (points forward along -Z). */
  readonly rightHand = new THREE.Group();
  private readonly hips = new THREE.Group();
  private readonly spine = new THREE.Group();
  private readonly chest = new THREE.Group();
  private readonly neck = new THREE.Group();
  private readonly shoulder: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly elbow: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly hip: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly knee: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];
  private readonly ankle: [THREE.Group, THREE.Group] = [new THREE.Group(), new THREE.Group()];

  private phase = Math.random() * Math.PI * 2;
  private speedSmooth = 0;
  private fwdSign = 1;
  private strafe = 0;
  private time = Math.random() * 100;
  private flinch = 0;
  private flinchTwist = 0;
  private attackT = 0;
  private deadT = -1;
  private readonly fallDir = Math.random() < 0.65 ? -1 : 1; // mostly backwards
  private readonly fallSide = (Math.random() - 0.5) * 0.6;

  constructor(look: HumanoidLook, private readonly style: HumanoidStyle) {
    const g = look.girth ?? 1;
    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(0, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };

    this.root.add(this.hips);
    this.hips.position.y = 0.92;
    this.hips.add(this.spine);
    const torso = mesh(GEO.torso, look.shirt, this.spine, 0.27);
    torso.scale.set(1.15 * g, 1, 0.75 * g);
    this.spine.add(this.chest);
    this.chest.position.y = 0.5;
    this.chest.add(this.neck);
    this.neck.position.y = 0.04;
    mesh(GEO.neck, look.skin, this.neck, 0.06);
    const head = mesh(GEO.head, look.skin, this.neck, 0.2, -0.01);
    head.scale.set(0.95, 1.1, 1.0);
    // Face (front of the head is -Z): eye sockets, nose, mouth. Zombies get sunken eyes and a gaping mouth.
    for (const ex of [-0.04, 0.04]) {
      const eye = mesh(GEO.eye, DARK, head, 0.025, -0.1);
      eye.position.x = ex;
      eye.scale.setScalar(style.zombie ? 1.25 : 0.7);
      eye.castShadow = false;
    }
    mesh(GEO.nose, look.skin, head, -0.005, -0.115).castShadow = false;
    const mouth = mesh(GEO.mouth, DARK, head, -0.06, -0.1);
    mouth.scale.set(style.zombie ? 1.1 : 0.8, style.zombie ? 1.8 : 0.5, 1);
    mouth.castShadow = false;
    if (!style.zombie) {
      // Hair cap.
      const hair = mesh(GEO.hair, HAIR[(look.hair ?? 0) % HAIR.length], head, 0.012, 0.005);
      hair.rotation.x = -0.25;
    }

    for (const i of [0, 1] as const) {
      const side = i === 0 ? -1 : 1;
      // Arm: shoulder -> elbow -> hand.
      const sh = this.shoulder[i];
      sh.position.set(side * (0.21 * g + 0.02), -0.04, 0);
      this.chest.add(sh);
      mesh(GEO.upperArm, look.shirt, sh, -0.14);
      const el = this.elbow[i];
      el.position.y = -0.29;
      sh.add(el);
      mesh(GEO.lowerArm, look.skin, el, -0.13);
      mesh(GEO.hand, look.skin, el, -0.28);
      if (i === 1) {
        this.rightHand.position.set(0, -0.29, -0.02);
        el.add(this.rightHand);
      }
      // Leg: hip -> knee -> ankle.
      const hp = this.hip[i];
      hp.position.set(side * 0.095 * g, 0, 0);
      this.hips.add(hp);
      mesh(GEO.upperLeg, look.pants, hp, -0.22);
      const kn = this.knee[i];
      kn.position.y = -0.45;
      hp.add(kn);
      mesh(GEO.lowerLeg, look.pants, kn, -0.22);
      const an = this.ankle[i];
      an.position.y = -0.44;
      kn.add(an);
      mesh(GEO.foot, look.shoes, an, -0.02, -0.05);
    }
  }

  /** Called when the character takes a hit: a quick flinch. */
  hit(): void {
    this.flinch = 1;
    this.flinchTwist = (Math.random() - 0.5) * 2;
  }

  update(a: AnimInput): void {
    const dt = Math.min(0.1, a.dt);
    this.time += dt;
    const st = this.style;

    // ------------------------------------------------------------- death
    if (a.dead) {
      if (this.deadT < 0) this.deadT = 0;
      this.deadT += dt;
      this.poseDead(this.deadT);
      return;
    }
    this.deadT = -1;
    this.root.rotation.set(0, 0, 0);
    this.root.position.y = 0;

    // ------------------------------------------------------------- gait
    const dist = Math.hypot(a.localDx, a.localDz);
    const speed = dist / Math.max(dt, 1e-4);
    this.speedSmooth = approach(this.speedSmooth, speed, 8, dt);
    const sp = this.speedSmooth;
    if (dist > 1e-4) {
      // Forward (-z) vs backwards (+z) and sideways component.
      this.fwdSign = approach(this.fwdSign, a.localDz <= 0 ? 1 : -1, 10, dt);
      this.strafe = approach(this.strafe, a.localDx / dist, 6, dt);
    }
    const running = sp > 3.2;
    const stride = running ? 2.4 : st.zombie ? 1.0 : 1.5; // metres per full cycle
    this.phase += (dist / stride) * Math.PI * 2 * (this.fwdSign >= 0 ? 1 : -1);
    const move = Math.min(1, sp / 1.2); // 0 idle .. 1 moving
    const run = Math.min(1, Math.max(0, (sp - 2.6) / 2));

    const ph = this.phase;
    const limp = st.limp;
    // Per-leg phase (the limping leg drags: smaller, slower swing).
    const legSwing = (i: 0 | 1) => {
      const p = ph + (i === 0 ? 0 : Math.PI);
      const amp = (0.45 + run * 0.35) * move * (i === 0 ? 1 - limp * 0.6 : 1);
      return { swing: Math.sin(p) * amp, lift: Math.max(0, -Math.cos(p)) };
    };

    // ------------------------------------------------------------- crouch & body
    const crouch = a.crouch;
    const bob = Math.abs(Math.cos(ph)) * (0.025 + run * 0.04) * move;
    const breathe = Math.sin(this.time * 1.6) * 0.012 * (1 - move);
    this.hips.position.y = 0.92 - crouch * 0.38 - bob * 0.8 + (st.zombie ? -0.03 : 0);
    this.hips.rotation.z = Math.sin(ph) * 0.05 * move + (st.zombie ? Math.sin(this.time * 0.7) * 0.04 : 0);
    this.hips.rotation.y = Math.sin(ph) * 0.12 * move * (1 - Math.abs(this.strafe));

    // Flinch spring.
    this.flinch = approach(this.flinch, 0, 6, dt);
    const fl = this.flinch;

    // Spine: lean into movement (more when running), counter-twist against the hips, hunch.
    this.attackT = approach(this.attackT, a.attacking ? 1 : 0, a.attacking ? 14 : 6, dt);
    const lean = run * 0.22 + move * 0.05 + st.hunch + crouch * 0.35 + this.attackT * (st.zombie ? 0.35 : 0.1) - fl * 0.35;
    this.spine.rotation.x = lean + breathe;
    this.spine.rotation.y = -this.hips.rotation.y * 1.3 + fl * this.flinchTwist * 0.25;
    this.spine.rotation.z = st.zombie ? Math.sin(this.time * 0.9 + 1) * 0.06 + limp * 0.08 : 0;
    this.chest.rotation.x = breathe * 0.5;

    // Head: look along aim pitch (players), loll (zombies).
    this.neck.rotation.x = st.zombie ? 0.25 + Math.sin(this.time * 1.3) * 0.08 : -a.aimPitch * 0.8 - lean * 0.6;
    this.neck.rotation.z = st.zombie ? Math.sin(this.time * 0.8) * 0.15 : 0;

    // ------------------------------------------------------------- legs
    for (const i of [0, 1] as const) {
      const { swing, lift } = legSwing(i);
      const sideways = this.strafe * Math.sin(ph + (i === 0 ? 0 : Math.PI)) * 0.25 * move;
      this.hip[i].rotation.x = swing * Math.abs(1 - Math.abs(this.strafe) * 0.7) + crouch * 1.25;
      this.hip[i].rotation.z = sideways;
      // Knee bends during the swing (foot lifts), more when running; deep in a crouch.
      const kneeBend = lift * (0.6 + run * 0.9) * move * (i === 0 ? 1 - limp * 0.5 : 1) + crouch * 2.1 + 0.05;
      this.knee[i].rotation.x = -kneeBend;
      // Keep the foot roughly flat.
      this.ankle[i].rotation.x = -(this.hip[i].rotation.x + this.knee[i].rotation.x) * 0.8;
    }

    // ------------------------------------------------------------- arms
    for (const i of [0, 1] as const) {
      const side = i === 0 ? -1 : 1;
      const counter = -legSwing(i).swing * (0.7 + run * 0.4); // arms swing opposite their leg
      let shX = counter;
      let shZ = side * 0.08;
      let elX = -(0.25 + run * 1.1) * (0.5 + move * 0.5);
      if (st.zombie) {
        if (st.flail && run > 0.3) {
          shX = Math.sin(ph * 1.5 + i * 2.1) * 1.1 + 0.4;
          shZ = side * (0.3 + Math.sin(ph + i) * 0.2);
          elX = -0.9 + Math.sin(ph * 2 + i) * 0.4;
        } else {
          // The classic reach, swaying; swipe down on attack.
          shX = st.reach + Math.sin(this.time * 1.7 + i * 1.3) * 0.12 + counter * 0.25 + this.attackT * 0.5;
          shZ = side * (0.1 + Math.sin(this.time + i) * 0.05);
          elX = -0.25 - this.attackT * 0.6;
        }
      } else if (a.holding === 'gun') {
        // Two-handed hold, following the aim.
        shX = 1.35 + a.aimPitch * 0.9 + (i === 0 ? 0.15 : 0) - this.attackT * 0.15;
        shZ = side * (i === 0 ? -0.55 : 0.05);
        elX = i === 0 ? -0.55 : -1.25;
      } else if (a.holding === 'melee' && i === 1) {
        // Weapon arm cocked; the attack swings it through.
        shX = 0.6 + this.attackT * 1.4 + a.aimPitch * 0.4;
        shZ = 0.2 - this.attackT * 0.6;
        elX = -1.2 + this.attackT * 0.9;
      } else if (a.holding === 'item' && i === 1) {
        shX = 0.4;
        elX = -1.1;
      }
      // Flinch throws the arms back a bit.
      this.shoulder[i].rotation.x = approach(this.shoulder[i].rotation.x, shX - fl * 0.4, 18, dt);
      this.shoulder[i].rotation.z = approach(this.shoulder[i].rotation.z, shZ, 18, dt);
      this.elbow[i].rotation.x = approach(this.elbow[i].rotation.x, elX, 18, dt);
    }
  }

  /** Knees buckle, then the body topples (accelerating like a falling plank) and goes limp. */
  private poseDead(t: number): void {
    const buckle = Math.min(1, t / 0.25);
    const fallT = Math.max(0, t - 0.15);
    const tip = Math.min(Math.PI / 2 - 0.08, 4.5 * fallT * fallT); // ~gravity-like acceleration
    this.hips.position.y = 0.92 - buckle * 0.25;
    this.root.rotation.x = -this.fallDir * tip;
    this.root.rotation.z = this.fallSide * (tip / (Math.PI / 2));
    // Pivot near the feet: lower slightly so the body rests on the ground.
    this.root.position.y = -Math.sin(tip) * 0.12;
    const limp = Math.min(1, fallT * 2.5);
    this.spine.rotation.x = 0.2 * buckle - limp * 0.15 * this.fallDir;
    for (const i of [0, 1] as const) {
      const side = i === 0 ? -1 : 1;
      this.knee[i].rotation.x = -0.9 * buckle * (1 - limp * 0.6);
      this.hip[i].rotation.x = 0.5 * buckle * (1 - limp * 0.5);
      this.shoulder[i].rotation.x = approach(this.shoulder[i].rotation.x, this.fallDir * 1.2 * limp, 10, 0.016);
      this.shoulder[i].rotation.z = approach(this.shoulder[i].rotation.z, side * (0.4 + limp * 0.8), 10, 0.016);
      this.elbow[i].rotation.x = -0.3 * limp;
    }
    this.neck.rotation.x = -0.3 * limp * this.fallDir;
  }
}
