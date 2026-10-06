import type { World } from '@dimforge/rapier3d-compat';
import {
  DOOR_USE_RANGE,
  DoorColliders,
  MOVEMENT,
  NETWORK,
  PLAYER_GROUPS,
  PROTOCOL_VERSION,
  PlayerFlags,
  TICK_DT,
  buildMapColliders,
  doorPose,
  doorAwayDir,
  doorPanelHits,
  eyeHeight,
  hashMap,
  loadMap,
  type InteractRequest,
  type JoinRequest,
  type MapData,
  type NetPlayer,
  type Rapier,
  type Vec3,
} from '@grey/shared';
import type { AuthProvider } from '../auth/AuthProvider';
import type { PlayerRepository } from '../db/PlayerRepository';
import { SERVER_CONFIG } from '../config';
import { ServerPlayer } from './ServerPlayer';
import { InventorySystem } from './InventorySystem';
import { SurvivalSystem, giveStartingKit, netStats } from './SurvivalSystem';
import { WeaponSystem } from './WeaponSystem';
import { DummySystem } from './DummySystem';
import { NoiseSystem } from './NoiseSystem';
import { ZombieSystem } from './ZombieSystem';
import { VehicleSystem } from './VehicleSystem';
import { Navigation, buildNavMesh } from './Navigation';
import { WorldClock } from './WorldClock';
import type { GameIO, GameSocket } from './types';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Yaw that looks from p towards the map center (forward = (-sin yaw, -cos yaw)). */
const yawTowardCenter = (p: Vec3): number => Math.atan2(p.x, p.z);

export class GameServer {
  readonly world: World;
  readonly map: MapData;
  readonly mapHash: string;
  readonly doors: DoorColliders;
  readonly items: InventorySystem;
  readonly survival: SurvivalSystem;
  readonly weapons: WeaponSystem;
  readonly dummies: DummySystem;
  readonly vehicles: VehicleSystem;
  readonly noise = new NoiseSystem();
  readonly clock = new WorldClock();
  /** Created by enableZombies() once the navmesh is ready. */
  zombies: ZombieSystem | null = null;
  private doorsDirty = false;
  private lastVehicleStep = 0;
  /** Door id -> time (ms) until which it can't be toggled again (swing animation). */
  private readonly doorBusyUntil = new Map<number, number>();
  readonly players = new Map<string, ServerPlayer>();
  private readonly joining = new Set<string>();
  private tick = 0;
  private snapshotAcc = 0;
  private timer: NodeJS.Timeout | null = null;
  private autosaveTimer: NodeJS.Timeout | null = null;
  private readonly startTime = performance.now();

