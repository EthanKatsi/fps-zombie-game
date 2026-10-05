import type { World } from '@dimforge/rapier3d-compat';
import type { CrowdAgent } from 'recast-navigation';
import {
  PLAYER_GROUPS,
  ZOMBIES,
  ZOMBIE_TYPES,
  ZOMBIE_TYPE_ORDER,
  ZombieAnim,
  humanoidHitboxes,
  makeItem,
  rollLoot,
  type DoorColliders,
  type DoorDef,
  type Hitboxes,
  type MapData,
  type NetZombie,
  type Rapier,
  type Vec3,
  type ZombieAIState,
  type ZombieType,
  type ZombieTypeDef,
} from '@grey/shared';
import { makeUid } from './ContainerSystem';
import { PositionHistory } from './PositionHistory';
import type { InventorySystem } from './InventorySystem';
import type { Navigation } from './Navigation';
import type { NoiseSystem } from './NoiseSystem';
import type { ServerPlayer } from './ServerPlayer';
import type { SurvivalSystem } from './SurvivalSystem';

interface ZombieEntity {
  id: number;
  type: ZombieType;
  def: ZombieTypeDef;
  agent: CrowdAgent | null;
  pos: Vec3;
  yaw: number;
  health: number;
  state: ZombieAIState;
  target: ServerPlayer | null;
  /** Where the target was last seen / the noise came from. */
  interest: Vec3 | null;
  lastSeenAt: number;
  stateUntil: number;
  nextThink: number;
  /** Attack windup in progress: lands at this time. */
  attackAt: number;
  cooldownUntil: number;
  deadAt: number;
  /** When no player was last near (for despawning). */
  aloneSince: number;
  /** Noises up to this time have been considered (each zombie thinks on its own schedule). */
  heardUpTo: number;
  /** Recent positions (server clock) for lag-compensated shots. */
  history: PositionHistory;
}

