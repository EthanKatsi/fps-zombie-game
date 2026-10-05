import * as THREE from 'three';
import { MOVEMENT, NETWORK, PlayerFlags, lerp, lerpAngle, type NetPlayer } from '@grey/shared';

interface Sample {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  crouch: boolean;
}

const BODY_COLOR = 0x5b5e4a;

const makeNameTag = (name: string): THREE.Sprite => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 30px Segoe UI, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(name, 128, 32);
  ctx.fillStyle = '#e8e3d4';
  ctx.fillText(name, 128, 32);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true }));
  sprite.scale.set(1.6, 0.4, 1);
  return sprite;
};

class RemotePlayer {
  readonly root = new THREE.Group();
  private readonly body: THREE.Mesh;
  private readonly head: THREE.Group;
  private readonly tag: THREE.Sprite;
  private buffer: Sample[] = [];
  private crouchBlend = 0;

  constructor(readonly id: string, name: string) {
    const mat = new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.9 });
    const r = MOVEMENT.radius;
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(r, MOVEMENT.standHeight - 2 * r - 0.25, 4, 10), mat);
    this.body.castShadow = true;
    this.root.add(this.body);

    this.head = new THREE.Group();
    const skull = new THREE.Mesh(
      new THREE.SphereGeometry(0.17, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xb08b6e, roughness: 0.8 }),
    );
    skull.castShadow = true;
    // A dark "visor" so you can tell which way someone is looking.
    const visor = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.06, 0.06),
      new THREE.MeshStandardMaterial({ color: 0x111111 }),
    );
    visor.position.set(0, 0.02, -0.15);
    this.head.add(skull, visor);
    this.root.add(this.head);

    this.tag = makeNameTag(name);
    this.root.add(this.tag);
  }

  push(n: NetPlayer, t: number): void {
    this.buffer.push({
      t,
      x: n.p[0],
      y: n.p[1],
      z: n.p[2],
      yaw: n.yaw,
      pitch: n.pitch,
      crouch: (n.f & PlayerFlags.crouching) !== 0,
    });
    if (this.buffer.length > 40) this.buffer.splice(0, this.buffer.length - 40);
  }

  /** Render `renderTime` (server ms) by interpolating between the bracketing snapshots. */
  update(renderTime: number, dt: number): void {
    const b = this.buffer;
    if (b.length === 0) return;
    let s: Sample;
    if (renderTime <= b[0].t) {
      s = b[0];
    } else if (renderTime >= b[b.length - 1].t) {
      s = b[b.length - 1]; // no extrapolation: hold the latest known pose
    } else {
      let i = 0;
      while (i < b.length - 2 && b[i + 1].t < renderTime) i++;
      const a = b[i], c = b[i + 1];
      const k = (renderTime - a.t) / Math.max(1, c.t - a.t);
      s = {
        t: renderTime,
        x: lerp(a.x, c.x, k),
        y: lerp(a.y, c.y, k),
        z: lerp(a.z, c.z, k),
        yaw: lerpAngle(a.yaw, c.yaw, k),
        pitch: lerp(a.pitch, c.pitch, k),
        crouch: k < 0.5 ? a.crouch : c.crouch,
      };
      // Drop samples we've fully passed (keep one behind for interpolation).
      if (i > 0) b.splice(0, i);
    }

    this.crouchBlend += ((s.crouch ? 1 : 0) - this.crouchBlend) * (1 - Math.exp(-dt * 12));
    const height = lerp(MOVEMENT.standHeight, MOVEMENT.crouchHeight, this.crouchBlend);
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.y = s.yaw;
    const bodyScale = (height - 0.25) / (MOVEMENT.standHeight - 0.25);
    this.body.scale.y = bodyScale;
    this.body.position.y = ((MOVEMENT.standHeight - 0.25) * bodyScale) / 2;
    this.head.position.y = height - 0.17;
    this.head.rotation.x = s.pitch;
    this.tag.position.y = height + 0.35;
  }

  dispose(): void {
    this.root.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture | null };
        m.map?.dispose();
        m.dispose();
      }
    });
  }
}

/** Other players: snapshot buffering + entity interpolation, rendered in the past. */
export class RemotePlayers {
  private readonly players = new Map<string, RemotePlayer>();
  private readonly names = new Map<string, string>();

  constructor(private readonly scene: THREE.Scene, private readonly localId: string) {}

  setName(id: string, name: string): void {
    this.names.set(id, name);
  }

  remove(id: string): void {
    this.names.delete(id);
    this.despawn(id);
  }

  private despawn(id: string): void {
    const p = this.players.get(id);
    if (!p) return;
    this.scene.remove(p.root);
    p.dispose();
    this.players.delete(id);
  }

  /** Apply one snapshot's player list. Players missing from it left our interest area. */
  onSnapshot(list: NetPlayer[], serverTime: number): void {
    const seen = new Set<string>();
    for (const n of list) {
      if (n.id === this.localId) continue;
      seen.add(n.id);
      let p = this.players.get(n.id);
      if (!p) {
        p = new RemotePlayer(n.id, this.names.get(n.id) ?? '???');
        this.players.set(n.id, p);
        this.scene.add(p.root);
      }
      p.push(n, serverTime);
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.despawn(id);
  }

  update(serverNow: number, dt: number): void {
    const renderTime = serverNow - NETWORK.interpolationDelayMs;
    for (const p of this.players.values()) p.update(renderTime, dt);
  }

  get count(): number {
    return this.players.size;
  }
}
