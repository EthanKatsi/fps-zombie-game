import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import type { AnimInput } from '../anim/Humanoid';

/**
 * Drop-in character models (public/models/manifest.json). Supports glTF/GLB (e.g. Sketchfab)
 * and FBX (e.g. Mixamo), with animations embedded in the model or one file per animation.
 * If the manifest or a model is missing, the game falls back to the procedural Humanoid.
 */
export type ClipName = 'idle' | 'walk' | 'run' | 'attack' | 'death' | 'hit' | 'crouch' | 'crouchWalk';

export interface ModelEntry {
  /** Path under public/ (e.g. "models/zombie/scene.gltf" or "models/zombie/Zombie.fbx"). */
  model: string;
  /**
   * Optional separate animation files (Mixamo exports one FBX per animation). A list gives
   * variants: each character instance picks one (e.g. different attacks / deaths).
   */
  animations?: Partial<Record<ClipName, string | string[]>>;
  /** Explicit clip names inside the model, if auto-matching picks the wrong ones. */
  clips?: Partial<Record<ClipName, string>>;
  /** Target height in metres (model is scaled to it). Default 1.8. */
  height?: number;
  /** Extra yaw (radians) if the model faces +Z instead of -Z. Default PI (most models face +Z). */
  rotationY?: number;
  /** Ground speed (m/s) the walk / run clips were authored at, to sync their playback to movement. */
  walkSpeed?: number;
  runSpeed?: number;
  /** Shown in the in-game credits (required for CC-BY assets). */
  credit?: string;
}

export interface ModelManifest {
  zombies?: ModelEntry[];
  player?: ModelEntry;
}

/** Keywords used to find clips by name when the manifest doesn't say. */
const KEYWORDS: Record<ClipName, RegExp> = {
  idle: /idle|breath|stand/i,
  walk: /walk/i,
  run: /run|sprint|jog/i,
  attack: /attack|bite|punch|swipe|hit_?attack|scream/i,
  death: /death|die|dying|dead/i,
  hit: /hit.?react|react|damage|hurt|flinch/i,
  crouch: /crouch.?idle|crouch$/i,
  crouchWalk: /crouch.?walk|sneak/i,
};

interface Template {
  entry: ModelEntry;
  scene: THREE.Object3D;
  clips: Partial<Record<ClipName, THREE.AnimationClip>>;
  /** Extra variants per role from animation file lists (index 0 is clips[role]). */
  variants: Partial<Record<ClipName, THREE.AnimationClip[]>>;
  scale: number;
  yOffset: number;
}

const loadAny = async (url: string): Promise<{ scene: THREE.Object3D; animations: THREE.AnimationClip[] }> => {
  if (/\.fbx$/i.test(url)) {
    const obj = await new FBXLoader().loadAsync(url);
    return { scene: obj, animations: obj.animations };
  }
  const gltf = await new GLTFLoader().loadAsync(url);
  return { scene: gltf.scene, animations: gltf.animations };
};

/** Keep animations "in place": zero the horizontal motion of the root/hips (server drives movement). */
const stripRootMotion = (clip: THREE.AnimationClip): THREE.AnimationClip => {
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.position')) continue;
    const node = track.name.split('.')[0];
    if (!/hips|pelvis|root|armature/i.test(node)) continue;
    const v = track.values;
    const x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) {
      v[i] = x0;
      v[i + 2] = z0;
    }
  }
  return clip;
};

const pickClips = (all: THREE.AnimationClip[], entry: ModelEntry): Partial<Record<ClipName, THREE.AnimationClip>> => {
  const out: Partial<Record<ClipName, THREE.AnimationClip>> = {};
  for (const name of Object.keys(KEYWORDS) as ClipName[]) {
    const explicit = entry.clips?.[name];
    const clip = explicit ? all.find((c) => c.name === explicit) : all.find((c) => KEYWORDS[name].test(c.name));
    if (clip) out[name] = clip;
  }
  // "Attack" keyword shouldn't steal the hit-reaction clip and vice versa.
  if (out.attack && out.hit && out.attack === out.hit) delete out.hit;
  return out;
};

export class ModelLibrary {
  private zombies: Template[] = [];
  private player: Template | null = null;
  readonly credits: string[] = [];

  get hasZombies(): boolean {
    return this.zombies.length > 0;
  }

  get hasPlayer(): boolean {
    return this.player !== null;
  }

