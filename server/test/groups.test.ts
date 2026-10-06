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
  eyeHeight,
  type ChatMessage,
  type ClientToServerEvents,
  type GroupView,
  type JoinAccepted,
  type ServerToClientEvents,
  type TeammatePos,
  type Vec3,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { SqliteGroupRepository } from '../src/db/GroupRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';
import { GroupSystem } from '../src/game/GroupSystem';
import { makeUid } from '../src/game/ContainerSystem';
import type { ServerPlayer } from '../src/game/ServerPlayer';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

await RAPIER.init();
const db = openDatabase(':memory:');
const httpServer = http.createServer();
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
const groupRepo = new SqliteGroupRepository(db);
const game = new GameServer(RAPIER, io, new SqlitePlayerRepository(db), new GuestAuthProvider(), { mapId: 'testmap', groupRepo });
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

/** Connect and record everything group/chat related the client receives. */
const connect = (username: string) =>
  new Promise<{ c: C; join: JoinAccepted; p: ServerPlayer; chat: ChatMessage[]; state: { g: GroupView | null }; mates: { list: TeammatePos[] } }>((resolve, reject) => {
    const c: C = ioc(url, { transports: ['websocket'] });
    clients.push(c);
    const chat: ChatMessage[] = [];
    const state = { g: null as GroupView | null };
    const mates = { list: [] as TeammatePos[] };
    c.on('chatMessage', (m) => chat.push(m));
    c.on('groupState', (g) => (state.g = g));
    c.on('teammates', (l) => (mates.list = l));
    c.on('connect', () => c.emit('join', { protocol: PROTOCOL_VERSION, username }));
    c.on('joinAccepted', (join) => resolve({ c, join, p: game.players.get(join.playerId)!, chat, state, mates }));
    c.on('joinRejected', ({ reason }) => reject(new Error(reason)));
  });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await sleep(30);
  return cond();
};

test('create a group, invite, accept; both see it and each other', async () => {
  const a = await connect('leaderA');
  const b = await connect('memberB');
  a.c.emit('group', { op: 'create', name: 'Ridge Runners' });
  assert.ok(await until(() => a.state.g?.name === 'Ridge Runners'));
  assert.equal(a.state.g!.leaderId, a.p.id);

  const invite = new Promise<{ groupId: string; from: string }>((r) => b.c.once('groupInvite', r));
  a.c.emit('group', { op: 'invite', username: 'memberb' });
  const inv = await invite;
  assert.equal(inv.from, 'leaderA');
  b.c.emit('group', { op: 'accept', groupId: inv.groupId });
  assert.ok(await until(() => b.state.g?.members.length === 2 && a.state.g?.members.length === 2), 'both see 2 members');
  assert.ok(b.chat.some((m) => m.channel === 'system' && /joined the group/.test(m.text)));

  // Teammate positions arrive regardless of distance.
  a.p.teleport({ x: -50, y: 0, z: -50 });
  b.p.teleport({ x: 50, y: 0, z: 50 });
  assert.ok(await until(() => a.mates.list.some((t) => t.id === b.p.id && Math.abs(t.p[0] - 50) < 1)), 'A sees where B is');
});

test('group chat reaches only members; global chat reaches everyone; spam is limited', async () => {
  const a = await connect('chatA');
  const b = await connect('chatB');
  const outsider = await connect('chatOut');
  a.c.emit('group', { op: 'create', name: 'Night Shift' });
  await until(() => !!a.state.g);
  const inv = new Promise<{ groupId: string }>((r) => b.c.once('groupInvite', r));
  a.c.emit('group', { op: 'invite', username: 'chatB' });
  b.c.emit('group', { op: 'accept', groupId: (await inv).groupId });
  await until(() => a.state.g?.members.length === 2);

  a.c.emit('chat', { channel: 'group', text: 'meet at the gas station' });
  assert.ok(await until(() => b.chat.some((m) => m.channel === 'group' && m.text === 'meet at the gas station' && m.from === 'chatA')));
  await sleep(200);
  assert.ok(!outsider.chat.some((m) => m.text === 'meet at the gas station'), 'outsider does not see group chat');

  await sleep(800);
  a.c.emit('chat', { channel: 'global', text: '  hello\u0007 everyone  ' });
  assert.ok(await until(() => outsider.chat.some((m) => m.channel === 'global' && m.text === 'hello everyone')), 'global chat, cleaned');
  // Too fast: dropped.
  a.c.emit('chat', { channel: 'global', text: 'spam' });
  await sleep(300);
  assert.ok(!outsider.chat.some((m) => m.text === 'spam'));
});

