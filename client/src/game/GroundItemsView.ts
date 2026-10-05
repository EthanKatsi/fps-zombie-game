import * as THREE from 'three';
import { ITEM_CATEGORY_COLORS, getItemDef, type GroundItemNet } from '@grey/shared';

const geometry = new THREE.BoxGeometry(0.32, 0.22, 0.32);
const bagGeometry = new THREE.BoxGeometry(0.7, 0.4, 0.5);
const bagMaterial = new THREE.MeshStandardMaterial({ color: 0x3b2f22, roughness: 0.95 });
const materials = new Map<string, THREE.MeshStandardMaterial>();
const materialFor = (defId: string): THREE.MeshStandardMaterial => {
  const cat = getItemDef(defId)?.category ?? 'material';
  let m = materials.get(cat);
  if (!m) {
    const color = new THREE.Color(ITEM_CATEGORY_COLORS[cat]);
    // A faint glow so loot reads against the grey streets.
    m = new THREE.MeshStandardMaterial({ color, roughness: 0.6, emissive: color, emissiveIntensity: 0.25 });
    materials.set(cat, m);
  }
  return m;
};

/** Pick radius around a ground item's center for look-at targeting. */
const PICK_RADIUS = 0.32;

/** Renders server-announced ground items and finds the one under the crosshair. */
export class GroundItemsView {
  private readonly items = new Map<string, { net: GroundItemNet; mesh: THREE.Mesh }>();
  private readonly tmp = new THREE.Vector3();

  constructor(private readonly scene: THREE.Scene) {}

  apply(msg: { add: GroundItemNet[]; remove: string[] }): void {
    for (const id of msg.remove) {
      const it = this.items.get(id);
      if (!it) continue;
      this.scene.remove(it.mesh);
      this.items.delete(id);
    }
    for (const g of msg.add) {
      const existing = this.items.get(g.id);
      if (existing) {
        existing.net = g;
        continue;
      }
      const isBag = g.defId === 'loot_bag';
      const mesh = new THREE.Mesh(isBag ? bagGeometry : geometry, isBag ? bagMaterial : materialFor(g.defId));
      mesh.position.set(g.p[0], g.p[1], g.p[2]);
      mesh.rotation.y = g.rot;
      mesh.castShadow = true;
      this.scene.add(mesh);
      this.items.set(g.id, { net: g, mesh });
    }
  }

  /** Nearest item hit by the ray within maxDist (ray-sphere test). */
  pick(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { item: GroundItemNet; dist: number } | null {
    let best: { item: GroundItemNet; dist: number } | null = null;
    for (const { net } of this.items.values()) {
      this.tmp.set(net.p[0], net.p[1], net.p[2]).sub(origin);
      const t = this.tmp.dot(dir);
      if (t < 0 || t > maxDist) continue;
      const d2 = this.tmp.lengthSq() - t * t;
      const r = net.defId === 'loot_bag' ? PICK_RADIUS * 1.6 : PICK_RADIUS;
      if (d2 > r * r) continue;
      if (!best || t < best.dist) best = { item: net, dist: t };
    }
    return best;
  }

  get count(): number {
    return this.items.size;
  }
}
