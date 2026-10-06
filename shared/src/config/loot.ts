/**
 * Loot tables. A container's table id is `<buildingType>_<containerKind>` (e.g. 'grocery_shelf',
 * 'police_locker') or 'street_car_trunk'. Lookup falls back:
 *   exact id -> alias building type (apartment -> house) -> 'any_<kind>' -> 'default'.
 *
 * Each table: number of rolls, chance the container is empty, and weighted entries.
 */
export interface LootEntry {
  item: string;
  /** Relative weight. */
  w: number;
  /** Quantity range per roll (inclusive). Default 1. */
  qty?: [number, number];
}

export interface LootTable {
  rolls: [number, number];
  /** Chance (0-1) that the container is completely empty. */
  empty: number;
  entries: LootEntry[];
}

export const LOOT = {
  /** Minutes before a looted container can refill. */
  respawnMinutes: 20,
  /** Weapons/tools spawn with durability in this fraction range of max. */
  durability: [0.35, 1.0] as [number, number],
  /** Guns spawn with this fraction of a magazine loaded (0 = empty). */
  loadedFraction: [0, 0.6] as [number, number],
};

const FOOD: LootEntry[] = [
  { item: 'canned_beans', w: 5 },
  { item: 'chips', w: 5 },
  { item: 'energy_bar', w: 3 },
  { item: 'soda', w: 4 },
  { item: 'water_bottle', w: 4 },
];

export const BUILDING_ALIASES: Record<string, string> = {
  apartment: 'house',
};

