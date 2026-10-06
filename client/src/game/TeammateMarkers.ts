import * as THREE from 'three';
import type { TeammatePos } from '@grey/shared';

/**
 * Name + distance markers for teammates who are too far away to be drawn (outside the snapshot
 * interest area). Always on top, constant size on screen.
 */
export class TeammateMarkers {
  private readonly markers = new Map<string, { sprite: THREE.Sprite; canvas: HTMLCanvasElement; text: string; target: THREE.Vector3 }>();

  constructor(private readonly scene: THREE.Scene) {}

  private draw(canvas: HTMLCanvasElement, text: string, alive: boolean): void {
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = 'bold 28px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, 160, 24);
    ctx.fillStyle = alive ? '#8be08b' : '#9a9a9a';
    ctx.fillText(text, 160, 24);
    ctx.beginPath();
    ctx.moveTo(150, 46);
    ctx.lineTo(170, 46);
    ctx.lineTo(160, 60);
    ctx.closePath();
    ctx.fill();
  }

  /** `shown` = teammates already drawn as full characters (they have their own tag). */
  update(list: TeammatePos[], me: THREE.Vector3, shown: (id: string) => boolean, dt: number): void {
    const seen = new Set<string>();
    for (const t of list) {
      if (shown(t.id)) continue;
      seen.add(t.id);
      let m = this.markers.get(t.id);
      if (!m) {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 64;
        const tex = new THREE.CanvasTexture(canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
        sprite.scale.set(0.16, 0.032, 1);
        sprite.renderOrder = 30;
        sprite.center.set(0.5, 0);
        this.scene.add(sprite);
        m = { sprite, canvas, text: '', target: new THREE.Vector3(t.p[0], t.p[1] + 2.1, t.p[2]) };
        m.sprite.position.copy(m.target);
        this.markers.set(t.id, m);
      }
      m.target.set(t.p[0], t.p[1] + 2.1, t.p[2]);
      m.sprite.position.lerp(m.target, 1 - Math.exp(-dt * 4));
      const dist = Math.round(me.distanceTo(m.sprite.position) / 5) * 5;
      const text = `${t.name} · ${dist} m`;
      if (text !== m.text) {
        m.text = text;
        this.draw(m.canvas, text, t.alive);
        (m.sprite.material.map as THREE.Texture).needsUpdate = true;
      }
    }
    for (const [id, m] of this.markers) {
      if (seen.has(id)) continue;
      this.scene.remove(m.sprite);
      m.sprite.material.map?.dispose();
      m.sprite.material.dispose();
      this.markers.delete(id);
    }
  }
}
