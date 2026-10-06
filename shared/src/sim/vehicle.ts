import type { Collider, KinematicCharacterController, World } from '@dimforge/rapier3d-compat';
import { VEHICLES, type VehicleDef, type VehicleType } from '../config/vehicles';
import { MOVEMENT } from '../config/movement';
import { clamp, quatFromEulerYXZ } from '../math/math';
import type { Vec3 } from '../types/common';
import { VEHICLE_GROUPS, VEHICLE_MOVE_GROUPS } from './collision';
import { Buttons, type MoveInput, type Rapier } from './movement';

/**
 * Arcade vehicle model, deterministic like the player motor (the driver's client predicts it):
 *  - Walls: the collision box floats LIFT above the ground, so curbs, road edges and small lips
 *    pass underneath; a kinematic character controller slides it along whatever it hits.
 *  - Ground: rays at the centre and four corners find the surface; the vehicle rides on the
 *    highest one (wheels climb curbs), falls with gravity when nothing is below.
 *  - Fuel burns with distance (real-world consumption) plus a little idling.
 */
export interface VehicleState {
  /** Ground point under the vehicle's centre. */
  pos: Vec3;
  yaw: number;
  /** Signed forward speed (m/s); negative = reversing. */
  speed: number;
  vy: number;
  grounded: boolean;
  /** Smoothed steering, -1 (right) .. 1 (left). */
  steer: number;
  /** Litres in the tank. Empty = the engine stops (you can still roll and steer). */
  fuel: number;
}

export const createVehicleState = (pos: Vec3, yaw = 0, fuel = 0): VehicleState => ({
  pos: { ...pos },
  yaw,
  speed: 0,
  vy: 0,
  grounded: false,
  steer: 0,
  fuel,
});

export const cloneVehicleState = (s: VehicleState): VehicleState => ({ ...s, pos: { ...s.pos } });

/** Height of the collision box's bottom above the ground: anything lower is driven over. */
const LIFT = 0.38;
const EDGE = 0.08;

/** The collision box spans LIFT .. roof; centre height above the ground and half extents. */
const body = (d: VehicleDef) => {
  const top = d.clearance + d.size[1];
  const hy = (top - LIFT) / 2;
  return { hx: d.size[0] / 2, hy, hz: d.size[2] / 2, cy: LIFT + hy };
};

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
  const b = body(VEHICLES[type]);
  const desc = R.ColliderDesc.roundCuboid(b.hx - EDGE, b.hy - EDGE, b.hz - EDGE, EDGE)
    .setTranslation(s.pos.x, s.pos.y + b.cy, s.pos.z)
    .setRotation(quatFromEulerYXZ(0, s.yaw, 0))
    .setCollisionGroups(VEHICLE_GROUPS);
  return world.createCollider(desc);
};

/** Move a vehicle's collider to a state (spawn, reconciliation, remote interpolation). */
export const placeVehicleCollider = (c: Collider, type: VehicleType, s: VehicleState): void => {
  const b = body(VEHICLES[type]);
  c.setTranslation({ x: s.pos.x, y: s.pos.y + b.cy, z: s.pos.z });
  c.setRotation(quatFromEulerYXZ(0, s.yaw, 0));
};

