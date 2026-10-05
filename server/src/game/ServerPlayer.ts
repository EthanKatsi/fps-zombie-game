import {
  Buttons,
  CharacterMotor,
  NETWORK,
  PVP,
  createMoveState,
  normalizeInventory,
  sanitizeInput,
  type Inventory,
  type MoveInput,
  type MoveState,
  type PlayerRecord,
  type Rapier,
  type Vec3,
  type AttackRequest,
  type WeaponDef,
} from '@grey/shared';
import { PositionHistory } from './PositionHistory';
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
  alive = true;
  /** Times hurt (mod 256), for client flinch animations. */
  hitCount = 0;
  /** performance.now() of death; respawn is allowed after SURVIVAL.respawn.delaySec. */
  diedAt = 0;
  /** Item being consumed (eating, bandaging...). */
  using: { slot: number; uid: string; defId: string; endsAt: number } | null = null;
  /** Aiming down sights (from the latest movement input). */
  aiming = false;
  /** Random salt for deterministic shot spread, shared with this client at join. */
  readonly shotSalt = (Math.random() * 0x7fffffff) | 0;
  /** Recent positions on the server clock, for lag-compensated hit tests. */
  readonly history = new PositionHistory(PVP.historyMs);
  /** Immune to other players until then (performance.now ms); attacking ends it early. */
  protectedUntil = performance.now() + PVP.spawnProtectionSec * 1000;
  /** Attacks waiting for the inputs that preceded them to be simulated. */
  pendingAttacks: { req: AttackRequest; arrivedAt: number }[] = [];
  combat: {
    lastSeq: number;
    lastAttackAt: number;
    swing: { at: number; weapon: WeaponDef; uid: string | null } | null;
    reload: { slot: number; uid: string; endsAt: number } | null;
  } = { lastSeq: -1, lastAttackAt: -Infinity, swing: null, reload: null };

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

  /**
   * Apply queued inputs within this tick's budget. `onLand` receives the downward speed
   * whenever the player touches ground after being airborne (fall damage).
   */
  simulate(dt: number, onLand?: (impactSpeed: number) => void, onApplied?: () => void): void {
    if (!this.alive) {
      // Dead players don't move; swallow inputs but keep acking so seq numbers stay in order.
      for (const i of this.inputQueue) this.lastSeq = Math.max(this.lastSeq, i.seq);
      this.inputQueue.length = 0;
      return;
    }
    this.credit = Math.min(this.credit + 1, NETWORK.maxInputsPerTick);
    while (this.credit >= 1 && this.inputQueue.length > 0) {
      const input = this.inputQueue.shift()!;
      if (input.seq <= this.lastSeq) continue;
      const before = this.state;
      this.state = this.motor.step(this.state, input, dt);
      this.aiming = (input.b & Buttons.aim) !== 0;
      if (!before.grounded && this.state.grounded && before.vel.y < 0) onLand?.(-before.vel.y);
      this.lastSeq = input.seq;
      this.credit -= 1;
      onApplied?.();
    }
  }

  teleport(pos: Vec3, yaw = this.state.yaw): void {
    this.history.clear();
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
