import * as THREE from 'three';
import type { World } from '@dimforge/rapier3d-compat';
import {
  PLAYER_GROUPS,
  countItem,
  getItemDef,
  pelletDirections,
  shotSeed,
  spreadDegrees,
  weaponForItem,
  type Inventory,
  type ItemStack,
  type Rapier,
  type WeaponDef,
} from '@grey/shared';
import type { Connection } from '../../net/Connection';
import type { CombatHud } from '../../ui/CombatHud';
import type { Effects } from '../Effects';
import type { Input } from '../Input';
import type { LocalPlayer } from '../LocalPlayer';
import type { Viewmodel } from './Viewmodel';

const DEG = Math.PI / 180;

export interface WeaponControllerDeps {
  R: Rapier;
  world: World;
  conn: Connection;
  input: Input;
  local: LocalPlayer;
  camera: THREE.PerspectiveCamera;
  viewmodel: Viewmodel;
  effects: Effects;
  hud: CombatHud;
  playerId: string;
  shotSalt: number;
  /** Start using a consumable (eat / drink / bandage). */
  useItem: (slot: number) => void;
  toast: (text: string) => void;
}

/**
 * Turns input into attacks. Everything here is prediction/feedback for responsiveness
 * (tracers, recoil, ammo count, swing animation); the server decides what actually hits.
 */
export class WeaponController {
  private seq = 0;
  private lastAttackAt = -Infinity;
  private reloadingUntil = 0;
  private recoilToRecover = 0;
  private heldKey = '';
  aiming = false;
  private readonly tmp = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();

  constructor(private readonly d: WeaponControllerDeps) {}

  get reloading(): boolean {
    return performance.now() < this.reloadingUntil;
  }

  /** The weapon in hand right now (fists if nothing usable). */
  weaponFor(held: ItemStack | null): WeaponDef {
    return weaponForItem(held?.defId);
  }

  /**
   * Per frame while alive and playing. `slot` is the hotbar slot selected on this client: the
   * server only echoes the inventory on changes, so inv.activeHotbar can lag behind a key press.
   */
  update(dt: number, inv: Inventory, slot: number, usingItem: boolean): void {
    const { input, viewmodel } = this.d;
    const held = inv.slots[slot] ?? null;
    const def = held ? getItemDef(held.defId) : undefined;
    const w = this.weaponFor(held);
    const isWeaponItem = !!def?.weaponId;

    // Swap the viewmodel when the held item changes.
    const key = held ? `${held.uid}` : '';
    if (key !== this.heldKey) {
      this.heldKey = key;
      viewmodel.hold(held && (isWeaponItem || def) ? held.defId : null);
      this.reloadingUntil = 0;
    }
    viewmodel.setLoaded((held?.loadedAmmo ?? 0) > 0);

    // Aim down sights: right mouse with a ranged weapon.
    const ranged = w.kind !== 'melee';
    this.aiming = ranged && isWeaponItem && input.isMouseDown(2) && !this.reloading;
    input.aimActive = this.aiming;

    // Left mouse: consumables are used, weapons/fists attack. Melee repeats while held.
    if (def?.consume) {
      if (input.consumePress('Mouse0') && !usingItem) this.d.useItem(slot);
    } else {
      const pressed = input.consumePress('Mouse0');
      const wants = w.kind === 'melee' ? pressed || input.isMouseDown(0) : pressed;
      if (wants && !usingItem) this.tryAttack(w, held, inv);
    }
    if (input.consumePress('KeyR')) this.tryReload(w, held, inv);

    // Recoil recovery: give back part of the kick smoothly.
    if (this.recoilToRecover > 0) {
      const step = Math.min(this.recoilToRecover, this.recoilToRecover * dt * 7 + 0.0005);
      input.pitch -= step;
      this.recoilToRecover -= step;
    }

    // HUD: ammo + spread crosshair.
    if (ranged && isWeaponItem && w.ammoType) {
      const reserve = countItem(inv.slots, w.ammoType);
      this.d.hud.setAmmo(this.reloading ? 'RELOADING' : `${held?.loadedAmmo ?? 0} / ${reserve}`);
    } else {
      this.d.hud.setAmmo(null);
    }
    const spread = ranged && isWeaponItem ? spreadDegrees(w, this.d.local.state, this.aiming) : 0.6;
    const gap = (Math.tan(spread * DEG) / Math.tan((this.d.camera.fov * DEG) / 2)) * (window.innerHeight / 2);
    this.d.hud.setCrosshair(gap + 4, !this.aiming);
  }