  constructor(
    private readonly R: Rapier,
    private readonly io: GameIO,
    private readonly repo: PlayerRepository,
    private readonly auth: AuthProvider,
    opts: { mapId?: string; mapSeed?: number } = {},
  ) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    const t0 = performance.now();
    this.map = loadMap(opts.mapId ?? SERVER_CONFIG.mapId, opts.mapSeed ?? SERVER_CONFIG.mapSeed);
    this.mapHash = hashMap(this.map);
    buildMapColliders(R, this.world, this.map);
    this.doors = new DoorColliders(R, this.world, this.map.doors);
    this.world.step(); // populate the broad-phase so scene queries see the map
    this.items = new InventorySystem(R, this.world, this.map, () => this.players.values());
    this.survival = new SurvivalSystem(this.items, () => this.spawnPoint(), (e) => this.io.emit('killFeed', e));
    this.dummies = new DummySystem(this.map.dummies, io);
    this.vehicles = new VehicleSystem(R, this.world, this.map, () => this.players.values(), this.survival, this.noise, () => this.zombies, this.items);
    this.world.step(); // vehicle colliders
    this.weapons = new WeaponSystem(
      R, this.world, () => this.players.values(), this.survival, this.items, this.dummies, this.noise,
      () => this.zombies, () => this.serverTime(),
    );
    console.log(`[game] world built in ${Math.round(performance.now() - t0)} ms`);
    io.on('connection', (s) => this.onConnection(s));
  }

  /** Build (or load) the navmesh and start simulating zombies. */
  async enableZombies(cacheDir: string | null, autoSpawn = true): Promise<ZombieSystem> {
    const navMesh = await buildNavMesh(this.map, cacheDir);
    const nav = new Navigation(navMesh, 256);
    const zs = new ZombieSystem(this.R, this.world, nav, this.map, this.doors, () => this.players.values(), this.survival, this.noise, this.items);
    zs.autoSpawn = autoSpawn;
    zs.isNight = () => this.clock.isNight();
    zs.canBite = (p) => this.vehicles.canBeBitten(p);
    this.zombies = zs;
    return zs;
  }

  serverTime(): number {
    return performance.now() - this.startTime;
  }

  // ---------------------------------------------------------------- lifecycle

  start(): void {
    const dtMs = 1000 * TICK_DT;
    let next = performance.now();
    const loop = () => {
      const now = performance.now();
      // If we fall far behind (debugger, sleep), skip ahead instead of spiralling.
      if (now - next > 250) next = now;
      while (now >= next) {
        this.step();
        next += dtMs;
      }
      this.timer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
    this.autosaveTimer = setInterval(() => void this.saveAll(), NETWORK.autosaveIntervalSec * 1000);
    console.log(`[game] map '${this.map.id}' seed ${this.map.seed}, ${this.map.boxes.length} pieces, ${NETWORK.tickRate} Hz`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    await this.saveAll();
  }

  private async saveAll(): Promise<void> {
    for (const p of this.players.values()) {
      try {
        await this.repo.save(p.toRecord());
      } catch (err) {
        console.error(`[db] failed to save ${p.username}`, err);
      }
    }
  }

  // ---------------------------------------------------------------- connections

  private onConnection(socket: GameSocket): void {
    let player: ServerPlayer | null = null;

    socket.on('clockPing', (t) => {
      if (typeof t === 'number') socket.emit('clockPong', t, this.serverTime());
    });

    socket.once('join', async (req: JoinRequest) => {
      try {
        player = await this.handleJoin(socket, req);
      } catch (err) {
        console.error('[join] error', err);
        socket.emit('joinRejected', { reason: 'Server error' });
        socket.disconnect(true);
      }
    });

    socket.on('input', (inputs) => player?.enqueueInputs(inputs));
    socket.on('interact', (req) => {
      if (player?.alive) this.handleInteract(player, req);
    });
    socket.on('invOp', (op) => {
      if (!player?.alive) return;
      if (op?.op === 'use') this.survival.startUse(player, op.slot);
      else this.items.handleOp(player, op);
    });
    socket.on('closeContainer', () => {
      if (player) this.items.closeContainer(player);
    });
    socket.on('cancelUse', () => {
      if (player) this.survival.cancelUse(player);
    });
    socket.on('respawn', () => {
      if (player) this.survival.respawn(player);
    });
    socket.on('attack', (req) => {
      if (!player || this.vehicles.seatOf(player)?.seat === 0) return; // hands on the wheel
      this.weapons.attack(player, req);
    });
    socket.on('reload', () => {
      if (player) this.weapons.reload(player);
    });

    socket.on('disconnect', () => {
      if (!player) return;
      const p = player;
      this.vehicles.onPlayerGone(p);
      this.players.delete(p.id);
      this.items.onLeave(p);
      p.dispose();
      this.io.emit('playerLeft', { id: p.id });
      console.log(`[game] ${p.username} left (${this.players.size} online)`);
      this.repo.save(p.toRecord()).catch((err) => console.error('[db] save on leave failed', err));
    });
  }

  private async handleJoin(socket: GameSocket, req: JoinRequest): Promise<ServerPlayer | null> {
    const reject = (reason: string) => {
      socket.emit('joinRejected', { reason });
      socket.disconnect(true);
      return null;
    };
    if (req?.protocol !== PROTOCOL_VERSION) return reject('Client out of date, please refresh');
    if (this.players.size >= SERVER_CONFIG.maxPlayers) return reject('Server is full');

    const auth = await this.auth.authenticate(req);
    if (!auth.ok) return reject(auth.reason);

    const key = auth.username.toLowerCase();
    const online = [...this.players.values()].some((p) => p.username.toLowerCase() === key);
    if (online || this.joining.has(key)) return reject('That survivor is already in the city');

    this.joining.add(key);
    try {
      const existing = await this.repo.findByUsername(auth.username);
      const record = existing ?? (await this.repo.create(auth.username, this.randomSpawn()));
      if (!socket.connected) return null;

      if (!existing) giveStartingKit(record); // fresh survivor
      let spawn = record.position;
      if (!existing || !this.isValidPosition(spawn)) {
        spawn = existing ? this.randomSpawn() : record.position;
        record.yaw = yawTowardCenter(spawn);
      }
      const player = new ServerPlayer(this.R, this.world, socket, record, spawn);
      // Died and left before respawning: start a fresh life.
      if (record.stats.health <= 0) this.survival.reviveAt(player, this.spawnPoint());
      this.players.set(player.id, player);

      socket.emit('joinAccepted', {
        playerId: player.id,
        username: player.username,
        tick: this.tick,
        serverTime: this.serverTime(),
        state: player.state,
        mapId: this.map.id,
        mapSeed: this.map.seed,
        mapHash: this.mapHash,
        openDoors: this.doors.openIds(),
        reversedDoors: this.doors.reversedIds(),
        inventory: player.inventory,
        stats: netStats(player),
        shotSalt: player.shotSalt,
        dummiesDown: this.dummies.downIds(),
        players: [...this.players.values()].map((p) => ({ id: p.id, username: p.username })),
      });
      socket.broadcast.emit('playerJoined', { id: player.id, username: player.username });
      console.log(`[game] ${player.username} joined (${this.players.size} online)`);
      return player;
    } finally {
      this.joining.delete(key);
    }
  }

  /** In bounds and not inside geometry (saved positions may predate a map change). */
  private isValidPosition(p: Vec3): boolean {
    const h = this.map.halfSize - 1;
    if (!(Number.isFinite(p.x + p.y + p.z) && Math.abs(p.x) < h && Math.abs(p.z) < h && p.y > -1 && p.y < 100)) {
      return false;
    }
    const shape = new this.R.Capsule(MOVEMENT.standHeight / 2 - MOVEMENT.radius, MOVEMENT.radius);
    const hit = this.world.intersectionWithShape(
      { x: p.x, y: p.y + MOVEMENT.standHeight / 2 + 0.05, z: p.z },
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      undefined,
      PLAYER_GROUPS,
    );
    return hit === null;
  }

  // ---------------------------------------------------------------- interaction

  private handleInteract(p: ServerPlayer, req: InteractRequest): void {
    const now = performance.now();
    if (now < p.nextInteractAt) return;
    p.nextInteractAt = now + 200;
    if (req?.kind === 'door' && Number.isInteger(req.id)) this.toggleDoor(p, req.id, now);
    else if (req?.kind === 'container') this.items.openMapContainer(p, req.id);
    else if (req?.kind === 'pickup') this.items.pickup(p, req.id);
    else if (req?.kind === 'exitVehicle') this.vehicles.exit(p);
    else if (req?.kind === 'refuel' && Number.isInteger(req.id)) this.vehicles.refuel(p, req.id);
    else if (req?.kind === 'pump' && Number.isInteger(req.id)) this.vehicles.pump(p, req.id, this.map.fuelPumps);
    else if (req?.kind === 'vehicle' && Number.isInteger(req.id)) {
      if (this.vehicles.seatOf(p)) this.vehicles.exit(p);
      else this.vehicles.enter(p, req.id);
    }
  }

  private toggleDoor(p: ServerPlayer, id: number, now: number): void {
    const def = this.map.doors[id];
    if (!def || now < (this.doorBusyUntil.get(id) ?? 0)) return;
    // Range check from the player's eye to the door panel's current center.
    const open = this.doors.open[id];
    const pose = doorPose(def, open ? 1 : 0);
    const eyeY = p.state.pos.y + eyeHeight(p.state.crouching);
    const dist = Math.hypot(pose.x - p.state.pos.x, pose.y - eyeY, pose.z - p.state.pos.z);
    if (dist > DOOR_USE_RANGE + 0.5) return;
    // The door must not end up inside anyone. Opening swings it away from the user (however close
    // they stand), or the other way if someone is in the way there.
    const hits = (amount: number) => {
      for (const other of this.players.values()) {
        const o = other.state.pos;
        if (!other.alive || Math.abs(o.y - def.hinge[1]) > def.height) continue;
        if (doorPanelHits(def, amount, o.x, o.z, MOVEMENT.radius)) return true;
      }
      return false;
    };
    let dir = this.doors.dir[id] ?? 1;
    if (open) {
      if (hits(0)) return; // someone is standing in the doorway
    } else {
      const away = doorAwayDir(def, p.state.pos.x, p.state.pos.z);
      const choice = [away, -away as 1 | -1].find((d) => !hits(d));
      if (!choice) return;
      dir = choice;
    }
    this.doors.set(id, !open, dir);
    this.doorsDirty = true;
    this.doorBusyUntil.set(id, now + 450);
    this.io.emit('doorChanged', { id, open: !open, dir });
  }

  private randomSpawn(): Vec3 {
    const pts = this.map.spawnPoints;
    return { ...pts[Math.floor(Math.random() * pts.length)] };
  }

  /** Random edge spawn facing into the city. */
  private spawnPoint(): { pos: Vec3; yaw: number } {
    const pos = this.randomSpawn();
    return { pos, yaw: yawTowardCenter(pos) };
  }

  // ---------------------------------------------------------------- simulation

  private step(): void {
    this.tick++;
    if (this.doorsDirty) {
      this.world.step(); // refresh the broad-phase so moved door colliders are seen
      this.doorsDirty = false;
    }
    const st = this.serverTime();
    for (const p of this.players.values()) {
      p.simulate(
        TICK_DT,
        (impact) => this.survival.onLand(p, impact),
        () => this.weapons.flushPending(p),
      );
      this.weapons.flushPending(p); // drop attacks that waited too long
      if (!p.alive && p.seatInput) this.vehicles.onPlayerGone(p);
      if (p.alive) p.history.push(st, p.state.pos, p.state.crouching);
      if (p.alive && p.state.pos.y < -30) {
        // Fell out of the world.
        this.vehicles.onPlayerGone(p);
        const spawn = this.randomSpawn();
        p.teleport(spawn, yawTowardCenter(spawn));
      }
    }
    this.vehicles.update(performance.now(), TICK_DT);
    // Stepping the world refreshes scene queries for moved vehicle colliders, but costs ~7 ms on the
    // big map, so do it at most twice a second (moving obstacles are slightly stale in between).
    if (this.vehicles.moved && performance.now() - this.lastVehicleStep > 500) {
      this.world.step();
      this.vehicles.moved = false;
      this.lastVehicleStep = performance.now();
    }

    const now = performance.now();
    this.survival.update(this.players.values(), TICK_DT, now);
    this.weapons.update(this.players.values(), now, TICK_DT);
    this.dummies.update(now);
    this.zombies?.update(now, TICK_DT, this.serverTime());
    this.noise.prune(now);
    if (this.tick % 10 === 0) this.items.update([...this.players.values()], now);
    if (this.tick % 15 === 0) this.survival.flushStats(this.players.values());

    this.snapshotAcc += NETWORK.snapshotRate / NETWORK.tickRate;
    if (this.snapshotAcc >= 1) {
      this.snapshotAcc -= 1;
      this.sendSnapshots();
    }
  }

  private sendSnapshots(): void {
    const time = this.serverTime();
    const all = [...this.players.values()];
    const net = new Map<string, NetPlayer>();
    for (const p of all) {
      const s = p.state;
      net.set(p.id, {
        id: p.id,
        p: [r2(s.pos.x), r2(s.pos.y), r2(s.pos.z)],
        yaw: r2(s.yaw),
        pitch: r2(s.pitch),
        f:
          (s.crouching ? PlayerFlags.crouching : 0) |
          (s.grounded ? PlayerFlags.grounded : 0) |
          (s.sprinting ? PlayerFlags.sprinting : 0) |
          (p.inventory.equipment?.head ? PlayerFlags.helmet : 0) |
          (p.inventory.equipment?.body ? PlayerFlags.vest : 0) |
          (p.seatInput ? PlayerFlags.seated : 0),
        h: p.inventory.slots[p.inventory.activeHotbar]?.defId ?? '',
        hc: p.hitCount,
        ...(() => {
          const seat = p.seatInput ? this.vehicles.seatOf(p) : null;
          return seat ? { v: seat.v.id * 8 + seat.seat } : {};
        })(),
      });
    }

    const r2max = NETWORK.interestRadius * NETWORK.interestRadius;
    for (const me of all) {
      const visible: NetPlayer[] = [];
      for (const other of all) {
        if (other === me || !other.alive) continue;
        const dx = other.state.pos.x - me.state.pos.x;
        const dz = other.state.pos.z - me.state.pos.z;
        if (dx * dx + dz * dz <= r2max) visible.push(net.get(other.id)!);
      }
      me.socket.emit('snapshot', {
        tick: this.tick,
        serverTime: time,
        ack: me.lastSeq,
        you: me.state,
        drive: this.vehicles.driveFor(me),
        players: visible,
        zombies: this.zombies?.netFor(me.state.pos) ?? [],
        vehicles: this.vehicles.netFor(me.state.pos),
      });
    }
  }
}
