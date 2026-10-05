import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type ClientToServerEvents,
  type JoinAccepted,
  type ServerToClientEvents,
  type Snapshot,
} from '@grey/shared';
import { openDatabase } from '../src/db/Database';
import { SqlitePlayerRepository } from '../src/db/PlayerRepository';
import { GuestAuthProvider } from '../src/auth/AuthProvider';
import { GameServer } from '../src/game/GameServer';

type C = Socket<ServerToClientEvents, ClientToServerEvents>;

await RAPIER.init();
const db = openDatabase(':memory:');
const repo = new SqlitePlayerRepository(db);
const httpServer = http.createServer();
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer);
const game = new GameServer(RAPIER, io, repo, new GuestAuthProvider());
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

const nextSnapshot = (c: C, pred: (s: Snapshot) => boolean = () => true, timeoutMs = 3000): Promise<Snapshot> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('snapshot timeout')), timeoutMs);
    const h = (s: Snapshot) => {
      if (!pred(s)) return;
      clearTimeout(timer);
      c.off('snapshot', h);
      resolve(s);
    };
    c.on('snapshot', h);
  });

/** Send inputs like a real client: one per tick. */
const sendPaced = async (c: C, inputs: { seq: number }[]) => {
  for (const i of inputs) {
    c.emit('input', [i as never]);
    await new Promise((r) => setTimeout(r, 1000 / 30));
  }
};

test('rejects invalid usernames', async () => {
  await assert.rejects(connect('x'), /Username/);
});

test('two players join and see each other in snapshots', async () => {
  const a = await connect('alice');
  const b = await connect('bob');
  const snapA = await nextSnapshot(a.c, (s) => s.players.some((p) => p.id === b.join.playerId));
  assert.ok(snapA.players.find((p) => p.id === b.join.playerId));
  const snapB = await nextSnapshot(b.c, (s) => s.players.some((p) => p.id === a.join.playerId));
  assert.ok(snapB);
});

test('duplicate username is rejected while online', async () => {
  await assert.rejects(connect('ALICE'), /already/);
});

test('server applies inputs, acks them and moves the player', async () => {
  const { c, join } = await connect('carol');
  const start = join.state.pos;
  // Let the player settle on the ground first, then walk forward (-Z) for 1 second.
  const inputs = Array.from({ length: 40 }, (_, i) => ({
    seq: i + 1, mx: 0, mz: i < 10 ? 0 : 1, yaw: 0, pitch: 0, b: 0,
  }));
  await sendPaced(c, inputs);
  const snap = await nextSnapshot(c, (s) => s.ack === 40);
  assert.ok(snap.you.pos.z < start.z - 3, `moved: ${start.z} -> ${snap.you.pos.z}`);
});

test('input flooding cannot exceed the tick-rate budget (speedhack)', async () => {
  const { c, join } = await connect('dave');
  const flood = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, mx: 0, mz: 1, yaw: 0, pitch: 0, b: 2 }));
  c.emit('input', flood);
  // After one tick at most maxInputsPerTick inputs may be applied.
  const snap = await nextSnapshot(c);
  assert.ok(snap.ack <= 3 + 2, `ack ${snap.ack} should be budget-limited`);
  assert.ok(Math.abs(snap.you.pos.z - join.state.pos.z) < 2);
});

test('position persists across reconnects', async () => {
  const { c } = await connect('erin');
  const inputs = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, mx: 1, mz: 0, yaw: 0, pitch: 0, b: 0 }));
  await sendPaced(c, inputs);
  const snap = await nextSnapshot(c, (s) => s.ack === 30);
  c.disconnect();
  await new Promise((r) => setTimeout(r, 200));
  const again = await connect('erin');
  assert.ok(Math.abs(again.join.state.pos.x - snap.you.pos.x) < 0.01, 'resumed at saved position');
});
