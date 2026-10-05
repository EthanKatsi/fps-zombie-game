import {
  INVENTORY,
  SURVIVAL,
  createMoveState,
  getItemDef,
  insertStack,
  makeItem,
  type DeathCause,
  type Inventory,
  type NetStats,
  type Vec3,
} from '@grey/shared';
import { makeUid } from './ContainerSystem';
import type { InventorySystem } from './InventorySystem';
import type { ServerPlayer } from './ServerPlayer';

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

export const netStats = (p: ServerPlayer): NetStats => {
  const s = p.record.stats;
  return {
    health: Math.round(s.health * 10) / 10,
    hunger: Math.round(s.hunger * 10) / 10,
    thirst: Math.round(s.thirst * 10) / 10,
    bleeding: s.bleeding,
  };
};

/** Fill a fresh inventory with the starting kit. */
export const giveStartingKit = (p: { inventory: Inventory }): void => {
  for (const k of INVENTORY.startingKit) {
    const stack = makeItem(k.item, k.qty, makeUid, Math.random);
    if (stack) insertStack(p.inventory.slots, stack, k.qty, makeUid);
  }
};

/**
 * Server-side survival: hunger/thirst drain, starvation, bleeding, fall damage, regen,
 * consumables, death (inventory -> loot bag) and respawn. All damage in the game goes
 * through `damage()` so zombies and PvP plug into the same death flow later.
 */
export class SurvivalSystem {
  /** Last stats sent per player, to only send changes. */
  private readonly lastSent = new WeakMap<ServerPlayer, string>();

  constructor(
    private readonly items: InventorySystem,
    private readonly randomSpawn: () => { pos: Vec3; yaw: number },
  ) {}

  /** Per-tick update. */
  update(players: Iterable<ServerPlayer>, dt: number, now: number): void {
    for (const p of players) {
      if (!p.alive) continue;
      const s = p.record.stats;
      const sprint = p.state.sprinting;
      const H = SURVIVAL.hunger;
      const T = SURVIVAL.thirst;
      s.hunger = Math.max(0, s.hunger - (H.drainPerMin / 60) * dt * (sprint ? H.sprintMultiplier : 1));
      s.thirst = Math.max(0, s.thirst - (T.drainPerMin / 60) * dt * (sprint ? T.sprintMultiplier : 1));

      if (s.hunger <= 0) this.damage(p, H.starvingDamagePerSec * dt, 'starvation', null, true);
      if (p.alive && s.thirst <= 0) this.damage(p, T.dehydratedDamagePerSec * dt, 'dehydration', null, true);
      if (p.alive && s.bleeding) this.damage(p, SURVIVAL.bleeding.damagePerSec * dt, 'bleeding', null, true);
      if (!p.alive) continue;

      const hp = SURVIVAL.health;
      if (!s.bleeding && s.hunger >= hp.regenMinHunger && s.thirst >= hp.regenMinThirst && s.health < hp.max) {
        s.health = Math.min(hp.max, s.health + hp.regenPerSec * dt);
      }
      this.updateUse(p, now);
    }
  }

  /** Send stats to players whose rounded values changed (call a few times per second). */
  flushStats(players: Iterable<ServerPlayer>): void {
    for (const p of players) this.sendStats(p);
  }

  sendStats(p: ServerPlayer, force = false): void {
    const n = netStats(p);
    const key = `${Math.ceil(n.health)}|${Math.ceil(n.hunger)}|${Math.ceil(n.thirst)}|${n.bleeding}`;
    if (!force && this.lastSent.get(p) === key) return;
    this.lastSent.set(p, key);
    p.socket.emit('stats', n);
  }

  // ------------------------------------------------------------------ damage & death

  /**
   * Apply damage. `quiet` skips the hit-flash event (used for slow per-tick drains).
   * attacker = the killing player for PvP (milestone 7).
   */
  damage(p: ServerPlayer, amount: number, cause: DeathCause, attacker: ServerPlayer | null = null, quiet = false): void {
    if (!p.alive || !(amount > 0)) return;
    const s = p.record.stats;
    s.health = Math.max(0, s.health - amount);
    if (!quiet) p.socket.emit('damaged', { amount: Math.round(amount), cause });
    if (s.health <= 0) this.kill(p, cause, attacker);
  }

