import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  CharacterMotor,
  NETWORK,
  TICK_DT,
  cloneMoveState,
  eyeHeight,
  type MoveInput,
  type MoveState,
  type Rapier,
} from '@grey/shared';
import type { Input } from './Input';

/**
 * Client-side prediction + server reconciliation for the local player.
 *  - Every fixed tick: sample input, simulate it locally, remember it, send it.
 *  - On each snapshot: rewind to the server's state for the last acked input and
 *    replay the inputs the server hasn't processed yet.
 *  - Small corrections are blended out visually instead of snapping the camera.
 */
export class LocalPlayer {
  state: MoveState;
  private prev: MoveState;
  readonly motor: CharacterMotor;
  private pending: MoveInput[] = [];
  private seq = 0;
  private readonly errorOffset = new THREE.Vector3();
  private eye: number;
  lastCorrection = 0;

  constructor(R: Rapier, world: World, initial: MoveState, private readonly input: Input) {
    this.state = cloneMoveState(initial);
    this.prev = cloneMoveState(initial);
    this.motor = new CharacterMotor(R, world, this.state);
    input.yaw = initial.yaw;
    input.pitch = initial.pitch;
    this.eye = eyeHeight(initial.crouching);
  }

  /** Run one prediction tick and return the input to send to the server. */
  fixedUpdate(): MoveInput {
    const { mx, mz, b } = this.input.sample();
    const cmd: MoveInput = { seq: ++this.seq, mx, mz, b, yaw: this.input.yaw, pitch: this.input.pitch };
    this.prev = this.state;
    this.state = this.motor.step(this.state, cmd, TICK_DT);
    this.pending.push(cmd);
    if (this.pending.length > 120) this.pending.shift(); // ~4s; server is hopelessly behind
    return cmd;
  }

  reconcile(ack: number, server: MoveState): void {
    while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();

    const before = this.state.pos;
    let s = cloneMoveState(server);
    this.motor.syncCollider(s);
    for (const cmd of this.pending) s = this.motor.step(s, cmd, TICK_DT);

    const err = new THREE.Vector3(before.x - s.pos.x, before.y - s.pos.y, before.z - s.pos.z);
    this.lastCorrection = err.length();
    if (this.lastCorrection > NETWORK.reconcileSnapDistance) {
      this.errorOffset.set(0, 0, 0);
      this.prev = cloneMoveState(s);
    } else if (this.lastCorrection > 1e-4) {
      this.errorOffset.add(err);
      this.prev = cloneMoveState(this.prev);
      this.prev.pos = { x: this.prev.pos.x - err.x, y: this.prev.pos.y - err.y, z: this.prev.pos.z - err.z };
    }
    this.state = s;
  }

  /** Place the camera, interpolating between the last two predicted ticks. */
  updateCamera(camera: THREE.PerspectiveCamera, alpha: number, dt: number): void {
    this.errorOffset.multiplyScalar(Math.exp(-dt * 15));
    const targetEye = eyeHeight(this.state.crouching);
    this.eye += (targetEye - this.eye) * (1 - Math.exp(-dt * 14));
    const a = this.prev.pos, b = this.state.pos;
    camera.position.set(
      a.x + (b.x - a.x) * alpha + this.errorOffset.x,
      a.y + (b.y - a.y) * alpha + this.errorOffset.y + this.eye,
      a.z + (b.z - a.z) * alpha + this.errorOffset.z,
    );
    camera.rotation.set(this.input.pitch, this.input.yaw, 0, 'YXZ');
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}
