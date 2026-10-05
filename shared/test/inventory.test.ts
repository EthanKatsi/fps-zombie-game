import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INVENTORY,
  ITEMS,
  LOOT_TABLES,
  RECIPES,
  countItem,
  craft,
  createInventory,
  generateCity,
  getRecipe,
  insertStack,
  moveItem,
  mulberry32,
  normalizeInventory,
  resolveLootTable,
  rollLoot,
  totalWeight,
  type ItemStack,
  type Slots,
} from '../src/index';

let n = 0;
const uid = () => `u${++n}`;
const item = (defId: string, qty = 1): ItemStack => ({ uid: uid(), defId, qty });
const empty = (k: number): Slots => Array.from({ length: k }, () => null);

test('every loot entry, recipe and starting item refers to a real item', () => {
  for (const [id, t] of Object.entries(LOOT_TABLES)) {
    for (const e of t.entries) assert.ok(ITEMS[e.item], `${id} -> ${e.item}`);
  }
  for (const r of RECIPES) {
    for (const i of [...r.inputs, r.output]) assert.ok(ITEMS[i.item], `recipe ${r.id} -> ${i.item}`);
  }
  for (const k of INVENTORY.startingKit) assert.ok(ITEMS[k.item]);
});

test('every container in the city resolves to a loot table', () => {
  const city = generateCity(1337);
  const ids = new Set(city.containers.map((c) => c.lootTable));
  for (const id of ids) assert.ok(resolveLootTable(id), id);
  // Shops should hit their specific tables, not the generic fallback.
  assert.equal(resolveLootTable('grocery_shelf'), LOOT_TABLES.grocery_shelf);
  assert.equal(resolveLootTable('apartment_fridge'), LOOT_TABLES.house_fridge);
  assert.equal(resolveLootTable('house_crate'), LOOT_TABLES.any_crate);
});

test('insert merges stacks before using empty slots and respects max stack', () => {
  const slots = empty(4);
  slots[2] = item('nails', 90);
  const inserted = insertStack(slots, item('nails', 30), 30, uid);
  assert.equal(inserted, 30);
  assert.equal(slots[2]!.qty, 100);
  assert.equal(slots[0]!.qty, 20);
});

test('insert stops at the weight cap', () => {
  const slots = empty(10);
  const planks = item('wood_plank', 10); // 1 kg each
  const inserted = insertStack(slots, planks, 10, uid, 4.5);
  assert.equal(inserted, 4);
  assert.ok(totalWeight(slots) <= 4.5);
});

test('move: split into an empty slot, merge, and swap', () => {
  const a = empty(3);
  const b = empty(3);
  a[0] = item('bandage', 6);
  assert.ok(moveItem(a, 0, b, 1, 2, { makeUid: uid }).ok);
  assert.equal(a[0]!.qty, 4);
  assert.equal(b[1]!.qty, 2);
  assert.notEqual(a[0]!.uid, b[1]!.uid, 'split gets a new uid');

  assert.ok(moveItem(a, 0, b, 1, undefined, { makeUid: uid }).ok);
  assert.equal(a[0], null);
  assert.equal(b[1]!.qty, 6);

  a[2] = item('bat');
  assert.ok(moveItem(a, 2, b, 1, undefined, { makeUid: uid }).ok);
  assert.equal(a[2]!.defId, 'bandage');
  assert.equal(b[1]!.defId, 'bat');
});

test('move: cannot exceed the destination weight cap, partial stacks allowed', () => {
  const container = empty(4);
  const player = empty(4);
  container[0] = item('wood_plank', 10);
  player[0] = item('axe'); // 2.2 kg
  const r = moveItem(container, 0, player, -1, undefined, { makeUid: uid, dstMaxWeight: 5 });
  assert.ok(r.ok);
  assert.equal(countItem(player, 'wood_plank'), 2);
  assert.equal(container[0]!.qty, 8);
  const r2 = moveItem(container, 0, player, -1, undefined, { makeUid: uid, dstMaxWeight: 5 });
  assert.deepEqual(r2, { ok: false, reason: 'Too heavy' });
});

test('move: swap that would overload the player is refused', () => {
  const container = empty(2);
  const player = empty(2);
  container[0] = item('rifle'); // 4 kg
  player[0] = item('bandage'); // 0.05
  const r = moveItem(container, 0, player, 0, undefined, { makeUid: uid, dstMaxWeight: 3 });
  assert.equal(r.ok, false);
  assert.equal(player[0]!.defId, 'bandage');
});

test('crafting consumes inputs atomically', () => {
  const slots = empty(5);
  slots[0] = item('wood_plank', 4);
  slots[1] = item('nails', 12);
  const r = craft(slots, getRecipe('barricade')!, 30, uid);
  assert.ok(r.ok);
  assert.equal(countItem(slots, 'wood_plank'), 1);
  assert.equal(countItem(slots, 'nails'), 2);
  assert.equal(countItem(slots, 'barricade'), 1);
  const again = craft(slots, getRecipe('barricade')!, 30, uid);
  assert.equal(again.ok, false);
  assert.equal(countItem(slots, 'wood_plank'), 1, 'failed craft changes nothing');
});

test('loot rolls are deterministic per rng and fit the container', () => {
  const a = rollLoot('gunshop_cabinet', 6, mulberry32(5), uid);
  const b = rollLoot('gunshop_cabinet', 6, mulberry32(5), uid);
  assert.deepEqual(a.map((s) => s && [s.defId, s.qty]), b.map((s) => s && [s.defId, s.qty]));
  assert.equal(a.length, 6);
  let any = 0;
  const rand = mulberry32(9);
  for (let i = 0; i < 200; i++) any += rollLoot('grocery_shelf', 8, rand, uid).filter(Boolean).length;
  assert.ok(any > 100, 'grocery shelves usually have something');
});

test('normalize repairs bad saved inventories', () => {
  const inv = normalizeInventory({ slots: [item('ghost_item'), { ...item('bandage'), qty: 999 }, null], activeHotbar: 42 });
  assert.equal(inv.slots.length, INVENTORY.slots);
  assert.equal(inv.slots[0], null);
  assert.equal(inv.slots[1]!.qty, 10);
  assert.equal(inv.activeHotbar, 0);
  assert.equal(createInventory().slots.length, INVENTORY.slots);
});
