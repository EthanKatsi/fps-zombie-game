import {
  CharacterMotor,
  NETWORK,
  createMoveState,
  normalizeInventory,
  sanitizeInput,
  type Inventory,
  type MoveInput,
  type MoveState,
  type PlayerRecord,
  type Rapier,
  type Vec3,
} from '@grey/shared';
import type { World } from '@dimforge/rapier3d-compat';
import type { GameSocket } from './types';
import type { WorldContainer } from './ContainerSystem';

export class ServerPlayer {
  state: MoveState;
  readonly motor: CharacterMotor;
  private inputQueue: MoveInput[] = [];
  /** Highest input seq applied; acknowledged in every snapshot. */
  lastSeq = -1;
  /** Input budget: +1 per tick, capped. Prevents speedhacks via input flooding. */
  private credit = 0;
  /** Rate limit for E-presses (ms, performance.now clock). */
  nextInteractAt = 0;
  /** Container the player currently has open (inventory screen). */
  openContainer: WorldContainer | null = null;
  /** Ground item ids this client has been told about (interest management). */
  knownGround = new Set<string>();

  constructor(
    R: Rapier,
    world: World,
    readonly socket: GameSocket,
    readonly record: PlayerRecord,
    spawn: Vec3,
  ) {
    record.inventory = normalizeInventory(record.inventory);
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

  /** Live inventory (persisted as part of the player record). */
  get inventory(): Inventory {
    return this.record.inventory;
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

  teleport(pos: Vec3, yaw = this.state.yaw): void {
    this.state = createMoveState(pos, yaw);
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
