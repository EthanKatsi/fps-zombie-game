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
  ZOMBIE_TYPES,
  eyeHeight,
  type ClientToServerEvents,
  type JoinAccepted,
  type ServerToClientEvents,
  type Vec3,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';
import { makeUid } from '../src/game/ContainerSystem';
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
const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
};
const flat = (a: Vec3, b: Vec3) => Math.hypot(a.x - b.x, a.z - b.z);

/** Keep a player "alive" in the sim with idle inputs (and grounded). */
const inputSeq = new Map<C, number>();
const idle = (c: C, ms: number, buttons = 0) => {
  const iv = setInterval(() => {
    const seq = (inputSeq.get(c) ?? 0) + 1;
    inputSeq.set(c, seq);
    c.emit('input', [{ seq, mx: 0, mz: 0, yaw: 0, pitch: 0, b: buttons }]);
  }, 33);
  return sleep(ms).then(() => clearInterval(iv));
};

test('zombies spawn on the navmesh and the snapshot includes them', async () => {
  const { c, p } = await connect('watcher');
  p.teleport({ x: 30, y: 0, z: 30 });
  const id = zombies.spawn('walker', { x: 33, y: 0, z: 30 })!;
  assert.ok(id, 'spawned');
  const snap = await new Promise<any>((r) => c.once('snapshot', r));
  await sleep(100);
  const snap2 = await new Promise<any>((r) => c.once('snapshot', r));
  assert.ok([...snap.zombies, ...snap2.zombies].some((z: any) => z.id === id), 'zombie in snapshot');
});

test('a zombie that sees a player chases them', async () => {
  const { c, p } = await connect('bait');
  p.teleport({ x: -30, y: 0, z: 30 });
  await idle(c, 200);
  // Zombie 12 m away, facing the player (yaw such that forward points at them).
  const id = zombies.spawn('runner', { x: -30, y: 0, z: 42 })!;
  const z = zombies.get(id)! as any;
  z.yaw = 0; // forward = -Z, towards the player
  const start = flat(z.pos, p.state.pos);
  const chased = await until(() => zombies.get(id)!.state === 'chase', 2000);
  assert.ok(chased, `state ${zombies.get(id)!.state}`);
  await idle(c, 1500);
  assert.ok(flat(zombies.get(id)!.pos, p.state.pos) < start - 3, 'closed the distance');
});

test('a zombie hears a gunshot far away and investigates', async () => {
  const { c, p } = await connect('loud');
  p.teleport({ x: 48, y: 0, z: -48 });
  await idle(c, 200);
  // 40 m away, facing away (yaw PI => forward +Z), well outside vision (and nobody else in view).
  const id = zombies.spawn('walker', { x: 48, y: 0, z: -8 })!;
  (zombies.get(id)! as any).yaw = Math.PI;
  await sleep(600);
  assert.notEqual(zombies.get(id)!.state, 'chase');
  p.inventory.slots[0] = { uid: makeUid(), defId: 'pistol', qty: 1, loadedAmmo: 5, durability: 100 };
  p.inventory.activeHotbar = 0;
  c.emit('attack', { seq: 0, dir: [0, 1, 0], aim: false }); // shoot into the air
  const heard = await until(() => zombies.get(id)!.state === 'investigate', 1500);
  assert.ok(heard, `state ${zombies.get(id)!.state}`);
  const before = flat(zombies.get(id)!.pos, p.state.pos);
  await idle(c, 2500);
  assert.ok(flat(zombies.get(id)!.pos, p.state.pos) < before - 1, 'walking towards the shot');
});

test('zombies attack players in reach after a windup', async () => {
  const { c, p } = await connect('snack');
  p.teleport({ x: -30, y: 0, z: -30 });
  await idle(c, 200);
  const id = zombies.spawn('walker', { x: -30, y: 0, z: -31.2 })!;
  const dmg = new Promise<any>((r) => c.on('damaged', (m) => m.cause === 'zombie' && r(m)));
  const hit = await Promise.race([dmg, idle(c, 3000).then(() => null)]);
  assert.ok(hit, 'got bitten');
  assert.equal(hit.amount, ZOMBIE_TYPES.walker.attackDamage);
  assert.ok(hit.from, 'damage direction for the indicator');
  zombies.damage(id, 9999, null, performance.now());
});

test('headshots kill zombies fast; kills are confirmed', async () => {
  const { c, p } = await connect('hunter');
  p.teleport({ x: 40, y: 0, z: 40 });
  await idle(c, 300, Buttons.aim); // aiming down sights => tight spread
  const id = zombies.spawn('walker', { x: 40, y: 0, z: 34 })!;
  const zz = zombies.get(id)! as any;
  zz.yaw = Math.PI; // facing away
  zz.nextThink = Infinity; // hold still for the test (no wandering)
  await sleep(100);
  const zpos = zombies.get(id)!.pos;
  const eye = { x: p.state.pos.x, y: p.state.pos.y + eyeHeight(false), z: p.state.pos.z };
  const head = { x: zpos.x, y: zpos.y + 1.62, z: zpos.z };
  const d = { x: head.x - eye.x, y: head.y - eye.y, z: head.z - eye.z };
  const l = Math.hypot(d.x, d.y, d.z);
  p.inventory.slots[0] = { uid: makeUid(), defId: 'pistol', qty: 1, loadedAmmo: 5, durability: 100 };
  p.inventory.activeHotbar = 0;
  const confirm = new Promise<any>((r) => c.once('hitConfirm', r));
  c.emit('attack', { seq: 0, dir: [d.x / l, d.y / l, d.z / l], aim: true });
  const res = await confirm;
  assert.equal(res.kind, 'zombie');
  assert.equal(res.head, true);
  // 26 dmg x 2.5 = 65 of 80: one more body shot or a second headshot finishes it.
  assert.ok(zombies.get(id)!.health <= ZOMBIE_TYPES.walker.health - 60);
  await sleep(300);
  const kill = new Promise<any>((r) => c.once('hitConfirm', r));
  c.emit('attack', { seq: 1, dir: [d.x / l, d.y / l, d.z / l], aim: true });
  assert.equal((await kill).kill, true);
  assert.equal(zombies.get(id)!.state, 'dead');
});

test('zombies can follow you up the stairs to a roof (stair nav links)', async () => {
  const { c, p } = await connect('climber');
  // Test map: the brick block's roof (x 14..26, z -25..-15, top y=6), stairs on its west side.
  p.teleport({ x: 20, y: 6.05, z: -20 });
  await idle(c, 300);
  const id = zombies.spawn('runner', { x: 10, y: 0, z: -8 })!;
  (zombies.get(id)! as any).target = p;
  (zombies.get(id)! as any).state = 'chase';
  (zombies.get(id)! as any).lastSeenAt = performance.now();
  const up = await until(() => zombies.get(id)!.pos.y > 5, 9000);
  assert.ok(up, `zombie y ${zombies.get(id)!.pos.y.toFixed(2)}`);
});
