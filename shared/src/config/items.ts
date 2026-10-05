import type { ItemDef } from '../types/item';

/**
 * Every item in the game. Weight is kg per unit. `consume` values are applied by the
 * survival system (milestone 4); `weaponId` points into config/weapons.ts (milestone 5).
 * Add an item here and it can immediately appear in loot tables and recipes.
 */
const defs: ItemDef[] = [
  // ---- melee
  { id: 'bat', name: 'Baseball Bat', category: 'melee', weight: 1.0, maxStack: 1, weaponId: 'bat', maxDurability: 100,
    description: 'Aluminium. Dented. Reliable.' },
  { id: 'crowbar', name: 'Crowbar', category: 'melee', weight: 1.5, maxStack: 1, weaponId: 'crowbar', maxDurability: 150,
    description: 'Opens doors, and heads.' },
  { id: 'machete', name: 'Machete', category: 'melee', weight: 1.0, maxStack: 1, weaponId: 'machete', maxDurability: 90 },
  { id: 'axe', name: 'Fire Axe', category: 'melee', weight: 2.2, maxStack: 1, weaponId: 'axe', maxDurability: 120,
    description: 'Heavy and slow. Good against barricades.' },

  // ---- ranged
  { id: 'pistol', name: 'Pistol', category: 'ranged', weight: 1.0, maxStack: 1, weaponId: 'pistol', maxDurability: 200 },
  { id: 'shotgun', name: 'Pump Shotgun', category: 'ranged', weight: 3.5, maxStack: 1, weaponId: 'shotgun', maxDurability: 150 },
  { id: 'rifle', name: 'Hunting Rifle', category: 'ranged', weight: 4.0, maxStack: 1, weaponId: 'rifle', maxDurability: 180 },
  { id: 'assault_rifle', name: 'Assault Rifle', category: 'ranged', weight: 3.6, maxStack: 1, weaponId: 'assault_rifle', maxDurability: 300,
    description: 'Full-auto. Loud enough to wake the whole block.' },
  { id: 'crossbow', name: 'Crossbow', category: 'ranged', weight: 3.0, maxStack: 1, weaponId: 'crossbow', maxDurability: 150,
    description: 'Silent. Bolts can be recovered.' },

  // ---- ammo
  { id: 'ammo_9mm', name: '9mm Rounds', category: 'ammo', weight: 0.01, maxStack: 60 },
  { id: 'ammo_12g', name: '12 Gauge Shells', category: 'ammo', weight: 0.04, maxStack: 24 },
  { id: 'ammo_556', name: '5.56 Rounds', category: 'ammo', weight: 0.012, maxStack: 60 },
  { id: 'bolt', name: 'Crossbow Bolt', category: 'ammo', weight: 0.05, maxStack: 20 },

  // ---- food & drink
  { id: 'canned_beans', name: 'Canned Beans', category: 'food', weight: 0.4, maxStack: 5,
    consume: { hunger: 30, useTimeMs: 2500 } },
  { id: 'chips', name: 'Bag of Chips', category: 'food', weight: 0.15, maxStack: 5,
    consume: { hunger: 12, thirst: -4, useTimeMs: 1500 } },
  { id: 'energy_bar', name: 'Energy Bar', category: 'food', weight: 0.1, maxStack: 8,
    consume: { hunger: 15, useTimeMs: 1200 } },
  { id: 'mre', name: 'Military Ration', category: 'food', weight: 0.6, maxStack: 3,
    consume: { hunger: 55, thirst: 5, useTimeMs: 4000 } },
  { id: 'water_bottle', name: 'Water Bottle', category: 'drink', weight: 0.5, maxStack: 5,
    consume: { thirst: 35, useTimeMs: 2000 } },
  { id: 'soda', name: 'Can of Soda', category: 'drink', weight: 0.35, maxStack: 6,
    consume: { thirst: 20, hunger: 3, useTimeMs: 1500 } },

  // ---- medical
  { id: 'bandage', name: 'Bandage', category: 'medical', weight: 0.05, maxStack: 10,
    consume: { health: 10, stopsBleeding: true, useTimeMs: 3000 } },
  { id: 'painkillers', name: 'Painkillers', category: 'medical', weight: 0.05, maxStack: 10,
    consume: { health: 15, useTimeMs: 1500 } },
  { id: 'medkit', name: 'First Aid Kit', category: 'medical', weight: 0.8, maxStack: 3,
    consume: { health: 60, stopsBleeding: true, useTimeMs: 6000 } },

  // ---- materials
  { id: 'wood_plank', name: 'Wooden Plank', category: 'material', weight: 1.0, maxStack: 10 },
  { id: 'nails', name: 'Nails', category: 'material', weight: 0.01, maxStack: 100 },
  { id: 'scrap_metal', name: 'Scrap Metal', category: 'material', weight: 0.5, maxStack: 20 },
  { id: 'cloth', name: 'Cloth Rag', category: 'material', weight: 0.1, maxStack: 20 },

  // ---- tools & buildables
  { id: 'flashlight', name: 'Flashlight', category: 'tool', weight: 0.3, maxStack: 1, maxDurability: 100,
    description: 'Equip it to light the way at night.' },
  { id: 'barricade', name: 'Barricade Kit', category: 'buildable', weight: 4.0, maxStack: 2, structureKind: 'barricade',
    description: 'Planks and nails, ready to board up a doorway.' },
];

export const ITEMS: Readonly<Record<string, ItemDef>> = Object.fromEntries(defs.map((d) => [d.id, d]));

export const getItemDef = (id: string): ItemDef | undefined => ITEMS[id];

/** Short label + color used by the placeholder UI icons and ground item meshes. */
export const ITEM_CATEGORY_COLORS: Record<ItemDef['category'], string> = {
  melee: '#9c6b3f',
  ranged: '#4b5563',
  ammo: '#b59a3b',
  food: '#6b8e3d',
  drink: '#3b78a8',
  medical: '#c0392b',
  material: '#8a7a64',
  tool: '#c9a43a',
  buildable: '#7a5c3a',
  explosive: '#a8452c',
};
