import * as THREE from 'three';
import type { DummySpawn } from '@grey/shared';

const postMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 0.9 });
const bodyMat = new THREE.MeshStandardMaterial({ color: 0xb8a77a, roughness: 0.95 });
const targetMat = new THREE.MeshStandardMaterial({ color: 0x8e1f1a, roughness: 0.8 });

/** Shooting-range dummies: a burlap body on a post that tips over when "killed". */
export class DummiesView {
  private readonly pivots: THREE.Group[] = [];
  private readonly angle: number[] = [];
  private readonly target: number[] = [];

  constructor(scene: THREE.Scene, dummies: DummySpawn[], down: number[]) {
    for (const d of dummies) {
      const base = new THREE.Group();
      base.position.set(d.p[0], d.p[1], d.p[2]);
      base.rotation.y = d.yaw;
      const pivot = new THREE.Group(); // tips over around its foot
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.75, 0.08), postMat);
      post.position.y = 0.875;
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.3, 1.1, 10), bodyMat);
      body.position.y = 0.95;
      const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 10), bodyMat);
      head.position.y = 1.62;
      const mark = new THREE.Mesh(new THREE.CircleGeometry(0.12, 16), targetMat);
      mark.position.set(0, 1.15, -0.3);
      mark.rotation.y = Math.PI;
      for (const m of [post, body, head]) m.castShadow = true;
      pivot.add(post, body, head, mark);
      base.add(pivot);
      scene.add(base);
      this.pivots.push(pivot);
      const isDown = down.includes(d.id) ? 1 : 0;
      this.angle.push(isDown);
      this.target.push(isDown);
    }
  }

  setDown(id: number, down: boolean): void {
    this.target[id] = down ? 1 : 0;
  }

  update(dt: number): void {
    this.pivots.forEach((p, i) => {
      const t = this.target[i];
      const a = this.angle[i];
      const next = t > a ? Math.min(t, a + dt * 3) : Math.max(t, a - dt * 1.2);
      this.angle[i] = next;
      p.rotation.x = next * 1.45; // falls backwards, away from the shooter
    });
  }
}
