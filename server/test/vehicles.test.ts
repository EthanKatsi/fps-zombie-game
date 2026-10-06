import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  Buttons,
  PROTOCOL_VERSION,
  generateWorld,
  type ClientToServerEvents,
  type JoinAccepted,
  type ServerToClientEvents,
  type Snapshot,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';
import type { ServerPlayer } from '../src/game/ServerPlayer';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

await RAPIER.init();
const db = openDatabase(':memory:');
const httpServer = http.createServer();
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
const game = new GameServer(RAPIER, io, new SqlitePlayerRepository(db), new GuestAuthProvider(), { mapId: 'testmap' });
const zombies = await game.enableZombies(os.tmpdir(), false);
game.start();
await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
const clients: C[] = [];

after(async () => {
  clients.forEach((c) => c.disconnect());
  await game.stop();
  io.close();
  db.close();
});

const connect = (username: string): Promise<{ c: C; join: JoinAccepted; p: ServerPlayer }> =>
  new Promise((resolve, reject) => {
    const c: C = ioc(url, { transports: ['websocket'] });
    clients.push(c);
    c.on('connect', () => c.emit('join', { protocol: PROTOCOL_VERSION, username }));
    c.on('joinAccepted', (join) => resolve({ c, join, p: game.players.get(join.playerId)! }));
    c.on('joinRejected', ({ reason }) => reject(new Error(reason)));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const seqs = new Map<C, number>();
/** Stream inputs at the tick rate (W/S = mz, A/D = mx, Space = handbrake). */
const drive = (c: C, ms: number, mz: number, mx = 0, b = 0) => {
  const iv = setInterval(() => {
    const seq = (seqs.get(c) ?? 0) + 1;
    seqs.set(c, seq);
    c.emit('input', [{ seq, mx, mz, yaw: 0, pitch: 0, b }]);
  }, 33);
  return sleep(ms).then(() => clearInterval(iv));
};

test('get in a car, drive it, can only get out when slow, and step out beside it', async () => {
  const { c, p } = await connect('driver');
  const car = game.vehicles.vehicles.find((v) => v.type === 'sedan')!;
  // Far away: refused.
  c.emit('interact', { kind: 'vehicle', id: car.id });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(p), null);

  // Next to the driver's door.
  p.teleport({ x: car.state.pos.x - 2, y: 0.05, z: car.state.pos.z });
  await drive(c, 300, 0);
  c.emit('interact', { kind: 'vehicle', id: car.id });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(p)?.seat, 0, 'in the driver seat');
  const snap = await new Promise<Snapshot>((r) => c.once('snapshot', r));
  assert.equal(snap.drive?.id, car.id);
  assert.ok(snap.vehicles.some((v) => v.id === car.id && v.d), 'vehicle has a driver');

  // Full throttle for a bit: the car (facing +Z) moves forward and the driver goes with it.
  const z0 = car.state.pos.z;
  await drive(c, 2500, 1);
  assert.ok(car.state.pos.z > z0 + 5, `drove forward: ${z0} -> ${car.state.pos.z}`);
  assert.ok(car.state.speed > 4, `has speed ${car.state.speed}`);
  assert.ok(Math.hypot(p.state.pos.x - car.state.pos.x, p.state.pos.z - car.state.pos.z) < 1.5, 'driver rides along');

  // Too fast to jump out.
  c.emit('interact', { kind: 'exitVehicle' });
  await sleep(150);
  assert.ok(game.vehicles.seatOf(p), 'still inside at speed');

  // Brake to a stop, then get out beside the car.
  await drive(c, 3500, -1, 0, Buttons.jump);
  await drive(c, 300, 0);
  assert.ok(Math.abs(car.state.speed) < 1, `stopped: ${car.state.speed}`);
  await sleep(250);
  c.emit('interact', { kind: 'exitVehicle' });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(p), null, 'got out');
  const d = Math.hypot(p.state.pos.x - car.state.pos.x, p.state.pos.z - car.state.pos.z);
  assert.ok(d > 1 && d < 3, `standing beside it (${d.toFixed(2)} m)`);
});

