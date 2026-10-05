import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import { io as ioc, type Socket } from 'socket.io-client';
import { CITY, PROTOCOL_VERSION, type ClientToServerEvents, type ServerToClientEvents } from '@grey/shared';
import { Frame } from '../../shared/src/world/city/buildings';
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
const zombies = await game.enableZombies(os.tmpdir(), false);
game.start();
await new Promise<void>((r) => httpServer.listen(0, r));
const url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
let client: C | null = null;

after(async () => {
  client?.disconnect();
  await game.stop();
  io.close();
  db.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a closed front door keeps a chasing zombie out; opening it lets it in', async () => {
  const c: C = ioc(url, { transports: ['websocket'] });
  client = c;
  const join = await new Promise<any>((r) => {
    c.on('connect', () => c.emit('join', { protocol: PROTOCOL_VERSION, username: 'homebody' }));
    c.on('joinAccepted', r);
  });
  const p = game.players.get(join.playerId)!;
  const house = game.map.buildings.find((b) => b.type === 'house' && b.floors === 1)!;
  const fr = new Frame(house.center[0], house.center[1], house.size[0], house.size[1], house.rot);
  const [W, D] = house.size;
  const front = game.map.doors.find((d) => d.buildingId === house.id)!;
  // Close every door of the house.
  for (const d of game.map.doors) if (d.buildingId === house.id && game.doors.open[d.id]) game.doors.set(d.id, false);
  game.world.step();

  // Player in the middle of the house; zombie on the street in front of the door.
  const [ix, iz] = fr.pt(W / 2, D / 2);
  p.teleport({ x: ix, y: house.floorY + 0.05, z: iz });
  const [ox, oz] = fr.pt(W / 2, -4);
  const id = zombies.spawn('runner', { x: ox, y: CITY.curbHeight, z: oz })!;
  const z = zombies.get(id)! as any;
  z.target = p;
  z.state = 'chase';
  z.lastSeenAt = Infinity; // never forget the target in this test

  // Depth into the house along local +z (negative = still outside the facade).
  const depth = () => {
    const [ax, az] = fr.pt(W / 2, 0);
    const [bx, bz] = fr.pt(W / 2, 1);
    const zp = zombies.get(id)!.pos;
    return (zp.x - ax) * (bx - ax) + (zp.z - az) * (bz - az);
  };
  await sleep(5000);
  assert.ok(depth() < 0.3, `zombie stayed outside (depth ${depth().toFixed(2)})`);

  game.doors.set(front.id, true);
  game.world.step();
  await sleep(4000);
  assert.ok(depth() > 1, `zombie got in once the door opened (depth ${depth().toFixed(2)})`);
});
