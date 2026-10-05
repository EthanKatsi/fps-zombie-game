/**
 * Player movement tuning. Shared by client prediction and the authoritative server,
 * so changing a value here changes both (restart the server after editing).
 * Units: meters, seconds, meters/second.
 */
export const MOVEMENT = {
  walkSpeed: 4.2,
  sprintSpeed: 7.0,
  crouchSpeed: 2.0,
  /** Speed multiplier when moving backwards. */
  backpedalMultiplier: 0.75,

  /** How quickly ground velocity reaches the target (1/s). Higher = snappier. */
  groundAccel: 12,
  airAccel: 2,
  gravity: 22,
  jumpVelocity: 7.2,

  // Capsule dimensions
  radius: 0.35,
  standHeight: 1.8,
  crouchHeight: 1.15,
  eyeHeightStand: 1.65,
  eyeHeightCrouch: 1.0,

  // Character controller
  maxStepHeight: 0.45,
  minStepWidth: 0.2,
  snapToGround: 0.35,
  maxSlopeDeg: 50,
  /** Small gap Rapier keeps between the capsule and geometry. */
  skinOffset: 0.02,
} as const;
