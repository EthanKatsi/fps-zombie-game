import type { World } from '@dimforge/rapier3d-compat';
import {
  COMBAT,
  SHOT_GROUPS,
  GROUPS,
  sameGroup,
  PVP,
  aimDirection,
  countItem,
  eyeHeight,
  getItemDef,
  humanoidHitboxes,
  pelletDirections,
  rayHitboxes,
  removeItem,
  shotSeed,
  spreadDegrees,
  weaponForItem,
  type AttackRequest,
  type HitKind,
  type Rapier,
  type ShotEnd,
  type Vec3,
  type WeaponDef,
} from '@grey/shared';
import { makeUid } from './ContainerSystem';
import type { DummySystem } from './DummySystem';
import type { InventorySystem } from './InventorySystem';
import type { NoiseSystem } from './NoiseSystem';
import type { ServerPlayer } from './ServerPlayer';
import type { SurvivalSystem } from './SurvivalSystem';
import type { ZombieSystem } from './ZombieSystem';

type Target = { kind: 'player'; p: ServerPlayer } | { kind: 'dummy'; id: number } | { kind: 'zombie'; id: number };

interface RayResult {
  /** Distance along the ray to whatever was hit first (or maxT). */
  t: number;
  target: Target | null;
  head: boolean;
  /** Hit the world (wall, floor, car...) before maxT. */
  world: boolean;
}

interface Projectile {
  id: string;
  owner: ServerPlayer;
  weapon: WeaponDef;
  pos: Vec3;
  vel: Vec3;
  traveled: number;
}

const v3 = (v: Vec3): [number, number, number] => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];
const add = (a: Vec3, d: Vec3, t: number): Vec3 => ({ x: a.x + d.x * t, y: a.y + d.y * t, z: a.z + d.z * t });

/** Rotate a direction by small yaw/pitch offsets (radians) for the melee sweep. */
const offsetDir = (yaw: number, pitch: number, dy: number, dp: number): Vec3 => aimDirection(yaw + dy, pitch + dp);
const MELEE_SWEEP: [number, number][] = [[0, 0], [0.11, 0], [-0.11, 0], [0, 0.09], [0, -0.09]];

/**
 * Server-authoritative combat: validates every attack (sequence, fire rate, ammo, stamina),
 * resolves hitscan / melee / projectile hits against players and dummies,
 * applies damage through the survival system, and broadcasts shots for effects + noise.
 * Lag compensation (rewinding targets to the shooter's view) arrives in milestone 7.
 */
export class WeaponSystem {
  private readonly projectiles = new Map<string, Projectile>();

  constructor(
    private readonly R: Rapier,
    private readonly world: World,
    private readonly players: () => Iterable<ServerPlayer>,
    private readonly survival: SurvivalSystem,
    private readonly items: InventorySystem,
    private readonly dummies: DummySystem,
    private readonly noise: NoiseSystem,
    private readonly zombies: () => ZombieSystem | null,
    /** Server clock (same timeline as snapshots / AttackRequest.viewTime). */
    private readonly serverTime: () => number = () => performance.now(),
  ) {}

  /** Headshot multiplier: zombies have their own (headshots are what kills the dead). */
  private mult(target: Target, head: boolean, w: WeaponDef): number {
    if (!head) return 1;
    return target.kind === 'zombie' ? (this.zombies()?.headshotMultiplier(target.id) ?? w.headshotMultiplier) : w.headshotMultiplier;
  }

  // ------------------------------------------------------------------ helpers

  private eye(p: ServerPlayer): Vec3 {
    const s = p.state;
    return { x: s.pos.x, y: s.pos.y + eyeHeight(s.crouching), z: s.pos.z };
  }

  private held(p: ServerPlayer) {
    const slot = p.inventory.activeHotbar;
    return { slot, item: p.inventory.slots[slot] ?? null };
  }

