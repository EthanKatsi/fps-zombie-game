export type WeaponKind = 'melee' | 'hitscan' | 'projectile';
export type AmmoType = 'ammo_9mm' | 'ammo_12g' | 'ammo_556' | 'bolt';

/** Static weapon definition. All numbers live in config/weapons.ts for balancing. */
export interface WeaponDef {
  id: string;
  kind: WeaponKind;
  damage: number;
  headshotMultiplier: number;
  /** Shots (or swings) per second. */
  fireRate: number;
  range: number;
  /** Radius (m) in which zombies hear this weapon. Melee is quiet, guns are loud. */
  noiseRadius: number;
  // Melee
  staminaCost?: number;
  swingWindupMs?: number;
  /** Damage to structures (raiding). */
  structureDamage?: number;
  // Ranged
  ammoType?: AmmoType;
  magazineSize?: number;
  reloadMs?: number;
  pellets?: number;
  /** Degrees of cone spread. */
  spreadHip?: number;
  spreadAds?: number;
  spreadMoving?: number;
  /** Degrees of camera kick per shot (pitch / random yaw). */
  recoilPitch?: number;
  recoilYaw?: number;
  /** Projectile weapons. */
  projectileSpeed?: number;
  projectileGravity?: number;
  adsFov?: number;
}

/** Runtime weapon state held by the server for the active item. */
export interface WeaponState {
  itemUid: string;
  loadedAmmo: number;
  nextFireAt: number;
  reloadingUntil: number;
}
