/**
 * Items are split into two layers:
 *  - ItemDef: static definition, lives in config/items.ts (balance-tweakable).
 *  - ItemStack: an instance in the world / an inventory. Only stacks are persisted.
 */

export type ItemCategory =
  | 'melee'
  | 'ranged'
  | 'ammo'
  | 'food'
  | 'drink'
  | 'medical'
  | 'material'
  | 'tool'
  | 'buildable'
  | 'explosive'
  | 'armor';

/** Where a piece of armour is worn. Helmets protect against headshots, vests against body hits. */
export type ArmorSlot = 'head' | 'body';

export type ItemDefId = string;

export interface ItemDef {
  id: ItemDefId;
  name: string;
  category: ItemCategory;
  /** kg per single unit */
  weight: number;
  maxStack: number;
  description?: string;
  /** Consumables: what using the item restores. */
  consume?: {
    health?: number;
    hunger?: number;
    thirst?: number;
    stopsBleeding?: boolean;
    useTimeMs: number;
  };
  /** Weapons reference a WeaponDef by id (config/weapons.ts). */
  weaponId?: string;
  /** Buildables reference a StructureDef kind (config/structures.ts). */
  structureKind?: string;
  /** Only armour has durability (owner: no durability on anything else). */
  maxDurability?: number;
  /**
   * Wearable armour: "use" it to put it on. Absorbs `reduction` (0-1) of player/zombie damage
   * to its zone and loses durability by the amount absorbed.
   */
  armor?: { slot: ArmorSlot; reduction: number; equipTimeMs: number };
  /** A fuel container (gas can): how many litres it holds when full. */
  fuelCan?: { liters: number };
}

export interface ItemStack {
  /** Unique instance id (uuid) so the server can track stacks across moves. */
  uid: string;
  defId: ItemDefId;
  qty: number;
  durability?: number;
  /** Rounds currently loaded (ranged weapons only). */
  loadedAmmo?: number;
  /** Litres of gasoline in a gas can. */
  fuel?: number;
}
