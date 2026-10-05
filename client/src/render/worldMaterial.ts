import * as THREE from 'three';
import { LAYERS, LAYER_SCALE, type Layer, type SurfaceTextures } from './textures';

/** Which procedural surface each map material key uses. Unlisted keys use 'plain'. */
const SURFACE_OF: Record<string, Layer> = {
  asphalt: 'asphalt', lot_asphalt: 'asphalt', sidewalk: 'sidewalk', pavement: 'concrete', grass: 'grass',
  concrete: 'concrete', concrete_wall: 'concrete', concrete_dark: 'concrete', concrete_barrier: 'concrete',
  floor_concrete: 'concrete', stairs: 'concrete', trash: 'concrete', debris: 'concrete',
  brick: 'brick', brick_dark: 'brick',
  stucco: 'plaster', plaster: 'plaster',
  siding_grey: 'siding', siding_blue: 'siding', siding_green: 'siding', siding_cream: 'siding',
  metal_siding: 'metal', metal: 'metal', metal_dark: 'metal', fence_metal: 'metal', glasscase: 'metal',
  car_red: 'metal', car_blue: 'metal', car_white: 'metal', car_rust: 'metal', car_green: 'metal', car_black: 'metal',
  floor_wood: 'wood', wood: 'wood', wood_dark: 'wood', crate: 'wood', fence_wood: 'wood', door: 'wood',
  floor_tile: 'tile', fabric: 'fabric', sandbag: 'fabric', roof: 'roof', bark: 'bark', leaves: 'leaves', bush: 'leaves',
};

/** Per-material base roughness / metalness (everything else is matte). */
const SURFACE_PROPS: Partial<Record<string, { roughness: number; metalness: number }>> = {
  car_red: { roughness: 0.45, metalness: 0.35 }, car_blue: { roughness: 0.45, metalness: 0.35 },
  car_white: { roughness: 0.45, metalness: 0.35 }, car_green: { roughness: 0.45, metalness: 0.35 },
  car_black: { roughness: 0.4, metalness: 0.4 }, car_rust: { roughness: 0.8, metalness: 0.2 },
  metal: { roughness: 0.5, metalness: 0.6 }, metal_dark: { roughness: 0.55, metalness: 0.6 },
  fence_metal: { roughness: 0.6, metalness: 0.5 }, appliance: { roughness: 0.35, metalness: 0.2 },
  floor_tile: { roughness: 0.35, metalness: 0 }, car_glass: { roughness: 0.1, metalness: 0.6 },
};

export const surfaceIndex = (materialKey: string): number => LAYERS.indexOf(SURFACE_OF[materialKey] ?? 'plain');

/**
 * World-space triplanar material for instanced map pieces. Per-instance attributes:
 *   aTex   - surface layer index (see textures.ts)
 *   aSurf  - (roughness, metalness)
 * Adds: tiled detail colour + grout, relief normals, roughness variation, ground grime and
 * large-scale weathering stains. Works with instancing, shadows and fog.
 */
