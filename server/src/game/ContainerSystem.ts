import {
  CONTAINER_NAMES,
  INVENTORY,
  LOOT,
  rollLoot,
  type ContainerKind,
  type ContainerSpawn,
  type Slots,
  type Vec3,
} from '@grey/shared';
import { randomUUID } from 'node:crypto';
import type { ServerPlayer } from './ServerPlayer';

export interface WorldContainer {
  /** Network key, used as SlotRef.owner. Map containers are 'c<id>'. */
  key: string;
  kind: ContainerKind;
  title: string;
  /** Center of the container (for range checks). */
  pos: Vec3;
  /** Map furniture this container belongs to (for line-of-sight checks); null for dynamic ones. */
  spawn: ContainerSpawn | null;
  lootTable: string | null;
  slots: Slots;
  /** performance.now() ms after which world loot may be re-rolled. */
  respawnAt: number;
  viewers: Set<ServerPlayer>;
}

export const makeUid = (): string => randomUUID();

/**
 * World containers. Map furniture containers are created lazily the first time someone
 * opens them and re-rolled from their loot table once the respawn timer has passed
 * (only while nobody is looking inside).
 */
export class ContainerSystem {
  private readonly containers = new Map<string, WorldContainer>();

  constructor(private readonly spawns: ContainerSpawn[]) {}

  /** Get (and lazily create / refill) a map container by spawn id. */
  getMapContainer(id: number, now: number): WorldContainer | null {
    const spawn = this.spawns[id];
    if (!spawn) return null;
    const key = `c${id}`;
    let c = this.containers.get(key);
    if (!c) {
      c = {
        key,
        kind: spawn.kind,
        title: CONTAINER_NAMES[spawn.kind],
        pos: { x: spawn.p[0], y: spawn.p[1], z: spawn.p[2] },
        spawn,
        lootTable: spawn.lootTable,
        slots: [],
        respawnAt: 0,
        viewers: new Set(),
      };
      this.containers.set(key, c);
    }
    if (c.lootTable && now >= c.respawnAt && c.viewers.size === 0) {
      c.slots = rollLoot(c.lootTable, INVENTORY.containerSlots[c.kind], Math.random, makeUid);
      c.respawnAt = now + LOOT.respawnMinutes * 60_000;
    }
    return c;
  }

  get(key: string): WorldContainer | undefined {
    return this.containers.get(key);
  }

  open(p: ServerPlayer, c: WorldContainer): void {
    this.close(p);
    p.openContainer = c;
    c.viewers.add(p);
    p.socket.emit('containerOpened', { key: c.key, kind: c.kind, title: c.title, slots: c.slots });
  }

  close(p: ServerPlayer, notify = false): void {
    const c = p.openContainer;
    if (!c) return;
    c.viewers.delete(p);
    p.openContainer = null;
    if (notify) p.socket.emit('containerClosed', { key: c.key });
  }

  broadcast(c: WorldContainer): void {
    for (const v of c.viewers) v.socket.emit('containerUpdate', { key: c.key, slots: c.slots });
  }
}
