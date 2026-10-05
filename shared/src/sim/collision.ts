/**
 * Rapier collision groups. A 32-bit value: upper 16 bits = membership, lower 16 = filter.
 * Two colliders interact when (a.membership & b.filter) && (b.membership & a.filter).
 */
export const Layer = {
  WORLD: 0x0001,
  PLAYER: 0x0002,
  ZOMBIE: 0x0004,
  STRUCTURE: 0x0008,
} as const;

export const groups = (membership: number, filter: number): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

/** Static city geometry: collides with everything. */
export const WORLD_GROUPS = groups(Layer.WORLD, 0xffff);
/**
 * Players only collide with the world and structures (not each other). That keeps the
 * client's predicted world (map only) identical to what the server sees for that player.
 */
export const PLAYER_GROUPS = groups(Layer.PLAYER, Layer.WORLD | Layer.STRUCTURE);
