import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  DOOR_USE_RANGE,
  DoorColliders,
  PLAYER_GROUPS,
  RENDER,
  SURVIVAL,
  TICK_DT,
  buildMapColliders,
  hashMap,
  loadMap,
  type JoinAccepted,
  type MapData,
  type MoveInput,
  type Rapier,
} from '@grey/shared';
import type { Connection } from '../net/Connection';
import { Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import { RemotePlayers } from './RemotePlayers';
import { DoorRenderer, MapRenderer } from './MapRenderer';

export interface GameUi {
  setPaused(paused: boolean): void;
  setStamina(fraction: number): void;
  setDebug(text: string): void;
  setPrompt(text: string | null): void;
}

type Target = { kind: 'door'; id: number } | null;

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

    // --- players ---
    this.input = new Input(this.renderer.domElement);
    this.input.onLockChange = (locked) => this.ui.setPaused(!locked);
    this.local = new LocalPlayer(R, this.world, join.state, this.input);
    this.remotes = new RemotePlayers(this.scene, join.playerId);
    for (const p of join.players) this.remotes.setName(p.id, p.username);
    this.online = join.players.length;

    // --- network ---
    const s = conn.socket;
    s.on('snapshot', (snap) => {
      conn.observeServerTime(snap.serverTime + conn.rtt / 2, 0.05);
      this.local.reconcile(snap.ack, snap.you);
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

    window.addEventListener('resize', this.onResize);
    this.renderer.domElement.addEventListener('click', () => this.input.requestLock());
    this.input.requestLock();
    requestAnimationFrame(this.frame);
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
      batch.push(this.local.fixedUpdate());
      this.accumulator -= TICK_DT;
    }
    if (batch.length) this.conn.socket.emit('input', batch);

    this.local.updateCamera(this.camera, this.accumulator / TICK_DT, dt);
    this.updateInteraction();
    this.remotes.update(this.conn.serverNow(), dt);
    this.doorRenderer.update(dt);
    this.mapRenderer.update(this.camera.position);
    this.updateSun();
    this.renderer.render(this.scene, this.camera);

    this.updateHud(dt);
  };

  /** Look-at raycast: what would E interact with? */
  private updateInteraction(): void {
    this.camera.getWorldDirection(this.rayDir);
    const o = this.camera.position;
    const ray = new this.R.Ray({ x: o.x, y: o.y, z: o.z }, { x: this.rayDir.x, y: this.rayDir.y, z: this.rayDir.z });
    const hit = this.world.castRay(ray, DOOR_USE_RANGE, true, undefined, PLAYER_GROUPS, this.local.motor.collider);
    const doorId = hit ? this.doorColliders.byHandle.get(hit.collider.handle) : undefined;
    this.target = doorId !== undefined ? { kind: 'door', id: doorId } : null;

    if (this.target) {
      this.ui.setPrompt(this.doorColliders.open[this.target.id] ? 'Close door' : 'Open door');
    } else {
      this.ui.setPrompt(null);
    }
    if (this.input.consumePress('KeyE') && this.target) {
      this.conn.socket.emit('interact', this.target);
    }
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
          `players ${this.online} online, ${this.remotes.count} nearby`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
  }

  dispose(): void {
    this.running = false;
    window.removeEventListener('resize', this.onResize);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.world.free();
  }
}
