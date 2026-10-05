import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { doorPose, type BuildingType, type Vec3 } from '@grey/shared';
import type { GameServer } from './game/GameServer';
import type { PlayerRepository } from './db/PlayerRepository';

/**
 * Local-only admin API for testing (teleport, list players). Requests must come from this
 * machine AND carry the token the server writes to data/admin-token.txt on startup.
 *
 *   TOKEN=$(cat server/data/admin-token.txt)
 *   curl -H "x-admin-token: $TOKEN" localhost:2567/admin/players
 *   curl -H "x-admin-token: $TOKEN" -X POST localhost:2567/admin/teleport \
 *        -d '{"username":"kats","to":"police"}'          # or "x","y","z"
 *
 * Offline players are moved in the database and appear there on their next join.
 */
export const createAdmin = (dataDir: string, game: GameServer, repo: PlayerRepository) => {
  const token = randomBytes(16).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'admin-token.txt'), token);

  const json = (res: http.ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };

  /** Spot on the street side of a building's front door, facing the door. */
  const frontOf = (type: BuildingType): { pos: Vec3; yaw: number } | null => {
    const b = game.map.buildings.find((x) => x.type === type);
    const door = b && game.map.doors.find((d) => d.buildingId === b.id);
    if (!b || !door) return null;
    const c = doorPose(door, 0);
    const psi = (b.rot * Math.PI) / 2;
    const out = { x: -Math.sin(psi), z: -Math.cos(psi) }; // building front faces local -Z
    return {
      pos: { x: c.x + out.x * 3, y: door.hinge[1] + 0.3, z: c.z + out.z * 3 },
      yaw: Math.atan2(out.x, out.z), // looking back at the door
    };
  };

  const readBody = (req: http.IncomingMessage): Promise<any> =>
    new Promise((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve(null);
        }
      });
    });

  /** Returns true if the request was an admin request (handled here). */
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = (req.url ?? '').split('?')[0];
    if (!url.startsWith('/admin/')) return false;
    const remote = req.socket.remoteAddress ?? '';
    const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    if (!local || req.headers['x-admin-token'] !== token) {
      json(res, 403, { error: 'forbidden' });
      return true;
    }

    if (url === '/admin/players' && req.method === 'GET') {
      json(res, 200, [...game.players.values()].map((p) => ({
        username: p.username,
        alive: p.alive,
        pos: p.state.pos,
        health: p.record.stats.health,
      })));
      return true;
    }

    if (url === '/admin/teleport' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.username !== 'string') return json(res, 400, { error: 'username required' }), true;
      let target: { pos: Vec3; yaw: number } | null = null;
      if (typeof body.to === 'string') target = frontOf(body.to as BuildingType);
      else if ([body.x, body.y, body.z].every(Number.isFinite)) target = { pos: { x: body.x, y: body.y, z: body.z }, yaw: Number(body.yaw) || 0 };
      if (!target) return json(res, 400, { error: 'give "to" (building type) or x,y,z' }), true;

      const online = [...game.players.values()].find((p) => p.username.toLowerCase() === body.username.toLowerCase());
      if (online) {
        online.teleport(target.pos, target.yaw);
        console.log(`[admin] teleported ${online.username} to ${JSON.stringify(target.pos)}`);
        return json(res, 200, { ok: true, online: true, ...target }), true;
      }
      const rec = await repo.findByUsername(body.username);
      if (!rec) return json(res, 404, { error: 'no such player' }), true;
      rec.position = target.pos;
      rec.yaw = target.yaw;
      await repo.save(rec);
      console.log(`[admin] moved offline player ${rec.username} to ${JSON.stringify(target.pos)}`);
      return json(res, 200, { ok: true, online: false, note: 'applied on next join', ...target }), true;
    }

    json(res, 404, { error: 'unknown admin route' });
    return true;
  };
};