  private tryAttack(w: WeaponDef, held: ItemStack | null, inv: Inventory): void {
    const now = performance.now();
    if (now - this.lastAttackAt < 1000 / w.fireRate || this.reloading) return;
    if (held?.durability !== undefined && held.durability <= 0) {
      this.d.toast('It is broken');
      this.lastAttackAt = now;
      return;
    }
    const { local, viewmodel, camera, conn } = this.d;

    if (w.kind === 'melee') {
      const cost = w.staminaCost ?? 0;
      if (local.state.stamina < cost) return;
      local.state = { ...local.state, stamina: local.state.stamina - cost, staminaDelay: 1 };
      viewmodel.playSwing(w.swingWindupMs ?? 150, w.fireRate);
    } else {
      if (!held || (held.loadedAmmo ?? 0) <= 0) {
        this.lastAttackAt = now;
        if (w.ammoType && countItem(inv.slots, w.ammoType) > 0) this.tryReload(w, held, inv);
        else this.d.toast('Out of ammo');
        return;
      }
      held.loadedAmmo = (held.loadedAmmo ?? 0) - 1;
      this.shootEffects(w);
    }

    camera.getWorldDirection(this.fwd);
    conn.socket.emit('attack', { seq: this.seq, dir: [this.fwd.x, this.fwd.y, this.fwd.z], aim: this.aiming });
    this.seq++;
    this.lastAttackAt = now;
  }

  /** Predicted muzzle flash, tracers, impacts and recoil (the server's result may differ slightly). */
  private shootEffects(w: WeaponDef): void {
    const { R, world, local, camera, viewmodel, effects, input } = this.d;
    viewmodel.playFire();
    camera.getWorldDirection(this.fwd);
    const muzzle = viewmodel.muzzleWorld(camera, new THREE.Vector3());
    const spread = spreadDegrees(w, local.state, this.aiming);
    const dirs = pelletDirections(this.fwd, spread, w.pellets ?? 1, shotSeed(this.d.shotSalt, this.seq));
    if (w.noiseRadius > 30) effects.muzzleFlash(muzzle, this.fwd);

    if (w.kind === 'projectile') {
      const d0 = dirs[0];
      const speed = w.projectileSpeed ?? 60;
      const start = camera.position.clone().addScaledVector(new THREE.Vector3(d0.x, d0.y, d0.z), 0.3);
      effects.spawnBolt(`${this.d.playerId.slice(0, 8)}:${this.seq}`, start, new THREE.Vector3(d0.x * speed, d0.y * speed, d0.z * speed), w.projectileGravity ?? 9.8);
    } else {
      const o = camera.position;
      for (const d of dirs) {
        const ray = new R.Ray({ x: o.x, y: o.y, z: o.z }, d);
        const hit = world.castRay(ray, w.range, true, undefined, PLAYER_GROUPS, local.motor.collider);
        const t = hit ? hit.timeOfImpact : w.range;
        const end = this.tmp.set(o.x + d.x * t, o.y + d.y * t, o.z + d.z * t).clone();
        effects.tracer(muzzle, end);
        if (hit) effects.impact(end, false);
      }
    }

    // Camera kick: up, plus a random sideways jolt. Some of it recovers automatically.
    const k = this.aiming ? 0.55 : 1;
    const up = (w.recoilPitch ?? 0) * DEG * k;
    input.pitch = Math.min(Math.PI / 2 - 0.01, input.pitch + up);
    input.yaw += (Math.random() * 2 - 1) * (w.recoilYaw ?? 0) * DEG * k;
    this.recoilToRecover += up * 0.6;
  }

  private tryReload(w: WeaponDef, held: ItemStack | null, inv: Inventory): void {
    if (!held || !w.magazineSize || !w.ammoType || this.reloading) return;
    if ((held.loadedAmmo ?? 0) >= w.magazineSize) return;
    if (countItem(inv.slots, w.ammoType) <= 0) {
      this.d.toast('No ammo');
      return;
    }
    this.d.conn.socket.emit('reload');
  }

  // ---------------------------------------------------------------- server feedback

  onWeaponState(inv: Inventory | null, msg: { uid: string; loaded: number; durability?: number }): void {
    const item = inv?.slots.find((s) => s?.uid === msg.uid);
    if (!item) return;
    item.loadedAmmo = msg.loaded;
    if (msg.durability !== undefined) item.durability = msg.durability;
  }

  onReloadStarted(ms: number): void {
    this.reloadingUntil = performance.now() + ms;
    this.d.viewmodel.playReload(ms);
  }

  onReloadEnded(): void {
    this.reloadingUntil = 0;
    this.d.viewmodel.stopReload();
  }

  /** Forget pending state (death / respawn). */
  reset(): void {
    this.reloadingUntil = 0;
    this.recoilToRecover = 0;
    this.aiming = false;
    this.d.input.aimActive = false;
  }
}
