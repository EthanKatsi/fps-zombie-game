import * as THREE from 'three';

interface Tracer {
  line: THREE.Line;
  life: number;
}
interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}
interface Bolt {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  gravity: number;
  life: number;
  stuck: boolean;
}

const tracerMat = new THREE.LineBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.8 });
const particleGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
const dustMat = new THREE.MeshBasicMaterial({ color: 0x9a9284 });
const bloodMat = new THREE.MeshBasicMaterial({ color: 0x7a0f0a });
const boltGeo = new THREE.BoxGeometry(0.02, 0.02, 0.5);
const boltMat = new THREE.MeshStandardMaterial({ color: 0x5b4632 });
const flashGeo = new THREE.PlaneGeometry(0.35, 0.35);
const flashMat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, depthWrite: false });

/**
 * Short-lived combat visuals. Lights are a fixed pool that stays in the scene (intensity 0
 * when idle) because adding/removing lights forces Three.js to recompile every shader.
 */
export class Effects {
  private readonly tracers: Tracer[] = [];
  private readonly particles: Particle[] = [];
  private readonly bolts = new Map<string, Bolt>();
  private readonly lights: { light: THREE.PointLight; life: number }[] = [];
  private readonly flashes: { mesh: THREE.Mesh; life: number }[] = [];
  private nextLight = 0;

  constructor(private readonly scene: THREE.Scene) {
    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffc070, 0, 12, 2);
      scene.add(light);
      this.lights.push({ light, life: 0 });
    }
  }

  muzzleFlash(at: THREE.Vector3, facing?: THREE.Vector3): void {
    const slot = this.lights[this.nextLight++ % this.lights.length];
    slot.light.position.copy(at);
    slot.light.intensity = 6;
    slot.life = 0.06;
    const mesh = new THREE.Mesh(flashGeo, flashMat);
    mesh.position.copy(at);
    if (facing) mesh.lookAt(at.clone().sub(facing));
    mesh.rotation.z = Math.random() * Math.PI;
    this.scene.add(mesh);
    this.flashes.push({ mesh, life: 0.05 });
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from, to]);
    const line = new THREE.Line(geo, tracerMat);
    this.scene.add(line);
    this.tracers.push({ line, life: 0.07 });
  }

  /** Small burst: grey dust on the world, red on flesh. */
  impact(at: THREE.Vector3, flesh: boolean): void {
    const n = flesh ? 7 : 5;
    for (let i = 0; i < n; i++) {
      const mesh = new THREE.Mesh(particleGeo, flesh ? bloodMat : dustMat);
      mesh.position.copy(at);
      this.scene.add(mesh);
      this.particles.push({
        mesh,
        vel: new THREE.Vector3((Math.random() - 0.5) * 2.5, Math.random() * 2.5, (Math.random() - 0.5) * 2.5),
        life: 0.35 + Math.random() * 0.2,
      });
    }
  }

  spawnBolt(id: string, pos: THREE.Vector3, vel: THREE.Vector3, gravity: number): void {
    const mesh = new THREE.Mesh(boltGeo, boltMat);
    mesh.position.copy(pos);
    mesh.lookAt(pos.clone().add(vel));
    this.scene.add(mesh);
    this.bolts.set(id, { mesh, vel: vel.clone(), gravity, life: 4, stuck: false });
  }

  /** Server says the bolt stopped: snap it there; it lingers briefly if it stuck in the world. */
  endBolt(id: string, at: THREE.Vector3, hit: 0 | 1 | 2): void {
    const b = this.bolts.get(id);
    if (!b) return;
    b.mesh.position.copy(at);
    b.stuck = true;
    b.life = hit === 1 ? 3 : 0;
    if (hit) this.impact(at, hit === 2);
  }

  update(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.line);
        t.line.geometry.dispose();
        this.tracers.splice(i, 1);
      }
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      p.vel.y -= 9.8 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particles.splice(i, 1);
      }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) {
        this.scene.remove(f.mesh);
        this.flashes.splice(i, 1);
      }
    }
    for (const l of this.lights) {
      if (l.life > 0) {
        l.life -= dt;
        if (l.life <= 0) l.light.intensity = 0;
      }
    }
    for (const [id, b] of this.bolts) {
      b.life -= dt;
      if (!b.stuck) {
        b.vel.y -= b.gravity * dt;
        b.mesh.position.addScaledVector(b.vel, dt);
        b.mesh.lookAt(b.mesh.position.clone().add(b.vel));
      }
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        this.bolts.delete(id);
      }
    }
  }
}