export const LOOT_TABLES: Record<string, LootTable> = {
  // ---------------------------------------------------------------- homes
  house_fridge: { rolls: [1, 3], empty: 0.35, entries: [...FOOD, { item: 'water_bottle', w: 6 }] },
  house_cabinet: {
    rolls: [1, 2], empty: 0.4,
    entries: [
      ...FOOD,
      { item: 'cloth', w: 5, qty: [1, 3] },
      { item: 'bandage', w: 3 },
      { item: 'painkillers', w: 2 },
      { item: 'nails', w: 2, qty: [5, 20] },
      { item: 'flashlight', w: 2 },
      { item: 'ammo_9mm', w: 1, qty: [3, 10] },
    ],
  },
  house_shelf: {
    rolls: [1, 2], empty: 0.5,
    entries: [{ item: 'cloth', w: 4, qty: [1, 2] }, { item: 'flashlight', w: 1 }, { item: 'energy_bar', w: 2 }],
  },
  house_desk: {
    rolls: [1, 1], empty: 0.5,
    entries: [{ item: 'painkillers', w: 3 }, { item: 'energy_bar', w: 3 }, { item: 'ammo_9mm', w: 1, qty: [3, 8] }, { item: 'pistol', w: 0.3 }],
  },

  // ---------------------------------------------------------------- shops
  grocery_shelf: { rolls: [1, 3], empty: 0.3, entries: [...FOOD, { item: 'mre', w: 0.5 }] },
  grocery_fridge: { rolls: [1, 3], empty: 0.3, entries: [{ item: 'water_bottle', w: 6 }, { item: 'soda', w: 6 }] },
  grocery_cabinet: { rolls: [1, 2], empty: 0.3, entries: [{ item: 'energy_bar', w: 4 }, { item: 'chips', w: 3 }, { item: 'cloth', w: 2 }] },
  grocery_crate: { rolls: [2, 4], empty: 0.3, entries: [...FOOD, { item: 'mre', w: 1 }] },

  pharmacy_shelf: {
    rolls: [1, 3], empty: 0.3,
    entries: [{ item: 'bandage', w: 6, qty: [1, 3] }, { item: 'painkillers', w: 5, qty: [1, 2] }, { item: 'medkit', w: 1 }],
  },
  pharmacy_cabinet: { rolls: [1, 2], empty: 0.3, entries: [{ item: 'medkit', w: 2 }, { item: 'painkillers', w: 3 }] },
  pharmacy_crate: { rolls: [2, 3], empty: 0.3, entries: [{ item: 'bandage', w: 5, qty: [2, 4] }, { item: 'medkit', w: 1 }] },

  hardware_shelf: {
    rolls: [1, 3], empty: 0.25,
    entries: [
      { item: 'nails', w: 6, qty: [10, 40] },
      { item: 'wood_plank', w: 5, qty: [1, 3] },
      { item: 'scrap_metal', w: 4, qty: [1, 3] },
      { item: 'flashlight', w: 2 },
      { item: 'crowbar', w: 1.5 },
      { item: 'axe', w: 1 },
      { item: 'machete', w: 0.8 },
    ],
  },
  hardware_crate: { rolls: [2, 4], empty: 0.3, entries: [{ item: 'wood_plank', w: 5, qty: [2, 4] }, { item: 'nails', w: 5, qty: [20, 50] }] },
  hardware_cabinet: { rolls: [1, 2], empty: 0.3, entries: [{ item: 'nails', w: 3, qty: [5, 20] }, { item: 'flashlight', w: 2 }] },

  gunshop_locker: {
    rolls: [1, 2], empty: 0.35,
    entries: [{ item: 'pistol', w: 4 }, { item: 'shotgun', w: 2 }, { item: 'rifle', w: 1.2 }, { item: 'crossbow', w: 1 }, { item: 'assault_rifle', w: 0.7 }, { item: 'sniper_rifle', w: 0.4 }],
  },
  gunshop_cabinet: {
    rolls: [1, 3], empty: 0.25,
    entries: [
      { item: 'ammo_9mm', w: 5, qty: [8, 24] },
      { item: 'ammo_12g', w: 4, qty: [4, 10] },
      { item: 'ammo_556', w: 2, qty: [5, 15] },
      { item: 'ammo_308', w: 1.2, qty: [3, 10] },
      { item: 'bolt', w: 2, qty: [3, 8] },
      { item: 'pistol', w: 0.8 },
    ],
  },
  gunshop_shelf: {
    rolls: [1, 3], empty: 0.3,
    entries: [{ item: 'ammo_9mm', w: 4, qty: [6, 18] }, { item: 'ammo_12g', w: 3, qty: [4, 8] }, { item: 'bolt', w: 2, qty: [3, 6] }],
  },
  gunshop_crate: { rolls: [1, 3], empty: 0.3, entries: [{ item: 'ammo_9mm', w: 3, qty: [10, 30] }, { item: 'ammo_12g', w: 3, qty: [4, 12] }] },

  // ---------------------------------------------------------------- police
  police_locker: {
    rolls: [1, 2], empty: 0.35,
    entries: [
      { item: 'pistol', w: 3 },
      { item: 'shotgun', w: 1.5 },
      { item: 'assault_rifle', w: 0.6 },
      { item: 'vest_police', w: 1.2 },
      { item: 'helmet_riot', w: 1.2 },
      { item: 'ammo_9mm', w: 4, qty: [6, 20] },
      { item: 'ammo_12g', w: 3, qty: [4, 8] },
      { item: 'bat', w: 1 },
      { item: 'flashlight', w: 2 },
      { item: 'bandage', w: 2 },
    ],
  },
  police_desk: { rolls: [1, 2], empty: 0.4, entries: [{ item: 'ammo_9mm', w: 3, qty: [3, 12] }, { item: 'energy_bar', w: 2 }, { item: 'flashlight', w: 1 }] },
  police_cabinet: { rolls: [1, 2], empty: 0.4, entries: [{ item: 'bandage', w: 3 }, { item: 'painkillers', w: 2 }, { item: 'ammo_9mm', w: 2, qty: [3, 10] }] },
  police_crate: {
    rolls: [1, 3], empty: 0.3,
    entries: [
      { item: 'ammo_556', w: 3, qty: [10, 30] },
      { item: 'ammo_12g', w: 2, qty: [4, 10] },
      { item: 'ammo_308', w: 1, qty: [5, 10] },
      { item: 'rifle', w: 0.5 },
      { item: 'assault_rifle', w: 0.5 },
      { item: 'sniper_rifle', w: 0.3 },
      { item: 'vest_plate', w: 0.4 },
      { item: 'helmet_combat', w: 0.5 },
    ],
  },

  // ---------------------------------------------------------------- streets
  street_car_trunk: {
    rolls: [1, 3], empty: 0.4,
    entries: [
      { item: 'water_bottle', w: 4 },
      { item: 'scrap_metal', w: 4, qty: [1, 3] },
      { item: 'cloth', w: 3, qty: [1, 3] },
      { item: 'crowbar', w: 1 },
      { item: 'bat', w: 1 },
      { item: 'flashlight', w: 1.5 },
      { item: 'canned_beans', w: 2 },
    ],
  },

  // ---------------------------------------------------------------- zombies (what a corpse may drop)
  zombie_drop: {
    rolls: [1, 1], empty: 0,
    entries: [
      { item: 'cloth', w: 5, qty: [1, 2] },
      { item: 'bandage', w: 2 },
      { item: 'ammo_9mm', w: 2, qty: [2, 6] },
      { item: 'energy_bar', w: 2 },
      { item: 'water_bottle', w: 1 },
      { item: 'scrap_metal', w: 2 },
      { item: 'helmet_riot', w: 0.15 },
      { item: 'vest_police', w: 0.1 },
    ],
  },

  // ---------------------------------------------------------------- fallbacks
  any_fridge: { rolls: [1, 2], empty: 0.4, entries: FOOD },
  any_crate: { rolls: [1, 3], empty: 0.4, entries: [...FOOD, { item: 'cloth', w: 3 }, { item: 'scrap_metal', w: 3 }] },
  any_locker: { rolls: [1, 2], empty: 0.5, entries: [{ item: 'cloth', w: 3 }, { item: 'bat', w: 1 }] },
  default: { rolls: [1, 2], empty: 0.5, entries: [...FOOD, { item: 'cloth', w: 3, qty: [1, 2] }] },
};

/** Resolve a container's table id using the fallback chain. */
export const resolveLootTable = (id: string): LootTable => {
  if (LOOT_TABLES[id]) return LOOT_TABLES[id];
  const sep = id.indexOf('_');
  const building = id.slice(0, sep);
  const kind = id.slice(sep + 1);
  const alias = BUILDING_ALIASES[building];
  return LOOT_TABLES[`${alias}_${kind}`] ?? LOOT_TABLES[`any_${kind}`] ?? LOOT_TABLES.default;
};
