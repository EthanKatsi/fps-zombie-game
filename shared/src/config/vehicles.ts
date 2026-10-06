/**
 * Drivable vehicles. Speeds in m/s (24 m/s = 86 km/h), accelerations in m/s^2.
 * The same numbers drive the server simulation and the driver's client prediction.
 */
export type VehicleType = 'sedan' | 'pickup' | 'motorcycle';

export interface VehicleDef {
  type: VehicleType;
  name: string;
  /** Collision box (full size: width, height, length). The box's bottom sits `clearance` above the ground. */
  size: [number, number, number];
  clearance: number;
  maxSpeed: number;
  reverseSpeed: number;
  accel: number;
  brake: number;
  /** Deceleration when coasting. */
  drag: number;
  /** Max yaw rate (rad/s) at full steering lock and a moderate speed. */
  turnRate: number;
  /** Seats: occupant hip position [x right, y up from the ground, z forward] in vehicle space. Seat 0 drives. */
  seats: [number, number, number][];
  health: number;
}

export const VEHICLES: Record<VehicleType, VehicleDef> = {
  sedan: {
    type: 'sedan', name: 'Sedan', size: [1.9, 1.2, 4.4], clearance: 0.25,
    maxSpeed: 26, reverseSpeed: 7, accel: 6.5, brake: 14, drag: 2.2, turnRate: 1.7,
    seats: [[-0.42, 0.55, 0.1], [0.42, 0.55, 0.1], [-0.42, 0.55, -1.0], [0.42, 0.55, -1.0]],
    health: 400,
  },
  pickup: {
    type: 'pickup', name: 'Pickup Truck', size: [2.1, 1.5, 5.2], clearance: 0.4,
    maxSpeed: 23, reverseSpeed: 6, accel: 5.5, brake: 13, drag: 2.4, turnRate: 1.45,
    seats: [[-0.45, 0.8, 0.6], [0.45, 0.8, 0.6]],
    health: 550,
  },
  motorcycle: {
    type: 'motorcycle', name: 'Motorcycle', size: [0.8, 1.0, 2.1], clearance: 0.2,
    maxSpeed: 31, reverseSpeed: 3, accel: 9, brake: 16, drag: 1.8, turnRate: 2.3,
    seats: [[0, 0.85, -0.15], [0, 0.95, -0.7]],
    health: 220,
  },
};

export const VEHICLE_TYPE_ORDER: VehicleType[] = ['sedan', 'pickup', 'motorcycle'];

export const VEHICLE_RULES = {
  /** Max distance (m) from a vehicle's centre to get in. */
  enterRange: 3.6,
  /** Speed (m/s) above which you can't get out. */
  maxExitSpeed: 4,
  /** Hitting something: speed lost above this (m/s) damages the vehicle... */
  crashSpeedThreshold: 7,
  /** ...by this much per m/s over the threshold; occupants take `crashOccupantFactor` of it. */
  crashDamagePerMps: 12,
  crashOccupantFactor: 0.15,
  /** Running over zombies / players: damage per m/s of speed, above `runOverMinSpeed`. */
  runOverMinSpeed: 4,
  runOverDamagePerMps: 7,
  /** Speed kept after running someone over. */
  runOverSlowdown: 0.85,
  /** Engine noise radius (m) that zombies hear while driving (louder at speed). */
  engineNoiseRadius: 45,
  /** Wrecked vehicles reappear at their spawn after this long (also abandoned far-off ones). */
  respawnAfterSec: 300,
  /** Vehicles are sent to clients within this radius (m). */
  interestRadius: 200,
} as const;