test('a passenger rides along; running over a zombie hurts it', async () => {
  const a = await connect('wheelman');
  const b = await connect('shotgun');
  const bike = game.vehicles.vehicles.find((v) => v.type === 'motorcycle')!;
  a.p.teleport({ x: bike.state.pos.x - 1.5, y: 0.05, z: bike.state.pos.z });
  b.p.teleport({ x: bike.state.pos.x + 1.5, y: 0.05, z: bike.state.pos.z });
  await Promise.all([drive(a.c, 300, 0), drive(b.c, 300, 0)]);
  a.c.emit('interact', { kind: 'vehicle', id: bike.id });
  await sleep(150);
  b.c.emit('interact', { kind: 'vehicle', id: bike.id });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(a.p)?.seat, 0);
  assert.equal(game.vehicles.seatOf(b.p)?.seat, 1, 'passenger seat');

  // A zombie standing in the road ahead (the bike faces +Z).
  const zid = zombies.spawn('walker', { x: bike.state.pos.x, y: 0, z: bike.state.pos.z + 14 })!;
  assert.ok(zid !== null);
  const health0 = 80;
  const zhealth = () => (zombies as unknown as { zombies: Map<number, { health: number }> }).zombies.get(zid)?.health ?? 0;
  let hurt = false;
  for (let t = 0; t < 7000 && !hurt; t += 500) {
    await Promise.all([drive(a.c, 500, 1), drive(b.c, 500, 0)]);
    hurt = zhealth() < health0;
  }
  assert.ok(hurt, 'zombie was hit');
  assert.ok(Math.hypot(b.p.state.pos.x - bike.state.pos.x, b.p.state.pos.z - bike.state.pos.z) < 1.5, 'passenger rode along');
});

test('the world map has vehicles of every type, spawn points and a navigable size', () => {
  const m = generateWorld(1337);
  for (const t of ['sedan', 'pickup', 'motorcycle']) assert.ok(m.vehicleSpawns.some((v) => v.type === t), `has a ${t}`);
  assert.ok(m.spawnPoints.length >= 40);
  assert.ok(m.halfSize >= 600);
  assert.ok(m.buildings.some((b) => b.type === 'police'), 'downtown police station');
  assert.ok(m.buildings.filter((b) => b.type === 'house').length > 60, 'suburbs and cabins');
});

test('no fuel, no driving; a gas can refuels it and a pump refills the can', async () => {
  const { c, p } = await connect('fueler');
  const car = game.vehicles.vehicles.find((v) => v.type === 'sedan')!;
  // Park it back at a known spot with an empty tank.
  car.state = { ...car.state, pos: { x: -28, y: 0, z: -2 }, yaw: Math.PI, speed: 0, fuel: 0 };
  car.motor.sync(car.state);
  p.teleport({ x: car.state.pos.x - 2, y: 0.05, z: car.state.pos.z });
  await drive(c, 300, 0);
  c.emit('interact', { kind: 'vehicle', id: car.id });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(p)?.seat, 0);
  const z0 = car.state.pos.z;
  await drive(c, 1200, 1);
  assert.ok(Math.abs(car.state.pos.z - z0) < 0.2, 'an empty engine does not drive');
  c.emit('interact', { kind: 'exitVehicle' });
  await sleep(250);
  assert.equal(game.vehicles.seatOf(p), null);

  // Hold a gas can with 6 L and pour it in.
  p.inventory.slots[0] = { uid: 'can-1', defId: 'gas_can', qty: 1, fuel: 6 };
  p.inventory.activeHotbar = 0;
  c.emit('interact', { kind: 'refuel', id: car.id });
  await sleep(250);
  assert.equal(car.state.fuel, 6, 'tank got 6 L');
  assert.equal(p.inventory.slots[0]?.fuel, 0, 'can is empty');

  // Fill the can at the pump, then drive a bit: fuel burns slowly (litres per 100 km).
  const pump = game.map.fuelPumps[0];
  p.teleport({ x: pump[0] - 1.2, y: 0.05, z: pump[2] });
  await drive(c, 300, 0);
  c.emit('interact', { kind: 'pump', id: 0 });
  await sleep(250);
  assert.equal(p.inventory.slots[0]?.fuel, 10, 'can filled at the pump');

  p.teleport({ x: car.state.pos.x - 2, y: 0.05, z: car.state.pos.z });
  await drive(c, 300, 0);
  c.emit('interact', { kind: 'vehicle', id: car.id });
  await sleep(250);
  await drive(c, 1500, 1);
  assert.ok(car.state.pos.z > z0 + 3, 'drives with fuel');
  assert.ok(car.state.fuel < 6 && car.state.fuel > 5.9, `burned a tiny amount: ${car.state.fuel}`);
});
