import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import RAPIER from '@dimforge/rapier3d-compat';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '@grey/shared';
import { SERVER_CONFIG } from './config';
import { openDatabase } from './db/Database';
import { SqlitePlayerRepository } from './db/PlayerRepository';
import { GuestAuthProvider } from './auth/AuthProvider';
import { GameServer } from './game/GameServer';
import { createAdmin } from './admin';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
};

/** Serves the production client build if present (dev uses the Vite server instead). */
const staticHandler = (distDir: string): http.RequestListener => (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.normalize(path.join(distDir, urlPath));
  if (!file.startsWith(distDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(distDir, 'index.html');
  if (!fs.existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('Grey Season server running. Start the client with `npm run dev`.');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
};

const main = async () => {
  await RAPIER.init();

  const db = openDatabase(path.resolve(serverRoot, SERVER_CONFIG.dbPath));
  const repo = new SqlitePlayerRepository(db);

  const serveStatic = staticHandler(path.resolve(serverRoot, SERVER_CONFIG.clientDist));
  let admin: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>) | null = null;
  const httpServer = http.createServer(async (req, res) => {
    if (admin && (await admin(req, res))) return;
    serveStatic(req, res);
  });
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    cors: { origin: SERVER_CONFIG.corsOrigins },
    transports: ['websocket'],
  });

  const game = new GameServer(RAPIER, io, repo, new GuestAuthProvider());
  await game.enableZombies(path.resolve(serverRoot, 'data'));
  game.start();
  admin = createAdmin(path.resolve(serverRoot, 'data'), game, repo);

  httpServer.listen(SERVER_CONFIG.port, () => {
    console.log(`[server] listening on http://localhost:${SERVER_CONFIG.port}`);
  });

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[server] shutting down, saving players...');
    await game.stop();
    io.close();
    db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
