import type { Collider, KinematicCharacterController, World } from '@dimforge/rapier3d-compat';
import { VEHICLES, type VehicleDef, type VehicleType } from '../config/vehicles';
import { MOVEMENT } from '../config/movement';
import { clamp, degToRad, quatFromEulerYXZ } from '../math/math';
import type { Vec3 } from '../types/common';
import { VEHICLE_GROUPS, VEHICLE_MOVE_GROUPS } from './collision';
import { Buttons, type MoveInput, type Rapier } from './movement';

/**
 * Arcade vehicle model on Rapier's kinematic character controller: the collision box slides
 * along walls, steps up curbs and snaps to the ground; throttle/brake/steering are integrated
 * here. Like the player motor it is deterministic, so the driver's client predicts it exactly.
 */
export interface VehicleState {
  /** Ground point under the vehicle's centre (bottom of the collision box). */
  pos: Vec3;
  yaw: number;
  /** Signed forward speed (m/s); negative = reversing. */
  speed: number;
  vy: number;
  grounded: boolean;
  /** Smoothed steering, -1 (right) .. 1 (left). */
  steer: number;
}

export const createVehicleState = (pos: Vec3, yaw = 0): VehicleState => ({
  pos: { ...pos },
  yaw,
  speed: 0,
  vy: 0,
  grounded: false,
  steer: 0,
});

export const cloneVehicleState = (s: VehicleState): VehicleState => ({ ...s, pos: { ...s.pos } });

/** Half extents of the collision box: it reaches from the ground to the roof. */
const halfExtents = (d: VehicleDef) => ({ x: d.size[0] / 2, y: (d.clearance + d.size[1]) / 2, z: d.size[2] / 2 });

/** Player feet sit this far below the seat (hip) point; seated players use crouch hitboxes. */
export const SEAT_HIP = 0.5;

/** Forward (-Z at yaw 0) and right vectors of a vehicle. */
export const vehicleAxes = (yaw: number) => ({
  fx: -Math.sin(yaw), fz: -Math.cos(yaw),
  rx: Math.cos(yaw), rz: -Math.sin(yaw),
});

/** World position of a seat (the occupant's hip), and of the occupant's feet. */
export const seatPosition = (type: VehicleType, s: VehicleState, seat: number): Vec3 => {
  const d = VEHICLES[type];
  const [sx, sy, sz] = d.seats[Math.min(seat, d.seats.length - 1)];
  const { fx, fz, rx, rz } = vehicleAxes(s.yaw);
  return { x: s.pos.x + rx * sx + fx * sz, y: s.pos.y + sy, z: s.pos.z + rz * sx + fz * sz };
};

export const seatFeet = (type: VehicleType, s: VehicleState, seat: number): Vec3 => {
  const p = seatPosition(type, s, seat);
  return { x: p.x, y: p.y - SEAT_HIP, z: p.z };
};

/** Create a vehicle's collision box (an obstacle for players and other vehicles). */
export const createVehicleCollider = (R: Rapier, world: World, type: VehicleType, s: VehicleState): Collider => {
  const he = halfExtents(VEHICLES[type]);
  const desc = R.ColliderDesc.cuboid(he.x, he.y, he.z)
    .setTranslation(s.pos.x, s.pos.y + he.y, s.pos.z)
    .setRotation(quatFromEulerYXZ(0, s.yaw, 0))
    .setCollisionGroups(VEHICLE_GROUPS);
  return world.createCollider(desc);
};

/** Move a vehicle's collider to a state (spawn, reconciliation, remote interpolation). */
export const placeVehicleCollider = (c: Collider, type: VehicleType, s: VehicleState): void => {
  const he = halfExtents(VEHICLES[type]);
  c.setTranslation({ x: s.pos.x, y: s.pos.y + he.y, z: s.pos.z });
  c.setRotation(quatFromEulerYXZ(0, s.yaw, 0));
};

export interface VehicleStepResult {
  state: VehicleState;
  /** Speed (m/s) lost to collisions this tick: crash damage on the server. */
  impact: number;
}

