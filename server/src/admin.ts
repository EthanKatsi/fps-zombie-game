import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import {
  ZOMBIE_TYPE_ORDER,
  doorPose,
  getItemDef,
  getWeaponDef,
  insertStack,
  normalizeInventory,
  type BuildingType,
  type ItemStack,
  type Vec3,
  type ZombieType,
} from '@grey/shared';
import { makeUid } from './game/ContainerSystem';
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
 *
 *   POST /admin/zombies  {"username":"kats","count":5,"type":"runner"}  spawns zombies 8-16 m away
 *   POST /admin/give     {"username":"kats","item":"assault_rifle","qty":1}  (online players; ignores weight)
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
        game.vehicles.onPlayerGone(online);
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

    if (url === '/admin/zombies' && req.method === 'POST') {
      const body = await readBody(req);
      const zs = game.zombies;
      const p = body && [...game.players.values()].find((x) => x.username.toLowerCase() === String(body.username).toLowerCase());
      if (!zs) return json(res, 503, { error: 'zombies not enabled' }), true;
      if (!p) return json(res, 404, { error: 'player not online' }), true;
      const count = Math.max(1, Math.min(30, Number(body.count) || 3));
      const type = ZOMBIE_TYPE_ORDER.includes(body.type) ? (body.type as ZombieType) : null;
      let spawned = 0;
      for (let i = 0; i < count; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = 8 + Math.random() * 8;
        const t = type ?? ZOMBIE_TYPE_ORDER[Math.floor(Math.random() * 3)];
        if (zs.spawn(t, { x: p.state.pos.x + Math.sin(a) * d, y: p.state.pos.y, z: p.state.pos.z + Math.cos(a) * d })) spawned++;
      }
      return json(res, 200, { ok: true, spawned }), true;
    }

    if (url === '/admin/give' && req.method === 'POST') {
      const body = await readBody(req);
      const p = body && [...game.players.values()].find((x) => x.username.toLowerCase() === String(body.username).toLowerCase());
      // Offline players get it in their saved inventory (applied on next join).
      const rec = p ? null : body && typeof body.username === 'string' ? await repo.findByUsername(body.username) : null;
      if (!p && !rec) return json(res, 404, { error: 'no such player' }), true;
      const def = getItemDef(String(body.item));
      if (!def) return json(res, 400, { error: 'unknown item' }), true;
      const qty = Math.max(1, Math.min(999, Math.floor(Number(body.qty) || 1)));
      const stack: ItemStack = { uid: makeUid(), defId: def.id, qty };
      if (def.maxDurability) stack.durability = def.maxDurability;
      const mag = getWeaponDef(def.weaponId)?.magazineSize;
      if (mag) stack.loadedAmmo = mag;
      const inv = p ? p.inventory : normalizeInventory(rec!.inventory);
      // Guns are given one by one (each needs its own uid / magazine).
      let given = 0;
      if (def.maxStack === 1) {
        for (let i = 0; i < qty; i++) given += insertStack(inv.slots, { ...stack, uid: makeUid() }, 1, makeUid);
      } else {
        given = insertStack(inv.slots, stack, qty, makeUid);
      }
      if (p) game.items.sendInventory(p);
      else {
        rec!.inventory = inv;
        await repo.save(rec!);
      }
      console.log(`[admin] gave ${given}x ${def.id} to ${p?.username ?? rec!.username}${p ? '' : ' (offline)'}`);
      return json(res, 200, { ok: true, given, requested: qty, online: !!p }), true;
    }

    json(res, 404, { error: 'unknown admin route' });
    return true;
  };
};
