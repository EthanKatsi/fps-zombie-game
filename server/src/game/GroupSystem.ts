import { randomUUID } from 'node:crypto';
import {
  CHAT,
  GROUPS,
  SURVIVAL,
  cleanChatText,
  cleanGroupName,
  type ChatMessage,
  type GroupOp,
  type GroupView,
  type TeammatePos,
} from '@grey/shared';
import type { GroupRepository } from '../db/GroupRepository';
import type { ServerPlayer } from './ServerPlayer';
import type { GameIO } from './types';

interface LiveGroup {
  id: string;
  name: string;
  leaderId: string;
  createdAt: number;
  /** All members (online or not): player id -> name. */
  members: Map<string, string>;
}

interface Invite {
  groupId: string;
  from: string;
  expires: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Groups (teams) and chat. Groups and membership persist (GroupRepository + players.group_id);
 * invites are in memory and expire. Members see each other on the minimap / compass and through
 * walls (teammate positions are sent regardless of distance), and can't hurt each other.
 */
export class GroupSystem {
  private readonly groups = new Map<string, LiveGroup>();
  /** Invitee player id -> pending invites. */
  private readonly invites = new Map<string, Invite[]>();
  private readonly lastChat = new Map<string, number>();
  private lastTeammates = 0;
  readonly ready: Promise<void>;

  constructor(
    private readonly repo: GroupRepository,
    private readonly players: () => Iterable<ServerPlayer>,
    private readonly io: GameIO,
  ) {
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    for (const g of await this.repo.loadAll()) {
      this.groups.set(g.id, {
        id: g.id,
        name: g.name,
        leaderId: g.leaderId,
        createdAt: g.createdAt,
        members: new Map(g.members.map((m) => [m.id, m.username])),
      });
    }
  }

  // ------------------------------------------------------------------ queries

  groupOf(p: ServerPlayer): LiveGroup | null {
    const id = p.record.groupId;
    return id ? (this.groups.get(id) ?? null) : null;
  }

  private online(id: string): ServerPlayer | null {
    for (const p of this.players()) if (p.id === id) return p;
    return null;
  }

  private onlineMembers(g: LiveGroup): ServerPlayer[] {
    const out: ServerPlayer[] = [];
    for (const p of this.players()) if (g.members.has(p.id)) out.push(p);
    return out;
  }

  view(g: LiveGroup): GroupView {
    const online = new Set(this.onlineMembers(g).map((p) => p.id));
    return {
      id: g.id,
      name: g.name,
      leaderId: g.leaderId,
      members: [...g.members].map(([id, name]) => ({ id, name, online: online.has(id) })),
    };
  }

  private broadcastState(g: LiveGroup): void {
    const v = this.view(g);
    for (const p of this.onlineMembers(g)) p.socket.emit('groupState', v);
  }

  // ------------------------------------------------------------------ messages

  private send(to: ServerPlayer, m: Omit<ChatMessage, 'at'>): void {
    to.socket.emit('chatMessage', { ...m, at: Date.now() });
  }

  /** A system line in a group's chat. */
  private tellGroup(g: LiveGroup, text: string): void {
    for (const p of this.onlineMembers(g)) this.send(p, { channel: 'system', from: null, text });
  }

  /** A system line for everyone (joins / leaves). */
  announce(text: string): void {
    this.io.emit('chatMessage', { channel: 'system', from: null, text, at: Date.now() });
  }

  chat(p: ServerPlayer, msg: { channel: 'global' | 'group'; text: string }): void {
    const text = cleanChatText(msg?.text);
    if (!text) return;
    const now = performance.now();
    if (now - (this.lastChat.get(p.id) ?? -Infinity) < CHAT.minIntervalMs) {
      p.socket.emit('notice', { text: 'Slow down' });
      return;
    }
    this.lastChat.set(p.id, now);
    if (msg.channel === 'group') {
      const g = this.groupOf(p);
      if (!g) return void p.socket.emit('notice', { text: 'You are not in a group' });
      for (const m of this.onlineMembers(g)) this.send(m, { channel: 'group', from: p.username, text });
    } else {
      this.io.emit('chatMessage', { channel: 'global', from: p.username, text, at: Date.now() });
    }
  }

  // ------------------------------------------------------------------ lifecycle

  onJoin(p: ServerPlayer): void {
    const g = this.groupOf(p);
    if (p.record.groupId && !g) p.record.groupId = null; // group was disbanded while away
    if (g) {
      g.members.set(p.id, p.username);
      this.broadcastState(g);
      this.tellGroup(g, `${p.username} is online`);
    } else {
      p.socket.emit('groupState', null);
    }
    for (const inv of this.pendingInvites(p.id)) {
      const ig = this.groups.get(inv.groupId);
      if (ig) p.socket.emit('groupInvite', { groupId: ig.id, groupName: ig.name, from: inv.from });
    }
  }

  onLeave(p: ServerPlayer): void {
    this.lastChat.delete(p.id);
    const g = this.groupOf(p);
    if (!g) return;
    // Sent after the player is removed from the online list, so they show as offline.
    queueMicrotask(() => {
      this.broadcastState(g);
      this.tellGroup(g, `${p.username} went offline`);
    });
  }

  private pendingInvites(playerId: string): Invite[] {
    const now = Date.now();
    const list = (this.invites.get(playerId) ?? []).filter((i) => i.expires > now && this.groups.has(i.groupId));
    if (list.length) this.invites.set(playerId, list);
    else this.invites.delete(playerId);
    return list;
  }

  // ------------------------------------------------------------------ operations