  /** Landing after a fall. */
  onLand(p: ServerPlayer, impactSpeed: number): void {
    const f = SURVIVAL.fall;
    if (impactSpeed <= f.minImpactSpeed) return;
    const dmg = (impactSpeed - f.minImpactSpeed) * f.damagePerSpeed;
    if (dmg >= f.bleedAtDamage) p.record.stats.bleeding = true;
    this.damage(p, dmg, 'fall');
  }

  kill(p: ServerPlayer, cause: DeathCause, attacker: ServerPlayer | null): void {
    if (!p.alive) return;
    const now = performance.now();
    p.alive = false;
    p.diedAt = now;
    p.using = null;
    p.record.stats.health = 0;
    p.record.stats.bleeding = false;
    p.record.deaths++;
    if (attacker) attacker.record.kills++;
    this.items.dropDeathBag(p, now);
    this.items.sendInventory(p);
    this.sendStats(p, true);
    p.socket.emit('died', {
      cause,
      killer: attacker?.username ?? null,
      respawnInMs: SURVIVAL.respawn.delaySec * 1000,
    });
  }

  /** Respawn request from a dead player (after the delay). */
  respawn(p: ServerPlayer): void {
    if (p.alive) return;
    if (performance.now() - p.diedAt < SURVIVAL.respawn.delaySec * 1000 - 50) return;
    this.reviveAt(p, this.randomSpawn());
    p.socket.emit('respawned', { state: p.state, inventory: p.inventory, stats: netStats(p) });
  }

  /** Reset a player to a fresh life at a spawn point (also used on join after dying offline). */
  reviveAt(p: ServerPlayer, spawn: { pos: Vec3; yaw: number }): void {
    const s = p.record.stats;
    s.health = SURVIVAL.health.max;
    s.hunger = SURVIVAL.respawn.hunger;
    s.thirst = SURVIVAL.respawn.thirst;
    s.bleeding = false;
    p.alive = true;
    p.state = createMoveState(spawn.pos, spawn.yaw);
    p.motor.syncCollider(p.state);
    p.inventory.slots = p.inventory.slots.map(() => null);
    giveStartingKit(p);
    this.sendStats(p, true);
  }

  // ------------------------------------------------------------------ consumables

  startUse(p: ServerPlayer, slot: number): void {
    if (!p.alive || p.using) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= p.inventory.slots.length) return;
    const item = p.inventory.slots[slot];
    const def = item && getItemDef(item.defId);
    if (!item || !def?.consume) return;
    const s = p.record.stats;
    const c = def.consume;
    // Don't waste items that would do nothing.
    const useful =
      (c.health && s.health < SURVIVAL.health.max) ||
      (c.hunger && c.hunger > 0 && s.hunger < SURVIVAL.hunger.max) ||
      (c.thirst && c.thirst > 0 && s.thirst < SURVIVAL.thirst.max) ||
      (c.stopsBleeding && s.bleeding);
    if (!useful) {
      p.socket.emit('notice', { text: `You don't need that right now` });
      return;
    }
    p.using = { slot, uid: item.uid, defId: item.defId, endsAt: performance.now() + c.useTimeMs };
    p.socket.emit('useStarted', { defId: item.defId, durationMs: c.useTimeMs });
  }

  cancelUse(p: ServerPlayer): void {
    if (!p.using) return;
    p.using = null;
    p.socket.emit('useEnded', { completed: false });
  }

  private updateUse(p: ServerPlayer, now: number): void {
    const u = p.using;
    if (!u) return;
    const item = p.inventory.slots[u.slot];
    // Cancelled by sprinting, or the item was moved / dropped meanwhile.
    if (p.state.sprinting || !item || item.uid !== u.uid) return this.cancelUse(p);
    if (now < u.endsAt) return;

    const c = getItemDef(u.defId)!.consume!;
    const s = p.record.stats;
    if (c.health) s.health = clamp(s.health + c.health, 0, SURVIVAL.health.max);
    if (c.hunger) s.hunger = clamp(s.hunger + c.hunger, 0, SURVIVAL.hunger.max);
    if (c.thirst) s.thirst = clamp(s.thirst + c.thirst, 0, SURVIVAL.thirst.max);
    if (c.stopsBleeding) s.bleeding = false;
    item.qty -= 1;
    if (item.qty <= 0) p.inventory.slots[u.slot] = null;
    p.using = null;
    p.socket.emit('useEnded', { completed: true });
    this.items.sendInventory(p);
    this.sendStats(p, true);
  }
}
