/**
 * Rapier collision groups. A 32-bit value: upper 16 bits = membership, lower 16 = filter.
 * Two colliders interact when (a.membership & b.filter) && (b.membership & a.filter).
 */
export const Layer = {
  WORLD: 0x0001,
  PLAYER: 0x0002,
  ZOMBIE: 0x0004,
  STRUCTURE: 0x0008,
  VEHICLE: 0x0010,
} as const;

export const groups = (membership: number, filter: number): number =>
  ((membership & 0xffff) << 16) | (filter & 0xffff);

/** Static city geometry: collides with everything. */
export const WORLD_GROUPS = groups(Layer.WORLD, 0xffff);
/**
 * Players only collide with the world and structures (not each other). That keeps the
 * client's predicted world (map only) identical to what the server sees for that player.
 */
export const PLAYER_GROUPS = groups(Layer.PLAYER, Layer.WORLD | Layer.STRUCTURE | Layer.VEHICLE);
/** Bullets: the world and structures stop them; they pass through vehicles (you can shoot the driver). */
export const SHOT_GROUPS = groups(Layer.PLAYER, Layer.WORLD | Layer.STRUCTURE);
/**
 * A vehicle's own collider is only the shape its motor sweeps; nothing queries it (filter 0), so it
 * never has to be refreshed in the broad-phase. Players and other vehicles collide with vehicles
 * through `pushOutOfBox` instead (see sim/vehicle.ts).
 */
export const VEHICLE_GROUPS = groups(Layer.VEHICLE, 0);
/** A collider that interacts with nothing (inactive door poses). */
export const DISABLED_GROUPS = groups(Layer.STRUCTURE, 0);
/** What a moving vehicle collides with (players and zombies are run over, not collided with). */
export const VEHICLE_MOVE_GROUPS = groups(Layer.VEHICLE, Layer.WORLD | Layer.STRUCTURE | Layer.VEHICLE);
