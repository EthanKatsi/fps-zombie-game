import type { World } from '@dimforge/rapier3d-compat';
import {
  ContainerIndex,
  INVENTORY,
  PLAYER_GROUPS,
  craft,
  eyeHeight,
  getItemDef,
  getRecipe,
  insertStack,
  moveItem,
  type InventoryOp,
  type MapData,
  type Rapier,
  type Slots,
  type SlotRef,
  type Vec3,
} from '@grey/shared';
import { ContainerSystem, makeUid, type WorldContainer } from './ContainerSystem';
import { GroundItems } from './GroundItems';
import type { ServerPlayer } from './ServerPlayer';

const isIndex = (n: unknown, len: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= -1 && n < len;

/**
 * Server-authoritative items: inventory operations, world containers, ground items, crafting.
 * Every request is validated (ownership, range, line of sight, weight) before anything changes.
 */
export class InventorySystem {
  readonly containers: ContainerSystem;
  readonly ground = new GroundItems();

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    private readonly map: MapData,
    private readonly players: () => Iterable<ServerPlayer>,
  ) {
    this.containers = new ContainerSystem(map.containers);
  }

  // ------------------------------------------------------------------ helpers

  private eye(p: ServerPlayer): Vec3 {
    const s = p.state;
    return { x: s.pos.x, y: s.pos.y + eyeHeight(s.crouching), z: s.pos.z };
  }

  private notice(p: ServerPlayer, text: string): void {
    p.socket.emit('notice', { text });
  }

  sendInventory(p: ServerPlayer): void {
    p.socket.emit('inventory', p.inventory);
  }

  /** First thing a ray from the eye towards `to` hits (or null if nothing within the distance). */
  private rayHit(from: Vec3, to: Vec3): { x: number; y: number; z: number; toi: number; dist: number } | null {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const dist = Math.hypot(dx, dy, dz);
    if (dist < 1e-4) return null;
    const ray = new this.R.Ray(from, { x: dx / dist, y: dy / dist, z: dz / dist });
    const hit = this.world.castRay(ray, dist, true, undefined, PLAYER_GROUPS);
    if (!hit) return null;
    const t = hit.timeOfImpact;
    return { x: from.x + (dx / dist) * t, y: from.y + (dy / dist) * t, z: from.z + (dz / dist) * t, toi: t, dist };
  }

  /** Distance from a point to a container's box (0 inside). */
  private distToContainer(c: WorldContainer, p: Vec3): number {
    const s = c.spawn?.s;
    if (!s) return Math.hypot(p.x - c.pos.x, p.y - c.pos.y, p.z - c.pos.z);
    const dx = Math.max(0, Math.abs(p.x - c.pos.x) - s[0] / 2);
    const dy = Math.max(0, Math.abs(p.y - c.pos.y) - s[1] / 2);
    const dz = Math.max(0, Math.abs(p.z - c.pos.z) - s[2] / 2);
    return Math.hypot(dx, dy, dz);
  }

  /** Range + line of sight: the first thing the eye ray hits must be the container itself. */
  private canReachContainer(p: ServerPlayer, c: WorldContainer): boolean {
    const eye = this.eye(p);
    const slack = c.spawn?.s ? 0.6 : 1.6;
    if (this.distToContainer(c, eye) > INVENTORY.useRange + slack) return false;
    if (!c.spawn) return true;
    const hit = this.rayHit(eye, c.pos);
    return hit === null || ContainerIndex.contains(c.spawn, hit.x, hit.y, hit.z, 0.12);
  }

  private resolveSlots(p: ServerPlayer, owner: string): { slots: Slots; container: WorldContainer | null } | null {
    if (owner === 'self') return { slots: p.inventory.slots, container: null };
    const c = p.openContainer;
    if (!c || c.key !== owner) return null;
    return { slots: c.slots, container: c };
  }

  // ------------------------------------------------------------------ requests

  openMapContainer(p: ServerPlayer, id: number): void {
    if (!Number.isInteger(id)) return;
    const c = this.containers.getMapContainer(id, performance.now());
    if (!c) return;
    if (!this.canReachContainer(p, c)) return;
    this.containers.open(p, c);
  }

  closeContainer(p: ServerPlayer): void {
    this.containers.close(p);
  }

  pickup(p: ServerPlayer, id: string): void {
    const g = typeof id === 'string' ? this.ground.items.get(id) : undefined;
    if (!g) return;
    const eye = this.eye(p);
    const target = { x: g.pos.x, y: g.pos.y + 0.1, z: g.pos.z };
    if (Math.hypot(target.x - eye.x, target.y - eye.y, target.z - eye.z) > INVENTORY.useRange + 0.5) return;
    const hit = this.rayHit(eye, target);
    if (hit && hit.toi < hit.dist - 0.3) return; // something in the way
    const moved = insertStack(p.inventory.slots, g.stack, g.stack.qty, makeUid, INVENTORY.maxCarryWeight);
    if (moved === 0) {
      this.notice(p, 'Too heavy or no space');
      return;
    }
    g.stack.qty -= moved;
    if (g.stack.qty <= 0) this.ground.remove(g.id, this.players());
    else {
      this.ground.changed(g, this.players());
      this.notice(p, 'Could not carry it all');
    }
    this.sendInventory(p);
  }

  handleOp(p: ServerPlayer, op: InventoryOp): void {
    if (!op || typeof op !== 'object') return;
    switch (op.op) {
      case 'select':
        if (isIndex(op.hotbar, INVENTORY.hotbarSize) && op.hotbar >= 0) p.inventory.activeHotbar = op.hotbar;
        return;
      case 'move':
        return this.move(p, op.from, op.to, op.qty);
      case 'drop':
        return this.drop(p, op.from, op.qty);
      case 'craft':
        return this.craft(p, op.recipeId);
      case 'use':
        this.notice(p, 'Using items arrives with survival stats (milestone 4)');
        return;
    }
  }

  private move(p: ServerPlayer, from: SlotRef, to: SlotRef, qty?: number): void {
    if (!from || !to || typeof from.owner !== 'string' || typeof to.owner !== 'string') return;
    const src = this.resolveSlots(p, from.owner);
    const dst = this.resolveSlots(p, to.owner);
    if (!src || !dst) return;
    if (!isIndex(from.index, src.slots.length) || from.index < 0 || !isIndex(to.index, dst.slots.length)) return;
    if (qty !== undefined && !(Number.isInteger(qty) && qty > 0)) return;
    for (const c of [src.container, dst.container]) {
      if (c && !this.canReachContainer(p, c)) {
        this.containers.close(p, true);
        return;
      }
    }
    const res = moveItem(src.slots, from.index, dst.slots, to.index, qty, {
      makeUid,
      srcMaxWeight: src.container ? undefined : INVENTORY.maxCarryWeight,
      dstMaxWeight: dst.container ? undefined : INVENTORY.maxCarryWeight,
    });
    if (!res.ok) this.notice(p, res.reason);
    this.sendInventory(p);
    const c = src.container ?? dst.container;
    if (c) this.containers.broadcast(c);
  }

  private drop(p: ServerPlayer, from: SlotRef, qty?: number): void {
    if (!from || from.owner !== 'self' || !isIndex(from.index, p.inventory.slots.length) || from.index < 0) return;
    const slots = p.inventory.slots;
    const item = slots[from.index];
    if (!item) return;
    const n = qty === undefined ? item.qty : Math.floor(qty);
    if (!(n > 0 && n <= item.qty)) return;

    const pos = this.dropPosition(p);
    const stack = n === item.qty ? item : { ...item, uid: makeUid(), qty: n };
    if (n === item.qty) slots[from.index] = null;
    else item.qty -= n;
    this.ground.spawn(stack, pos, performance.now());
    this.sendInventory(p);
    // Make the drop visible right away instead of waiting for the next interest sync.
    this.ground.sync([...this.players()], performance.now());
  }

  /** In front of the player, pulled back from walls, resting on whatever floor is below. */
  private dropPosition(p: ServerPlayer): Vec3 {
    const eye = this.eye(p);
    const yaw = p.state.yaw;
    let reach = 0.9;
    const ahead = { x: eye.x - Math.sin(yaw) * reach, y: eye.y - 0.4, z: eye.z - Math.cos(yaw) * reach };
    const hit = this.rayHit(eye, ahead);
    if (hit) reach = Math.max(0, hit.toi - 0.3);
    const x = eye.x - Math.sin(yaw) * reach;
    const z = eye.z - Math.cos(yaw) * reach;
    const down = this.rayHit({ x, y: eye.y, z }, { x, y: eye.y - 4, z });
    return { x, y: (down ? down.y : p.state.pos.y) + 0.12, z };
  }

  private craft(p: ServerPlayer, recipeId: string): void {
    const recipe = typeof recipeId === 'string' ? getRecipe(recipeId) : undefined;
    if (!recipe) return;
    const res = craft(p.inventory.slots, recipe, INVENTORY.maxCarryWeight, makeUid);
    if (!res.ok) this.notice(p, res.reason);
    else this.notice(p, `Crafted ${getItemDef(recipe.output.item)?.name ?? recipe.output.item}`);
    this.sendInventory(p);
  }

  // ------------------------------------------------------------------ periodic

  /** Close containers players walked away from; sync ground item interest. */
  update(players: ServerPlayer[], now: number): void {
    for (const p of players) {
      const c = p.openContainer;
      if (c && this.distToContainer(c, this.eye(p)) > INVENTORY.containerCloseDistance) this.containers.close(p, true);
    }
    this.ground.sync(players, now);
  }

  onLeave(p: ServerPlayer): void {
    this.containers.close(p);
  }
}