export interface VehicleStepResult {
  state: VehicleState;
  /** Speed (m/s) lost by hitting something solid this tick: crash damage on the server. */
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
    // Horizontal sliding only: no stepping, snapping or slope climbing (the ground rays do that).
    const c = world.createCharacterController(0.02);
    c.setSlideEnabled(true);
    c.setMaxSlopeClimbAngle(0);
    c.setApplyImpulsesToDynamicBodies(false);
    this.controller = c;
    const b = body(this.def);
    // Slightly smaller box for "can I turn here" checks (touching contacts aren't overlaps).
    this.probe = new R.Cuboid(b.hx - 0.06, b.hy - 0.06, b.hz - 0.06);
  }

  sync(s: VehicleState): void {
    placeVehicleCollider(this.collider, this.type, s);
  }

  /** Highest ground under the centre and corners, searching down from `fromY`. */
  private groundAt(x: number, z: number, yaw: number, fromY: number): number | null {
    const d = this.def;
    const { fx, fz, rx, rz } = vehicleAxes(yaw);
    const u = d.size[0] / 2 - 0.25, w = d.size[2] / 2 - 0.4;
    let best: number | null = null;
    for (const [a, b] of [[0, 0], [u, w], [-u, w], [u, -w], [-u, -w]]) {
      const ox = x + rx * a + fx * b, oz = z + rz * a + fz * b;
      const ray = new this.R.Ray({ x: ox, y: fromY, z: oz }, { x: 0, y: -1, z: 0 });
      const hit = this.world.castRay(ray, 3, true, this.R.QueryFilterFlags.EXCLUDE_SENSORS, VEHICLE_MOVE_GROUPS, this.collider);
      if (hit) {
        const gy = fromY - hit.timeOfImpact;
        if (best === null || gy > best) best = gy;
      }
    }
    return best;
  }

  /**
   * Advance one fixed tick with the driver's input (null = nobody driving: coast to a stop).
   * The collider must already be at `state`.
   */
  step(state: VehicleState, input: MoveInput | null, dt: number): VehicleStepResult {
    const d = this.def;
    const s = cloneVehicleState(state);
    const running = input !== null && s.fuel > 0;
    const throttle = running ? clamp(input!.mz, -1, 1) : 0;
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
    const b = body(d);
    if (Math.abs(yawRate) > 1e-5 && s.grounded) {
      const newYaw = s.yaw + yawRate * dt;
      // Don't rotate into a wall.
      const hit = this.world.intersectionWithShape(
        { x: s.pos.x, y: s.pos.y + b.cy, z: s.pos.z },
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

    // ---- horizontal: slide the raised body along walls
    const { fx, fz } = vehicleAxes(s.yaw);
    const want = { x: fx * s.speed * dt, y: 0, z: fz * s.speed * dt };
    this.collider.setTranslation({ x: s.pos.x, y: s.pos.y + b.cy, z: s.pos.z });
    this.controller.computeColliderMovement(this.collider, want, this.R.QueryFilterFlags.EXCLUDE_SENSORS, VEHICLE_MOVE_GROUPS);
    const mv = this.controller.computedMovement();
    const nx = s.pos.x + mv.x, nz = s.pos.z + mv.z;
    let impact = 0;
    if (this.controller.numComputedCollisions() > 0 && Math.abs(s.speed) > 0.3) {
      // Hit something: keep only the speed we actually made along our heading.
      const achieved = (mv.x * fx + mv.z * fz) / dt;
      const kept = s.speed > 0 ? clamp(achieved, 0, s.speed) : clamp(achieved, s.speed, 0);
      impact = Math.abs(s.speed - kept);
      s.speed = kept;
    }

    // ---- vertical: ride on the highest ground under the wheels, or fall
    const ground = this.groundAt(nx, nz, s.yaw, s.pos.y + LIFT);
    let ny: number;
    if (ground !== null && s.pos.y + s.vy * dt <= ground + 0.25 && s.vy <= 0.5) {
      ny = ground;
      s.vy = 0;
      s.grounded = true;
    } else {
      s.vy = Math.max(-40, s.vy - MOVEMENT.gravity * dt);
      ny = s.pos.y + s.vy * dt;
      if (ground !== null && ny <= ground) {
        ny = ground;
        s.vy = 0;
        s.grounded = true;
      } else {
        s.grounded = false;
      }
    }

    // ---- fuel: real-world consumption per km, plus idling while someone sits at the wheel
    if (running) {
      const km = (Math.abs(s.speed) * dt) / 1000;
      s.fuel = Math.max(0, s.fuel - km * (d.litersPer100km / 100) - (d.idleLitersPerHour / 3600) * dt);
    }

    s.pos = { x: nx, y: ny, z: nz };
    this.collider.setTranslation({ x: nx, y: ny + b.cy, z: nz });
    return { state: s, impact };
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
  }
}
