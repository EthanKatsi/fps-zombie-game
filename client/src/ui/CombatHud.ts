const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Crosshair (spread-aware), ammo counter, hit markers, scope overlay, damage direction. */
export class CombatHud {
  private readonly crosshair = $('crosshair');
  private readonly ammo = $('ammo');
  private readonly hitmarker = $('hitmarker');
  private readonly scope = $('scope');
  private readonly dmgDir = $('dmg-dir');
  private hitTimer = 0;
  private dmgTimer = 0;

  /** Gap in px from the screen center to each crosshair line. Hidden while aiming. */
  setCrosshair(gapPx: number, visible: boolean): void {
    this.crosshair.style.setProperty('--gap', `${Math.min(120, Math.max(3, gapPx)).toFixed(1)}px`);
    this.crosshair.classList.toggle('hidden', !visible);
  }

  setAmmo(text: string | null): void {
    this.ammo.classList.toggle('hidden', text === null);
    if (text !== null && this.ammo.textContent !== text) this.ammo.textContent = text;
  }

  hit(strong: boolean): void {
    this.hitmarker.classList.remove('hidden');
    this.hitmarker.classList.toggle('strong', strong);
    window.clearTimeout(this.hitTimer);
    this.hitTimer = window.setTimeout(() => this.hitmarker.classList.add('hidden'), strong ? 260 : 160);
  }

  setScope(on: boolean): void {
    this.scope.classList.toggle('hidden', !on);
  }

  /** Point the damage indicator towards the attacker. `angle` = radians, 0 = straight ahead. */
  damageFrom(angle: number): void {
    this.dmgDir.style.transform = `translate(-50%, -50%) rotate(${angle}rad)`;
    this.dmgDir.classList.remove('hidden');
    window.clearTimeout(this.dmgTimer);
    this.dmgTimer = window.setTimeout(() => this.dmgDir.classList.add('hidden'), 1200);
  }
}
