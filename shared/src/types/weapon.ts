export type WeaponKind = 'melee' | 'hitscan' | 'projectile';
export type AmmoType = 'ammo_9mm' | 'ammo_12g' | 'ammo_556' | 'ammo_308' | 'bolt';

/** Static weapon definition. All numbers live in config/weapons.ts for balancing. */
export interface WeaponDef {
  id: string;
  kind: WeaponKind;
  /** Damage per hit (per pellet for shotguns). */
  damage: number;
  headshotMultiplier: number;
  /** Shots (or swings) per second. */
  fireRate: number;
  /** Max reach / range (m). */
  range: number;
  /** Radius (m) in which zombies hear this weapon. Melee is quiet, guns are loud. */
  noiseRadius: number;
  /** Chance (0-1) a hit makes the victim bleed. */
  bleedChance?: number;
  // Melee
  staminaCost?: number;
  /** Delay between pressing attack and the hit landing. */
  swingWindupMs?: number;
  /** Damage to structures (raiding, milestone 10). */
  structureDamage?: number;
  // Ranged
  /** Keeps firing while the trigger is held (otherwise one shot per click). */
  automatic?: boolean;
  ammoType?: AmmoType;
  magazineSize?: number;
  reloadMs?: number;
  pellets?: number;
  /** Degrees of cone spread (full angle / 2). */
  spreadHip?: number;
  spreadAds?: number;
  /** Extra spread at full movement speed. */
  spreadMoving?: number;
  /** Degrees of camera kick per shot (pitch up / random yaw). */
  recoilPitch?: number;
  recoilYaw?: number;
  /** Projectile weapons. */
  projectileSpeed?: number;
  projectileGravity?: number;
  /** Field of view while aiming down sights. */
  adsFov?: number;
  /** Aiming switches to a full-screen scope overlay (first person). */
  scope?: boolean;
}

/** Runtime weapon state held by the server for the active item. */
export interface WeaponState {
  itemUid: string;
  loadedAmmo: number;
  nextFireAt: number;
  reloadingUntil: number;
}
