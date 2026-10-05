import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  WEAPONS,
  countItem,
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

/** Put a weapon in hotbar slot 0 and hold it. */
const equip = (p: ServerPlayer, defId: string, loaded?: number) => {
  p.inventory.slots[0] = { uid: makeUid(), defId, qty: 1, durability: 100, ...(loaded !== undefined ? { loadedAmmo: loaded } : {}) };
  p.inventory.activeHotbar = 0;
  return p.inventory.slots[0]!;
};

/** Unit vector from p's eye to a point. */
const aimAt = (p: ServerPlayer, t: Vec3): [number, number, number] => {
  const e = { x: p.state.pos.x, y: p.state.pos.y + eyeHeight(false), z: p.state.pos.z };
  const d = { x: t.x - e.x, y: t.y - e.y, z: t.z - e.z };
  const l = Math.hypot(d.x, d.y, d.z);
  return [d.x / l, d.y / l, d.z / l];
};

/** Send a few idle movement inputs so a teleported player lands (grounded = normal spread). */
const inputSeq = new Map<C, number>();
const settle = async (c: C, yaw = 0, pitch = 0) => {
  for (let i = 0; i < 4; i++) {
    const seq = (inputSeq.get(c) ?? 0) + 1;
    inputSeq.set(c, seq);
    c.emit('input', [{ seq, mx: 0, mz: 0, yaw, pitch, b: 0 }]);
    await sleep(35);
  }
  await sleep(100); // let the server apply them all
};

let seqs = new Map<ServerPlayer, number>();
const attack = (c: C, p: ServerPlayer, dir: [number, number, number], aim = false) => {
  const seq = (seqs.get(p) ?? -1) + 1;
  seqs.set(p, seq);
  c.emit('attack', { seq, dir, aim });
};

// Dummy 2 of the test map stands at (0, 0, -14).
const DUMMY_CHEST = { x: 0, y: 1.0, z: -14 };

test('pistol hits a dummy, uses ammo and wears the gun', async () => {
  const { c, p } = await connect('shooter');
  p.teleport({ x: 0, y: 0, z: -11 });
  await settle(c);
  const gun = equip(p, 'pistol', 12);
  const hit = next(c, 'hitConfirm');
  const ws = next(c, 'weaponState');
  attack(c, p, aimAt(p, DUMMY_CHEST));
  assert.deepEqual(await hit, { kind: 'dummy', head: false, kill: false });
  const state = await ws;
  assert.equal(state?.loaded, 11);
  assert.equal(gun.durability, 99);
});

test('fire rate and shot sequence are enforced', async () => {
  const { c, p } = await connect('spammer');
  p.teleport({ x: 3, y: 0, z: -11 });
  await settle(c);
  const gun = equip(p, 'rifle', 5);
  attack(c, p, aimAt(p, { x: 3, y: 1, z: -14 }));
  attack(c, p, aimAt(p, { x: 3, y: 1, z: -14 })); // too fast for a bolt-action
  await sleep(300);
  assert.equal(gun.loadedAmmo, 4, 'second shot rejected by fire rate');
  // Skipping sequence numbers is rejected outright.
  await sleep(1300);
  c.emit('attack', { seq: 99, dir: aimAt(p, { x: 3, y: 1, z: -14 }), aim: false });
  await sleep(200);
  assert.equal(gun.loadedAmmo, 4);
});

test('reload takes time and moves ammo from the inventory into the magazine', async () => {
  const { c, p } = await connect('reloader');
  const gun = equip(p, 'pistol', 0);
  p.inventory.slots[10] = { uid: makeUid(), defId: 'ammo_9mm', qty: 20 };
  const started = next(c, 'reloadStarted');
  c.emit('reload');
  assert.ok(await started);
  const ended = await next(c, 'reloadEnded', WEAPONS.pistol.reloadMs! + 1000);
  assert.deepEqual(ended, { completed: true });
  assert.equal(gun.loadedAmmo, 12);
  assert.equal(countItem(p.inventory.slots, 'ammo_9mm'), 8);
});