  /**
   * First thing along a ray: the world, a player (not `ignore`), a dummy or a zombie.
   * With `rewindTo` (server time), players and zombies are tested where they were at that
   * moment - i.e. where the shooter saw them (lag compensation). The world is not rewound.
   */
  private castRay(o: Vec3, d: Vec3, maxT: number, ignore: ServerPlayer | null, rewindTo?: number): RayResult {
    const hit = this.world.castRay(new this.R.Ray(o, d), maxT, true, undefined, SHOT_GROUPS);
    let best: RayResult = { t: hit ? hit.timeOfImpact : maxT, target: null, head: false, world: hit !== null };
    for (const p of this.players()) {
      if (p === ignore || !p.alive) continue;
      const past = rewindTo !== undefined ? p.history.sample(rewindTo) : null;
      const box = past ? humanoidHitboxes(past.pos, past.crouch) : humanoidHitboxes(p.state.pos, p.state.crouching);
      const r = rayHitboxes(o, d, best.t, box);
      if (r) best = { t: r.t, target: { kind: 'player', p }, head: r.head, world: false };
    }
    for (const dm of this.dummies.spawns) {
      if (this.dummies.isDown(dm.id)) continue;
      const r = rayHitboxes(o, d, best.t, this.dummies.hitboxes(dm.id));
      if (r) best = { t: r.t, target: { kind: 'dummy', id: dm.id }, head: r.head, world: false };
    }
    const zs = this.zombies();
    if (zs) {
      for (const z of zs.targets(rewindTo)) {
        const r = rayHitboxes(o, d, best.t, z.hitboxes);
        if (r) best = { t: r.t, target: { kind: 'zombie', id: z.id }, head: r.head, world: false };
      }
    }
    return best;
  }

  /** Apply damage to a target and confirm to the attacker. */
  private hit(attacker: ServerPlayer, target: Target, damage: number, head: boolean, w: WeaponDef, now: number): void {
    let kill = false;
    let kind: HitKind;
    if (target.kind === 'player') {
      kind = 'player';
      const victim = target.p;
      if (!PVP.enabled || now < victim.protectedUntil) return; // spawn protection: no damage, no marker
      if (!GROUPS.friendlyFire && sameGroup(attacker.record.groupId, victim.record.groupId)) return; // teammates
      if (w.bleedChance && Math.random() < w.bleedChance) victim.record.stats.bleeding = true;
      this.survival.damage(victim, damage, 'player', attacker, false, attacker.state.pos, { weapon: w.id, headshot: head });
      kill = !victim.alive;
    } else if (target.kind === 'zombie') {
      kind = 'zombie';
      kill = this.zombies()?.damage(target.id, damage, attacker, now) ?? false;
    } else {
      kind = 'dummy';
      kill = this.dummies.damage(target.id, damage, now);
    }
    attacker.socket.emit('hitConfirm', { kind, head, kill });
  }

  private broadcastShot(shooter: ServerPlayer, weapon: string, o: Vec3, ends: ShotEnd[]): void {
    const r2 = COMBAT.shotBroadcastRadius ** 2;
    for (const p of this.players()) {
      if (p === shooter) continue;
      const dx = p.state.pos.x - o.x, dz = p.state.pos.z - o.z;
      if (dx * dx + dz * dz <= r2) p.socket.emit('shotFired', { shooter: shooter.id, weapon, o: v3(o), ends });
    }
  }

  // ------------------------------------------------------------------ requests

  /**
   * An attack arrives. It's applied right after the movement input that preceded it on the
   * client (so it fires from exactly where the shooter was), deferring if needed.
   */
  attack(p: ServerPlayer, req: AttackRequest): void {
    if (!p.alive || !req || !Number.isInteger(req.seq)) return;
    const c = p.combat;
    // Shots are numbered strictly +1: keeps spread seeds in sync and stops seed shopping.
    if (req.seq !== c.lastSeq + 1) return;
    c.lastSeq = req.seq;
    const after = Number.isInteger(req.afterSeq) ? req.afterSeq : -1;
    if (after > p.lastSeq) {
      if (p.pendingAttacks.length < 8) p.pendingAttacks.push({ req, arrivedAt: performance.now() });
      return;
    }
    this.execute(p, req);
  }

  /** Called after each simulated input: run attacks whose preceding input is now applied. */
  flushPending(p: ServerPlayer): void {
    if (!p.pendingAttacks.length) return;
    const now = performance.now();
    while (p.pendingAttacks.length) {
      const next = p.pendingAttacks[0];
      if (now - next.arrivedAt > PVP.pendingAttackTimeoutMs) {
        p.pendingAttacks.shift();
        continue;
      }
      if (next.req.afterSeq > p.lastSeq) break;
      p.pendingAttacks.shift();
      this.execute(p, next.req);
    }
  }

