import type { Collider, World } from '@dimforge/rapier3d-compat';
import {
  MOVEMENT,
  GROUPS,
  getItemDef,
  sameGroup,
  PLAYER_GROUPS,
  PVP,
  VEHICLES,
  VEHICLE_RULES,
  VEHICLE_TYPE_ORDER,
  VehicleMotor,
  cloneVehicleState,
  createVehicleCollider,
  createVehicleState,
  seatFeet,
  vehicleAxes,
  vehicleBox,
  pushOutOfBox,
  type DriveInfo,
  type ObstacleBox,
  type MapData,
  type MoveInput,
  type NetVehicle,
  type Rapier,
  type Vec3,
  type VehicleDef,
  type VehicleSpawn,
  type VehicleState,
  type VehicleType,
} from '@grey/shared';
import type { ServerPlayer } from './ServerPlayer';
import type { SurvivalSystem } from './SurvivalSystem';
import type { NoiseSystem } from './NoiseSystem';
import type { ZombieSystem } from './ZombieSystem';
import type { InventorySystem } from './InventorySystem';

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** Abandoned vehicles have some fuel left, rarely a full tank. */
const spawnFuel = (d: VehicleDef): number => {
  const [lo, hi] = VEHICLE_RULES.spawnFuel;
  return Math.round(d.tankLiters * (lo + (hi - lo) * Math.random()) * 10) / 10;
};

export class ServerVehicle {
  readonly def: VehicleDef;
  state: VehicleState;
  readonly collider: Collider;
  readonly motor: VehicleMotor;
  health: number;
  wrecked = false;
  wreckedAt = 0;
  readonly seats: (ServerPlayer | null)[];
  /** Stepped by its driver's input this tick (otherwise it coasts). */
  driven = false;
  lastNoiseAt = 0;
  /** Run-over cooldown per target (zombie id / player id) -> time. */
  readonly hitCooldown = new Map<string, number>();

  constructor(R: Rapier, world: World, readonly id: number, readonly type: VehicleType, readonly spawn: VehicleSpawn) {
    this.def = VEHICLES[type];
    this.state = createVehicleState({ x: spawn.p[0], y: spawn.p[1], z: spawn.p[2] }, spawn.yaw, spawnFuel(this.def));
    this.collider = createVehicleCollider(R, world, type, this.state);
    this.motor = new VehicleMotor(R, world, type, this.collider);
    this.health = this.def.health;
    this.seats = this.def.seats.map(() => null);
  }

  get driver(): ServerPlayer | null {
    return this.seats[0];
  }

  get occupied(): boolean {
    return this.seats.some(Boolean);
  }
}

/**
 * Server-authoritative vehicles. A seated player's movement inputs are routed here
 * (ServerPlayer.seatInput): the driver's inputs step the vehicle, passengers only look around.
 */
