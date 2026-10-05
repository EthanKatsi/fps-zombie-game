import { SURVIVAL, getItemDef, type DeathCause, type DeathInfo, type NetStats } from '@grey/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const DEATH_TEXT: Record<DeathCause, (killer: string | null) => string> = {
  starvation: () => 'You starved to death.',
  dehydration: () => 'You died of thirst.',
  bleeding: () => 'You bled out.',
  fall: () => 'You fell to your death.',
  player: (k) => `Killed by ${k ?? 'another survivor'}.`,
  zombie: () => 'The dead got you.',
  unknown: () => 'You died.',
};

/** "a Hunting Rifle" / "their fists" for death and kill feed text. */
export const weaponName = (weaponId: string): string => {
  if (weaponId === 'fists') return 'their fists';
  const item = getItemDef(weaponId);
  if (!item) return weaponId;
  return `${/^[aeiou]/i.test(item.name) ? 'an' : 'a'} ${item.name}`;
};

/** Health / food / water bars, hit flash, item-use progress and the death screen. */
export class SurvivalHud {
  private readonly health = $('health-fill');
  private readonly hunger = $('hunger-fill');
  private readonly thirst = $('thirst-fill');
  private readonly bleeding = $('bleeding');
  private readonly vignette = $('vignette');
  private readonly useBox = $('use-progress');
  private readonly useFill = $('use-fill');
  private readonly death = $('death');
  private readonly respawnBtn = $<HTMLButtonElement>('respawn-btn');
  private stats: NetStats | null = null;
  private use: { start: number; duration: number } | null = null;
  private hitFlash = 0;
  private deathTimer = 0;
  private onRespawn: (() => void) | null = null;

  constructor() {
    this.respawnBtn.addEventListener('click', () => {
      if (this.respawnBtn.disabled) return;
      this.respawnBtn.disabled = true;
      this.respawnBtn.textContent = 'Respawning...';
      this.onRespawn?.();
    });
  }

  setStats(s: NetStats): void {
    this.stats = s;
    const bar = (el: HTMLElement, v: number, max: number) => {
      el.style.width = `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
      el.classList.toggle('low', v / max < 0.2);
    };
    bar(this.health, s.health, SURVIVAL.health.max);
    bar(this.hunger, s.hunger, SURVIVAL.hunger.max);
    bar(this.thirst, s.thirst, SURVIVAL.thirst.max);
    this.bleeding.classList.toggle('hidden', !s.bleeding);
  }

  hit(amount: number): void {
    this.hitFlash = Math.min(1, 0.35 + amount / 40);
  }

  startUse(label: string, durationMs: number): void {
    this.use = { start: performance.now(), duration: durationMs };
    $('use-label').textContent = label;
    this.useBox.classList.remove('hidden');
  }

  endUse(): void {
    this.use = null;
    this.useBox.classList.add('hidden');
  }

  get using(): boolean {
    return this.use !== null;
  }

  /** Per-frame: use progress bar and vignette (hit flash + low-health baseline). */
  update(dt: number): void {
    if (this.use) {
      const f = Math.min(1, (performance.now() - this.use.start) / this.use.duration);
      this.useFill.style.width = `${f * 100}%`;
    }
    this.hitFlash = Math.max(0, this.hitFlash - dt * 1.5);
    const hp = this.stats ? this.stats.health / SURVIVAL.health.max : 1;
    const lowHealth = hp < 0.3 ? (0.3 - hp) * 2 : 0;
    const v = Math.max(this.hitFlash, lowHealth);
    this.vignette.classList.toggle('hit', this.hitFlash > 0);
    this.vignette.style.opacity = v.toFixed(2);
  }

  showDeath(info: DeathInfo, onRespawn: () => void): void {
    this.endUse();
    this.onRespawn = onRespawn;
    let text = DEATH_TEXT[info.cause](info.killer);
    if (info.cause === 'player' && info.killer) {
      const weapon = info.weapon ? weaponName(info.weapon) : null;
      text = `Killed by ${info.killer}${weapon ? ` with ${weapon}` : ''}${info.headshot ? ' (headshot)' : ''}${
        info.distance !== undefined ? ` from ${info.distance} m` : ''
      }.`;
    }
    $('death-cause').textContent = text;
    this.death.classList.remove('hidden');
    const unlockAt = performance.now() + info.respawnInMs;
    this.respawnBtn.disabled = true;
    window.clearInterval(this.deathTimer);
    const tick = () => {
      const left = Math.ceil((unlockAt - performance.now()) / 1000);
      if (left > 0) {
        this.respawnBtn.textContent = `Respawn in ${left}`;
      } else {
        this.respawnBtn.textContent = 'Respawn';
        this.respawnBtn.disabled = false;
        window.clearInterval(this.deathTimer);
      }
    };
    tick();
    this.deathTimer = window.setInterval(tick, 250);
  }

  hideDeath(): void {
    window.clearInterval(this.deathTimer);
    this.death.classList.add('hidden');
  }

  get deathVisible(): boolean {
    return !this.death.classList.contains('hidden');
  }
}
