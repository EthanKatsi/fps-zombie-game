import type RAPIER_NS from '@dimforge/rapier3d-compat';
import type { Collider, KinematicCharacterController, World } from '@dimforge/rapier3d-compat';
import { MOVEMENT } from '../config/movement';
import { SURVIVAL } from '../config/survival';
import { COMBAT } from '../config/weapons';
import { clamp, degToRad } from '../math/math';
import type { Vec3 } from '../types/common';
import { PLAYER_GROUPS } from './collision';

export type Rapier = typeof RAPIER_NS;

export const Buttons = {
  jump: 1,
  sprint: 2,
  crouch: 4,
  /** Aiming down sights: slower movement, no sprint. */
  aim: 8,
} as const;

/** One tick of player intent. Sent client -> server, replayed during reconciliation. */
export interface MoveInput {
  seq: number;
  /** Strafe axis, -1 (left) .. 1 (right). */
  mx: number;
  /** Forward axis, -1 (back) .. 1 (forward). */
  mz: number;
  yaw: number;
  pitch: number;
  /** Bit mask of Buttons. */
  b: number;
}

/** Everything the movement sim needs to resume from. Positions are the FEET position. */
export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
  sprinting: boolean;
  stamina: number;
  /** Seconds until stamina starts regenerating. */
  staminaDelay: number;
}

export const createMoveState = (pos: Vec3, yaw = 0): MoveState => ({
  pos: { ...pos },
  vel: { x: 0, y: 0, z: 0 },
  yaw,
  pitch: 0,
  grounded: false,
  crouching: false,
  sprinting: false,
  stamina: SURVIVAL.stamina.max,
  staminaDelay: 0,
});

export const cloneMoveState = (s: MoveState): MoveState => ({
  ...s,
  pos: { ...s.pos },
  vel: { ...s.vel },
});

const capsuleHalfHeight = (crouching: boolean): number =>
  (crouching ? MOVEMENT.crouchHeight : MOVEMENT.standHeight) / 2 - MOVEMENT.radius;

const bodyHeight = (crouching: boolean): number =>
  crouching ? MOVEMENT.crouchHeight : MOVEMENT.standHeight;

export const eyeHeight = (crouching: boolean): number =>
  crouching ? MOVEMENT.eyeHeightCrouch : MOVEMENT.eyeHeightStand;

const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Reject NaN / huge values from untrusted clients. */
export const sanitizeInput = (i: MoveInput): MoveInput | null => {
  if (
    !i ||
    !Number.isFinite(i.seq) ||
    !Number.isFinite(i.mx) ||
    !Number.isFinite(i.mz) ||
    !Number.isFinite(i.yaw) ||
    !Number.isFinite(i.pitch) ||
    !Number.isFinite(i.b)
  ) {
    return null;
  }
  return {
    seq: Math.floor(i.seq),
    mx: clamp(i.mx, -1, 1),
    mz: clamp(i.mz, -1, 1),
    yaw: i.yaw % (Math.PI * 2),
    pitch: clamp(i.pitch, -PITCH_LIMIT, PITCH_LIMIT),
    b: i.b & 0xff,
  };
};

/**
 * Deterministic kinematic character motor built on Rapier's character controller.
 * The exact same code runs on the server (authoritative) and on the client (prediction),
 * so given the same start state and inputs both produce the same result.
 */
