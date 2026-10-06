import type { SqliteDb } from './Database';

export interface GroupRow {
  id: string;
  name: string;
  leaderId: string;
  createdAt: number;
  /** Every member, online or not. */
  members: { id: string; username: string }[];
}

/**
 * Group persistence. Membership lives on the player (players.group_id); this also writes it
 * directly so offline members can be kicked / leaders replaced without loading their record.
 */
export interface GroupRepository {
  loadAll(): Promise<GroupRow[]>;
  create(g: { id: string; name: string; leaderId: string; createdAt: number }): Promise<void>;
  delete(id: string): Promise<void>;
  setLeader(id: string, leaderId: string): Promise<void>;
  setMembership(playerId: string, groupId: string | null): Promise<void>;
}

export class SqliteGroupRepository implements GroupRepository {
  constructor(private readonly db: SqliteDb) {}

  async loadAll(): Promise<GroupRow[]> {
    const groups = this.db.prepare('SELECT id, name, leader_id, created_at FROM groups').all() as {
      id: string;
      name: string;
      leader_id: string;
      created_at: number;
    }[];
    const members = this.db
      .prepare('SELECT id, username, group_id FROM players WHERE group_id IS NOT NULL')
      .all() as { id: string; username: string; group_id: string }[];
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      leaderId: g.leader_id,
      createdAt: g.created_at,
      members: members.filter((m) => m.group_id === g.id).map((m) => ({ id: m.id, username: m.username })),
    }));
  }

  async create(g: { id: string; name: string; leaderId: string; createdAt: number }): Promise<void> {
    this.db
      .prepare('INSERT INTO groups (id, name, name_key, leader_id, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(g.id, g.name, g.name.toLowerCase(), g.leaderId, g.createdAt);
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('UPDATE players SET group_id = NULL WHERE group_id = ?').run(id);
    this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
  }

  async setLeader(id: string, leaderId: string): Promise<void> {
    this.db.prepare('UPDATE groups SET leader_id = ? WHERE id = ?').run(leaderId, id);
  }

  async setMembership(playerId: string, groupId: string | null): Promise<void> {
    this.db.prepare('UPDATE players SET group_id = ? WHERE id = ?').run(groupId, playerId);
  }
}

/** In-memory groups (tests and servers without a database). */
export class MemoryGroupRepository implements GroupRepository {
  private readonly groups = new Map<string, Omit<GroupRow, 'members'>>();
  private readonly membership = new Map<string, string | null>();
  async loadAll(): Promise<GroupRow[]> {
    return [...this.groups.values()].map((g) => ({ ...g, members: [] }));
  }
  async create(g: { id: string; name: string; leaderId: string; createdAt: number }): Promise<void> {
    this.groups.set(g.id, { ...g });
  }
  async delete(id: string): Promise<void> {
    this.groups.delete(id);
  }
  async setLeader(id: string, leaderId: string): Promise<void> {
    const g = this.groups.get(id);
    if (g) g.leaderId = leaderId;
  }
  async setMembership(playerId: string, groupId: string | null): Promise<void> {
    this.membership.set(playerId, groupId);
  }
}
