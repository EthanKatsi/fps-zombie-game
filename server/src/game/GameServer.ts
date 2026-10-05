import type { World } from '@dimforge/rapier3d-compat';
import {
  NETWORK,
  PROTOCOL_VERSION,
  PlayerFlags,
  TICK_DT,
  buildMapColliders,
  generateTestMap,
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
import type { GameIO, GameSocket } from './types';

const r2 = (n: number): number => Math.round(n * 100) / 100;

export class GameServer {
  readonly world: World;
  readonly map: MapData;
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
  ) {
    this.world = new R.World({ x: 0, y: 0, z: 0 });
    this.map = generateTestMap(SERVER_CONFIG.mapSeed);
    buildMapColliders(R, this.world, this.map);
    this.world.step(); // populate the broad-phase so scene queries see the map
    io.on('connection', (s) => this.onConnection(s));
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

    socket.on('disconnect', () => {
      if (!player) return;
      const p = player;
      this.players.delete(p.id);
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
      const record =
        (await this.repo.findByUsername(auth.username)) ??
        (await this.repo.create(auth.username, this.randomSpawn()));
      if (!socket.connected) return null;

      const spawn = this.isValidPosition(record.position) ? record.position : this.randomSpawn();
      const player = new ServerPlayer(this.R, this.world, socket, record, spawn);
      this.players.set(player.id, player);

      socket.emit('joinAccepted', {
        playerId: player.id,
        username: player.username,
        tick: this.tick,
        serverTime: this.serverTime(),
        state: player.state,
        mapId: this.map.id,
        mapSeed: this.map.seed,
        players: [...this.players.values()].map((p) => ({ id: p.id, username: p.username })),
      });
      socket.broadcast.emit('playerJoined', { id: player.id, username: player.username });
      console.log(`[game] ${player.username} joined (${this.players.size} online)`);
      return player;
    } finally {
      this.joining.delete(key);
    }
  }

  private isValidPosition(p: Vec3): boolean {
    const h = this.map.halfSize - 1;
    return Number.isFinite(p.x + p.y + p.z) && Math.abs(p.x) < h && Math.abs(p.z) < h && p.y > -1 && p.y < 100;
  }

  private randomSpawn(): Vec3 {
    const pts = this.map.spawnPoints;
    return { ...pts[Math.floor(Math.random() * pts.length)] };
  }

  // ---------------------------------------------------------------- simulation

  private step(): void {
    this.tick++;
    for (const p of this.players.values()) {
      p.simulate(TICK_DT);
      if (p.state.pos.y < -30) p.teleport(this.randomSpawn()); // fell out of the world
    }

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
          (s.sprinting ? PlayerFlags.sprinting : 0),
      });
    }

    const r2max = NETWORK.interestRadius * NETWORK.interestRadius;
    for (const me of all) {
      const visible: NetPlayer[] = [];
      for (const other of all) {
        if (other === me) continue;
        const dx = other.state.pos.x - me.state.pos.x;
        const dz = other.state.pos.z - me.state.pos.z;
        if (dx * dx + dz * dz <= r2max) visible.push(net.get(other.id)!);
      }
      me.socket.emit('snapshot', {
        tick: this.tick,
        serverTime: time,
        ack: me.lastSeq,
        you: me.state,
        players: visible,
      });
    }
  }
}