export class CharacterMotor {
  readonly collider: Collider;
  private readonly controller: KinematicCharacterController;

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    state: MoveState,
  ) {
    const desc = R.ColliderDesc.capsule(capsuleHalfHeight(state.crouching), MOVEMENT.radius)
      .setTranslation(state.pos.x, state.pos.y + bodyHeight(state.crouching) / 2, state.pos.z)
      .setCollisionGroups(PLAYER_GROUPS);
    this.collider = world.createCollider(desc);

    const c = world.createCharacterController(MOVEMENT.skinOffset);
    c.enableAutostep(MOVEMENT.maxStepHeight, MOVEMENT.minStepWidth, false);
    c.enableSnapToGround(MOVEMENT.snapToGround);
    c.setMaxSlopeClimbAngle(degToRad(MOVEMENT.maxSlopeDeg));
    c.setMinSlopeSlideAngle(degToRad(MOVEMENT.maxSlopeDeg + 5));
    c.setSlideEnabled(true);
    c.setApplyImpulsesToDynamicBodies(false);
    this.controller = c;
  }

  /** Teleport the collider to match a state (spawn, respawn, reconciliation). */
  syncCollider(state: MoveState): void {
    this.collider.setHalfHeight(capsuleHalfHeight(state.crouching));
    this.collider.setTranslation({
      x: state.pos.x,
      y: state.pos.y + bodyHeight(state.crouching) / 2,
      z: state.pos.z,
    });
  }

  private canStand(state: MoveState): boolean {
    const shape = new this.R.Capsule(capsuleHalfHeight(false), MOVEMENT.radius - 0.05);
    const center = {
      x: state.pos.x,
      y: state.pos.y + MOVEMENT.standHeight / 2 + 0.05,
      z: state.pos.z,
    };
    const hit = this.world.intersectionWithShape(
      center,
      { x: 0, y: 0, z: 0, w: 1 },
      shape,
      this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      PLAYER_GROUPS,
      this.collider,
    );
    return hit === null;
  }

  /**
   * Advance one fixed tick. Returns a NEW state; the input state is not mutated.
   * The collider must already be at `state` (call syncCollider after teleports).
   */
  step(state: MoveState, input: MoveInput, dt: number): MoveState {
    const s = cloneMoveState(state);
    const st = SURVIVAL.stamina;
    s.yaw = input.yaw;
    s.pitch = clamp(input.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    // --- crouch (keep feet planted when the capsule changes size) ---
    const wantCrouch = (input.b & Buttons.crouch) !== 0;
    if (wantCrouch !== s.crouching && (wantCrouch || this.canStand(s))) {
      s.crouching = wantCrouch;
      this.syncCollider(s);
    }

    // --- wish direction (Three.js convention: yaw 0 looks down -Z) ---
    let mx = clamp(input.mx, -1, 1);
    let mz = clamp(input.mz, -1, 1);
    const len = Math.hypot(mx, mz);
    if (len > 1) {
      mx /= len;
      mz /= len;
    }
    const sin = Math.sin(s.yaw);
    const cos = Math.cos(s.yaw);
    const wishX = cos * mx - sin * mz;
    const wishZ = -sin * mx - cos * mz;
    const moving = len > 0.01;

    // --- sprint + stamina ---
    const aiming = (input.b & Buttons.aim) !== 0;
    const wantsSprint = (input.b & Buttons.sprint) !== 0 && !s.crouching && !aiming && mz > 0.1;
    s.sprinting = wantsSprint && (s.sprinting ? s.stamina > 0 : s.stamina >= st.minToSprint);
    if (s.sprinting && moving) {
      s.stamina = Math.max(0, s.stamina - st.sprintDrainPerSec * dt);
      s.staminaDelay = st.regenDelay;
    } else if (s.staminaDelay > 0) {
      s.staminaDelay = Math.max(0, s.staminaDelay - dt);
    } else {
      s.stamina = Math.min(st.max, s.stamina + st.regenPerSec * dt);
    }

    let speed = s.crouching ? MOVEMENT.crouchSpeed : s.sprinting ? MOVEMENT.sprintSpeed : MOVEMENT.walkSpeed;
    if (mz < 0) speed *= MOVEMENT.backpedalMultiplier;
    if (aiming) speed *= COMBAT.aimMoveMultiplier;

    // --- horizontal velocity (exponential approach to target) ---
    const k = s.grounded ? MOVEMENT.groundAccel : MOVEMENT.airAccel;
    const t = 1 - Math.exp(-k * dt);
    s.vel.x += (wishX * speed - s.vel.x) * t;
    s.vel.z += (wishZ * speed - s.vel.z) * t;

    // --- vertical ---
    const wantJump = (input.b & Buttons.jump) !== 0;
    if (s.grounded && wantJump && !s.crouching && s.stamina >= st.jumpCost) {
      s.vel.y = MOVEMENT.jumpVelocity;
      s.stamina -= st.jumpCost;
      s.staminaDelay = st.regenDelay;
      s.grounded = false;
    } else {
      s.vel.y -= MOVEMENT.gravity * dt;
    }

    // --- collide & slide ---
    const desired = { x: s.vel.x * dt, y: s.vel.y * dt, z: s.vel.z * dt };
    this.controller.computeColliderMovement(
      this.collider,
      desired,
      this.R.QueryFilterFlags.EXCLUDE_SENSORS,
      PLAYER_GROUPS,
    );
    const mv = this.controller.computedMovement();
    const c = this.collider.translation();
    this.collider.setTranslation({ x: c.x + mv.x, y: c.y + mv.y, z: c.z + mv.z });

    s.grounded = this.controller.computedGrounded();
    if (s.grounded && s.vel.y < 0) s.vel.y = 0;
    // Bonked a ceiling
    if (s.vel.y > 0 && mv.y < desired.y * 0.5) s.vel.y = 0;
    // Walls absorb the velocity pushing into them (keeps the sliding component).
    // Walkable slopes are ignored so climbing ramps/stairs doesn't bleed speed.
    const wallMaxNy = Math.cos(degToRad(MOVEMENT.maxSlopeDeg));
    for (let i = 0, n = this.controller.numComputedCollisions(); i < n; i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit) continue;
      const nrm = hit.normal1;
      if (nrm.y >= wallMaxNy) continue;
      const hl = Math.hypot(nrm.x, nrm.z);
      if (hl < 1e-4) continue;
      const nx = nrm.x / hl, nz = nrm.z / hl;
      const into = s.vel.x * nx + s.vel.z * nz;
      if (into < 0) {
        s.vel.x -= into * nx;
        s.vel.z -= into * nz;
      }
    }

    s.pos = {
      x: c.x + mv.x,
      y: c.y + mv.y - bodyHeight(s.crouching) / 2,
      z: c.z + mv.z,
    };
    return s;
  }

  dispose(): void {
    this.world.removeCharacterController(this.controller);
    this.world.removeCollider(this.collider, false);
  }
}
