import type { WeaponDef } from '../types/weapon';

/**
 * Weapon balance. Item -> weapon mapping is ItemDef.weaponId (config/items.ts).
 * Empty hands (or holding a non-weapon) use 'fists'.
 */
const defs: WeaponDef[] = [
  // ---------------------------------------------------------------- melee
  { id: 'fists', kind: 'melee', damage: 9, headshotMultiplier: 1.5, fireRate: 2.2, range: 1.6, noiseRadius: 4,
    staminaCost: 6, swingWindupMs: 120, structureDamage: 1 },
  { id: 'bat', kind: 'melee', damage: 28, headshotMultiplier: 1.8, fireRate: 1.4, range: 2.0, noiseRadius: 7,
    staminaCost: 12, swingWindupMs: 220, structureDamage: 5 },
  { id: 'crowbar', kind: 'melee', damage: 31, headshotMultiplier: 1.8, fireRate: 1.25, range: 1.9, noiseRadius: 7,
    staminaCost: 13, swingWindupMs: 240, structureDamage: 10 },
  { id: 'machete', kind: 'melee', damage: 30, headshotMultiplier: 1.7, fireRate: 1.6, range: 1.9, noiseRadius: 6,
    staminaCost: 10, swingWindupMs: 180, structureDamage: 4, bleedChance: 0.35 },
  { id: 'axe', kind: 'melee', damage: 46, headshotMultiplier: 1.8, fireRate: 0.9, range: 2.1, noiseRadius: 9,
    staminaCost: 20, swingWindupMs: 380, structureDamage: 25, bleedChance: 0.25 },

  // ---------------------------------------------------------------- guns
  { id: 'pistol', kind: 'hitscan', damage: 26, headshotMultiplier: 2.0, fireRate: 4, range: 80, noiseRadius: 120,
    ammoType: 'ammo_9mm', magazineSize: 12, reloadMs: 1800, pellets: 1,
    spreadHip: 1.8, spreadAds: 0.4, spreadMoving: 2.5, recoilPitch: 2.2, recoilYaw: 0.8, adsFov: 60, bleedChance: 0.3 },
  { id: 'shotgun', kind: 'hitscan', damage: 12, headshotMultiplier: 1.5, fireRate: 1.1, range: 32, noiseRadius: 160,
    ammoType: 'ammo_12g', magazineSize: 6, reloadMs: 3200, pellets: 8,
    spreadHip: 5.5, spreadAds: 4.0, spreadMoving: 2.0, recoilPitch: 6.5, recoilYaw: 2.0, adsFov: 65, bleedChance: 0.2 },
  { id: 'rifle', kind: 'hitscan', damage: 75, headshotMultiplier: 2.0, fireRate: 0.8, range: 250, noiseRadius: 220,
    ammoType: 'ammo_556', magazineSize: 5, reloadMs: 3000, pellets: 1,
    spreadHip: 3.5, spreadAds: 0.08, spreadMoving: 4.0, recoilPitch: 5.0, recoilYaw: 1.0, adsFov: 28, bleedChance: 0.5,
    scope: true },
  // Bolt-action .308: one-shot headshots on players, useless from the hip or on the move.
  { id: 'sniper_rifle', kind: 'hitscan', damage: 95, headshotMultiplier: 2.5, fireRate: 0.55, range: 400, noiseRadius: 300,
    ammoType: 'ammo_308', magazineSize: 5, reloadMs: 3600, pellets: 1,
    spreadHip: 7.0, spreadAds: 0.02, spreadMoving: 6.0, recoilPitch: 7.5, recoilYaw: 1.2, adsFov: 11, bleedChance: 0.6,
    scope: true },
  { id: 'assault_rifle', kind: 'hitscan', damage: 22, headshotMultiplier: 2.0, fireRate: 10, range: 150, noiseRadius: 200,
    automatic: true, ammoType: 'ammo_556', magazineSize: 30, reloadMs: 2600, pellets: 1,
    spreadHip: 3.0, spreadAds: 0.6, spreadMoving: 3.5, recoilPitch: 1.3, recoilYaw: 0.9, adsFov: 55, bleedChance: 0.35 },
  { id: 'crossbow', kind: 'projectile', damage: 70, headshotMultiplier: 2.0, fireRate: 0.5, range: 150, noiseRadius: 12,
    ammoType: 'bolt', magazineSize: 1, reloadMs: 2200, pellets: 1, projectileSpeed: 70, projectileGravity: 9.8,
    spreadHip: 1.5, spreadAds: 0.15, spreadMoving: 2.5, recoilPitch: 1.5, recoilYaw: 0.4, adsFov: 55, bleedChance: 0.6 },
];

export const WEAPONS: Readonly<Record<string, WeaponDef>> = Object.fromEntries(defs.map((d) => [d.id, d]));

export const getWeaponDef = (id: string | undefined): WeaponDef | undefined => (id ? WEAPONS[id] : undefined);

/** Combat rules that aren't per-weapon. */
export const COMBAT = {
  /** Movement speed multiplier while aiming down sights (part of the predicted movement sim). */
  aimMoveMultiplier: 0.6,
  /** Spread multipliers. */
  crouchSpreadMultiplier: 0.75,
  airborneSpreadExtra: 4,
  /** Horizontal speed (m/s) considered "fully moving" for spread. */
  movingSpeedForFullSpread: 4.2,
  /** Server accepts attacks this fraction of the fire interval early (network jitter). */
  fireRateTolerance: 0.8,
  /** Durability lost per melee hit / per gunshot. Broken weapons can't be used. */
  meleeWearPerHit: 1,
  gunWearPerShot: 1,
  /** Training dummies at the police station shooting range. */
  dummyHealth: 150,
  dummyRespawnSec: 8,
  /** Crossbow bolts that hit the world can be picked up again with this chance. */
  boltRecoverChance: 0.7,
  /** Armour loses this much durability per point of damage it absorbs. */
  armorWearPerDamage: 1,
  /** Shots are broadcast to players within this radius (tracers, muzzle flashes, later audio). */
  shotBroadcastRadius: 250,
} as const;