test('switching weapons cancels a reload', async () => {
  const { c, p } = await connect('switcher');
  equip(p, 'shotgun', 0);
  p.inventory.slots[10] = { uid: makeUid(), defId: 'ammo_12g', qty: 10 };
  c.emit('reload');
  await next(c, 'reloadStarted');
  const ended = next(c, 'reloadEnded');
  c.emit('invOp', { op: 'select', hotbar: 3 });
  assert.deepEqual(await ended, { completed: false });
  assert.equal(countItem(p.inventory.slots, 'ammo_12g'), 10);
});

test('melee costs stamina, lands after the windup and hurts players', async () => {
  const a = await connect('brawler');
  const v = await connect('victim');
  // Away from spawn points and the other tests' players (players can overlap; a bystander in
  // the swing would take the hit instead).
  a.p.teleport({ x: -8, y: 0, z: -3 }, 0);
  v.p.teleport({ x: -8, y: 0, z: -4.3 });
  equip(a.p, 'bat');
  // Aim at the victim's chest: the server swings along the latest view direction from inputs.
  const dir = aimAt(a.p, { x: -8, y: 1.0, z: -4.3 });
  await Promise.all([settle(a.c, 0, Math.asin(dir[1])), settle(v.c)]);
  const stamina = a.p.state.stamina;
  const dmg = next(v.c, 'damaged');
  attack(a.c, a.p, dir);
  await sleep(50);
  assert.ok(a.p.state.stamina < stamina, 'stamina spent');
  const d = await dmg;
  assert.ok(d && d.cause === 'player' && d.amount === WEAPONS.bat.damage, `took ${d?.amount}`);
  assert.ok(d!.from, 'damage direction included');
});

test('headshots multiply damage and kills are confirmed with the killer name', async () => {
  const a = await connect('marksman');
  const v = await connect('target');
  a.p.teleport({ x: -3, y: 0, z: 0 });
  v.p.teleport({ x: -3, y: 0, z: -3 });
  await Promise.all([settle(a.c), settle(v.c)]);
  equip(a.p, 'pistol', 12);
  const head = { x: -3, y: v.p.state.pos.y + 1.62, z: -3 };
  const dmg = next(v.c, 'damaged');
  attack(a.c, a.p, aimAt(a.p, head));
  const d = await dmg;
  assert.equal(d?.amount, WEAPONS.pistol.damage * WEAPONS.pistol.headshotMultiplier);

  v.p.record.stats.health = 10;
  await sleep(300);
  const died = next(v.c, 'died');
  const confirm = next(a.c, 'hitConfirm');
  attack(a.c, a.p, aimAt(a.p, { x: -3, y: v.p.state.pos.y + 1.0, z: -3 }));
  const info = await died;
  assert.equal(info?.cause, 'player');
  assert.equal(info?.killer, 'marksman');
  assert.equal((await confirm)?.kill, true);
  assert.equal(a.p.record.kills, 1);
});

test('crossbow bolts fly as projectiles and can be recovered from walls', async () => {
  const { c, p } = await connect('archer');
  p.teleport({ x: 6, y: 0, z: -8 });
  await settle(c);
  equip(p, 'crossbow', 1);
  const hit = next(c, 'hitConfirm', 2000);
  const end = next(c, 'projectileEnd', 2000);
  attack(c, p, aimAt(p, { x: 6, y: 1.05, z: -14 }), true);
  assert.equal((await hit)?.kind, 'dummy');
  assert.equal((await end)?.hit, 2);
});

test('enough damage knocks a dummy down and it gets back up', async () => {
  const { c, p } = await connect('demolisher');
  p.teleport({ x: -6, y: 0, z: -11 });
  await settle(c);
  equip(p, 'shotgun', 6);
  const down = next(c, 'dummyState', 4000, (m) => m.id === 0 && m.down);
  for (let i = 0; i < 3; i++) {
    attack(c, p, aimAt(p, { x: -6, y: 1.1, z: -14 }));
    await sleep(1000);
  }
  assert.ok(await down, 'dummy 0 went down');
  assert.ok(game.dummies.downIds().includes(0));
});
