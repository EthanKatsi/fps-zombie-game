import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  INVENTORY,
  PROTOCOL_VERSION,
  SURVIVAL,
  countItem,
  type ClientToServerEvents,
  type ContainerView,
  type DeathInfo,
  type GroundItemNet,
  type JoinAccepted,
  type ServerToClientEvents,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';
import { makeUid } from '../src/game/ContainerSystem';

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

const connect = (username: string): Promise<{ c: C; join: JoinAccepted }> =>
  new Promise((resolve, reject) => {
    const c: C = ioc(url, { transports: ['websocket'] });
    clients.push(c);
    c.on('connect', () => c.emit('join', { protocol: PROTOCOL_VERSION, username }));
    c.on('joinAccepted', (join) => resolve({ c, join }));
    c.on('joinRejected', ({ reason }) => reject(new Error(reason)));
  });

const next = <K extends keyof ServerToClientEvents>(c: C, ev: K, ms = 2000, pred: (m: any) => boolean = () => true) =>
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

/** Keep the player ticking (idle inputs) so the server simulates falls etc. */
let seq = 1000;
const idle = (c: C, ms: number) => {
  const iv = setInterval(() => c.emit('input', [{ seq: ++seq, mx: 0, mz: 0, yaw: 0, pitch: 0, b: 0 }]), 33);
  return sleep(ms).then(() => clearInterval(iv));
};

test('join includes full stats; hunger and thirst drain over time', async () => {
  const { join } = await connect('hungry');
  assert.equal(join.stats.health, SURVIVAL.health.max);
  const p = game.players.get(join.playerId)!;
  const before = p.record.stats.hunger;
  await sleep(600);
  assert.ok(p.record.stats.hunger < before, 'hunger drains');
  assert.ok(p.record.stats.thirst < SURVIVAL.thirst.max, 'thirst drains');
});

test('eating takes time and restores hunger; moving the item cancels', async () => {
  const { c, join } = await connect('eater');
  const p = game.players.get(join.playerId)!;
  p.record.stats.hunger = 40;
  const slot = p.inventory.slots.findIndex((s) => s?.defId === 'canned_beans');
  const started = next(c, 'useStarted');
  c.emit('invOp', { op: 'use', slot });
  assert.ok(await started);
  const ended = next(c, 'useEnded', 4000);
  const res = await ended;
  assert.deepEqual(res, { completed: true });
  assert.ok(p.record.stats.hunger >= 69, `hunger restored: ${p.record.stats.hunger}`);
  assert.equal(countItem(p.inventory.slots, 'canned_beans'), 0);

  // Bandage, then move it away mid-use -> cancelled, nothing consumed.
  p.record.stats.health = 50;
  const bslot = p.inventory.slots.findIndex((s) => s?.defId === 'bandage');
  c.emit('invOp', { op: 'use', slot: bslot });
  await next(c, 'useStarted');
  const empty = p.inventory.slots.findIndex((s, i) => !s && i > bslot);
  const cancel = next(c, 'useEnded', 2000);
  c.emit('invOp', { op: 'move', from: { owner: 'self', index: bslot }, to: { owner: 'self', index: empty } });
  assert.deepEqual(await cancel, { completed: false });
  assert.equal(countItem(p.inventory.slots, 'bandage'), 2);
});

test('using an item you do not need is refused', async () => {
  const { c, join } = await connect('fullbelly');
  const p = game.players.get(join.playerId)!;
  p.record.stats.thirst = SURVIVAL.thirst.max;
  const slot = p.inventory.slots.findIndex((s) => s?.defId === 'water_bottle');
  const notice = next(c, 'notice');
  c.emit('invOp', { op: 'use', slot });
  assert.ok(await notice);
  assert.equal(p.using, null);
});

test('starving to death drops a bag others can loot, then respawn works', async () => {
  const victim = await connect('starver');
  const looter = await connect('scavenger');
  const pv = game.players.get(victim.join.playerId)!;
  const pl = game.players.get(looter.join.playerId)!;
  pv.inventory.slots[5] = { uid: makeUid(), defId: 'pistol', qty: 1, durability: 100 };
  // Open ground next to the origin (the test map keeps props out of a 6 m radius).
  pv.teleport({ x: -2, y: 0.05, z: 0 });
  pl.teleport({ x: -1, y: 0.05, z: 0 });
  await sleep(300);

  pv.record.stats.hunger = 0;
  pv.record.stats.health = 0.3;
  const died = (await next(victim.c, 'died', 3000)) as DeathInfo;
  assert.ok(died, 'died');
  assert.equal(died.cause, 'starvation');
  assert.equal(pv.alive, false);
  assert.ok(pv.inventory.slots.every((s) => s === null), 'inventory emptied');
  assert.equal(pv.record.deaths, 1);

  // The looter sees the bag and can search it.
  const bagMsg = (await next(looter.c, 'groundItems', 2000, (m) => m.add.some((g: GroundItemNet) => g.defId === 'loot_bag'))) as {
    add: GroundItemNet[];
  };
  const bag = bagMsg.add.find((g) => g.defId === 'loot_bag')!;
  assert.equal(bag.title, "starver's Bag");
  const opened = next(looter.c, 'containerOpened');
  looter.c.emit('interact', { kind: 'pickup', id: bag.id });
  const view = (await opened) as ContainerView;
  assert.ok(view.slots.some((s) => s?.defId === 'pistol'), 'bag holds the pistol');

  // Dead players can't act and can't respawn before the delay.
  victim.c.emit('respawn');
  await sleep(200);
  assert.equal(pv.alive, false);

  // Take everything -> bag disappears.
  for (let i = 0; i < view.slots.length; i++) {
    if (view.slots[i]) looter.c.emit('invOp', { op: 'move', from: { owner: view.key, index: i }, to: { owner: 'self', index: -1 } });
  }
  const gone = await next(looter.c, 'groundItems', 3000, (m) => m.remove.includes(bag.id));
  assert.ok(gone, 'emptied bag removed');
  assert.ok(countItem(pl.inventory.slots, 'pistol') === 1);

  // After the delay, respawn with full health and a fresh kit.
  pv.diedAt -= SURVIVAL.respawn.delaySec * 1000;
  const respawned = next(victim.c, 'respawned');
  victim.c.emit('respawn');
  const r = (await respawned) as { stats: { health: number }; inventory: { slots: unknown[] } };
  assert.ok(r, 'respawned');
  assert.equal(r.stats.health, SURVIVAL.health.max);
  assert.equal(pv.alive, true);
  for (const k of INVENTORY.startingKit) assert.equal(countItem(pv.inventory.slots, k.item), k.qty);
});

test('a long fall hurts and makes you bleed; a short drop does not', async () => {
  const { c, join } = await connect('jumper');
  const p = game.players.get(join.playerId)!;
  p.teleport({ x: 1, y: 1.5, z: 1.5 });
  await idle(c, 800);
  assert.equal(p.record.stats.health, SURVIVAL.health.max, 'short drop is harmless');

  const hurt = next(c, 'damaged', 3000);
  p.teleport({ x: 1, y: 8, z: 1.5 });
  await idle(c, 1500);
  const dmg = await hurt;
  assert.ok(dmg && dmg.cause === 'fall', 'fall damage event');
  assert.ok(p.record.stats.health < SURVIVAL.health.max - 20, `health ${p.record.stats.health}`);
  assert.equal(p.record.stats.bleeding, true, 'bad falls cause bleeding');
});
