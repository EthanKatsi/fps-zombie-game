import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  INVENTORY,
  MOVEMENT,
  PLAYER_GROUPS,
  PROTOCOL_VERSION,
  countItem,
  eyeHeight,
  ContainerIndex,
  type ClientToServerEvents,
  type ContainerSpawn,
  type ContainerView,
  type GroundItemNet,
  type Inventory,
  type JoinAccepted,
  type ServerToClientEvents,
  type Vec3,
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
const game = new GameServer(RAPIER, io, new SqlitePlayerRepository(db), new GuestAuthProvider(), { mapId: 'city' });
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

const next = <K extends keyof ServerToClientEvents>(c: C, ev: K, ms = 1000) =>
  new Promise<Parameters<ServerToClientEvents[K]>[0] | null>((resolve) => {
    const t = setTimeout(() => {
      c.off(ev, h as never);
      resolve(null);
    }, ms);
    const h = (m: Parameters<ServerToClientEvents[K]>[0]) => {
      clearTimeout(t);
      resolve(m);
    };
    c.once(ev, h as never);
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is a standing capsule at feet position p free of geometry? */
const free = (p: Vec3) =>
  game.world.intersectionWithShape(
    { x: p.x, y: p.y + MOVEMENT.standHeight / 2 + 0.05, z: p.z },
    { x: 0, y: 0, z: 0, w: 1 },
    new RAPIER.Capsule(MOVEMENT.standHeight / 2 - MOVEMENT.radius, MOVEMENT.radius),
    undefined,
    PLAYER_GROUPS,
  ) === null;

/** First hit from p's eye towards the container lands on the container? */
const sees = (p: Vec3, c: ContainerSpawn) => {
  const eye = { x: p.x, y: p.y + eyeHeight(false), z: p.z };
  const d = { x: c.p[0] - eye.x, y: c.p[1] - eye.y, z: c.p[2] - eye.z };
  const len = Math.hypot(d.x, d.y, d.z);
  const hit = game.world.castRay(new RAPIER.Ray(eye, { x: d.x / len, y: d.y / len, z: d.z / len }), len, true, undefined, PLAYER_GROUPS);
  if (!hit) return true;
  const t = hit.timeOfImpact;
  return ContainerIndex.contains(c, eye.x + (d.x / len) * t, eye.y + (d.y / len) * t, eye.z + (d.z / len) * t, 0.12);
};

/** Find a furniture container plus a free standing spot that sees it and one that doesn't. */
const findSetup = () => {
  for (const c of game.map.containers) {
    if (!c.s || c.kind !== 'shelf') continue;
    const floorY = game.map.buildings[c.buildingId!].floorY;
    if (Math.abs(c.p[1] - c.s[1] / 2 - floorY) > 0.05) continue; // ground floor only
    let good: Vec3 | null = null;
    let blocked: Vec3 | null = null;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const half = dx ? c.s[0] / 2 : c.s[2] / 2;
      const near = { x: c.p[0] + dx * (half + 0.7), y: floorY + 0.02, z: c.p[2] + dz * (half + 0.7) };
      if (!good && free(near) && sees(near, c)) good = near;
      const behind = { x: c.p[0] + dx * (half + 1.3), y: floorY + 0.02, z: c.p[2] + dz * (half + 1.3) };
      if (!blocked && free(behind) && !sees(behind, c)) blocked = behind;
    }
    if (good && blocked) return { c, good, blocked };
  }
  throw new Error('no suitable container found');
};

test('new survivors start with the starting kit', async () => {
  const { join } = await connect('rookie');
  for (const k of INVENTORY.startingKit) assert.equal(countItem(join.inventory.slots, k.item), k.qty, k.item);
});

test('loot a container in reach; refuse through a wall', async () => {
  const { c, join } = await connect('looter');
  const me = game.players.get(join.playerId)!;
  const { c: spawn, good, blocked } = findSetup();

  me.teleport(blocked);
  c.emit('interact', { kind: 'container', id: spawn.id });
  assert.equal(await next(c, 'containerOpened', 400), null, 'no looting through walls');

  me.teleport(good);
  const opened = next(c, 'containerOpened');
  c.emit('interact', { kind: 'container', id: spawn.id });
  const view = (await opened) as ContainerView;
  assert.ok(view, 'container opened');
  assert.equal(view.key, `c${spawn.id}`);
  assert.equal(view.slots.length, INVENTORY.containerSlots.shelf);

  // Force a known item into the container (test-only) and take it.
  const container = game.items.containers.get(view.key)!;
  container.slots[0] = { uid: makeUid(), defId: 'cloth', qty: 4 };
  const inv = next(c, 'inventory');
  c.emit('invOp', { op: 'move', from: { owner: view.key, index: 0 }, to: { owner: 'self', index: -1 } });
  const after = (await inv) as Inventory;
  assert.equal(countItem(after.slots, 'cloth'), 4);
  assert.equal(container.slots[0], null);

  // Craft a bandage from 2 cloth.
  const inv2 = next(c, 'inventory');
  c.emit('invOp', { op: 'craft', recipeId: 'bandage' });
  const crafted = (await inv2) as Inventory;
  assert.equal(countItem(crafted.slots, 'cloth'), 2);
  assert.equal(countItem(crafted.slots, 'bandage'), INVENTORY.startingKit.find((k) => k.item === 'bandage')!.qty + 1);

  // Walking away closes the container.
  const closed = next(c, 'containerClosed', 1500);
  me.teleport({ x: good.x, y: good.y + 40, z: good.z });
  assert.ok(await closed, 'auto-closed when far away');
});

test('weight limit is enforced when taking from containers', async () => {
  const { c, join } = await connect('mule');
  const me = game.players.get(join.playerId)!;
  const { c: spawn, good } = findSetup();
  me.teleport(good);
  const opened = next(c, 'containerOpened');
  c.emit('interact', { kind: 'container', id: spawn.id });
  const view = (await opened) as ContainerView;
  const container = game.items.containers.get(view.key)!;
  for (let i = 0; i < container.slots.length; i++) container.slots[i] = { uid: makeUid(), defId: 'wood_plank', qty: 10 };
  for (let i = 0; i < container.slots.length; i++) {
    c.emit('invOp', { op: 'move', from: { owner: view.key, index: i }, to: { owner: 'self', index: -1 } });
  }
  await sleep(400);
  const weight = me.inventory.slots.reduce((w, s) => w + (s ? (s.defId === 'wood_plank' ? 1 : 0) * s.qty : 0), 0);
  assert.ok(weight <= INVENTORY.maxCarryWeight, `carrying ${weight} kg of planks`);
  assert.ok(weight >= INVENTORY.maxCarryWeight - 3, 'filled up close to the limit');
});

test('drop shows up for nearby players and can be picked up', async () => {
  const a = await connect('dropper');
  const b = await connect('finder');
  const pa = game.players.get(a.join.playerId)!;
  const pb = game.players.get(b.join.playerId)!;
  const { good } = findSetup();
  pa.teleport(good);
  pb.teleport({ x: good.x + 0.5, y: good.y, z: good.z + 0.5 });
  await sleep(400); // let interest sync settle

  const slot = pa.inventory.slots.findIndex((s) => s?.defId === 'water_bottle');
  const seen = next(b.c, 'groundItems', 1500);
  a.c.emit('invOp', { op: 'drop', from: { owner: 'self', index: slot } });
  const msg = (await seen) as { add: GroundItemNet[]; remove: string[] };
  const item = msg.add.find((g) => g.defId === 'water_bottle');
  assert.ok(item, 'finder sees the dropped bottle');
  assert.equal(countItem(pa.inventory.slots, 'water_bottle'), 0);

  const gone = next(a.c, 'groundItems', 1500);
  b.c.emit('interact', { kind: 'pickup', id: item!.id });
  const removed = (await gone) as { add: GroundItemNet[]; remove: string[] };
  assert.deepEqual(removed.remove, [item!.id]);
  assert.equal(countItem(pb.inventory.slots, 'water_bottle'), 2);
});

test('inventory ops on containers you have not opened are ignored', async () => {
  const { c, join } = await connect('cheater');
  const me = game.players.get(join.playerId)!;
  const before = JSON.stringify(me.inventory);
  c.emit('invOp', { op: 'move', from: { owner: 'c0', index: 0 }, to: { owner: 'self', index: -1 } });
  c.emit('invOp', { op: 'move', from: { owner: 'self', index: 99 }, to: { owner: 'self', index: 0 } });
  c.emit('invOp', { op: 'move', from: { owner: 'self', index: 0 }, to: { owner: 'self', index: 1 }, qty: -5 });
  c.emit('invOp', { op: 'drop', from: { owner: 'c0', index: 0 } });
  c.emit('invOp', null as never);
  await sleep(300);
  assert.equal(JSON.stringify(me.inventory), before);
});
