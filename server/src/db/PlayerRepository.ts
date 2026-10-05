import { randomUUID } from 'node:crypto';
import { SURVIVAL, createInventory, type PlayerRecord, type Vec3 } from '@grey/shared';
import type { SqliteDb } from './Database';

/**
 * Storage-agnostic player persistence. Async so a Postgres implementation can be
 * dropped in without touching game code.
 */
export interface PlayerRepository {
  findByUsername(username: string): Promise<PlayerRecord | null>;
  create(username: string, position: Vec3): Promise<PlayerRecord>;
  save(record: PlayerRecord): Promise<void>;
}

interface PlayerRow {
  id: string;
  username: string;
  pos_x: number;
  pos_y: number;
  pos_z: number;
  yaw: number;
  stats: string;
  inventory: string;
  group_id: string | null;
  spawn_bed_id: string | null;
  kills: number;
  deaths: number;
  created_at: number;
  last_seen_at: number;
}

const usernameKey = (u: string): string => u.trim().toLowerCase();

const fromRow = (r: PlayerRow): PlayerRecord => ({
  id: r.id,
  username: r.username,
  position: { x: r.pos_x, y: r.pos_y, z: r.pos_z },
  yaw: r.yaw,
  stats: JSON.parse(r.stats),
  inventory: JSON.parse(r.inventory),
  groupId: r.group_id,
  spawnBedId: r.spawn_bed_id,
  kills: r.kills,
  deaths: r.deaths,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export class SqlitePlayerRepository implements PlayerRepository {
  constructor(private readonly db: SqliteDb) {}

  async findByUsername(username: string): Promise<PlayerRecord | null> {
    const row = this.db
      .prepare('SELECT * FROM players WHERE username_key = ?')
      .get(usernameKey(username)) as PlayerRow | undefined;
    return row ? fromRow(row) : null;
  }

  async create(username: string, position: Vec3): Promise<PlayerRecord> {
    const now = Date.now();
    const rec: PlayerRecord = {
      id: randomUUID(),
      username: username.trim(),
      position: { ...position },
      yaw: 0,
      stats: {
        health: SURVIVAL.health.max,
        hunger: SURVIVAL.hunger.max,
        thirst: SURVIVAL.thirst.max,
        stamina: SURVIVAL.stamina.max,
        bleeding: false,
      },
      inventory: createInventory(),
      groupId: null,
      spawnBedId: null,
      kills: 0,
      deaths: 0,
      createdAt: now,
      lastSeenAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO players (id, username, username_key, pos_x, pos_y, pos_z, yaw, stats, inventory,
          group_id, spawn_bed_id, kills, deaths, created_at, last_seen_at)
         VALUES (@id, @username, @key, @x, @y, @z, @yaw, @stats, @inventory, @groupId, @spawnBedId,
          @kills, @deaths, @createdAt, @lastSeenAt)`,
      )
      .run(this.toParams(rec));
    return rec;
  }

  async save(rec: PlayerRecord): Promise<void> {
    this.db
      .prepare(
        `UPDATE players SET pos_x=@x, pos_y=@y, pos_z=@z, yaw=@yaw, stats=@stats, inventory=@inventory,
          group_id=@groupId, spawn_bed_id=@spawnBedId, kills=@kills, deaths=@deaths,
          last_seen_at=@lastSeenAt WHERE id=@id`,
      )
      .run(this.toParams(rec));
  }

  private toParams(r: PlayerRecord) {
    return {
      id: r.id,
      username: r.username,
      key: usernameKey(r.username),
      x: r.position.x,
      y: r.position.y,
      z: r.position.z,
      yaw: r.yaw,
      stats: JSON.stringify(r.stats),
      inventory: JSON.stringify(r.inventory),
      groupId: r.groupId,
      spawnBedId: r.spawnBedId,
      kills: r.kills,
      deaths: r.deaths,
      createdAt: r.createdAt,
      lastSeenAt: r.lastSeenAt,
    };
  }
}
