import type { ContainerKind } from '../types/inventory';

export const INVENTORY = {
  /** Total player slots; the first `hotbarSize` are the hotbar (keys 1-9). */
  slots: 24,
  hotbarSize: 9,
  /** Carry limit in kg. Picking up / taking items beyond this is refused. */
  maxCarryWeight: 30,
  /** Interaction reach (m) from the eye. */
  useRange: 2.6,
  /** Containers auto-close when the looter walks further than this (m). */
  containerCloseDistance: 4,
  /** Dropped items disappear after this many minutes. */
  groundItemDespawnMin: 15,
  /** Ground items are sent to players within this radius (m). */
  groundItemViewRadius: 60,
  /** Slots per container type. */
  containerSlots: {
    cabinet: 6,
    fridge: 8,
    shelf: 8,
    locker: 6,
    car_trunk: 8,
    desk: 4,
    crate: 8,
    storage_chest: 20,
    loot_bag: 30,
  } satisfies Record<ContainerKind, number>,
  /** What new survivors start with. */
  startingKit: [
    { item: 'water_bottle', qty: 1 },
    { item: 'canned_beans', qty: 1 },
    { item: 'bandage', qty: 2 },
  ],
} as const;
