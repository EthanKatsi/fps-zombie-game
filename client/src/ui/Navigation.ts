import type { MapData, TeammatePos } from '@grey/shared';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Top-down colours for the map image. */
const SURFACE: Record<string, string> = {
  grass: '#4b5435', forest_floor: '#38382a', asphalt: '#2c2d2b', lot_asphalt: '#353633', dirt: '#6a5940',
  sidewalk: '#77736a', pavement: '#6f6c65', concrete: '#66635d', paint: '', concrete_wall: '#1f1f1d',
};
const BUILDING: Record<string, string> = {
  house: '#7b6f60', apartment: '#6c5f55', grocery: '#7e7a63', pharmacy: '#6b7f74', hardware: '#7a6f58',
  gunshop: '#6f5148', police: '#3e5a86',
};

/** Bearing (radians, 0 = north = -Z, clockwise) of a world direction. */
const bearing = (dx: number, dz: number) => Math.atan2(dx, -dz);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Render the whole map top-down once (roads, ground, buildings, trees). North is up. */
export const renderMapImage = (map: MapData, size = 1024): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const H = map.halfSize;
  const k = size / (2 * H);
  const X = (x: number) => (x + H) * k;
  const Z = (z: number) => (z + H) * k;
  ctx.fillStyle = SURFACE.grass;
  ctx.fillRect(0, 0, size, size);
  // Flat surfaces, lowest first.
  const flat = map.boxes.filter((b) => b.vis !== false && !b.d && b.s[1] < 1.2 && SURFACE[b.m]).sort((a, b) => a.p[1] + a.s[1] / 2 - (b.p[1] + b.s[1] / 2));
  const draw = (b: (typeof map.boxes)[number], color: string, minPx = 0) => {
    ctx.fillStyle = color;
    const w = Math.max(minPx, b.s[0] * k), h = Math.max(minPx, b.s[2] * k);
    const yaw = b.r?.[1] ?? 0;
    if (Math.abs(yaw) < 1e-3) {
      ctx.fillRect(X(b.p[0]) - w / 2, Z(b.p[2]) - h / 2, w, h);
    } else {
      ctx.save();
      ctx.translate(X(b.p[0]), Z(b.p[2]));
      ctx.rotate(-yaw);
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.restore();
    }
  };
  for (const b of flat) draw(b, SURFACE[b.m]);
  // City wall.
  for (const b of map.boxes) if (b.m === 'concrete_wall') draw(b, SURFACE.concrete_wall, 1.5);
  // Buildings.
  for (const b of map.buildings) {
    const [x0, z0, x1, z1] = b.bounds;
    ctx.fillStyle = BUILDING[b.type] ?? '#776b5e';
    ctx.fillRect(X(x0), Z(z0), (x1 - x0) * k, (z1 - z0) * k);
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 1;
    ctx.strokeRect(X(x0) + 0.5, Z(z0) + 0.5, (x1 - x0) * k - 1, (z1 - z0) * k - 1);
  }
  // Tree crowns.
  for (const b of map.boxes) {
    if (b.m !== 'pine' && b.m !== 'leaves') continue;
    if (b.m === 'pine' && b.s[0] < 2.5) continue; // only the bottom cone of each pine
    ctx.fillStyle = b.m === 'pine' ? 'rgba(28,40,24,0.85)' : 'rgba(46,62,36,0.8)';
    ctx.beginPath();
    ctx.arc(X(b.p[0]), Z(b.p[2]), Math.max(0.8, (b.s[0] / 2) * k), 0, Math.PI * 2);
    ctx.fill();
  }
  // Gas pumps.
  ctx.fillStyle = '#d9b25a';
  for (const p of map.fuelPumps) ctx.fillRect(X(p[0]) - 1.5, Z(p[2]) - 1.5, 3, 3);
  return canvas;
};

export interface MapMarker {
  name: string;
  x: number;
  z: number;
  alive: boolean;
}

/** Small north-up minimap (top right) and the full-screen map (M). */
export class Minimap {
  private readonly image: HTMLCanvasElement;
  private readonly mini = $<HTMLCanvasElement>('minimap');
  private readonly big = $<HTMLCanvasElement>('bigmap-canvas');
  private readonly bigScreen = $('bigmap');
  isBigOpen = false;
  /** Metres from the centre to the edge of the minimap. */
  private readonly radius = 110;

  constructor(private readonly map: MapData) {
    this.image = renderMapImage(map);
  }

  toggleBig(): void {
    this.isBigOpen = !this.isBigOpen;
    this.bigScreen.classList.toggle('hidden', !this.isBigOpen);
  }

  closeBig(): void {
    this.isBigOpen = false;
    this.bigScreen.classList.add('hidden');
  }