  handle(p: ServerPlayer, op: GroupOp): void {
    if (!op || typeof op !== 'object') return;
    const fail = (text: string): void => void p.socket.emit('notice', { text });
    switch (op.op) {
      case 'create': {
        if (this.groupOf(p)) return fail('Leave your group first');
        const name = cleanGroupName(op.name);
        if (!name) return fail(`Group names are ${GROUPS.nameMin}-${GROUPS.nameMax} letters, numbers or spaces`);
        if ([...this.groups.values()].some((g) => g.name.toLowerCase() === name.toLowerCase())) return fail('That name is taken');
        const g: LiveGroup = { id: randomUUID(), name, leaderId: p.id, createdAt: Date.now(), members: new Map([[p.id, p.username]]) };
        this.groups.set(g.id, g);
        p.record.groupId = g.id;
        void this.repo.create(g).then(() => this.repo.setMembership(p.id, g.id));
        this.broadcastState(g);
        this.tellGroup(g, `Group "${name}" created. Invite people from the group panel (G).`);
        return;
      }
      case 'invite': {
        const g = this.groupOf(p);
        if (!g) return fail('Create a group first');
        const key = String(op.username ?? '').trim().toLowerCase();
        const target = [...this.players()].find((x) => x.username.toLowerCase() === key);
        if (!target) return fail('No survivor online with that name');
        if (target === p) return fail("You can't invite yourself");
        if (g.members.has(target.id)) return fail(`${target.username} is already in your group`);
        if (this.groupOf(target)) return fail(`${target.username} is in another group`);
        if (g.members.size >= GROUPS.maxMembers) return fail(`Groups are limited to ${GROUPS.maxMembers}`);
        const list = this.pendingInvites(target.id).filter((i) => i.groupId !== g.id);
        list.push({ groupId: g.id, from: p.username, expires: Date.now() + GROUPS.inviteTtlSec * 1000 });
        this.invites.set(target.id, list);
        target.socket.emit('groupInvite', { groupId: g.id, groupName: g.name, from: p.username });
        this.tellGroup(g, `${p.username} invited ${target.username}`);
        return;
      }
      case 'accept':
      case 'decline': {
        const list = this.pendingInvites(p.id);
        const inv = list.find((i) => i.groupId === op.groupId);
        if (!inv) return fail('That invite has expired');
        this.invites.set(p.id, list.filter((i) => i !== inv));
        if (op.op === 'decline') return;
        const g = this.groups.get(inv.groupId);
        if (!g) return fail('That group no longer exists');
        if (this.groupOf(p)) return fail('Leave your group first');
        if (g.members.size >= GROUPS.maxMembers) return fail('That group is full');
        g.members.set(p.id, p.username);
        p.record.groupId = g.id;
        this.invites.delete(p.id);
        void this.repo.setMembership(p.id, g.id);
        this.broadcastState(g);
        this.tellGroup(g, `${p.username} joined the group`);
        return;
      }
      case 'leave': {
        const g = this.groupOf(p);
        if (!g) return;
        this.removeMember(g, p.id);
        p.socket.emit('groupState', null);
        this.send(p, { channel: 'system', from: null, text: `You left "${g.name}"` });
        if (this.groups.has(g.id)) this.tellGroup(g, `${p.username} left the group`);
        return;
      }
      case 'kick': {
        const g = this.groupOf(p);
        if (!g || g.leaderId !== p.id) return fail('Only the group leader can do that');
        if (op.playerId === p.id || !g.members.has(op.playerId)) return;
        const name = g.members.get(op.playerId)!;
        this.removeMember(g, op.playerId);
        const target = this.online(op.playerId);
        if (target) {
          target.socket.emit('groupState', null);
          this.send(target, { channel: 'system', from: null, text: `You were removed from "${g.name}"` });
        }
        this.tellGroup(g, `${name} was removed from the group`);
        return;
      }
      case 'promote': {
        const g = this.groupOf(p);
        if (!g || g.leaderId !== p.id) return fail('Only the group leader can do that');
        if (!g.members.has(op.playerId)) return;
        g.leaderId = op.playerId;
        void this.repo.setLeader(g.id, op.playerId);
        this.broadcastState(g);
        this.tellGroup(g, `${g.members.get(op.playerId)} is now the leader`);
        return;
      }
    }
  }

  /** Remove a member (online or not); hand over leadership or disband if needed. */
  private removeMember(g: LiveGroup, playerId: string): void {
    g.members.delete(playerId);
    const online = this.online(playerId);
    if (online) online.record.groupId = null;
    void this.repo.setMembership(playerId, null);
    if (g.members.size === 0) {
      this.groups.delete(g.id);
      void this.repo.delete(g.id);
      return;
    }
    if (g.leaderId === playerId) {
      // Prefer someone who's online.
      const next = this.onlineMembers(g)[0]?.id ?? [...g.members.keys()][0];
      g.leaderId = next;
      void this.repo.setLeader(g.id, next);
    }
    this.broadcastState(g);
  }

  // ------------------------------------------------------------------ teammate positions

  update(now: number): void {
    if (now - this.lastTeammates < GROUPS.teammateUpdateMs) return;
    this.lastTeammates = now;
    for (const g of this.groups.values()) {
      const online = this.onlineMembers(g);
      if (online.length < 2) continue;
      const all: TeammatePos[] = online.map((m) => ({
        id: m.id,
        name: m.username,
        p: [r1(m.state.pos.x), r1(m.state.pos.y), r1(m.state.pos.z)],
        hp: Math.round((m.record.stats.health / SURVIVAL.health.max) * 100) / 100,
        alive: m.alive,
      }));
      for (const m of online) m.socket.emit('teammates', all.filter((t) => t.id !== m.id));
    }
  }
}