  private execute(p: ServerPlayer, req: AttackRequest): void {
    if (!p.alive) return;
    const c = p.combat;
    const [dx, dy, dz] = Array.isArray(req.dir) ? req.dir : [NaN, NaN, NaN];
    const len = Math.hypot(dx, dy, dz);
    if (!Number.isFinite(len) || len < 0.5 || len > 1.5) return;
    const dir = { x: dx / len, y: dy / len, z: dz / len };

    const now = performance.now();
    const { item } = this.held(p);
    const def = item ? getItemDef(item.defId) : undefined;
    if (def?.consume) return; // food etc. is "used", not swung
    const w = weaponForItem(item?.defId);
    if (c.reload || c.swing) return;
    const interval = 1000 / w.fireRate;
    if (now - c.lastAttackAt < interval * COMBAT.fireRateTolerance) return;

    // Attacking ends spawn protection.
    p.protectedUntil = 0;
    // Lag compensation window: what the shooter saw, but not too far in the past.
    const st = this.serverTime();
    const vt = Number(req.viewTime);
    const rewindTo = Number.isFinite(vt) ? Math.min(st, Math.max(st - PVP.maxRewindMs, vt)) : undefined;

    if (w.kind === 'melee') {
      const cost = w.staminaCost ?? 0;
      if (p.state.stamina < cost) return;
      p.state = { ...p.state, stamina: p.state.stamina - cost, staminaDelay: 1 };
      c.lastAttackAt = now;
      c.swing = { at: now + (w.swingWindupMs ?? 150), weapon: w, uid: item?.uid ?? null };
      this.noise.emit(this.eye(p), w.noiseRadius, now);
      return;
    }

    // Guns.
    if (!item || (item.loadedAmmo ?? 0) <= 0) return;
    c.lastAttackAt = now;
    item.loadedAmmo = (item.loadedAmmo ?? 0) - 1;
    const eye = this.eye(p);
    const spread = spreadDegrees(w, p.state, req.aim === true && p.aiming);
    const dirs = pelletDirections(dir, spread, w.pellets ?? 1, shotSeed(p.shotSalt, req.seq));
    this.noise.emit(eye, w.noiseRadius, now);

    if (w.kind === 'projectile') {
      const d = dirs[0];
      const id = `${p.id.slice(0, 8)}:${req.seq}`;
      const speed = w.projectileSpeed ?? 60;
      const proj: Projectile = { id, owner: p, weapon: w, pos: add(eye, d, 0.3), vel: { x: d.x * speed, y: d.y * speed, z: d.z * speed }, traveled: 0 };
      this.projectiles.set(id, proj);
      for (const o of this.players()) {
        if (o !== p) o.socket.emit('projectile', { id, owner: p.id, p: v3(proj.pos), v: v3(proj.vel) });
      }
    } else {
      // Hitscan: total damage per target over all pellets.
      const ends: ShotEnd[] = [];
      const dealt = new Map<string, { target: Target; dmg: number; head: boolean }>();
      for (const d of dirs) {
        const r = this.castRay(eye, d, w.range, p, rewindTo);
        const end = add(eye, d, r.t);
        ends.push([...v3(end), r.target ? 2 : r.world ? 1 : 0]);
        if (!r.target) continue;
        const key = r.target.kind === 'player' ? `p:${r.target.p.id}` : `${r.target.kind}:${r.target.id}`;
        const entry = dealt.get(key) ?? { target: r.target, dmg: 0, head: false };
        entry.dmg += w.damage * this.mult(r.target, r.head, w);
        entry.head ||= r.head;
        dealt.set(key, entry);
      }
      for (const e of dealt.values()) this.hit(p, e.target, e.dmg, e.head, w, now);
      this.broadcastShot(p, w.id, eye, ends);
    }
    p.socket.emit('weaponState', { uid: item.uid, loaded: item.loadedAmmo ?? 0 });
  }

  reload(p: ServerPlayer): void {
    if (!p.alive || p.combat.reload) return;
    const { slot, item } = this.held(p);
    const w = weaponForItem(item?.defId);
    if (!item || !w.magazineSize || !w.ammoType) return;
    if ((item.loadedAmmo ?? 0) >= w.magazineSize) return;
    if (countItem(p.inventory.slots, w.ammoType) <= 0) {
      p.socket.emit('notice', { text: 'No ammo' });
      return;
    }
    const ms = w.reloadMs ?? 2000;
    p.combat.reload = { slot, uid: item.uid, endsAt: performance.now() + ms };
    p.socket.emit('reloadStarted', { durationMs: ms });
  }

