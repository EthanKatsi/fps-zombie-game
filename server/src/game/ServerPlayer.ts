import {
  CharacterMotor,
  NETWORK,
  createMoveState,
  sanitizeInput,
  type MoveInput,
  type MoveState,
  type PlayerRecord,
  type Rapier,
  type Vec3,
} from '@grey/shared';
import type { World } from '@dimforge/rapier3d-compat';
import type { GameSocket } from './types';

export class ServerPlayer {
  state: MoveState;
  readonly motor: CharacterMotor;
  private inputQueue: MoveInput[] = [];
  /** Highest input seq applied; acknowledged in every snapshot. */
  lastSeq = -1;
  /** Input budget: +1 per tick, capped. Prevents speedhacks via input flooding. */
  private credit = 0;

  constructor(
    R: Rapier,
    world: World,
    readonly socket: GameSocket,
    readonly record: PlayerRecord,
    spawn: Vec3,
  ) {
    this.state = createMoveState(spawn, record.yaw);
    this.state.stamina = record.stats.stamina;
    this.motor = new CharacterMotor(R, world, this.state);
  }

  get id(): string {
    return this.record.id;
  }

  get username(): string {
    return this.record.username;
  }

  enqueueInputs(raw: unknown): void {
    if (!Array.isArray(raw)) return;
    for (const r of raw.slice(0, 10)) {
      const input = sanitizeInput(r as MoveInput);
      if (!input || input.seq <= this.lastSeq) continue;
      if (this.inputQueue.length >= NETWORK.maxInputQueue) return;
      this.inputQueue.push(input);
    }
  }

  /** Apply queued inputs within this tick's budget. */
  simulate(dt: number): void {
    this.credit = Math.min(this.credit + 1, NETWORK.maxInputsPerTick);
    while (this.credit >= 1 && this.inputQueue.length > 0) {
      const input = this.inputQueue.shift()!;
      if (input.seq <= this.lastSeq) continue;
      this.state = this.motor.step(this.state, input, dt);
      this.lastSeq = input.seq;
      this.credit -= 1;
    }
  }

  teleport(pos: Vec3): void {
    this.state = createMoveState(pos, this.state.yaw);
    this.motor.syncCollider(this.state);
  }

  /** Copy live state into the persisted record. */
  toRecord(): PlayerRecord {
    this.record.position = { ...this.state.pos };
    this.record.yaw = this.state.yaw;
    this.record.stats.stamina = this.state.stamina;
    this.record.lastSeenAt = Date.now();
    return this.record;
  }

  dispose(): void {
    this.motor.dispose();
  }
}