  /** Load everything listed in public/models/manifest.json (silently empty if absent). */
  static async load(): Promise<ModelLibrary> {
    const lib = new ModelLibrary();
    let manifest: ModelManifest;
    try {
      const res = await fetch('models/manifest.json');
      if (!res.ok) return lib;
      manifest = (await res.json()) as ModelManifest;
    } catch {
      return lib;
    }
    const build = async (entry: ModelEntry): Promise<Template | null> => {
      try {
        const base = await loadAny(encodeURI(entry.model));
        const all = [...base.animations];
        const variants: Partial<Record<ClipName, THREE.AnimationClip[]>> = {};
        const files = Object.entries(entry.animations ?? {}) as [ClipName, string | string[] | undefined][];
        await Promise.all(
          files.map(async ([name, urls]) => {
            const list = (Array.isArray(urls) ? urls : urls ? [urls] : []).map((u) => encodeURI(u));
            const loaded = await Promise.all(list.map((u) => loadAny(u).then((a) => a.animations[0] ?? null).catch((err) => (console.warn('[models] animation failed', u, err), null))));
            const clips = loaded.filter((c): c is THREE.AnimationClip => !!c);
            clips.forEach((c, i) => (c.name = i === 0 ? name : `${name}#${i}`)); // explicit file -> explicit role
            if (clips.length) {
              all.push(clips[0]);
              variants[name] = clips;
            }
          }),
        );
        // Animations from other files may use other units (FBX cm vs glTF m): scale their position
        // tracks so the hips' first frame matches the model's own rest hips height.
        let hipsRest = 0;
        base.scene.traverse((o) => {
          if (!hipsRest && /hips|pelvis/i.test(o.name)) hipsRest = o.position.length();
        });
        const matchUnits = (clip: THREE.AnimationClip) => {
          const hips = clip.tracks.find((t) => t.name.endsWith('.position') && /hips|pelvis/i.test(t.name));
          if (!hips || !hipsRest) return;
          const first = Math.hypot(hips.values[0], hips.values[1], hips.values[2]);
          const ratio = hipsRest / Math.max(first, 1e-6);
          if (Math.abs(Math.log(ratio)) < 0.3) return;
          for (const t of clip.tracks) if (t.name.endsWith('.position')) for (let i = 0; i < t.values.length; i++) t.values[i] *= ratio;
        };
        const fileClips = new Set(Object.values(variants).flat());
        fileClips.forEach((c) => c && matchUnits(c));
        all.forEach(stripRootMotion);
        for (const list of Object.values(variants)) list?.forEach(stripRootMotion);
        const clips = pickClips(all, { ...entry, clips: { ...Object.fromEntries(Object.keys(entry.animations ?? {}).map((k) => [k, k])), ...entry.clips } });
        // Normalise size: scale to the target height, feet on the ground.
        base.scene.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(base.scene);
        const h = Math.max(0.01, box.max.y - box.min.y);
        const scale = (entry.height ?? 1.8) / h;
        base.scene.traverse((o) => {
          if ((o as THREE.Mesh).isMesh) {
            o.castShadow = true;
            o.receiveShadow = true;
            // Skinned meshes are culled with their bind-pose bounds; animated poses can leave them.
            o.frustumCulled = false;
          }
        });
        if (entry.credit) lib.credits.push(entry.credit);
        return { entry, scene: base.scene, clips, variants, scale, yOffset: -box.min.y * scale };
      } catch (err) {
        console.warn('[models] failed to load', entry.model, err);
        return null;
      }
    };
    for (const e of manifest.zombies ?? []) {
      const t = await build(e);
      if (t) lib.zombies.push(t);
    }
    if (manifest.player) lib.player = await build(manifest.player);
    console.info(`[models] ${lib.zombies.length} zombie model(s), player model: ${lib.player ? 'yes' : 'no'}`);
    return lib;
  }

  createZombie(variant: number, typeScale: number): ModelRig | null {
    if (!this.zombies.length) return null;
    return new ModelRig(this.zombies[variant % this.zombies.length], typeScale, true, variant);
  }

  createPlayer(): ModelRig | null {
    return this.player ? new ModelRig(this.player, 1, false) : null;
  }
}

/**
 * One animated instance of a loaded model, with the same interface as the procedural
 * Humanoid (root / rightHand / update / hit) so views can use either.
 */
export class ModelRig {
  readonly root = new THREE.Group();
  readonly rightHand: THREE.Object3D;
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<ClipName, THREE.AnimationAction>();
  private current: ClipName | null = null;
  private readonly model: THREE.Object3D;
  private deadT = -1;
  private readonly handBone: THREE.Object3D | null;
  private readonly tmp = new THREE.Vector3();
  private readonly fallDir = Math.random() < 0.65 ? -1 : 1;