  /** Forget in-flight actions (death / respawn). */
  reset(p: ServerPlayer): void {
    p.combat.reload = null;
    p.combat.swing = null;
  }

  // ------------------------------------------------------------------ per tick

  update(players: Iterable<ServerPlayer>, now: number, dt: number): void {
    for (const p of players) {
      if (!p.alive) continue;
      this.updateSwing(p, now);
      this.updateReload(p, now);
    }
    this.updateProjectiles(now, dt);
  }

  private updateSwing(p: ServerPlayer, now: number): void {
    const s = p.combat.swing;
    if (!s || now < s.at) return;
    p.combat.swing = null;
    const w = s.weapon;
    const eye = this.eye(p);
    let landed: RayResult | null = null;
    let landedDir: Vec3 | null = null;
    let worldEnd: Vec3 | null = null;
    for (const [dyaw, dpitch] of MELEE_SWEEP) {
      const d = offsetDir(p.state.yaw, p.state.pitch, dyaw, dpitch);
      const r = this.castRay(eye, d, w.range, p);
      if (r.target) {
        landed = r;
        landedDir = d;
        break;
      }
      if (!worldEnd && r.world) worldEnd = add(eye, d, r.t);
    }
    const ends: ShotEnd[] = [];
    if (landed && landedDir) {
      this.hit(p, landed.target!, w.damage * this.mult(landed.target!, landed.head, w), landed.head, w, now);
      ends.push([...v3(add(eye, landedDir, landed.t)), 2]);
    } else if (worldEnd) {
      ends.push([...v3(worldEnd), 1]);
    }
    this.broadcastShot(p, w.id, eye, ends);
  }

  private updateReload(p: ServerPlayer, now: number): void {
    const r = p.combat.reload;
    if (!r) return;
    const item = p.inventory.slots[r.slot];
    if (p.inventory.activeHotbar !== r.slot || !item || item.uid !== r.uid) {
      p.combat.reload = null;
      p.socket.emit('reloadEnded', { completed: false });
      return;
    }
    if (now < r.endsAt) return;
    p.combat.reload = null;
    const w = weaponForItem(item.defId);
    const need = (w.magazineSize ?? 0) - (item.loadedAmmo ?? 0);
    const n = Math.min(need, countItem(p.inventory.slots, w.ammoType!));
    if (n > 0) {
      removeItem(p.inventory.slots, w.ammoType!, n);
      item.loadedAmmo = (item.loadedAmmo ?? 0) + n;
    }
    p.socket.emit('reloadEnded', { completed: n > 0 });
    this.items.sendInventory(p);
  }

  private updateProjectiles(now: number, dt: number): void {
    for (const pr of [...this.projectiles.values()]) {
      const g = pr.weapon.projectileGravity ?? 9.8;
      pr.vel.y -= g * dt;
      const speed = Math.hypot(pr.vel.x, pr.vel.y, pr.vel.z);
      const d = { x: pr.vel.x / speed, y: pr.vel.y / speed, z: pr.vel.z / speed };
      const step = speed * dt;
      const owner = pr.owner;
      const r = this.castRay(pr.pos, d, step, owner);
      let end: 0 | 1 | 2 | null = null;
      if (r.target) {
        // Bolts in flight still count even if the shooter has died meanwhile.
        this.hit(owner, r.target, pr.weapon.damage * this.mult(r.target, r.head, pr.weapon), r.head, pr.weapon, now);
        end = 2;
      } else if (r.world) {
        end = 1;
      }
      pr.pos = add(pr.pos, d, r.t);
      pr.traveled += r.t;
      if (end === null && pr.traveled >= pr.weapon.range) end = 0;
      if (end === null) continue;

      this.projectiles.delete(pr.id);
      for (const o of this.players()) o.socket.emit('projectileEnd', { id: pr.id, p: v3(pr.pos), hit: end });
      if (end === 1 && Math.random() < COMBAT.boltRecoverChance) {
        // Stuck in the world: back off a little so it isn't inside the wall, then make it pickable.
        const at = add(pr.pos, d, -0.15);
        this.items.ground.spawn({ uid: makeUid(), defId: 'bolt', qty: 1 }, at, now);
      }
    }
  }
}