export class VehicleMotor {
  private readonly controller: KinematicCharacterController;
  private readonly def: VehicleDef;
  private readonly probe: InstanceType<Rapier['Cuboid']>;

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    readonly type: VehicleType,
    readonly collider: Collider,
  ) {
    this.def = VEHICLES[type];
    const c = world.createCharacterController(0.03);
    c.enableAutostep(0.4, 0.15, false);
    c.enableSnapToGround(0.5);
    c.setMaxSlopeClimbAngle(degToRad(40));
    c.setMinSlopeSlideAngle(degToRad(45));
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(false);
    this.controller = c;
    const he = halfExtents(this.def);
    // Slightly smaller box for "can I turn here" checks (touching contacts aren't overlaps).
    this.probe = new R.Cuboid(he.x - 0.06, he.y - 0.12, he.z - 0.06);
  }

  sync(s: VehicleState): void {
    placeVehicleCollider(this.collider, this.type, s);
  }

  /**
   * Advance one fixed tick with the driver's input (null = nobody driving: coast to a stop).
   * The collider must already be at `state`.
   */
  step(state: VehicleState, input: MoveInput | null, dt: number): VehicleStepResult {
    const d = this.def;
    const s = cloneVehicleState(state);
    const throttle = input ? clamp(input.mz, -1, 1) : 0;
    const steerIn = input ? -clamp(input.mx, -1, 1) : 0; // A = left = yaw increases
    const handbrake = input ? (input.b & Buttons.jump) !== 0 : false;

    // ---- longitudinal: throttle, brake (pressing against the motion), coasting drag
    const v = s.speed;
    if (throttle > 0.05) {
      if (v < -0.2) s.speed = Math.min(0, v + d.brake * throttle * dt);
      else s.speed = v + d.accel * throttle * (1 - Math.max(0, v) / d.maxSpeed * 0.55) * dt;
    } else if (throttle < -0.05) {
      if (v > 0.2) s.speed = Math.max(0, v + d.brake * throttle * dt);
      else s.speed = v + d.accel * 0.7 * throttle * dt;
    } else {
      s.speed = v - Math.sign(v) * Math.min(Math.abs(v), d.drag * dt);
    }
    if (handbrake) s.speed -= Math.sign(s.speed) * Math.min(Math.abs(s.speed), d.brake * 0.75 * dt);
    if (!s.grounded) s.speed = v; // no traction in the air
    s.speed = clamp(s.speed, -d.reverseSpeed, d.maxSpeed);

    // ---- steering: needs some speed; gentler at top speed; handbrake tightens the turn
    s.steer += (steerIn - s.steer) * (1 - Math.exp(-7 * dt));
    const sp = Math.abs(s.speed);
    const grip = clamp(sp / 4, 0, 1) * (1 - 0.45 * clamp(sp / d.maxSpeed, 0, 1));
    const yawRate = s.steer * d.turnRate * grip * Math.sign(s.speed) * (handbrake ? 1.5 : 1);
    if (Math.abs(yawRate) > 1e-5 && s.grounded) {
      const newYaw = s.yaw + yawRate * dt;
      // Don't rotate into a wall.
      const c = this.collider.translation();
      const hit = this.world.intersectionWithShape(
        c,
        quatFromEulerYXZ(0, newYaw, 0),
        this.probe,
        this.R.QueryFilterFlags.EXCLUDE_SENSORS,
        VEHICLE_MOVE_GROUPS,
        this.collider,
      );
      if (hit === null) {
        s.yaw = newYaw;
        this.collider.setRotation(quatFromEulerYXZ(0, s.yaw, 0));
      }
    }

    // ---- move: forward motion + gravity, collide & slide
    s.vy = s.grounded ? -2 : Math.max(-40, s.vy - MOVEMENT.gravity * dt);
    const { fx, fz } = vehicleAxes(s.yaw);
    const desired = { x: fx * s.speed * dt, y: s.vy * dt, z: fz * s.speed * dt };
    this.controller.computeColliderMovement(this.collider, desired, this.R.QueryFilterFlags.EXCLUDE_SENSORS, VEHICLE_MOVE_GROUPS);
    const mv = this.controller.computedMovement();
    const c = this.collider.translation();
    this.collider.setTranslation({ x: c.x + mv.x, y: c.y + mv.y, z: c.z + mv.z });
    s.grounded = this.controller.computedGrounded();
    if (s.grounded) s.vy = 0;

    // Blocked: the speed along our heading is whatever we actually achieved.
    let impact = 0;
    if (Math.abs(s.speed) > 0.3) {
      const achieved = (mv.x * fx + mv.z * fz) / dt;
      const kept = s.speed > 0 ? clamp(achieved, 0, s.speed) : clamp(achieved, s.speed, 0);
      // Small losses are slopes and scraping; only big ones count as impacts.
      if (Math.abs(s.speed - kept) > 0.5) {
        impact = Math.abs(s.speed - kept);
        s.speed = kept;
      }
    }

    const he = halfExtents(d);
    s.pos = { x: c.x + mv.x, y: c.y + mv.y - he.y, z: c.z + mv.z };
    return { state: s, impact };
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
  }
}
