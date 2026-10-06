import { INVENTORY } from '../config/inventory';
import { getItemDef } from '../config/items';
import type { Recipe } from '../config/crafting';
import type { Inventory } from '../types/inventory';
import type { ItemStack } from '../types/item';

/**
 * Pure inventory rules shared by server (authority) and client (display / weight preview).
 * Functions mutate the slot arrays they're given; the server is the only caller that
 * mutates real state. Every stack keeps a unique uid; splits get a fresh one.
 */
export type Slots = (ItemStack | null)[];
export type UidFactory = () => string;
export type OpResult = { ok: true } | { ok: false; reason: string };

const OK: OpResult = { ok: true };
const fail = (reason: string): OpResult => ({ ok: false, reason });

export const unitWeight = (defId: string): number => getItemDef(defId)?.weight ?? 0;
export const stackWeight = (s: ItemStack | null): number => (s ? unitWeight(s.defId) * s.qty : 0);
export const totalWeight = (slots: Slots): number => slots.reduce((w, s) => w + stackWeight(s), 0);
export const maxStackOf = (defId: string): number => getItemDef(defId)?.maxStack ?? 1;

/** Stackable items never carry per-instance state (durability, loaded ammo). */
export const canMerge = (a: ItemStack, b: ItemStack): boolean => a.defId === b.defId && maxStackOf(a.defId) > 1;

export const createInventory = (): Inventory => ({
  slots: Array.from({ length: INVENTORY.slots }, () => null),
  activeHotbar: 0,
  equipment: { head: null, body: null },
});

/** Repair inventories loaded from storage: right slot count, known items, sane quantities. */
export const normalizeInventory = (inv: Partial<Inventory> | null | undefined): Inventory => {
  const out = createInventory();
  const src = Array.isArray(inv?.slots) ? inv!.slots : [];
  for (let i = 0; i < out.slots.length && i < src.length; i++) {
    const s = src[i];
    if (!s || typeof s.defId !== 'string' || !getItemDef(s.defId)) continue;
    const qty = Math.floor(Number(s.qty));
    if (!(qty > 0)) continue;
    out.slots[i] = { ...s, qty: Math.min(qty, maxStackOf(s.defId)) };
  }
  const hb = Math.floor(Number(inv?.activeHotbar));
  out.activeHotbar = hb >= 0 && hb < INVENTORY.hotbarSize ? hb : 0;
  for (const slot of ['head', 'body'] as const) {
    const s = inv?.equipment?.[slot];
    if (s && typeof s.defId === 'string' && getItemDef(s.defId)?.armor?.slot === slot) out.equipment![slot] = { ...s, qty: 1 };
  }
  return out;
};

export const cloneSlots = (slots: Slots): Slots => slots.map((s) => (s ? { ...s } : null));

/** How many units of defId fit under a weight cap (Infinity when uncapped / weightless). */
const unitsUnderWeight = (slots: Slots, defId: string, maxWeight: number | undefined): number => {
  if (maxWeight === undefined) return Infinity;
  const w = unitWeight(defId);
  if (w <= 0) return Infinity;
  return Math.max(0, Math.floor((maxWeight - totalWeight(slots) + 1e-9) / w));
};

/**
 * Insert up to `qty` units of `stack` into slots: top up matching stacks first, then empty
 * slots in index order. Returns how many units were inserted. The source stack is not modified.
 */
export const insertStack = (
  slots: Slots,
  stack: ItemStack,
  qty: number,
  makeUid: UidFactory,
  maxWeight?: number,
): number => {
  let remaining = Math.min(qty, unitsUnderWeight(slots, stack.defId, maxWeight));
  const start = remaining;
  const max = maxStackOf(stack.defId);
  if (max > 1) {
    for (let i = 0; i < slots.length && remaining > 0; i++) {
      const s = slots[i];
      if (s && canMerge(s, stack) && s.qty < max) {
        const add = Math.min(remaining, max - s.qty);
        s.qty += add;
        remaining -= add;
      }
    }
  }
  let usedOriginalUid = false;
  for (let i = 0; i < slots.length && remaining > 0; i++) {
    if (slots[i]) continue;
    const put = Math.min(remaining, max);
    const uid: string = !usedOriginalUid && put === stack.qty ? stack.uid : makeUid();
    usedOriginalUid ||= uid === stack.uid;
    slots[i] = { ...stack, uid, qty: put };
    remaining -= put;
  }
  return start - remaining;
};

