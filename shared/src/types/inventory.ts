import type { ItemStack } from './item';

/**
 * Slot-based inventory. Slots [0, HOTBAR_SIZE) are the hotbar (keys 1-9).
 * Weight is derived from contents; carrying capacity comes from config/survival.ts.
 */
export interface Inventory {
  slots: (ItemStack | null)[];
  /** Index into slots of the currently held hotbar item. */
  activeHotbar: number;
}

/** A world container (cabinet, fridge, car trunk, storage chest, loot bag). */
export type ContainerKind =
  | 'cabinet'
  | 'fridge'
  | 'shelf'
  | 'locker'
  | 'car_trunk'
  | 'desk'
  | 'crate'
  | 'storage_chest'
  | 'loot_bag';

export interface Container {
  id: string;
  kind: ContainerKind;
  /** Loot table id used when (re)filling; null for player-owned storage / death bags. */
  lootTable: string | null;
  slots: (ItemStack | null)[];
  /** Epoch ms when the container may be refilled. */
  respawnAt: number;
}

/** Client -> server inventory operations. The server validates every one of these. */
export type InventoryOp =
  /** to.index = -1 means "first place it fits" (quick transfer). */
  | { op: 'move'; from: SlotRef; to: SlotRef; qty?: number }
  | { op: 'drop'; from: SlotRef; qty?: number }
  | { op: 'use'; slot: number }
  | { op: 'select'; hotbar: number }
  | { op: 'craft'; recipeId: string };

export const CONTAINER_NAMES: Record<ContainerKind, string> = {
  cabinet: 'Cabinet',
  fridge: 'Fridge',
  shelf: 'Shelf',
  locker: 'Locker',
  car_trunk: 'Car Trunk',
  desk: 'Desk',
  crate: 'Crate',
  storage_chest: 'Storage Chest',
  loot_bag: 'Bag',
};

export interface SlotRef {
  /** 'self' = own inventory, otherwise the key of the open container. */
  owner: 'self' | string;
  index: number;
}