const dist2 = (a: Vec3, b: Vec3) => (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** 2D segment intersection (p1-p2 vs p3-p4) in the XZ plane. */
const segmentsCross = (p1: Vec3, p2: Vec3, p3x: number, p3z: number, p4x: number, p4z: number): boolean => {
  const d = (p2.x - p1.x) * (p4z - p3z) - (p2.z - p1.z) * (p4x - p3x);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((p3x - p1.x) * (p4z - p3z) - (p3z - p1.z) * (p4x - p3x)) / d;
  const u = ((p3x - p1.x) * (p2.z - p1.z) - (p3z - p1.z) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= -0.05 && u <= 1.05;
};

/**
 * Server-side zombies: spawning around players, navmesh crowd movement, senses (vision cone
 * + line of sight, proximity, hearing via NoiseSystem), chasing, lunging attacks, closed doors
 * stopping them, damage/death/corpses and interest-managed snapshots.
 */
export class ZombieSystem {
  private readonly zombies = new Map<number, ZombieEntity>();
  private nextId = 1;
  private nextSpawnCheck = 0;
  private readonly doorGrid = new Map<string, DoorDef[]>();
  /** Spawning can be switched off (tests spawn zombies explicitly). */
  autoSpawn = true;
  /** Set by the day/night clock (milestone 11 lighting); scales the population. */
  isNight: () => boolean = () => false;

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    private readonly nav: Navigation,
    private readonly map: MapData,
    private readonly doors: DoorColliders,
    private readonly players: () => Iterable<ServerPlayer>,
    private readonly survival: SurvivalSystem,
    private readonly noise: NoiseSystem,
    private readonly items: InventorySystem,
  ) {
    for (const d of map.doors) {
      const key = `${Math.floor(d.hinge[0] / 8)},${Math.floor(d.hinge[2] / 8)}`;
      const list = this.doorGrid.get(key) ?? [];
      list.push(d);
      this.doorGrid.set(key, list);
    }
  }

  get count(): number {
    return this.zombies.size;
  }

  // ------------------------------------------------------------------ spawning

  /** Spawn one zombie at (the navmesh point nearest to) `at`. */
  spawn(type: ZombieType, at: Vec3, now = performance.now()): number | null {
    const p = this.nav.closest(at);
    if (!p) return null;
    const def = ZOMBIE_TYPES[type];
    const agent = this.nav.crowd.addAgent(p, {
      radius: 0.35 * def.scale,
      height: 1.8 * def.scale,
      maxSpeed: def.walkSpeed,
      maxAcceleration: 10,
      collisionQueryRange: 2.5,
      pathOptimizationRange: 12,
      separationWeight: 1.5,
    });
    if (!agent) return null;
    const z: ZombieEntity = {
      id: this.nextId++,
      type,
      def,
      agent,
      pos: { ...p },
      yaw: Math.random() * Math.PI * 2,
      health: def.health,
      state: 'idle',
      target: null,
      interest: null,
      lastSeenAt: 0,
      stateUntil: 0,
      nextThink: now + Math.random() * ZOMBIES.thinkIntervalMs,
      attackAt: 0,
      cooldownUntil: 0,
      deadAt: 0,
      aloneSince: now,
      heardUpTo: now,
      history: new PositionHistory(1000),
    };
    this.zombies.set(z.id, z);
    return z.id;
  }

  private rollType(): ZombieType {
    const total = ZOMBIE_TYPE_ORDER.reduce((s, t) => s + ZOMBIE_TYPES[t].spawnWeight, 0);
    let r = Math.random() * total;
    return ZOMBIE_TYPE_ORDER.find((t) => (r -= ZOMBIE_TYPES[t].spawnWeight) < 0) ?? 'walker';
  }

  /** Busier parts of town (apartments, shops) hold more of the dead. */
  private density(p: Vec3): number {
    let d = 1;
    for (const b of this.map.buildings) {
      const cx = b.center[0], cz = b.center[1];
      if ((cx - p.x) ** 2 + (cz - p.z) ** 2 > 60 * 60) continue;
      d += b.type === 'house' ? ZOMBIES.densityPerBuilding / 2 : ZOMBIES.densityPerBuilding;
    }
    return Math.max(ZOMBIES.densityMin, Math.min(ZOMBIES.densityMax, d - 0.6));
  }

  private updateSpawning(players: ServerPlayer[], now: number): void {
    if (!this.autoSpawn || now < this.nextSpawnCheck) return;
    this.nextSpawnCheck = now + ZOMBIES.spawnIntervalSec * 1000;
    const night = this.isNight() ? ZOMBIES.nightMultiplier : 1;
    for (const p of players) {
      if (!p.alive || this.zombies.size >= ZOMBIES.maxTotal) continue;
      const target = Math.round(ZOMBIES.perPlayer * this.density(p.state.pos) * night);
      let near = 0;
      for (const z of this.zombies.values()) if (z.state !== 'dead' && dist2(z.pos, p.state.pos) < ZOMBIES.populationRadius ** 2) near++;
      if (near >= target) continue;
      // A random reachable point at a distance - not right in the player's face.
      for (let attempt = 0; attempt < 4; attempt++) {
        const pt = this.nav.randomAround(p.state.pos, ZOMBIES.spawnMaxDist);
        if (!pt) break;
        const d = Math.sqrt(dist2(pt, p.state.pos));
        if (d < ZOMBIES.spawnMinDist) continue;
        if (players.some((o) => o.alive && dist2(pt, o.state.pos) < ZOMBIES.spawnMinDist ** 2)) continue;
        this.spawn(this.rollType(), pt, now);
        break;
      }
    }
  }

  private remove(z: ZombieEntity): void {
    if (z.agent) {
      this.nav.crowd.removeAgent(z.agent);
      z.agent = null;
    }
    this.zombies.delete(z.id);
  }

  // ------------------------------------------------------------------ AI

  private setSpeed(z: ZombieEntity, speed: number): void {
    z.agent?.updateParameters({ maxSpeed: speed });
  }

  private moveTo(z: ZombieEntity, p: Vec3): void {
    if (!z.agent) return;
    const t = this.nav.closest(p);
    if (t) z.agent.requestMoveTarget(t);
  }

  private stop(z: ZombieEntity): void {
    z.agent?.resetMoveTarget();
  }

  /** Eye-to-chest line of sight (walls and closed doors block it). */
  private canSee(z: ZombieEntity, p: ServerPlayer): boolean {
    const eye = { x: z.pos.x, y: z.pos.y + 1.6 * z.def.scale, z: z.pos.z };
    const tgt = { x: p.state.pos.x, y: p.state.pos.y + (p.state.crouching ? 0.8 : 1.2), z: p.state.pos.z };
    const dx = tgt.x - eye.x, dy = tgt.y - eye.y, dz = tgt.z - eye.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return true;
    const hit = this.world.castRay(new this.R.Ray(eye, { x: dx / len, y: dy / len, z: dz / len }), len, true, undefined, PLAYER_GROUPS);
    return hit === null;
  }

  /** Does the zombie notice this player right now? */
  private senses(z: ZombieEntity, p: ServerPlayer): boolean {
    const dx = p.state.pos.x - z.pos.x, dz = p.state.pos.z - z.pos.z;
    const dy = Math.abs(p.state.pos.y - z.pos.y);
    const d = Math.hypot(dx, dz);
    if (d < ZOMBIES.proximitySense && dy < 2.5) return this.canSee(z, p) || d < 1.5;
    const range = z.def.visionRange * (p.state.crouching ? ZOMBIES.crouchVisionMultiplier : 1);
    if (d > range || dy > 8) return false;
    // Facing: forward = (-sin yaw, -cos yaw).
    const fx = -Math.sin(z.yaw), fz = -Math.cos(z.yaw);
    const cos = (dx * fx + dz * fz) / Math.max(d, 1e-3);
    if (cos < Math.cos(((z.def.visionFov / 2) * Math.PI) / 180)) return false;
    return this.canSee(z, p);
  }

  private think(z: ZombieEntity, players: ServerPlayer[], recentNoises: { pos: Vec3; radius: number; at: number }[], now: number): void {
    const noises = recentNoises.filter((n) => n.at > z.heardUpTo);
    z.heardUpTo = now;
    // Vision / proximity: lock on to the closest player we can sense.
    let best: ServerPlayer | null = null;
    let bestD = Infinity;
    for (const p of players) {
      if (!p.alive) continue;
      const d = dist2(p.state.pos, z.pos);
      if (d < bestD && d < (z.def.visionRange + 5) ** 2 && this.senses(z, p)) {
        best = p;
        bestD = d;
      }
    }
    if (best) {
      if (z.target !== best || z.state !== 'chase') {
        z.target = best;
        z.state = 'chase';
        this.setSpeed(z, z.def.chaseSpeed);
      }
      z.lastSeenAt = now;
      z.interest = { ...best.state.pos };
      this.moveTo(z, best.state.pos);
      return;
    }

    if (z.state === 'chase') {
      const t = z.target;
      if (!t || !t.alive || now - z.lastSeenAt > ZOMBIES.loseTargetSec * 1000) {
        // Lost them: go and search where we last saw them.
        z.target = null;
        z.state = 'investigate';
        z.stateUntil = now + ZOMBIES.investigateSec * 1000;
        this.setSpeed(z, z.def.walkSpeed * 1.4);
        if (z.interest) this.moveTo(z, z.interest);
      } else {
        // Recently seen: keep homing in (they probably went round a corner).
        this.moveTo(z, t.state.pos);
      }
      return;
    }

    // Hearing: the loudest noise we can hear pulls us over to investigate.
    let heard: Vec3 | null = null;
    let heardScore = 0;
    for (const n of noises) {
      const r = n.radius * z.def.hearingMultiplier;
      const d2 = dist2(n.pos, z.pos);
      if (d2 > r * r) continue;
      const score = 1 - Math.sqrt(d2) / r;
      if (score > heardScore) {
        heardScore = score;
        heard = n.pos;
      }
    }
    if (heard) {
      z.state = 'investigate';
      z.interest = { ...heard };
      z.stateUntil = now + ZOMBIES.investigateSec * 1000;
      this.setSpeed(z, z.def.walkSpeed * 1.6);
      this.moveTo(z, heard);
      return;
    }

    if (z.state === 'investigate') {
      const arrived = z.interest && dist2(z.pos, z.interest) < 2.5 * 2.5;
      if (arrived || now > z.stateUntil) {
        z.state = 'idle';
        this.setSpeed(z, z.def.walkSpeed);
      }
      return;
    }

    // Idle / wander: shuffle about now and then.
    if (Math.random() < ZOMBIES.wanderChance * (z.state === 'wander' ? 0.5 : 1)) {
      const p = this.nav.randomAround(z.pos, ZOMBIES.wanderRadius);
      if (p) {
        z.state = 'wander';
        this.setSpeed(z, z.def.walkSpeed);
        this.moveTo(z, p);
      }
    } else if (z.state === 'wander' && z.agent && Math.hypot(z.agent.velocity().x, z.agent.velocity().z) < 0.05) {
      z.state = 'idle';
    }
  }

  /** Lunge at the target when in reach; the hit lands after the windup if still in reach. */
  private updateAttack(z: ZombieEntity, now: number): void {
    const t = z.target;
    if (z.attackAt) {
      if (now < z.attackAt) return;
      z.attackAt = 0;
      z.cooldownUntil = now + z.def.attackCooldownMs;
      if (t && t.alive) {
        const d = Math.hypot(t.state.pos.x - z.pos.x, t.state.pos.z - z.pos.z);
        if (d <= z.def.attackRange * 1.25 && Math.abs(t.state.pos.y - z.pos.y) < 1.6) {
          if (Math.random() < ZOMBIES.bleedChance) t.record.stats.bleeding = true;
          this.survival.damage(t, z.def.attackDamage, 'zombie', null, false, z.pos);
        }
      }
      return;
    }
    if (z.state !== 'chase' || !t || !t.alive || now < z.cooldownUntil) return;
    const d = Math.hypot(t.state.pos.x - z.pos.x, t.state.pos.z - z.pos.z);
    if (d <= z.def.attackRange && Math.abs(t.state.pos.y - z.pos.y) < 1.6) {
      z.attackAt = now + z.def.attackWindupMs;
      z.yaw = Math.atan2(-(t.state.pos.x - z.pos.x), -(t.state.pos.z - z.pos.z));
    }
  }

  /** Closed doors stop zombies (they'll mill about at the door; bashing it comes with raiding). */
  private blockedByDoor(from: Vec3, to: Vec3): boolean {
    const cx = Math.floor(to.x / 8), cz = Math.floor(to.z / 8);
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        for (const d of this.doorGrid.get(`${cx + i},${cz + j}`) ?? []) {
          if (this.doors.open[d.id]) continue;
          if (to.y < d.hinge[1] - 0.6 || to.y > d.hinge[1] + d.height) continue;
          const ex = d.hinge[0] + Math.cos(d.yaw) * d.width;
          const ez = d.hinge[2] - Math.sin(d.yaw) * d.width;
          if (segmentsCross(from, to, d.hinge[0], d.hinge[2], ex, ez)) return true;
        }
      }
    }
    return false;
  }

  // ------------------------------------------------------------------ tick

  update(now: number, dt: number, serverNow = now): void {
    const players = [...this.players()];
    this.updateSpawning(players, now);

    // Noises of the last few seconds; each zombie only reacts to ones it hasn't considered yet.
    const noises = this.noise.since(now - 3000);
    for (const z of this.zombies.values()) {
      if (z.state === 'dead') {
        if (now - z.deadAt > ZOMBIES.corpseSec * 1000) this.remove(z);
        continue;
      }
      if (now >= z.nextThink) {
        z.nextThink = now + ZOMBIES.thinkIntervalMs;
        this.think(z, players, noises, now);
      }
      this.updateAttack(z, now);
      // Hold still while lunging.
      if (z.attackAt && z.agent) z.agent.resetMoveTarget();

      // Despawn zombies nobody is near.
      const anyoneNear = players.some((p) => dist2(p.state.pos, z.pos) < ZOMBIES.despawnDist ** 2);
      if (anyoneNear) z.aloneSince = now;
      else if (now - z.aloneSince > ZOMBIES.despawnAfterSec * 1000) this.remove(z);
    }

    this.nav.crowd.update(dt);

    for (const z of this.zombies.values()) {
      if (!z.agent || z.state === 'dead') continue;
      const p = z.agent.position();
      if (this.blockedByDoor(z.pos, p)) {
        z.agent.teleport(z.pos);
        continue;
      }
      const v = z.agent.velocity();
      if (Math.hypot(v.x, v.z) > 0.15 && !z.attackAt) z.yaw = Math.atan2(-v.x, -v.z);
      z.pos = { x: p.x, y: p.y, z: p.z };
      z.history.push(serverNow, z.pos);
    }
  }

  // ------------------------------------------------------------------ combat

  /** Living zombies that can be hit (optionally where they were at server time `rewindTo`). */
  *targets(rewindTo?: number): Iterable<{ id: number; hitboxes: Hitboxes }> {
    for (const z of this.zombies.values()) {
      if (z.state === 'dead') continue;
      const past = rewindTo !== undefined ? z.history.sample(rewindTo) : null;
      yield { id: z.id, hitboxes: humanoidHitboxes(past ? past.pos : z.pos, false, z.def.scale) };
    }
  }

  headshotMultiplier(id: number): number {
    return this.zombies.get(id)?.def.headshotMultiplier ?? 2;
  }

  /** Apply damage; returns true if this killed it. Getting hurt makes it come for you. */
  damage(id: number, amount: number, attacker: ServerPlayer | null, now: number): boolean {
    const z = this.zombies.get(id);
    if (!z || z.state === 'dead') return false;
    z.health -= amount;
    if (z.health > 0) {
      if (attacker && attacker.alive) {
        z.target = attacker;
        z.state = 'chase';
        z.lastSeenAt = now;
        this.setSpeed(z, z.def.chaseSpeed);
        this.moveTo(z, attacker.state.pos);
      }
      return false;
    }
    z.state = 'dead';
    z.deadAt = now;
    z.attackAt = 0;
    if (z.agent) {
      this.nav.crowd.removeAgent(z.agent);
      z.agent = null;
    }
    if (Math.random() < ZOMBIES.dropChance) {
      const slots = rollLoot('zombie_drop', 1, Math.random, makeUid);
      const s = slots[0];
      if (s) {
        const item = makeItem(s.defId, s.qty, makeUid, Math.random) ?? s;
        this.items.ground.spawn(item, { x: z.pos.x, y: z.pos.y + 0.15, z: z.pos.z }, now);
      }
    }
    return true;
  }

  // ------------------------------------------------------------------ network

  /** Zombies within the interest radius of a viewer. */
  netFor(viewer: Vec3): NetZombie[] {
    const out: NetZombie[] = [];
    const max2 = ZOMBIES.interestRadius ** 2;
    for (const z of this.zombies.values()) {
      if (dist2(z.pos, viewer) > max2) continue;
      let s: number;
      if (z.state === 'dead') s = ZombieAnim.dead;
      else if (z.attackAt) s = ZombieAnim.attack;
      else {
        const v = z.agent?.velocity();
        const speed = v ? Math.hypot(v.x, v.z) : 0;
        s = speed < 0.15 ? ZombieAnim.idle : speed > 2.2 ? ZombieAnim.run : ZombieAnim.walk;
      }
      out.push({ id: z.id, t: ZOMBIE_TYPE_ORDER.indexOf(z.type), p: [r2(z.pos.x), r2(z.pos.y), r2(z.pos.z)], yaw: r2(z.yaw), s });
    }
    return out;
  }

  /** Debug / tests. */
  get(id: number): Readonly<ZombieEntity> | undefined {
    return this.zombies.get(id);
  }

  all(): Iterable<Readonly<ZombieEntity>> {
    return this.zombies.values();
  }
}
