import * as THREE from 'three';
import type { MapData } from '@grey/shared';

/** Placeholder palette - flat, desaturated, post-apocalyptic. */
const MATERIALS: Record<string, THREE.MeshStandardMaterialParameters> = {
  asphalt: { color: 0x2f302d, roughness: 0.95 },
  concrete: { color: 0x7a7870, roughness: 0.9 },
  brick: { color: 0x6b3b2e, roughness: 0.9 },
  wood: { color: 0x6e5236, roughness: 0.85 },
  crate: { color: 0x7d6440, roughness: 0.85 },
  car: { color: 0x4a5560, roughness: 0.6, metalness: 0.3 },
};
const FALLBACK: THREE.MeshStandardMaterialParameters = { color: 0xff00ff };

/**
 * Builds map visuals. All boxes sharing a material become ONE InstancedMesh of a unit
 * cube (scaled per instance), so the whole test map is a handful of draw calls.
 */
export const buildMapMeshes = (map: MapData): THREE.Group => {
  const group = new THREE.Group();
  const byMat = new Map<string, typeof map.boxes>();
  for (const b of map.boxes) {
    if (b.vis === false) continue;
    const list = byMat.get(b.m) ?? [];
    list.push(b);
    byMat.set(b.m, list);
  }

  const unit = new THREE.BoxGeometry(1, 1, 1);
  const m4 = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  for (const [key, boxes] of byMat) {
    const mat = new THREE.MeshStandardMaterial({ ...(MATERIALS[key] ?? FALLBACK), flatShading: true });
    const mesh = new THREE.InstancedMesh(unit, mat, boxes.length);
    boxes.forEach((b, i) => {
      pos.set(b.p[0], b.p[1], b.p[2]);
      euler.set(b.r?.[0] ?? 0, b.r?.[1] ?? 0, b.r?.[2] ?? 0, 'YXZ');
      quat.setFromEuler(euler);
      scale.set(b.s[0], b.s[1], b.s[2]);
      mesh.setMatrixAt(i, m4.compose(pos, quat, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    mesh.castShadow = key !== 'asphalt';
    mesh.receiveShadow = true;
    mesh.name = `map:${key}`;
    group.add(mesh);
  }
  return group;
};
