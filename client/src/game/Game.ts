import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  SURVIVAL,
  TICK_DT,
  buildMapColliders,
  generateTestMap,
  type JoinAccepted,
  type MapData,
  type MoveInput,
  type Rapier,
} from '@grey/shared';
import type { Connection } from '../net/Connection';
import { Input } from './Input';
import { LocalPlayer } from './LocalPlayer';
import { RemotePlayers } from './RemotePlayers';
import { buildMapMeshes } from './MapRenderer';

const loadMap = (id: string, seed: number): MapData => {
  if (id === 'testmap') return generateTestMap(seed);
  throw new Error(`Unknown map '${id}'`);
};

export interface GameUi {
  setPaused(paused: boolean): void;
  setStamina(fraction: number): void;
  setDebug(text: string): void;
}

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly world: World;
  private readonly input: Input;
  private readonly local: LocalPlayer;
  private readonly remotes: RemotePlayers;
  private accumulator = 0;
  private lastFrame = performance.now();
  private running = true;
  private fps = 0;
  private frames = 0;
  private fpsTimer = 0;
  private online = 0;

  constructor(
    R: Rapier,
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

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 400);
    this.scene.add(this.camera);
    const sky = new THREE.Color(0x8a8c86);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 20, 160);
    this.scene.add(new THREE.HemisphereLight(0xb7b9b0, 0x3a342c, 1.2));
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.6);
    sun.position.set(40, 60, 25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = sc.bottom = -70;
    sc.right = sc.top = 70;
    sc.near = 1;
    sc.far = 200;
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    // --- world: same map + colliders as the server ---
    const map = loadMap(join.mapId, join.mapSeed);
    this.scene.add(buildMapMeshes(map));
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    buildMapColliders(R, this.world, map);
    this.world.step();

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
    this.remotes.update(this.conn.serverNow(), dt);
    this.renderer.render(this.scene, this.camera);

    this.updateHud(dt);
  };

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
          `${this.fps} fps · ${info.calls} draws · ${Math.round(this.conn.rtt)} ms ping`,
          `pos ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}${this.local.state.grounded ? '' : ' (air)'}`,
          `pending ${this.local.pendingCount} · last correction ${this.local.lastCorrection.toFixed(3)} m`,
          `players ${this.online} online, ${this.remotes.count} nearby`,
        ].join('\n'),
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