test('teammates cannot hurt each other; strangers can', async () => {
  const a = await connect('ffShooter');
  const b = await connect('ffMate');
  const s = await connect('ffStranger');
  a.c.emit('group', { op: 'create', name: 'No Friendly Fire' });
  await until(() => !!a.state.g);
  const inv = new Promise<{ groupId: string }>((r) => b.c.once('groupInvite', r));
  a.c.emit('group', { op: 'invite', username: 'ffMate' });
  b.c.emit('group', { op: 'accept', groupId: (await inv).groupId });
  await until(() => a.state.g?.members.length === 2);
  for (const p of [a.p, b.p, s.p]) p.protectedUntil = 0;

  a.p.teleport({ x: 0, y: 0, z: 8 });
  a.p.inventory.slots[0] = { uid: makeUid(), defId: 'rifle', qty: 1, loadedAmmo: 5 };
  a.p.inventory.activeHotbar = 0;
  let seq = 0;
  const settle = async (c: C) => {
    for (let i = 0; i < 6; i++) {
      c.emit('input', [{ seq: ++seq, mx: 0, mz: 0, yaw: 0, pitch: 0, b: Buttons.aim }]);
      await sleep(34);
    }
  };
  const shootAt = async (target: ServerPlayer, attackSeq: number) => {
    const e = { x: a.p.state.pos.x, y: a.p.state.pos.y + eyeHeight(false), z: a.p.state.pos.z };
    const t: Vec3 = { x: target.state.pos.x, y: target.state.pos.y + 1.1, z: target.state.pos.z };
    const d = { x: t.x - e.x, y: t.y - e.y, z: t.z - e.z };
    const l = Math.hypot(d.x, d.y, d.z);
    a.c.emit('attack', { seq: attackSeq, dir: [d.x / l, d.y / l, d.z / l], aim: true, afterSeq: -1, viewTime: game.serverTime() });
  };

  b.p.teleport({ x: 0, y: 0, z: 2 });
  await settle(a.c);
  const hp0 = b.p.record.stats.health;
  await shootAt(b.p, 0);
  await sleep(400);
  assert.equal(b.p.record.stats.health, hp0, 'teammate unhurt');

  b.p.teleport({ x: 30, y: 0, z: 30 });
  s.p.teleport({ x: 0, y: 0, z: 2 });
  await settle(a.c);
  await sleep(1300); // rifle fire rate
  const sp0 = s.p.record.stats.health;
  await shootAt(s.p, 1);
  assert.ok(await until(() => s.p.record.stats.health < sp0, 1500), 'stranger hurt');
});

test('leaving hands over leadership; the last one out disbands; groups persist', async () => {
  const a = await connect('persistA');
  const b = await connect('persistB');
  a.c.emit('group', { op: 'create', name: 'Old Mill' });
  await until(() => !!a.state.g);
  const inv = new Promise<{ groupId: string }>((r) => b.c.once('groupInvite', r));
  a.c.emit('group', { op: 'invite', username: 'persistB' });
  b.c.emit('group', { op: 'accept', groupId: (await inv).groupId });
  await until(() => a.state.g?.members.length === 2);
  const gid = a.state.g!.id;

  // Saved: a fresh group system reading the same database sees the group and both members.
  const reloaded = new GroupSystem(groupRepo, () => [], io as never);
  await reloaded.ready;
  const g = (reloaded as unknown as { groups: Map<string, { name: string; members: Map<string, string> }> }).groups.get(gid)!;
  assert.equal(g.name, 'Old Mill');
  assert.deepEqual([...g.members.values()].sort(), ['persistA', 'persistB']);

  a.c.emit('group', { op: 'leave' });
  assert.ok(await until(() => a.state.g === null && b.state.g?.leaderId === b.p.id), 'B leads now');
  b.c.emit('group', { op: 'leave' });
  assert.ok(await until(() => b.state.g === null));
  await sleep(100);
  const after = await groupRepo.loadAll();
  assert.ok(!after.some((x) => x.id === gid), 'disbanded group deleted');
});