  constructor(private readonly t: Template, typeScale: number, private readonly zombie: boolean, seed = Math.floor(Math.random() * 1e9)) {
    this.model = cloneSkinned(t.scene);
    this.model.scale.setScalar(t.scale);
    this.model.position.y = t.yOffset;
    this.model.rotation.y = t.entry.rotationY ?? Math.PI;
    this.root.add(this.model);
    this.root.scale.setScalar(typeScale);
    this.mixer = new THREE.AnimationMixer(this.model);
    for (const [name, base] of Object.entries(t.clips) as [ClipName, THREE.AnimationClip][]) {
      // Pick this instance's variant of the role (stable per seed, different per role).
      const vs = t.variants[name];
      const clip = vs && vs.length > 1 ? vs[(((seed + name.length * 7919) * 2654435761) >>> 0) % vs.length] : base;
      const action = this.mixer.clipAction(clip);
      if (name === 'death' || name === 'hit') {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = name === 'death';
      }
      this.actions.set(name, action);
    }
    // Hand bone for held weapons (Mixamo: mixamorigRightHand; others: hand_r / RightHand).
    let hand: THREE.Object3D | null = null;
    this.model.traverse((o) => {
      if (!hand && /right.?hand$|hand.?r$|hand_right|righthand/i.test(o.name)) hand = o;
    });
    // The anchor lives under root (metre scale, facing the character's forward) and follows the
    // bone's position each frame; bone scale/orientation differ between model sources.
    this.handBone = hand;
    const anchor = new THREE.Group();
    anchor.position.set(0.25, 1.1, -0.3);
    this.root.add(anchor);
    this.rightHand = anchor;
    this.play('idle', 0);
  }

  private play(name: ClipName, fade = 0.25): void {
    const next = this.actions.get(name) ? name : name === 'run' && this.actions.get('walk') ? 'walk' : this.actions.get('idle') ? 'idle' : null;
    if (!next || next === this.current) return;
    const a = this.actions.get(next)!;
    a.reset().setEffectiveWeight(1).fadeIn(fade).play();
    if (this.current) this.actions.get(this.current)?.fadeOut(fade);
    this.current = next;
  }

  hit(): void {
    const h = this.actions.get('hit');
    if (!h || this.deadT >= 0) return;
    h.reset().setEffectiveWeight(0.8).fadeIn(0.05).play();
  }

  update(a: AnimInput): void {
    const dt = Math.min(0.1, a.dt);
    if (a.dead) {
      if (this.deadT < 0) {
        this.deadT = 0;
        if (this.actions.get('death')) this.play('death', 0.15);
      }
      this.deadT += dt;
      // No death clip: topple over like the procedural body does.
      if (!this.actions.get('death')) {
        const tip = Math.min(Math.PI / 2 - 0.08, 4.5 * Math.max(0, this.deadT - 0.1) ** 2);
        this.root.rotation.x = -this.fallDir * tip;
      }
      this.mixer.update(dt);
      return;
    }
    if (this.deadT >= 0) {
      this.deadT = -1;
      this.root.rotation.x = 0;
    }
    const speed = Math.hypot(a.localDx, a.localDz) / Math.max(dt, 1e-4);
    const walkRef = this.t.entry.walkSpeed ?? (this.zombie ? 1.0 : 1.5);
    const runRef = this.t.entry.runSpeed ?? (this.zombie ? 4.5 : 5.5);
    let state: ClipName;
    if (a.attacking) state = 'attack';
    else if (a.crouch > 0.5) state = speed > 0.3 ? 'crouchWalk' : 'crouch';
    else if (speed > (this.zombie ? 2.2 : 3.0)) state = 'run';
    else if (speed > 0.25) state = 'walk';
    else state = 'idle';
    if ((state === 'crouch' || state === 'crouchWalk') && !this.actions.get(state)) state = speed > 0.3 ? 'walk' : 'idle';
    this.play(state);
    // Sync walk/run playback to the actual speed so feet don't skate.
    const cur = this.current ? this.actions.get(this.current) : null;
    if (cur && (this.current === 'walk' || this.current === 'run' || this.current === 'crouchWalk')) {
      const ref = this.current === 'run' ? runRef : walkRef;
      cur.timeScale = THREE.MathUtils.clamp(speed / ref, 0.5, 2.0);
    } else if (cur) {
      cur.timeScale = 1;
    }
    this.mixer.update(dt);
    this.followHand();
  }

  private followHand(): void {
    if (!this.handBone) return;
    this.root.updateMatrixWorld(true);
    this.handBone.getWorldPosition(this.tmp);
    this.rightHand.position.copy(this.root.worldToLocal(this.tmp));
  }
}
