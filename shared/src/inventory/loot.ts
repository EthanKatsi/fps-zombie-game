import { getItemDef } from '../config/items';
import { LOOT, resolveLootTable } from '../config/loot';
import { getWeaponDef } from '../config/weapons';
import type { ItemStack } from '../types/item';
import { insertStack, type Slots, type UidFactory } from './inventory';

const randInt = (rand: () => number, [a, b]: [number, number]): number => a + Math.floor(rand() * (b - a + 1));

/** Create one rolled item stack (durability randomized for weapons/tools). */
export const makeItem = (defId: string, qty: number, makeUid: UidFactory, rand: () => number): ItemStack | null => {
  const def = getItemDef(defId);
  if (!def) return null;
  const s: ItemStack = { uid: makeUid(), defId, qty };
  if (def.maxDurability) {
    const [lo, hi] = LOOT.durability;
    s.durability = Math.max(1, Math.round(def.maxDurability * (lo + (hi - lo) * rand())));
  }
  // Gas cans are often empty; the rest hold some fuel.
  if (def.fuelCan) s.fuel = rand() < 0.35 ? 0 : Math.round(def.fuelCan.liters * (0.3 + 0.7 * rand()));
  const mag = getWeaponDef(def.weaponId)?.magazineSize;
  if (mag) {
    const [lo, hi] = LOOT.loadedFraction;
    s.loadedAmmo = Math.round(mag * (lo + (hi - lo) * rand()));
  }
  return s;
};

/** Fill a fresh slot array from a loot table id (with fallbacks). */
export const rollLoot = (tableId: string, slotCount: number, rand: () => number, makeUid: UidFactory): Slots => {
  const slots: Slots = Array.from({ length: slotCount }, () => null);
  const t = resolveLootTable(tableId);
  if (rand() < t.empty) return slots;
  const total = t.entries.reduce((a, e) => a + e.w, 0);
  const rolls = randInt(rand, t.rolls);
  for (let r = 0; r < rolls; r++) {
    let x = rand() * total;
    const entry = t.entries.find((e) => (x -= e.w) < 0) ?? t.entries[t.entries.length - 1];
    const qty = randInt(rand, entry.qty ?? [1, 1]);
    const stack = makeItem(entry.item, qty, makeUid, rand);
    if (stack) insertStack(slots, stack, qty, makeUid);
  }
  return slots;
};
