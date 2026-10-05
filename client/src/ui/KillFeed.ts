import { PVP, getItemDef, type DeathCause, type KillFeedEntry } from '@grey/shared';

const ENV_TEXT: Record<DeathCause, string> = {
  starvation: 'starved to death',
  dehydration: 'died of thirst',
  bleeding: 'bled out',
  fall: 'fell to their death',
  zombie: 'was eaten by the dead',
  player: 'was killed',
  unknown: 'died',
};

const MAX_ROWS = 6;

/** Top-right list of recent deaths. Entries involving you are highlighted. */
export class KillFeed {
  private readonly root = document.getElementById('killfeed')!;

  constructor(private readonly myName: string) {}

  push(e: KillFeedEntry): void {
    const row = document.createElement('div');
    row.className = 'kf';
    if (e.victim === this.myName || e.killer === this.myName) row.classList.add('me');
    const who = (name: string) => {
      const s = document.createElement('span');
      s.className = 'who';
      s.textContent = name;
      return s;
    };
    const how = (text: string) => {
      const s = document.createElement('span');
      s.className = 'how';
      s.textContent = text;
      return s;
    };
    if (e.killer) {
      const weapon = e.weapon === 'fists' ? 'fists' : (e.weapon && getItemDef(e.weapon)?.name) || 'killed';
      row.append(who(e.killer), how(`[${weapon}]`), who(e.victim));
      if (e.headshot) {
        const hs = document.createElement('span');
        hs.className = 'hs';
        hs.textContent = 'HEADSHOT';
        row.append(hs);
      }
    } else {
      row.append(who(e.victim), how(ENV_TEXT[e.cause]));
    }
    this.root.prepend(row);
    while (this.root.children.length > MAX_ROWS) this.root.lastElementChild?.remove();
    window.setTimeout(() => row.classList.add('fade'), PVP.killFeedSec * 1000);
    window.setTimeout(() => row.remove(), PVP.killFeedSec * 1000 + 700);
  }

  clear(): void {
    this.root.replaceChildren();
  }
}
