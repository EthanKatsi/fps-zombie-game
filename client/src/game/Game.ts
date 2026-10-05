import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  CONTAINER_NAMES,
  ContainerIndex,
  DoorColliders,
  INVENTORY,
  getItemDef,
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
import { RemotePlayers } from './RemotePlayers';
import { DoorRenderer, MapRenderer } from './MapRenderer';
import { GroundItemsView } from './GroundItemsView';
import { InventoryUI } from '../ui/InventoryUI';
import { SurvivalHud } from '../ui/SurvivalHud';

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
  private readonly sun: THREE.DirectionalLight;
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
  private dead = false;
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
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, RENDER.cameraFar);
    this.scene.add(this.camera);
    const sky = new THREE.Color(0x8a8c86);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, RENDER.fogNear, RENDER.fogFar);
    this.scene.add(new THREE.HemisphereLight(0xb7b9b0, 0x3a342c, 1.25));

    // Shadow-casting sun; its shadow box follows the player (see updateSun).
    this.sun = new THREE.DirectionalLight(0xfff1dc, 1.5);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -RENDER.shadowExtent;
    sc.right = sc.top = RENDER.shadowExtent;
    sc.near = 1;
    sc.far = 300;
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.03;
    this.scene.add(this.sun, this.sun.target);

    // --- world: regenerate the same map + colliders as the server ---
    this.map = loadMap(join.mapId, join.mapSeed);
    const localHash = hashMap(this.map);
    if (localHash !== join.mapHash) {
      this.mapMismatch = true;
      console.error(`[map] hash mismatch: client ${localHash} vs server ${join.mapHash}. Refresh the page.`);
    }
    this.mapRenderer = new MapRenderer(this.map);
    this.scene.add(this.mapRenderer.root);

    this.world = new R.World({ x: 0, y: 0, z: 0 });
    buildMapColliders(R, this.world, this.map);
    this.doorColliders = new DoorColliders(R, this.world, this.map.doors);
    const open = new Set(join.openDoors);
    for (const d of this.map.doors) {
      if (this.doorColliders.open[d.id] !== open.has(d.id)) this.doorColliders.set(d.id, open.has(d.id));
    }
    this.world.step();
    this.doorRenderer = new DoorRenderer(this.map.doors, this.doorColliders.open);
    this.scene.add(this.doorRenderer.mesh);
    this.containerIndex = new ContainerIndex(this.map.containers);
    this.groundItems = new GroundItemsView(this.scene);

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
    // Unlocking the mouse for the inventory screen is not a pause.
    this.input.onLockChange = (locked) => this.ui.setPaused(!locked && !this.inventoryUI.isOpen && !this.dead);
    this.local = new LocalPlayer(R, this.world, join.state, this.input);
    this.remotes = new RemotePlayers(this.scene, join.playerId);
    for (const p of join.players) this.remotes.setName(p.id, p.username);
    this.online = join.players.length;

    // --- network ---
    const s = conn.socket;
    s.on('snapshot', (snap) => {
      conn.observeServerTime(snap.serverTime + conn.rtt / 2, 0.05);
      if (!this.dead) this.local.reconcile(snap.ack, snap.you);
      this.remotes.onSnapshot(snap.players, snap.serverTime);
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
    s.on('damaged', ({ amount }) => this.hud.hit(amount));
    s.on('useStarted', ({ defId, durationMs }) => this.hud.startUse(getItemDef(defId)?.name ?? defId, durationMs));
    s.on('useEnded', () => this.hud.endUse());
    s.on('died', (info) => {
      this.dead = true;
      if (this.inventoryUI.isOpen) this.closeInventory(false);
      this.ui.setPrompt(null);
      this.ui.setPaused(false);
      if (document.pointerLockElement) document.exitPointerLock();
      this.hud.showDeath(info, () => conn.socket.emit('respawn'));
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
    requestAnimationFrame(this.frame);
  }

  private openInventory(): void {
    this.inventoryUI.open();
    this.ui.setPrompt(null);
    if (document.pointerLockElement) document.exitPointerLock();
  }

  private closeInventory(relock: boolean): void {
    if (this.inventoryUI.openContainerKey) this.conn.socket.emit('closeContainer');
    this.inventoryUI.close();
    this.hud.hideDeath();
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
    const held = this.inventoryUI.inventory?.slots[active];
    if (this.input.consumePress('KeyQ') && held) {
      this.conn.socket.emit('invOp', { op: 'drop', from: { owner: 'self', index: active } });
    }
    // Left click with a consumable in hand: eat / drink / bandage.
    if (this.input.consumePress('Mouse0') && held && getItemDef(held.defId)?.consume && !this.hud.using) {
      this.conn.socket.emit('invOp', { op: 'use', slot: active });
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
  };

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
    this.hud.update(dt);
    if (!this.inventoryUI.isOpen && !this.dead) {
      this.updateHotbarInput();
      this.updateInteraction();
    }
    this.remotes.update(this.conn.serverNow(), dt);
    this.doorRenderer.update(dt);
    this.mapRenderer.update(this.camera.position);
    this.updateSun();
    this.renderer.render(this.scene, this.camera);

    this.updateHud(dt);
  };

  /** Look-at raycast: what would E interact with? Ground items > doors > containers. */
  private updateInteraction(): void {
    this.camera.getWorldDirection(this.rayDir);
    const o = this.camera.position;
    const d = this.rayDir;
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

  /** Keep the shadow frustum centered on the player, snapped to shadow texels to avoid shimmer. */
  private updateSun(): void {
    const texel = (RENDER.shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const x = Math.round(this.camera.position.x / texel) * texel;
    const z = Math.round(this.camera.position.z / texel) * texel;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + 60, 110, z + 40);
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
          `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${this.local.state.grounded ? '' : ' (air)'}`,
          `pending ${this.local.pendingCount} · last correction ${this.local.lastCorrection.toFixed(3)} m`,
          `players ${this.online} online, ${this.remotes.count} nearby · ${this.groundItems.count} items near`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onUiKey);
    this.inventoryUI.close();
    this.hud.hideDeath();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.world.free();
  }
}