export interface MoveOpts {
  makeUid: UidFactory;
  /** Weight caps; undefined = unlimited (world containers). */
  srcMaxWeight?: number;
  dstMaxWeight?: number;
}

/**
 * Move `qty` (default: whole stack) from src[si] to dst[di]. di = -1 means "auto place".
 * Handles merge, split into an empty slot, and swap (whole stacks only).
 * src and dst may be the same array.
 */
export const moveItem = (src: Slots, si: number, dst: Slots, di: number, qty: number | undefined, o: MoveOpts): OpResult => {
  const item = src[si];
  if (!item) return fail('Nothing there');
  if (di !== -1 && (di < 0 || di >= dst.length)) return fail('Bad slot');
  const n = Math.max(1, Math.min(item.qty, Math.floor(qty ?? item.qty)));
  const crossing = src !== dst;
  const dstCap = crossing ? o.dstMaxWeight : undefined;

  if (di === -1) {
    const moved = insertStack(dst, item, n, o.makeUid, dstCap);
    if (moved === 0) return fail(dstCap !== undefined && unitsUnderWeight(dst, item.defId, dstCap) === 0 ? 'Too heavy' : 'No space');
    item.qty -= moved;
    if (item.qty <= 0) src[si] = null;
    return OK;
  }
  if (!crossing && si === di) return OK;

  const target = dst[di];
  if (!target) {
    const allowed = Math.min(n, unitsUnderWeight(dst, item.defId, dstCap));
    if (allowed <= 0) return fail('Too heavy');
    if (allowed === item.qty) {
      dst[di] = item;
      src[si] = null;
    } else {
      dst[di] = { ...item, uid: o.makeUid(), qty: allowed };
      item.qty -= allowed;
    }
    return OK;
  }

  if (canMerge(target, item)) {
    const room = maxStackOf(item.defId) - target.qty;
    const add = Math.min(n, room, unitsUnderWeight(dst, item.defId, dstCap));
    if (room <= 0) return fail('Stack is full');
    if (add <= 0) return fail('Too heavy');
    target.qty += add;
    item.qty -= add;
    if (item.qty <= 0) src[si] = null;
    return OK;
  }

  // Swap different items (whole stacks only).
  if (n !== item.qty) return fail('Slot is taken');
  if (crossing) {
    const dw = stackWeight(item) - stackWeight(target);
    if (o.dstMaxWeight !== undefined && dw > 0 && totalWeight(dst) + dw > o.dstMaxWeight + 1e-9) return fail('Too heavy');
    if (o.srcMaxWeight !== undefined && -dw > 0 && totalWeight(src) - dw > o.srcMaxWeight + 1e-9) return fail('Too heavy');
  }
  dst[di] = item;
  src[si] = target;
  return OK;
};

export const countItem = (slots: Slots, defId: string): number =>
  slots.reduce((n, s) => n + (s && s.defId === defId ? s.qty : 0), 0);

/** Remove qty units of defId, taking from the last slots first. Returns false (and changes nothing) if short. */
export const removeItem = (slots: Slots, defId: string, qty: number): boolean => {
  if (countItem(slots, defId) < qty) return false;
  let left = qty;
  for (let i = slots.length - 1; i >= 0 && left > 0; i--) {
    const s = slots[i];
    if (!s || s.defId !== defId) continue;
    const take = Math.min(left, s.qty);
    s.qty -= take;
    left -= take;
    if (s.qty <= 0) slots[i] = null;
  }
  return true;
};

export const canCraft = (slots: Slots, r: Recipe): boolean => r.inputs.every((i) => countItem(slots, i.item) >= i.qty);

/** Craft atomically: either everything succeeds or slots are untouched. */
export const craft = (slots: Slots, r: Recipe, maxWeight: number, makeUid: UidFactory): OpResult => {
  if (!canCraft(slots, r)) return fail('Missing materials');
  const trial = cloneSlots(slots);
  for (const i of r.inputs) removeItem(trial, i.item, i.qty);
  const out: ItemStack = { uid: makeUid(), defId: r.output.item, qty: r.output.qty };
  const def = getItemDef(r.output.item);
  if (def?.maxDurability) out.durability = def.maxDurability;
  if (insertStack(trial, out, out.qty, makeUid, maxWeight) < out.qty) {
    return fail(totalWeight(trial) + stackWeight(out) > maxWeight ? 'Too heavy' : 'No space');
  }
  for (let k = 0; k < slots.length; k++) slots[k] = trial[k];
  return OK;
};
