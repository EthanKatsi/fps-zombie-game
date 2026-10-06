import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  doorPose,
  doorPanelHits,
  MOVEMENT,
  type ClientToServerEvents,
  type JoinAccepted,
  type ServerToClientEvents,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('join reports the city map, its hash and open doors', async () => {
  const { join } = await connect('mapper');
  assert.equal(join.mapId, 'city');
  assert.equal(join.mapHash, game.mapHash);
  assert.deepEqual(join.openDoors, game.doors.openIds());
});

test('doors toggle only when the player is close enough', async () => {
  const { c, join } = await connect('doorman');
  const door = game.map.doors.find((d) => !game.doors.open[d.id])!;
  const changes: { id: number; open: boolean; dir: number }[] = [];
  c.on('doorChanged', (m) => changes.push(m));

  // Far away: ignored.
  c.emit('interact', { kind: 'door', id: door.id });
  await sleep(300);
  assert.equal(game.doors.open[door.id], false);

  // Teleport next to the door (test-only shortcut): 1.2 m from its center, on the side
  // the door swings AWAY from (otherwise it would rightly refuse to hit us).
  const pose = doorPose(door, 0);
  const openYaw = door.yaw + door.swing * (Math.PI / 2);
  const ox = Math.cos(openYaw), oz = -Math.sin(openYaw); // direction the panel swings towards
  const p = game.players.get(join.playerId)!;
  p.teleport({ x: pose.x - ox * 1.2, y: door.hinge[1] + 0.05, z: pose.z - oz * 1.2 });
  c.emit('interact', { kind: 'door', id: door.id });
  await sleep(300);
  assert.equal(game.doors.open[door.id], true);
  assert.deepEqual(changes.at(-1), { id: door.id, open: true, dir: 1 });
});

test('a door opens away from you even when you stand right against it', async () => {
  const { c, join } = await connect('blocker');
  const door = game.map.doors.find((d) => !game.doors.open[d.id] && !d.startsOpen)!;
  const p = game.players.get(join.playerId)!;
  // Pressed against the closed door on the side it normally swings towards.
  const closed = doorPose(door, 0);
  const openYaw = door.yaw + door.swing * (Math.PI / 2);
  const ox = Math.cos(openYaw), oz = -Math.sin(openYaw);
  const at = { x: closed.x + ox * 0.4, z: closed.z + oz * 0.4 };
  p.teleport({ x: at.x, y: door.hinge[1] + 0.05, z: at.z });
  const changed = new Promise<{ id: number; open: boolean; dir: number }>((r) => c.once('doorChanged', r));
  c.emit('interact', { kind: 'door', id: door.id });
  const msg = await changed;
  assert.equal(game.doors.open[door.id], true, 'opened');
  assert.equal(msg.dir, -1, 'swung the other way, away from the player');
  assert.ok(!doorPanelHits(door, -1, at.x, at.z, MOVEMENT.radius), 'panel clear of the player');

  // Standing in the doorway: it won't close on you.
  p.teleport({ x: closed.x, y: door.hinge[1] + 0.05, z: closed.z });
  await sleep(500);
  c.emit('interact', { kind: 'door', id: door.id });
  await sleep(300);
  assert.equal(game.doors.open[door.id], true, 'still open');
});

test('unknown or malformed door ids are ignored', async () => {
  const { c } = await connect('hacker');
  c.emit('interact', { kind: 'door', id: 999999 });
  c.emit('interact', { kind: 'door', id: -1 });
  c.emit('interact', { kind: 'door', id: 1.5 } as never);
  c.emit('interact', null as never);
  await sleep(200);
  assert.ok(true, 'server still alive');
  assert.ok(game.players.size > 0);
});
