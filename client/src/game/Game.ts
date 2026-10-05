import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  CONTAINER_NAMES,
  ContainerIndex,
  DoorColliders,
  INVENTORY,
  getItemDef,
  getWeaponDef,
  weaponForItem,
  aimDirection as aimDirFromAngles,
  CITY,
  PLAYER_GROUPS,
  RENDER,
  SURVIVAL,
  TICK_DT,
  buildMapColliders,
  hashMap,
  loadMap,
  type JoinAccepted,
  type MapData,
  type InteractRequest,
  type MoveInput,
  type Rapier,
  type SlotRef,
} from '@grey/shared';
import type { Connection } from '../net/Connection';
import { Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import { LocalAvatar, RemotePlayers } from './RemotePlayers';
import { DoorRenderer, MapRenderer } from './MapRenderer';
import { GroundItemsView } from './GroundItemsView';
import { InventoryUI } from '../ui/InventoryUI';
import { SurvivalHud } from '../ui/SurvivalHud';
import { CombatHud } from '../ui/CombatHud';
import { KillFeed } from '../ui/KillFeed';
import { Effects } from './Effects';
import { DummiesView } from './DummiesView';
import { ZombiesView } from './ZombiesView';
import { Viewmodel } from './weapons/Viewmodel';
import { WeaponController } from './weapons/WeaponController';
import { Atmosphere } from '../render/atmosphere';
import { PostFX } from '../render/postfx';
import { QUALITY_LABELS, QUALITY_ORDER, getSettings, onSettingsChange, updateSettings, type GraphicsQuality, type Settings } from '../settings';
import { generateSurfaceTextures } from '../render/textures';
import { createWorldMaterial } from '../render/worldMaterial';

const SHADOW_SIZE: Record<GraphicsQuality, number> = { high: 4096, medium: 2048, low: 1024, performance: 1024 };
const PIXEL_RATIO: Record<GraphicsQuality, number> = {
  high: Math.min(window.devicePixelRatio, 2),
  medium: Math.min(window.devicePixelRatio, 1.5),
  low: 1,
  performance: 0.75,
};

/** Base mouse sensitivity (radians per pixel) at 1.0x. */
const BASE_SENSITIVITY = 0.0022;

const BUILDING_NAMES: Record<string, string> = {
  house: 'House',
  apartment: 'Apartment block',
  grocery: 'Grocery store',
  pharmacy: 'Pharmacy',
  hardware: 'Hardware store',
  gunshop: 'Gun shop',
  police: 'Police station',
};

export interface GameUi {
  setPaused(paused: boolean): void;
  setStamina(fraction: number): void;
  setDebug(text: string): void;
  setPrompt(text: string | null): void;
  toast(text: string): void;
}

type Target = InteractRequest | null;

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly atmosphere: Atmosphere;
  private readonly postfx: PostFX;
  private quality: GraphicsQuality = getSettings().quality;
  private baseFov = getSettings().fov;
  private readonly offSettings: () => void;
  private readonly world: World;
  private readonly map: MapData;
  private readonly mapRenderer: MapRenderer;
  private readonly doorColliders: DoorColliders;
  private readonly doorRenderer: DoorRenderer;
  private readonly input: Input;
  private readonly local: LocalPlayer;
  private readonly remotes: RemotePlayers;
  private readonly containerIndex: ContainerIndex;
  private readonly groundItems: GroundItemsView;
  private readonly inventoryUI: InventoryUI;
  private readonly hud = new SurvivalHud();
  private readonly combatHud = new CombatHud();
  private readonly effects: Effects;
  private readonly viewmodel = new Viewmodel();
  private readonly weapons: WeaponController;
  private readonly dummies: DummiesView;
  private readonly zombies: ZombiesView;
  private readonly killFeed: KillFeed;
  private dead = false;
  private readonly tmpV = new THREE.Vector3();
  private lastLook = { yaw: 0, pitch: 0 };
  /** V cycles: first person -> third person (over the shoulder) -> facing the player -> first. */
  private cameraMode: 'first' | 'third' | 'front' = 'first';
  private readonly avatar: LocalAvatar;
  private readonly eye = new THREE.Vector3();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly rayDir = new THREE.Vector3();
  private target: Target = null;
  private mapMismatch = false;
  private accumulator = 0;
  private lastFrame = performance.now();
  private running = true;
  private fps = 0;
  private frames = 0;
  private fpsTimer = 0;
  private online = 0;

  constructor(
    private readonly R: Rapier,
    private readonly conn: Connection,
    join: JoinAccepted,
    container: HTMLElement,
    private readonly ui: GameUi,
  ) {
    // --- renderer / scene ---
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(PIXEL_RATIO[this.quality]);
    this.renderer.autoClear = false; // world + viewmodel are drawn in two passes
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(this.baseFov, window.innerWidth / window.innerHeight, 0.05, RENDER.cameraFar);
    this.scene.add(this.camera);
    // Physical sky, hazy sun with soft shadows, sky reflections; then AO / bloom / grade.
    this.atmosphere = new Atmosphere(this.renderer, this.scene, RENDER.shadowExtent, SHADOW_SIZE[this.quality]);
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, this.quality);
    this.atmosphere.sun.castShadow = this.quality !== 'performance';
    this.viewmodel.scene.environment = this.scene.environment;
    this.viewmodel.scene.environmentIntensity = 0.8;
    // Procedural surface textures for every map piece (brick, concrete, asphalt...).
    const tTex = performance.now();
    const surfaces = generateSurfaceTextures(this.renderer);
    console.info(`[gfx] surface textures generated in ${Math.round(performance.now() - tTex)} ms`);
    const worldMat = createWorldMaterial(surfaces);

    // --- world: regenerate the same map + colliders as the server ---
    this.map = loadMap(join.mapId, join.mapSeed);
    const localHash = hashMap(this.map);
    if (localHash !== join.mapHash) {
      this.mapMismatch = true;
      console.error(`[map] hash mismatch: client ${localHash} vs server ${join.mapHash}. Refresh the page.`);
    }
    this.mapRenderer = new MapRenderer(this.map, worldMat);
    this.scene.add(this.mapRenderer.root);

    this.world = new R.World({ x: 0, y: 0, z: 0 });
    buildMapColliders(R, this.world, this.map);
    this.doorColliders = new DoorColliders(R, this.world, this.map.doors);
    const open = new Set(join.openDoors);
    for (const d of this.map.doors) {
      if (this.doorColliders.open[d.id] !== open.has(d.id)) this.doorColliders.set(d.id, open.has(d.id));
    }
    this.world.step();
    this.doorRenderer = new DoorRenderer(this.map.doors, this.doorColliders.open, worldMat);
    this.scene.add(this.doorRenderer.mesh);
    this.containerIndex = new ContainerIndex(this.map.containers);
    this.groundItems = new GroundItemsView(this.scene);
    this.effects = new Effects(this.scene);
    this.dummies = new DummiesView(this.scene, this.map.dummies, join.dummiesDown);
    this.zombies = new ZombiesView(this.scene);
    this.killFeed = new KillFeed(join.username);
    this.viewmodel.setAspect(window.innerWidth / window.innerHeight);

    // --- items UI (pure view; every change goes through the server) ---
    this.inventoryUI = new InventoryUI({
      use: (slot: number) => conn.socket.emit('invOp', { op: 'use', slot }),
      move: (from: SlotRef, to: SlotRef, qty?: number) => conn.socket.emit('invOp', { op: 'move', from, to, qty }),
      drop: (from: SlotRef, qty?: number) => conn.socket.emit('invOp', { op: 'drop', from, qty }),
      craft: (recipeId: string) => conn.socket.emit('invOp', { op: 'craft', recipeId }),
    });
    this.inventoryUI.setInventory(join.inventory);
    this.inventoryUI.setActive(join.inventory.activeHotbar);
    this.hud.setStats(join.stats);
    window.addEventListener('keydown', this.onUiKey);

    // --- players ---
    this.input = new Input(this.renderer.domElement);
    this.input.sensitivity = BASE_SENSITIVITY * getSettings().sensitivity;
    this.offSettings = onSettingsChange((s) => this.applySettings(s));
    // Unlocking the mouse for the inventory screen is not a pause.
    this.input.onLockChange = (locked) => this.ui.setPaused(!locked && !this.inventoryUI.isOpen && !this.dead);
    this.local = new LocalPlayer(R, this.world, join.state, this.input);
    this.remotes = new RemotePlayers(this.scene, join.playerId);
    for (const p of join.players) this.remotes.setName(p.id, p.username);
    this.online = join.players.length;
    this.avatar = new LocalAvatar(join.playerId);
    this.scene.add(this.avatar.root);
    this.weapons = new WeaponController({
      R,
      world: this.world,
      conn,
      input: this.input,
      local: this.local,
      camera: this.camera,
      viewmodel: this.viewmodel,
      effects: this.effects,
      hud: this.combatHud,
      playerId: join.playerId,
      shotSalt: join.shotSalt,
      useItem: (slot) => conn.socket.emit('invOp', { op: 'use', slot }),
      toast: (t) => this.ui.toast(t),
      aimRay: (o, d) => this.aimRay(o, d),
      muzzle: (out) => (this.cameraMode === 'first' ? this.viewmodel.muzzleWorld(this.camera, out) : this.avatar.muzzle(out)),
      onAttack: () => this.avatar.playAttack(),
    });

    // --- network ---
    const s = conn.socket;
    s.on('snapshot', (snap) => {
      conn.observeServerTime(snap.serverTime + conn.rtt / 2, 0.05);
      if (!this.dead) this.local.reconcile(snap.ack, snap.you);
      this.remotes.onSnapshot(snap.players, snap.serverTime);
      this.zombies.onSnapshot(snap.zombies, snap.serverTime);
    });
    s.on('playerJoined', (p) => {
      this.remotes.setName(p.id, p.username);
      this.online++;
    });
    s.on('playerLeft', ({ id }) => {
      this.remotes.remove(id);
      this.online = Math.max(1, this.online - 1);
    });
    s.on('doorChanged', ({ id, open: isOpen }) => {
      this.doorColliders.set(id, isOpen);
      this.world.step(); // keep the prediction world's scene queries in sync
      this.doorRenderer.setOpen(id, isOpen);
    });
    s.on('inventory', (inv) => this.inventoryUI.setInventory(inv));
    s.on('containerOpened', (c) => {
      this.inventoryUI.setContainer(c);
      if (!this.inventoryUI.isOpen) this.openInventory();
    });
    s.on('containerUpdate', ({ key, slots }) => this.inventoryUI.updateContainer(key, slots));
    s.on('containerClosed', ({ key }) => {
      if (this.inventoryUI.openContainerKey === key) this.inventoryUI.setContainer(null);
    });
    s.on('groundItems', (msg) => this.groundItems.apply(msg));
    s.on('notice', ({ text }) => this.ui.toast(text));
    s.on('stats', (st) => this.hud.setStats(st));
    s.on('damaged', ({ amount, from }) => {
      this.hud.hit(amount);
      this.avatar.hit();
      if (from) {
        // Angle of the attacker relative to where we're looking (0 = ahead, + = to the right).
        const me = this.local.state.pos;
        const yawTo = Math.atan2(-(from[0] - me.x), -(from[2] - me.z));
        this.combatHud.damageFrom(-(yawTo - this.input.yaw));
      }
    });
    s.on('useStarted', ({ defId, durationMs }) => {
      this.hud.startUse(getItemDef(defId)?.name ?? defId, durationMs);
      this.viewmodel.playUse(durationMs);
    });
    s.on('useEnded', () => {
      this.hud.endUse();
      this.viewmodel.stopUse();
    });
    s.on('weaponState', (msg) => this.weapons.onWeaponState(this.inventoryUI.inventory, msg));
    s.on('reloadStarted', ({ durationMs }) => {
      this.weapons.onReloadStarted(durationMs);
      this.hud.startUse('Reloading', durationMs);
    });
    s.on('reloadEnded', () => {
      this.weapons.onReloadEnded();
      this.hud.endUse();
    });
    s.on('hitConfirm', ({ head, kill }) => this.combatHud.hit(head || kill));
    s.on('shotFired', (e) => {
      const w = getWeaponDef(e.weapon);
      const remote = this.remotes.get(e.shooter);
      remote?.playAttack();
      const origin = remote ? remote.muzzle(this.tmpV) : this.tmpV.set(e.o[0], e.o[1], e.o[2]);
      if (w && w.kind !== 'melee') {
        if (w.noiseRadius > 30) this.effects.muzzleFlash(origin.clone());
        for (const end of e.ends) this.effects.tracer(origin.clone(), new THREE.Vector3(end[0], end[1], end[2]));
      }
      for (const end of e.ends) if (end[3]) this.effects.impact(new THREE.Vector3(end[0], end[1], end[2]), end[3] === 2);
    });
    s.on('projectile', ({ id, p, v }) =>
      this.effects.spawnBolt(id, new THREE.Vector3(...p), new THREE.Vector3(...v), getWeaponDef('crossbow')?.projectileGravity ?? 9.8),
    );
    s.on('projectileEnd', ({ id, p, hit }) => this.effects.endBolt(id, new THREE.Vector3(...p), hit));
    s.on('dummyState', ({ id, down }) => this.dummies.setDown(id, down));
    s.on('killFeed', (e) => this.killFeed.push(e));
    s.on('died', (info) => {
      this.dead = true;
      if (this.inventoryUI.isOpen) this.closeInventory(false);
      this.ui.setPrompt(null);
      this.ui.setPaused(false);
      if (document.pointerLockElement) document.exitPointerLock();
      this.hud.showDeath(info, () => conn.socket.emit('respawn'));
      this.weapons.reset();
      this.combatHud.setScope(false);
      this.combatHud.setAmmo(null);
    });
    s.on('respawned', ({ state, inventory, stats }) => {
      this.dead = false;
      this.local.resetTo(state);
      this.inventoryUI.setInventory(inventory);
      this.hud.setStats(stats);
      this.hud.hideDeath();
      this.input.requestLock();
      // If the browser refuses the lock (no recent click), fall back to "click to resume".
      window.setTimeout(() => this.ui.setPaused(!this.input.locked), 300);
    });

    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('click', () => this.input.requestLock());
    this.input.requestLock();
    // Compile shaders in the background (KHR_parallel_shader_compile) before the first frame,
    // so joining doesn't freeze while the GPU driver compiles everything.
    this.ui.toast('Preparing graphics...');
    const tShaders = performance.now();
    this.renderer
      .compileAsync(this.scene, this.camera)
      .catch(() => {})
      .finally(() => {
        console.info(`[gfx] shaders ready in ${Math.round(performance.now() - tShaders)} ms`);
        this.lastFrame = performance.now();
        requestAnimationFrame(this.frame);
      });
  }

  private openInventory(): void {
    this.inventoryUI.open();
    this.ui.setPrompt(null);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private closeInventory(relock: boolean): void {
    if (this.inventoryUI.openContainerKey) this.conn.socket.emit('closeContainer');
    this.inventoryUI.close();
    if (relock) this.input.requestLock();
    else this.ui.setPaused(!this.input.locked);
  }

  /** Keys while the inventory screen is open (pointer unlocked, so Input ignores them). */
  private onUiKey = (e: KeyboardEvent) => {
    if (!this.inventoryUI.isOpen) return;
    if (e.code === 'Tab' || e.code === 'KeyI' || (e.code === 'KeyE' && this.inventoryUI.openContainerKey)) {
      e.preventDefault();
      this.closeInventory(true);
    } else if (e.code === 'Escape') {
      this.closeInventory(false);
    }
  };

  /** Hotbar keys, wheel, inventory toggle and quick drop (while playing). */
  private updateHotbarInput(): void {
    if (this.input.consumePress('Tab') || this.input.consumePress('KeyI')) {
      this.openInventory();
      return;
    }
    let active = this.inventoryUI.activeHotbar;
    for (let i = 0; i < INVENTORY.hotbarSize; i++) if (this.input.consumePress(`Digit${i + 1}`)) active = i;
    const wheel = this.input.consumeWheel();
    if (wheel) active = (((active + wheel) % INVENTORY.hotbarSize) + INVENTORY.hotbarSize) % INVENTORY.hotbarSize;
    if (active !== this.inventoryUI.activeHotbar) {
      this.inventoryUI.setActive(active);
      this.conn.socket.emit('invOp', { op: 'select', hotbar: active });
    }
    if (this.input.consumePress('F8')) this.cycleQuality();
    if (this.input.consumePress('KeyV')) {
      this.cameraMode = this.cameraMode === 'first' ? 'third' : this.cameraMode === 'third' ? 'front' : 'first';
      this.ui.toast(this.cameraMode === 'first' ? 'First person' : this.cameraMode === 'third' ? 'Third person' : 'Facing view');
    }
    const held = this.inventoryUI.inventory?.slots[active];
    if (this.input.consumePress('KeyQ') && held) {
      this.conn.socket.emit('invOp', { op: 'drop', from: { owner: 'self', index: active } });
    }
  }

  /** Called by the overlay when the player clicks "resume". */
  resume(): void {
    this.input.requestLock();
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.postfx.setSize(window.innerWidth, window.innerHeight);
    this.viewmodel.setAspect(this.camera.aspect);
  };

  /** F8: cycle graphics presets (same setting as the menu / pause screen). */
  private cycleQuality(): void {
    const next = QUALITY_ORDER[(QUALITY_ORDER.indexOf(this.quality) + 1) % QUALITY_ORDER.length];
    updateSettings({ quality: next });
    this.ui.toast(`Graphics: ${QUALITY_LABELS[next]}`);
  }

  /** Apply settings from the menu / pause screen live. */
  private applySettings(s: Settings): void {
    this.input.sensitivity = BASE_SENSITIVITY * s.sensitivity;
    this.baseFov = s.fov;
    if (s.quality === this.quality) return;
    this.quality = s.quality;
    this.postfx.setQuality(s.quality);
    this.renderer.setPixelRatio(PIXEL_RATIO[s.quality]);
    const sun = this.atmosphere.sun;
    sun.castShadow = s.quality !== 'performance';
    sun.shadow.mapSize.set(SHADOW_SIZE[s.quality], SHADOW_SIZE[s.quality]);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    this.onResize();
  }

  private frame = (now: number) => {
    if (!this.running) return;
    requestAnimationFrame(this.frame);
    const dt = Math.min(0.25, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    // Fixed-rate prediction ticks; inputs from this frame are sent in one batch.
    this.accumulator += dt;
    const batch: MoveInput[] = [];
    while (this.accumulator >= TICK_DT) {
      if (!this.dead) batch.push(this.local.fixedUpdate());
      this.accumulator -= TICK_DT;
    }
    if (batch.length) this.conn.socket.emit('input', batch);

    this.local.updateCamera(this.camera, this.accumulator / TICK_DT, dt);
    this.applyCameraMode(dt);
    this.hud.update(dt);
    const inv = this.inventoryUI.inventory;
    const playing = !this.inventoryUI.isOpen && !this.dead;
    if (playing) {
      this.updateHotbarInput();
      this.updateInteraction();
      if (inv) this.weapons.update(dt, inv, this.inventoryUI.activeHotbar, this.hud.using);
      if (this.cameraMode === 'front') this.combatHud.setCrosshair(0, false); // looking at yourself
    }
    this.updateAim(dt);
    this.remotes.update(this.conn.serverNow(), dt);
    this.zombies.update(this.conn.serverNow(), dt);
    this.doorRenderer.update(dt);
    this.dummies.update(dt);
    this.effects.update(dt);
    this.mapRenderer.update(this.camera.position);
    this.updateSun();

    // Pass 1: the world (+ post-processing). Pass 2: the first-person viewmodel on top.
    this.postfx.render(dt);
    const v = this.local.state.vel;
    this.viewmodel.visible = !this.dead && !this.scoped && this.cameraMode === 'first';
    const look = { dyaw: this.input.yaw - this.lastLook.yaw, dpitch: this.input.pitch - this.lastLook.pitch };
    this.lastLook = { yaw: this.input.yaw, pitch: this.input.pitch };
    this.viewmodel.update(
      dt,
      this.local.state.grounded ? Math.hypot(v.x, v.z) : 0,
      this.weapons.aiming,
      look,
      this.local.stepPhase,
      this.local.state.sprinting,
      this.local.landDip,
    );
    this.renderer.clearDepth();
    this.renderer.render(this.viewmodel.scene, this.viewmodel.camera);

    this.updateHud(dt);
  };

  private scoped = false;

  /** Aim-down-sights zoom; the rifle swaps to a full-screen scope once zoomed in. */
  private updateAim(dt: number): void {
    const held = this.inventoryUI.inventory?.slots[this.inventoryUI.activeHotbar];
    const w = weaponForItem(held?.defId);
    // ADS zoom keeps the weapon's magnification relative to your chosen FOV.
    const target = this.weapons.aiming && !this.dead ? (w.adsFov ?? 75) * (this.baseFov / 75) : this.baseFov;
    if (Math.abs(this.camera.fov - target) > 0.01) {
      this.camera.fov += (target - this.camera.fov) * (1 - Math.exp(-dt * 16));
      this.camera.updateProjectionMatrix();
    }
    this.scoped = this.cameraMode === 'first' && this.weapons.aiming && w.id === 'rifle' && this.camera.fov < (w.adsFov ?? 75) * (this.baseFov / 75) + 6;
    this.combatHud.setScope(this.scoped);
  }

  /**
   * Third-person / facing camera. The first-person camera (with head-bob) has just been placed
   * at the eye; remember that, then move the camera out, stopping short of walls.
   */
  private applyCameraMode(dt: number): void {
    this.eye.copy(this.camera.position);
    const showBody = this.cameraMode !== 'first';
    this.avatar.root.visible = showBody;
    if (showBody) {
      const inv = this.inventoryUI.inventory;
      this.avatar.setHeld(inv?.slots[this.inventoryUI.activeHotbar]?.defId ?? '');
      this.avatar.update(this.local.renderFeet, this.input.yaw, this.input.pitch, this.local.state.crouching, this.dead, dt);
    }
    if (this.cameraMode === 'first') return;

    const yaw = this.input.yaw, pitch = this.input.pitch;
    const right = this.tmpA.set(Math.cos(yaw), 0, -Math.sin(yaw));
    const desired = this.tmpB.copy(this.eye);
    if (this.cameraMode === 'third') {
      const f = aimDirFromAngles(yaw, pitch);
      desired.x += -f.x * 3.0 + right.x * 0.55;
      desired.y += -f.y * 3.0 + 0.3;
      desired.z += -f.z * 3.0 + right.z * 0.55;
    } else {
      desired.x += -Math.sin(yaw) * 2.2;
      desired.y += 0.05;
      desired.z += -Math.cos(yaw) * 2.2;
    }
    // Don't put the camera inside walls: pull it in front of whatever is between it and the eye.
    const dir = this.tmpA.copy(desired).sub(this.eye);
    const dist = dir.length();
    dir.divideScalar(dist);
    const ray = new this.R.Ray({ x: this.eye.x, y: this.eye.y, z: this.eye.z }, { x: dir.x, y: dir.y, z: dir.z });
    const hit = this.world.castRay(ray, dist, true, undefined, PLAYER_GROUPS, this.local.motor.collider);
    const t = hit ? Math.max(0.2, hit.timeOfImpact - 0.25) : dist;
    this.camera.position.copy(this.eye).addScaledVector(dir, t);
    if (this.cameraMode === 'third') this.camera.rotation.set(pitch, yaw, 0, 'YXZ');
    else this.camera.lookAt(this.eye.x, this.eye.y - 0.1, this.eye.z);
  }

  /**
   * The ray shots and E-interactions use: from the player's eye towards what the crosshair is
   * on. (In third person the camera is behind you, so aim at the crosshair's target point.)
   */
  private aimRay(origin: THREE.Vector3, dir: THREE.Vector3): void {
    origin.copy(this.eye);
    if (this.cameraMode === 'first') {
      this.camera.getWorldDirection(dir);
      return;
    }
    const a = aimDirFromAngles(this.input.yaw, this.input.pitch);
    if (this.cameraMode === 'front') {
      dir.set(a.x, a.y, a.z);
      return;
    }
    const c = this.camera.position;
    const ray = new this.R.Ray({ x: c.x, y: c.y, z: c.z }, a);
    const hit = this.world.castRay(ray, 250, true, undefined, PLAYER_GROUPS, this.local.motor.collider);
    const t = hit ? hit.timeOfImpact : 250;
    dir.set(c.x + a.x * t - origin.x, c.y + a.y * t - origin.y, c.z + a.z * t - origin.z).normalize();
  }

  /** Look-at raycast: what would E interact with? Ground items > doors > containers. */
  private updateInteraction(): void {
    const o = this.tmpB;
    const d = this.rayDir;
    this.aimRay(o, d);
    const range = INVENTORY.useRange;
    const ray = new this.R.Ray({ x: o.x, y: o.y, z: o.z }, { x: d.x, y: d.y, z: d.z });
    const hit = this.world.castRay(ray, range, true, undefined, PLAYER_GROUPS, this.local.motor.collider);
    const hitDist = hit ? hit.timeOfImpact : range;

    let prompt: string | null = null;
    this.target = null;
    const item = this.groundItems.pick(o, d, hitDist + 0.15);
    if (item) {
      this.target = { kind: 'pickup', id: item.item.id };
      if (item.item.defId === 'loot_bag') {
        prompt = `Search ${item.item.title ?? 'Bag'}`;
      } else {
        const name = getItemDef(item.item.defId)?.name ?? item.item.defId;
        prompt = `Pick up ${name}${item.item.qty > 1 ? ` ×${item.item.qty}` : ''}`;
      }
    } else if (hit) {
      const doorId = this.doorColliders.byHandle.get(hit.collider.handle);
      if (doorId !== undefined) {
        this.target = { kind: 'door', id: doorId };
        prompt = this.doorColliders.open[doorId] ? 'Close door' : 'Open door';
      } else {
        const t = hit.timeOfImpact;
        const c = this.containerIndex.atPoint(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t);
        if (c) {
          this.target = { kind: 'container', id: c.id };
          prompt = `Search ${CONTAINER_NAMES[c.kind]}`;
        }
      }
    }
    this.ui.setPrompt(prompt);
    if (this.input.consumePress('KeyE') && this.target) this.conn.socket.emit('interact', this.target);
  }

  /** Sky follows the camera; the shadow box follows the player (texel-snapped). */
  private updateSun(): void {
    this.atmosphere.update(this.camera, RENDER.shadowExtent);
  }

  private updateHud(dt: number): void {
    this.frames++;
    this.fpsTimer += dt;
    this.ui.setStamina(this.local.state.stamina / SURVIVAL.stamina.max);
    if (this.fpsTimer >= 0.5) {
      this.fps = Math.round(this.frames / this.fpsTimer);
      this.frames = 0;
      this.fpsTimer = 0;
      const p = this.local.state.pos;
      const info = this.renderer.info.render;
      this.ui.setDebug(
        [
          this.mapMismatch ? '!! MAP MISMATCH - refresh the page !!' : '',
          `${this.fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(0)}k tris · ${Math.round(this.conn.rtt)} ms ping`,
          `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${this.local.state.grounded ? '' : ' (air)'} · ${this.locationLabel()}`,
          `pending ${this.local.pendingCount} · last correction ${this.local.lastCorrection.toFixed(3)} m`,
          `players ${this.online} online, ${this.remotes.count} nearby · ${this.zombies.count} zombies · ${this.groundItems.count} items near`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  /** Which building the player is in (helps find shops until there's a map). */
  private locationLabel(): string {
    const p = this.local.state.pos;
    for (const b of this.map.buildings) {
      const [x0, z0, x1, z1] = b.bounds;
      if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
      const floor = Math.floor((p.y - b.floorY + 0.5) / CITY.floorHeight);
      const where = floor >= b.floors ? 'roof' : floor > 0 ? `floor ${floor + 1}` : 'ground floor';
      return `in ${BUILDING_NAMES[b.type]} (${where})`;
    }
    return 'outside';
  }

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onUiKey);
    this.offSettings();
    this.inventoryUI.close();
    this.killFeed.clear();
    this.hud.hideDeath();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.world.free();
  }
}
