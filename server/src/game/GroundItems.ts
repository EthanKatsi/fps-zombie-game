import { INVENTORY, type GroundItemNet, type ItemStack, type Vec3 } from '@grey/shared';
import { randomUUID } from 'node:crypto';
import type { ServerPlayer } from './ServerPlayer';

export interface GroundItem {
  id: string;
  stack: ItemStack;
  pos: Vec3;
  rot: number;
  despawnAt: number;
}

const toNet = (g: GroundItem): GroundItemNet => ({
  id: g.id,
  defId: g.stack.defId,
  qty: g.stack.qty,
  p: [Math.round(g.pos.x * 100) / 100, Math.round(g.pos.y * 100) / 100, Math.round(g.pos.z * 100) / 100],
  rot: Math.round(g.rot * 100) / 100,
});

/**
 * Items lying in the world, with interest management: each player only knows about
 * items within INVENTORY.groundItemViewRadius, and gets add/remove deltas as they move.
 */
export class GroundItems {
  readonly items = new Map<string, GroundItem>();

  spawn(stack: ItemStack, pos: Vec3, now: number): GroundItem {
    const g: GroundItem = {
      id: randomUUID().slice(0, 12),
      stack,
      pos: { ...pos },
      rot: Math.random() * Math.PI * 2,
      despawnAt: now + INVENTORY.groundItemDespawnMin * 60_000,
    };
    this.items.set(g.id, g);
    return g;
  }

  remove(id: string, players: Iterable<ServerPlayer>): void {
    if (!this.items.delete(id)) return;
    for (const p of players) {
      if (p.knownGround.delete(id)) p.socket.emit('groundItems', { add: [], remove: [id] });
    }
  }

  /** Quantity changed (partial pickup): re-send to everyone who knows it. */
  changed(g: GroundItem, players: Iterable<ServerPlayer>): void {
    for (const p of players) if (p.knownGround.has(g.id)) p.socket.emit('groundItems', { add: [toNet(g)], remove: [] });
  }

  /** Despawn old items and send each player their add/remove delta. */
  sync(players: ServerPlayer[], now: number): void {
    for (const g of [...this.items.values()]) if (now >= g.despawnAt) this.remove(g.id, players);

    const r2 = INVENTORY.groundItemViewRadius ** 2;
    for (const p of players) {
      const add: GroundItemNet[] = [];
      const visible = new Set<string>();
      const me = p.state.pos;
      for (const g of this.items.values()) {
        const dx = g.pos.x - me.x;
        const dz = g.pos.z - me.z;
        if (dx * dx + dz * dz > r2) continue;
        visible.add(g.id);
        if (!p.knownGround.has(g.id)) add.push(toNet(g));
      }
      const remove = [...p.knownGround].filter((id) => !visible.has(id));
      if (add.length || remove.length) {
        p.knownGround = visible;
        p.socket.emit('groundItems', { add, remove });
      }
    }
  }
}
