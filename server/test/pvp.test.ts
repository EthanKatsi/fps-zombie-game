import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  Buttons,
  PROTOCOL_VERSION,
  PVP,
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

const next = <K extends keyof ServerToClientEvents>(c: C, ev: K, ms = 1500, pred: (m: any) => boolean = () => true) =>
  new Promise<Parameters<ServerToClientEvents[K]>[0] | null>((resolve) => {
    const h = (m: Parameters<ServerToClientEvents[K]>[0]) => {
      if (!pred(m)) return;
      clearTimeout(t);
      c.off(ev, h as never);
      resolve(m);
    };
    const t = setTimeout(() => {
      c.off(ev, h as never);
      resolve(null);
    }, ms);
    c.on(ev, h as never);
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const inputSeq = new Map<C, number>();
/** Send `n` idle inputs (optionally aiming), one per tick; returns the last seq sent. */
const inputs = async (c: C, n: number, b = 0) => {
  for (let i = 0; i < n; i++) {
    const seq = (inputSeq.get(c) ?? 0) + 1;
    inputSeq.set(c, seq);
    c.emit('input', [{ seq, mx: 0, mz: 0, yaw: 0, pitch: 0, b }]);
    await sleep(34);
  }
  return inputSeq.get(c)!;
};

const attackSeq = new Map<C, number>();
const shoot = (c: C, dir: [number, number, number], viewTime: number, afterSeq = -1) => {
  const seq = (attackSeq.get(c) ?? -1) + 1;
  attackSeq.set(c, seq);
  c.emit('attack', { seq, dir, aim: true, afterSeq, viewTime });
};

const aimAt = (p: ServerPlayer, t: Vec3): [number, number, number] => {
  const e = { x: p.state.pos.x, y: p.state.pos.y + eyeHeight(false), z: p.state.pos.z };
  const d = { x: t.x - e.x, y: t.y - e.y, z: t.z - e.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return [d.x / l, d.y / l, d.z / l];
};

const giveRifle = (p: ServerPlayer) => {
  p.inventory.slots[0] = { uid: makeUid(), defId: 'rifle', qty: 1, loadedAmmo: 5, durability: 180 };
  p.inventory.activeHotbar = 0;
};

/** Move a target without clearing its history (teleport() would), so we can rewind into the past. */
const slide = (p: ServerPlayer, pos: Vec3) => {
  p.state = { ...p.state, pos: { ...pos } };
  p.motor.syncCollider(p.state);
};

test('lag compensation: you hit where the target was on your screen', async () => {
  const s = await connect('sniper');
  const t = await connect('dodger');
  t.p.protectedUntil = 0;
  s.p.teleport({ x: -4, y: 0, z: -2 });
  t.p.teleport({ x: -4, y: 0, z: -9 });
  giveRifle(s.p);
  await Promise.all([inputs(s.c, 6, Buttons.aim), inputs(t.c, 6)]);

  // The target "was" at A 150 ms ago (what the sniper sees) and is now 3 m to the side.
  const A = { x: -4, y: t.p.state.pos.y, z: -9 };
  const viewTime = game.serverTime() - 150;
  slide(t.p, { x: -1, y: A.y, z: -9 });
  t.p.history.push(game.serverTime(), t.p.state.pos);

  const hit = next(s.c, 'hitConfirm');
  shoot(s.c, aimAt(s.p, { x: A.x, y: A.y + 1.1, z: A.z }), viewTime);
  assert.equal((await hit)?.kind, 'player', 'rewound hit lands');

  // The same shot judged at the present moment misses (the target has moved on).
  await sleep(1300); // rifle fire rate
  const miss = next(s.c, 'hitConfirm', 600);
  shoot(s.c, aimAt(s.p, { x: A.x, y: A.y + 1.1, z: A.z }), game.serverTime());
  assert.equal(await miss, null, 'no rewind, no hit');
});

test('rewinding is capped: you cannot shoot far into the past', async () => {
  const s = await connect('laggy');
  const t = await connect('moved');
  t.p.protectedUntil = 0;
  s.p.teleport({ x: 4, y: 0, z: -2 });
  t.p.teleport({ x: 4, y: 0, z: -9 });
  giveRifle(s.p);
  await Promise.all([inputs(s.c, 6, Buttons.aim), inputs(t.c, 6)]);
  const A = { x: 4, y: t.p.state.pos.y, z: -9 };
  const oldTime = game.serverTime();
  slide(t.p, { x: 7, y: A.y, z: -9 });
  await inputs(t.c, Math.ceil((PVP.maxRewindMs + 300) / 34)); // history now holds only B in the window
  const miss = next(s.c, 'hitConfirm', 600);
  shoot(s.c, aimAt(s.p, { x: A.x, y: A.y + 1.1, z: A.z }), oldTime);
  assert.equal(await miss, null, 'older than maxRewindMs is clamped');
});

test('an attack waits until the inputs before it have been simulated', async () => {
  const s = await connect('patient');
  s.p.teleport({ x: 0, y: 0, z: 3 });
  s.p.inventory.slots[0] = { uid: makeUid(), defId: 'pistol', qty: 1, loadedAmmo: 5, durability: 100 };
  s.p.inventory.activeHotbar = 0;
  const lastBefore = await inputs(s.c, 2);
  // Claim the shot followed input lastBefore + 3, which hasn't been sent yet.
  const ws = next(s.c, 'weaponState', 400);
  shoot(s.c, [0, 1, 0], game.serverTime(), lastBefore + 3);
  assert.equal(await ws, null, 'held back');
  assert.equal(s.p.pendingAttacks.length, 1);
  const ws2 = next(s.c, 'weaponState', 1500);
  await inputs(s.c, 3);
  assert.equal((await ws2)?.loaded, 4, 'fired once its input arrived');
});

test('spawn protection blocks player damage until the protected player attacks', async () => {
  const a = await connect('ganker');
  const v = await connect('newbie');
  a.p.teleport({ x: -8, y: 0, z: 2 });
  v.p.teleport({ x: -8, y: 0, z: -3 });
  giveRifle(a.p);
  await Promise.all([inputs(a.c, 5, Buttons.aim), inputs(v.c, 5)]);
  assert.ok(v.p.protectedUntil > performance.now(), 'fresh joiners are protected');
  const dmg = next(v.c, 'damaged', 600);
  shoot(a.c, aimAt(a.p, { x: -8, y: v.p.state.pos.y + 1.1, z: -3 }), game.serverTime());
  assert.equal(await dmg, null, 'protected');
  assert.equal(v.p.record.stats.health, 100);

  // The newbie throws a punch at nothing (empty hands - left click with food would eat it) -> protection ends.
  v.p.inventory.activeHotbar = 8;
  v.c.emit('attack', { seq: 0, dir: [0, 0, -1], aim: false, afterSeq: -1, viewTime: game.serverTime() });
  await sleep(200);
  assert.equal(v.p.protectedUntil, 0);
});

test('kills reach everyone in the kill feed and the victim sees weapon, headshot and distance', async () => {
  const a = await connect('reaper');
  const v = await connect('unlucky');
  const w = await connect('witness');
  v.p.protectedUntil = 0;
  a.p.teleport({ x: 8, y: 0, z: 2 });
  v.p.teleport({ x: 8, y: 0, z: -10 });
  giveRifle(a.p);
  await Promise.all([inputs(a.c, 6, Buttons.aim), inputs(v.c, 6), inputs(w.c, 2)]);
  const feed = next(w.c, 'killFeed', 2000, (e) => e.victim === 'unlucky');
  const died = next(v.c, 'died');
  const head = { x: 8, y: v.p.state.pos.y + 1.62, z: -10 };
  shoot(a.c, aimAt(a.p, head), game.serverTime());
  const info = await died;
  assert.equal(info?.killer, 'reaper');
  assert.equal(info?.weapon, 'rifle');
  assert.equal(info?.headshot, true);
  assert.ok(Math.abs((info?.distance ?? 0) - 12) <= 1, `distance ${info?.distance}`);
  assert.deepEqual(await feed, { victim: 'unlucky', killer: 'reaper', cause: 'player', weapon: 'rifle', headshot: true });
});

test('non-PvP deaths also show in the kill feed', async () => {
  const v = await connect('famished');
  const w = await connect('onlooker');
  const feed = next(w.c, 'killFeed', 3000, (e) => e.victim === 'famished');
  v.p.record.stats.hunger = 0;
  v.p.record.stats.health = 0.2;
  assert.deepEqual(await feed, { victim: 'famished', killer: null, cause: 'starvation' });
});