export class VehicleSystem {
  readonly vehicles: ServerVehicle[];

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    map: MapData,
    private readonly players: () => Iterable<ServerPlayer>,
    private readonly survival: SurvivalSystem,
    private readonly noise: NoiseSystem,
    private readonly zombies: () => ZombieSystem | null,
    private readonly items: InventorySystem,
  ) {
    this.vehicles = map.vehicleSpawns.map((s, i) => new ServerVehicle(R, world, i, s.type, s));
    for (const v of this.vehicles) v.motor.obstacles = () => this.boxes(v.id);
  }

  /** Vehicle footprints for push-out collisions (optionally leaving one out). */
  boxes(except: number | null): ObstacleBox[] {
    const out: ObstacleBox[] = [];
    for (const v of this.vehicles) if (v.id !== except) out.push(vehicleBox(v.id, v.type, v.state));
    return out;
  }

  seatOf(p: ServerPlayer): { v: ServerVehicle; seat: number } | null {
    for (const v of this.vehicles) {
      const seat = v.seats.indexOf(p);
      if (seat >= 0) return { v, seat };
    }
    return null;
  }

  // ------------------------------------------------------------------ getting in and out

  enter(p: ServerPlayer, id: number): void {
    const v = this.vehicles[id];
    if (!v || !p.alive || this.seatOf(p)) return;
    if (v.wrecked) return void p.socket.emit('notice', { text: 'It is a burnt-out wreck' });
    const dx = v.state.pos.x - p.state.pos.x, dz = v.state.pos.z - p.state.pos.z;
    if (Math.hypot(dx, dz) > VEHICLE_RULES.enterRange + v.def.size[2] / 2 || Math.abs(v.state.pos.y - p.state.pos.y) > 2.5) return;
    const seat = v.seats.indexOf(null);
    if (seat < 0) return void p.socket.emit('notice', { text: 'No free seats' });
    v.seats[seat] = p;
    p.using = null;
    p.combat.reload = null;
    p.seatInput = (pl, input, dt) => this.onInput(pl, input, dt);
    this.placeOccupant(v, seat, p, p.state.yaw, p.state.pitch);
  }

  exit(p: ServerPlayer, force = false): boolean {
    const s = this.seatOf(p);
    if (!s) return false;
    const { v, seat } = s;
    if (!force && Math.abs(v.state.speed) > VEHICLE_RULES.maxExitSpeed) {
      p.socket.emit('notice', { text: 'Slow down to get out' });
      return false;
    }
    const spot = this.exitSpot(v, seat, p);
    if (!spot && !force) {
      p.socket.emit('notice', { text: 'No room to get out here' });
      return false;
    }
    v.seats[seat] = null;
    p.seatInput = null;
    p.teleport(spot ?? { x: v.state.pos.x, y: v.state.pos.y + v.def.size[1] + 0.5, z: v.state.pos.z }, p.state.yaw);
    return true;
  }

  /** Beside your door, then the other side, then behind / in front. */
  private exitSpot(v: ServerVehicle, seat: number, p: ServerPlayer): Vec3 | null {
    const [sx] = v.def.seats[seat];
    const { fx, fz, rx, rz } = vehicleAxes(v.state.yaw);
    const W = v.def.size[0] / 2 + MOVEMENT.radius + 0.25;
    const L = v.def.size[2] / 2 + MOVEMENT.radius + 0.3;
    const side = sx > 0 ? 1 : -1;
    const shape = new this.R.Capsule(MOVEMENT.standHeight / 2 - MOVEMENT.radius, MOVEMENT.radius);
    for (const [u, w] of [[side * W, 0], [-side * W, 0], [0, -L], [0, L]]) {
      const pos = { x: v.state.pos.x + rx * u + fx * w, y: v.state.pos.y + 0.1, z: v.state.pos.z + rz * u + fz * w };
      const hit = this.world.intersectionWithShape(
        { x: pos.x, y: pos.y + MOVEMENT.standHeight / 2 + 0.05, z: pos.z },
        { x: 0, y: 0, z: 0, w: 1 },
        shape,
        this.R.QueryFilterFlags.EXCLUDE_SENSORS,
        PLAYER_GROUPS,
        p.motor.collider,
      );
      // Not inside another vehicle either.
      const inCar = this.boxes(null).some((b) => pos.y < b.y1 && pushOutOfBox(b, pos.x, pos.z, MOVEMENT.radius));
      if (hit === null && !inCar) return pos;
    }
    return null;
  }

  /** The occupant's movement state follows their seat (crouched hitboxes, looking where they look). */
  private placeOccupant(v: ServerVehicle, seat: number, p: ServerPlayer, yaw: number, pitch: number): void {
    const feet = seatFeet(v.type, v.state, seat);
    p.state = { ...p.state, pos: feet, vel: { x: 0, y: 0, z: 0 }, yaw, pitch, grounded: true, crouching: true, sprinting: false };
    p.motor.syncCollider(p.state);
  }

  /** A seated player's input (from ServerPlayer.simulate). */
  private onInput(p: ServerPlayer, input: MoveInput, dt: number): void {
    const s = this.seatOf(p);
    if (!s) return;
    const { v, seat } = s;
    if (seat === 0 && !v.wrecked) {
      const res = v.motor.step(v.state, input, dt);
      v.state = res.state;
      v.driven = true;
      if (res.impact > 0) this.crash(v, res.impact);
    }
    this.placeOccupant(v, seat, p, input.yaw, input.pitch);
  }

  // ------------------------------------------------------------------ simulation

  update(now: number, dt: number): void {
    for (const v of this.vehicles) {
      // Nobody at the wheel: roll to a stop / fall onto the ground. (A driver's vehicle only moves
      // with their inputs, exactly like their client predicts, so a late input never double-steps.)
      if (!v.driver && (Math.abs(v.state.speed) > 0.02 || !v.state.grounded)) {
        const res = v.motor.step(v.state, null, dt);
        v.state = res.state;
          if (res.impact > 0) this.crash(v, res.impact);
      }
      v.driven = false;
      // Passengers ride along even when no input of theirs arrived this tick.
      v.seats.forEach((p, seat) => p && this.placeOccupant(v, seat, p, p.state.yaw, p.state.pitch));
      if (Math.abs(v.state.speed) >= VEHICLE_RULES.runOverMinSpeed) this.runOver(v, now);
      // Engine noise draws the dead.
      if (v.driver && now - v.lastNoiseAt > 1000) {
        v.lastNoiseAt = now;
        const loud = 0.5 + 0.5 * Math.min(1, Math.abs(v.state.speed) / v.def.maxSpeed);
        this.noise.emit(v.state.pos, VEHICLE_RULES.engineNoiseRadius * loud, now);
      }
      if (v.wrecked && !v.occupied && now - v.wreckedAt > VEHICLE_RULES.respawnAfterSec * 1000) this.respawn(v);
    }
  }

  /** Only real crashes count: scrapes and bumps below the threshold do nothing. */
  private crash(v: ServerVehicle, impact: number): void {
    const R = VEHICLE_RULES;
    if (impact <= R.crashSpeedThreshold) return;
    this.damage(v, R.crashDamageBase + (impact - R.crashSpeedThreshold) * R.crashDamagePerMps);
    const hurt = (impact - R.occupantInjurySpeed) * R.occupantDamagePerMps;
    if (hurt > 0) for (const p of v.seats) if (p) this.survival.damage(p, hurt, 'unknown');
  }

  /** Damage a vehicle; at 0 it becomes a wreck and throws everyone out. */
  damage(v: ServerVehicle, amount: number): void {
    if (v.wrecked) return;
    v.health -= amount;
    if (v.health > 0) return;
    v.health = 0;
    v.wrecked = true;
    v.wreckedAt = performance.now();
    v.state = { ...v.state, speed: 0 };
    for (const p of [...v.seats]) {
      if (!p) continue;
      p.socket.emit('notice', { text: 'The engine dies in a cloud of smoke' });
      this.exit(p, true);
    }
  }

  private respawn(v: ServerVehicle): void {
    v.state = createVehicleState({ x: v.spawn.p[0], y: v.spawn.p[1], z: v.spawn.p[2] }, v.spawn.yaw, spawnFuel(v.def));
    v.motor.sync(v.state);
    v.health = v.def.health;
    v.wrecked = false;
  }

  /** Is a point inside the vehicle's footprint (plus a margin)? */
  private touches(v: ServerVehicle, t: Vec3, margin: number): boolean {
    const { fx, fz, rx, rz } = vehicleAxes(v.state.yaw);
    const dx = t.x - v.state.pos.x, dz = t.z - v.state.pos.z;
    const lx = dx * rx + dz * rz, lz = dx * fx + dz * fz;
    return Math.abs(lx) < v.def.size[0] / 2 + margin && Math.abs(lz) < v.def.size[2] / 2 + margin && Math.abs(t.y - v.state.pos.y) < 2;
  }

  private runOver(v: ServerVehicle, now: number): void {
    const speed = Math.abs(v.state.speed);
    const dmg = speed * VEHICLE_RULES.runOverDamagePerMps;
    const ready = (key: string) => (v.hitCooldown.get(key) ?? 0) < now;
    let hits = 0;
    const zs = this.zombies();
    if (zs) {
      for (const z of zs.aliveNear(v.state.pos, v.def.size[2])) {
        const key = `z${z.id}`;
        if (!ready(key) || !this.touches(v, z.pos, 0.35)) continue;
        v.hitCooldown.set(key, now + 700);
        zs.damage(z.id, dmg, v.driver, now);
        hits++;
      }
    }
    for (const p of this.players()) {
      if (!p.alive || p.seatInput) continue;
      const key = `p${p.id}`;
      if (!ready(key) || !this.touches(v, p.state.pos, MOVEMENT.radius)) continue;
      const driver = v.driver;
      if (driver && (!PVP.enabled || now < p.protectedUntil)) continue;
      if (driver && !GROUPS.friendlyFire && sameGroup(driver.record.groupId, p.record.groupId)) continue;
      v.hitCooldown.set(key, now + 700);
      this.survival.damage(p, dmg, driver ? 'player' : 'unknown', driver, false, v.state.pos, { weapon: 'vehicle' });
      hits++;
    }
    if (hits > 0) v.state = { ...v.state, speed: v.state.speed * VEHICLE_RULES.runOverSlowdown };
    if (v.hitCooldown.size > 64) for (const [k, t] of v.hitCooldown) if (t < now) v.hitCooldown.delete(k);
  }

  // ------------------------------------------------------------------ fuel

  /** The gas can in the player's hand, if any. */
  private heldCan(p: ServerPlayer) {
    const item = p.inventory.slots[p.inventory.activeHotbar];
    const def = item && getItemDef(item.defId);
    return item && def?.fuelCan ? { item, capacity: def.fuelCan.liters } : null;
  }

  /** Pour the held gas can into a vehicle. */
  refuel(p: ServerPlayer, id: number): boolean {
    const v = this.vehicles[id];
    const can = this.heldCan(p);
    if (!v || !can || !p.alive || this.seatOf(p)) return false;
    if (Math.hypot(v.state.pos.x - p.state.pos.x, v.state.pos.z - p.state.pos.z) > VEHICLE_RULES.enterRange + v.def.size[2] / 2) return false;
    if (v.wrecked) return void p.socket.emit('notice', { text: 'It is a burnt-out wreck' }), false;
    const have = can.item.fuel ?? 0;
    if (have <= 0) return void p.socket.emit('notice', { text: 'The gas can is empty' }), false;
    const room = v.def.tankLiters - v.state.fuel;
    if (room < 0.1) return void p.socket.emit('notice', { text: 'The tank is full' }), false;
    const poured = Math.min(have, room);
    v.state = { ...v.state, fuel: v.state.fuel + poured };
    can.item.fuel = Math.round((have - poured) * 10) / 10;
    p.socket.emit('notice', { text: `Poured ${poured.toFixed(1)} L into the ${v.def.name} (${Math.round(v.state.fuel)}/${v.def.tankLiters} L)` });
    this.items.sendInventory(p);
    return true;
  }

  /** Fill the held gas can at a gas station pump (the station's tanks still hold fuel). */
  pump(p: ServerPlayer, pumpId: number, pumps: [number, number, number][]): boolean {
    const pos = pumps[pumpId];
    const can = this.heldCan(p);
    if (!pos || !p.alive || this.seatOf(p)) return false;
    if (!can) return void p.socket.emit('notice', { text: 'You need a gas can' }), false;
    if (Math.hypot(pos[0] - p.state.pos.x, pos[2] - p.state.pos.z) > 3) return false;
    if ((can.item.fuel ?? 0) >= can.capacity) return void p.socket.emit('notice', { text: 'The gas can is already full' }), false;
    can.item.fuel = can.capacity;
    p.socket.emit('notice', { text: `Filled the gas can (${can.capacity} L)` });
    this.items.sendInventory(p);
    return true;
  }

  /** Zombies can't reach people inside cars and pickups (they can on a motorcycle). */
  canBeBitten(p: ServerPlayer): boolean {
    const s = p.seatInput ? this.seatOf(p) : null;
    return !s || !s.v.def.enclosed;
  }

  /** Called when a player dies or leaves: they fall out of their seat. */
  onPlayerGone(p: ServerPlayer): void {
    const s = this.seatOf(p);
    if (!s) return;
    s.v.seats[s.seat] = null;
    p.seatInput = null;
    if (p.alive) this.exit(p, true);
  }

  // ------------------------------------------------------------------ networking

  netFor(pos: Vec3): NetVehicle[] {
    const r2max = VEHICLE_RULES.interestRadius ** 2;
    const out: NetVehicle[] = [];
    for (const v of this.vehicles) {
      const dx = v.state.pos.x - pos.x, dz = v.state.pos.z - pos.z;
      if (dx * dx + dz * dz > r2max) continue;
      out.push({
        id: v.id,
        t: VEHICLE_TYPE_ORDER.indexOf(v.type),
        p: [r2(v.state.pos.x), r2(v.state.pos.y), r2(v.state.pos.z)],
        yaw: r2(v.state.yaw),
        s: r2(v.state.speed),
        st: r2(v.state.steer),
        hp: r2(v.health / v.def.health),
        w: v.wrecked,
        f: r2(v.state.fuel / v.def.tankLiters),
        d: v.driver !== null,
      });
    }
    return out;
  }

  driveFor(p: ServerPlayer): DriveInfo | null {
    const s = this.seatOf(p);
    return s ? { id: s.v.id, type: s.v.type, seat: s.seat, state: cloneVehicleState(s.v.state) } : null;
  }
}