export const createWorldMaterial = (tex: SurfaceTextures): THREE.MeshStandardMaterial => {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, metalness: 0 });
  const scales = LAYERS.map((l) => 1 / LAYER_SCALE[l]);
  while (scales.length < 16) scales.push(1);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetail = { value: tex.detail };
    shader.uniforms.uNormalArr = { value: tex.normal };
    shader.uniforms.uInvScale = { value: scales };
    shader.uniforms.uNormalStrength = { value: 0.9 };

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aTex;
        attribute vec2 aSurf;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying float vTex;
        varying vec2 vSurf;`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        {
          vec4 wp = vec4(transformed, 1.0);
          vec3 wn = objectNormal;
          #ifdef USE_INSTANCING
            wp = instanceMatrix * wp;
            wn = mat3(instanceMatrix) * wn;
          #endif
          wp = modelMatrix * wp;
          vWPos = wp.xyz;
          vWNrm = normalize(mat3(modelMatrix) * wn);
          vTex = aTex;
          vSurf = aSurf;
        }`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform highp sampler2DArray uDetail;
        uniform highp sampler2DArray uNormalArr;
        uniform float uInvScale[16];
        uniform float uNormalStrength;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying float vTex;
        varying vec2 vSurf;
        vec3 triW;
        vec2 uvX; vec2 uvY; vec2 uvZ;
        float layerF;
        vec4 triSample(highp sampler2DArray s) {
          return texture(s, vec3(uvX, layerF)) * triW.x + texture(s, vec3(uvY, layerF)) * triW.y + texture(s, vec3(uvZ, layerF)) * triW.z;
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 n = normalize(vWNrm);
          triW = pow(abs(n), vec3(6.0));
          triW /= max(triW.x + triW.y + triW.z, 1e-4);
          layerF = floor(vTex + 0.5);
          float sc = uInvScale[int(layerF)];
          uvX = vWPos.zy * sc; uvY = vWPos.xz * sc; uvZ = vWPos.xy * sc;
          vec4 d = triSample(uDetail);
          vec3 base = diffuseColor.rgb * d.rgb * (255.0 / 160.0);
          // Grout / mortar: a neutral, slightly lighter grey regardless of the base colour.
          vec3 grout = vec3(0.32, 0.31, 0.29) + dot(diffuseColor.rgb, vec3(0.2));
          diffuseColor.rgb = mix(base, grout, d.a);
          // Weathering: dirt splash near street level and big soft stains.
          float grime = 1.0 - 0.3 * (1.0 - smoothstep(0.0, 1.3, vWPos.y));
          float stain = texture(uDetail, vec3(vWPos.xz * 0.021 + vec2(vWPos.y * 0.013), 0.0)).r * (255.0 / 160.0);
          diffuseColor.rgb *= grime * mix(0.8, 1.06, smoothstep(0.85, 1.1, stain));
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
        vec4 nr = triSample(uNormalArr);
        roughnessFactor = clamp(vSurf.x * mix(0.7, 1.3, nr.a), 0.04, 1.0);`,
      )
      .replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
        metalnessFactor = vSurf.y;`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        {
          // UDN triplanar normal blend in world space, then back to view space.
          vec3 tX = texture(uNormalArr, vec3(uvX, layerF)).xyz * 2.0 - 1.0;
          vec3 tY = texture(uNormalArr, vec3(uvY, layerF)).xyz * 2.0 - 1.0;
          vec3 tZ = texture(uNormalArr, vec3(uvZ, layerF)).xyz * 2.0 - 1.0;
          vec3 wn = normalize(vWNrm);
          vec3 bump = vec3(0.0, tX.y, tX.x) * triW.x + vec3(tY.x, 0.0, tY.y) * triW.y + vec3(tZ.x, tZ.y, 0.0) * triW.z;
          wn = normalize(wn + bump * uNormalStrength);
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`,
      );
  };
  // Distinct cache key so Three doesn't share the program with plain standard materials.
  mat.customProgramCacheKey = () => 'grey-world-triplanar-v1';
  return mat;
};

/** Fill the per-instance surface attributes for a list of material keys. */
export const surfaceAttributes = (keys: string[]): { tex: THREE.InstancedBufferAttribute; surf: THREE.InstancedBufferAttribute } => {
  const tex = new Float32Array(keys.length);
  const surf = new Float32Array(keys.length * 2);
  keys.forEach((k, i) => {
    tex[i] = surfaceIndex(k);
    const p = SURFACE_PROPS[k] ?? { roughness: 0.92, metalness: 0 };
    surf[i * 2] = p.roughness;
    surf[i * 2 + 1] = p.metalness;
  });
  return { tex: new THREE.InstancedBufferAttribute(tex, 1), surf: new THREE.InstancedBufferAttribute(surf, 2) };
};