  private arrow(ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, size: number, color: string): void {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(heading);
    ctx.fillStyle = color;
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -size);
    ctx.lineTo(size * 0.7, size * 0.8);
    ctx.lineTo(0, size * 0.4);
    ctx.lineTo(-size * 0.7, size * 0.8);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private mate(ctx: CanvasRenderingContext2D, x: number, y: number, m: MapMarker, label: boolean): void {
    ctx.fillStyle = m.alive ? '#6fd36f' : '#888';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (label) {
      ctx.font = 'bold 12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.lineWidth = 3;
      ctx.strokeText(m.name, x, y - 9);
      ctx.fillStyle = '#d9f5d9';
      ctx.fillText(m.name, x, y - 9);
    }
  }

  update(px: number, pz: number, yaw: number, mates: MapMarker[]): void {
    const H = this.map.halfSize;
    const k = this.image.width / (2 * H);
    const heading = -yaw; // bearing of where you look
    // ---- minimap
    {
      const c = this.mini;
      const ctx = c.getContext('2d')!;
      const S = c.width;
      const src = this.radius * 2 * k;
      ctx.fillStyle = '#1b1c18';
      ctx.fillRect(0, 0, S, S);
      ctx.drawImage(this.image, (px + H) * k - src / 2, (pz + H) * k - src / 2, src, src, 0, 0, S, S);
      const s = S / (this.radius * 2);
      for (const m of mates) {
        let x = S / 2 + (m.x - px) * s, y = S / 2 + (m.z - pz) * s;
        // Off the edge: pin to the border.
        const r = S / 2 - 7;
        const dx = x - S / 2, dy = y - S / 2, d = Math.hypot(dx, dy);
        if (d > r) {
          x = S / 2 + (dx / d) * r;
          y = S / 2 + (dy / d) * r;
        }
        this.mate(ctx, x, y, m, false);
      }
      this.arrow(ctx, S / 2, S / 2, heading, 8, '#f2e6c8');
      ctx.fillStyle = '#f2e6c8';
      ctx.font = 'bold 12px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('N', S / 2, 13);
    }
    // ---- full map
    if (this.isBigOpen) {
      const c = this.big;
      const want = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.86);
      if (c.width !== want) c.width = c.height = want;
      const ctx = c.getContext('2d')!;
      const S = c.width;
      ctx.drawImage(this.image, 0, 0, S, S);
      const s = S / (2 * H);
      const P = (x: number, z: number) => [(x + H) * s, (z + H) * s] as const;
      // Area labels.
      ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(240,232,210,0.75)';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 3;
      for (const [label, x, z] of [['DOWNTOWN', 300, -300], ['SUBURBS', 300, 300], ['FOREST', -330, 0]] as const) {
        const [lx, ly] = P(x, z);
        ctx.strokeText(label, lx, ly);
        ctx.fillText(label, lx, ly);
      }
      for (const m of mates) {
        const [x, y] = P(m.x, m.z);
        this.mate(ctx, x, y, m, true);
      }
      const [x, y] = P(px, pz);
      this.arrow(ctx, x, y, heading, 9, '#ffd36a');
    }
  }
}

/** Compass strip (top centre): headings and teammate markers within your field of view. */
export class Compass {
  private readonly bar = $('compass');
  private readonly labels: { el: HTMLElement; angle: number }[] = [];
  private readonly mateEls = new Map<string, HTMLElement>();
  private readonly headingEl: HTMLElement;

  constructor() {
    const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    for (let deg = 0; deg < 360; deg += 15) {
      const el = document.createElement('div');
      const name = deg % 45 === 0 ? names[deg / 45] : '';
      el.className = name ? `cmp-label${name.length === 1 ? ' major' : ''}` : 'cmp-tick';
      el.textContent = name || '|';
      this.bar.appendChild(el);
      this.labels.push({ el, angle: (deg * Math.PI) / 180 });
    }
    this.headingEl = document.createElement('div');
    this.headingEl.className = 'cmp-heading';
    this.bar.appendChild(this.headingEl);
  }

  update(px: number, pz: number, yaw: number, mates: TeammatePos[]): void {
    const heading = -yaw;
    const span = Math.PI / 2; // half the strip = 90 degrees
    const place = (el: HTMLElement, angle: number) => {
      const rel = wrap(angle - heading);
      const show = Math.abs(rel) < span;
      el.style.display = show ? '' : 'none';
      if (show) el.style.left = `${50 + (rel / span) * 50}%`;
    };
    for (const l of this.labels) place(l.el, l.angle);
    const deg = Math.round((((heading * 180) / Math.PI) % 360 + 360) % 360);
    this.headingEl.textContent = String(deg);
    // Teammates.
    const seen = new Set<string>();
    for (const m of mates) {
      seen.add(m.id);
      let el = this.mateEls.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'cmp-mate';
        this.bar.appendChild(el);
        this.mateEls.set(m.id, el);
      }
      const dx = m.p[0] - px, dz = m.p[2] - pz;
      el.textContent = `▼ ${m.name} ${Math.round(Math.hypot(dx, dz))}m`;
      el.classList.toggle('dead', !m.alive);
      place(el, bearing(dx, dz));
    }
    for (const [id, el] of this.mateEls) {
      if (seen.has(id)) continue;
      el.remove();
      this.mateEls.delete(id);
    }
  }
}
