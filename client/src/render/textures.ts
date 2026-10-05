import * as THREE from 'three';

/**
 * Procedural surface textures, generated ON THE GPU at startup (a few milliseconds; no
 * downloads). Each layer is a tileable 512x512 square in two array textures:
 *   detail: RGB = colour multiplier (1.0 stored as 160/255), A = "grout" mask (mortar, joints)
 *   normal: RGB = tangent-space normal from the height field, A = roughness variation
 * The world material samples them triplanar in world space (see worldMaterial.ts).
 */
export const LAYERS = [
  'plain', 'brick', 'concrete', 'asphalt', 'wood', 'siding', 'grass', 'tile',
  'plaster', 'metal', 'fabric', 'roof', 'sidewalk', 'bark', 'leaves',
] as const;
export type Layer = (typeof LAYERS)[number];

/** World metres covered by one repeat of each layer. */
export const LAYER_SCALE: Record<Layer, number> = {
  plain: 3, brick: 1.2, concrete: 4, asphalt: 3, wood: 2, siding: 2, grass: 2.5, tile: 1.2,
  plaster: 3, metal: 2, fabric: 0.6, roof: 2.5, sidewalk: 3, bark: 1, leaves: 1.2,
};

const SIZE = 512;

/**
 * GLSL ports of the surface patterns. surface(layer, uv) returns:
 *   rgb multiplier, grout mask, height, roughness   (packed in two vec4s via out params)
 */
const GEN_GLSL = /* glsl */ `
  float hash(vec2 p, float seed) {
    p = fract(p * vec2(0.1031, 0.1030) + seed * 0.0137);
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.x);
  }
  // Tileable value noise: lattice wraps every 'period' cells over uv in [0,1).
  float vnoise(vec2 uv, float period, float seed) {
    vec2 x = uv * period;
    vec2 i = floor(x), f = fract(x);
    vec2 s = f * f * (3.0 - 2.0 * f);
    float a = hash(mod(i, period), seed);
    float b = hash(mod(i + vec2(1.0, 0.0), period), seed);
    float c = hash(mod(i + vec2(0.0, 1.0), period), seed);
    float d = hash(mod(i + vec2(1.0, 1.0), period), seed);
    return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
  }
  float fbm(vec2 uv, float period, float seed, int oct) {
    float sum = 0.0, amp = 0.5, norm = 0.0, p = period;
    for (int o = 0; o < 6; o++) {
      if (o >= oct) break;
      sum += vnoise(uv, p, seed + float(o) * 17.0) * amp;
      norm += amp; amp *= 0.5; p *= 2.0;
    }
    return sum / norm;
  }
  // Fine, branching cracks that only appear in some areas (not a uniform web of outlines).
  float cracks(vec2 uv, float period, float seed, float width) {
    float line = max(0.0, 1.0 - abs(fbm(uv, period, seed, 4) - 0.5) / width);
    float mask = smoothstep(0.55, 0.7, fbm(uv, 2.0, seed + 5.0, 3));
    return line * mask;
  }
  float cellHash(vec2 cell, float seed) { return hash(cell + 0.5, seed); }

  // out: col (rgb multiplier), grout, height, rough
  void surface(int L, vec2 uv, out vec3 col, out float grout, out float h, out float rough) {
    grout = 0.0; rough = 0.5;
    if (L == 1) { // brick
      float rows = 10.0, cols = 4.0;
      float row = floor(uv.y * rows);
      float off = mod(row, 2.0) > 0.5 ? 0.5 / cols : 0.0;
      vec2 c = vec2((uv.x + off) * cols, uv.y * rows);
      vec2 f = fract(c);
      float mortar = (f.x < 0.035 || f.y < 0.09) ? 1.0 : 0.0;
      float tone = 0.78 + cellHash(vec2(mod(floor(c.x), cols), row), 7.0) * 0.4;
      float n = fbm(uv, 16.0, 3.0, 4);
      float chip = n > 0.72 ? (n - 0.72) * 2.5 : 0.0;
      float k = tone * (0.9 + n * 0.2) - chip * 0.3;
      col = vec3(k * 1.02, k, k * 0.97); grout = mortar;
      h = mortar > 0.5 ? 0.25 : 0.8 + n * 0.2 - chip; rough = mortar > 0.5 ? 0.9 : 0.55 + n * 0.2;
    } else if (L == 2) { // concrete
      float n = fbm(uv, 6.0, 5.0, 4);
      float pores = cellHash(floor(uv * 400.0), 9.0) > 0.985 ? 0.25 : 0.0;
      float c = cracks(uv, 5.0, 11.0, 0.006);
      float k = 0.82 + n * 0.3 - pores - c * 0.35;
      col = vec3(k); h = n * 0.5 + 0.4 - pores - c * 0.4; rough = 0.5 + n * 0.3;
    } else if (L == 3) { // asphalt
      float grain = cellHash(floor(uv * 512.0), 21.0);
      float n = fbm(uv, 5.0, 23.0, 4);
      float stone = grain > 0.93 ? 0.35 : 0.0;
      float c = cracks(uv, 4.0, 29.0, 0.005);
      float k = 0.8 + n * 0.25 + (grain - 0.5) * 0.18 + stone - c * 0.5;
      col = vec3(k); h = 0.5 + (grain - 0.5) * 0.4 + stone * 0.6 - c * 0.6; rough = 0.6 + grain * 0.3;
    } else if (L == 4) { // wood planks
      float pv = uv.y * 5.0;
      float plank = floor(pv);
      float fy = fract(pv);
      float seam = fy < 0.04 ? 1.0 : 0.0;
      float warp = fbm(uv, 3.0, 31.0 + plank, 3) * 8.0;
      float grain = 0.5 + 0.5 * sin(pv * 40.0 + warp + fbm(vec2(uv.x * 0.25, uv.y), 6.0, 37.0, 3) * 6.0);
      float tone = 0.8 + cellHash(vec2(plank, 0.0), 41.0) * 0.35;
      float k = tone * (0.85 + grain * 0.22) * (seam > 0.5 ? 0.45 : 1.0);
      col = vec3(k * 1.02, k, k * 0.94); h = seam > 0.5 ? 0.1 : 0.7 + grain * 0.15; rough = 0.55 + grain * 0.2;
    } else if (L == 5) { // lap siding
      float fy = fract(uv.y * 10.0);
      float shade = 0.72 + 0.28 * min(1.0, fy * 3.0);
      float n = fbm(uv, 8.0, 43.0, 4);
      float peel = fbm(uv, 12.0, 47.0, 4) > 0.7 ? 0.82 : 1.0;
      col = vec3(shade * (0.94 + n * 0.1) * peel); h = fy * 0.8 + n * 0.1; rough = 0.45 + n * 0.2;
    } else if (L == 6) { // grass
      float blade = cellHash(floor(uv * 512.0), 51.0);
      float clump = fbm(uv, 6.0, 53.0, 4);
      float dry = fbm(uv, 3.0, 57.0, 3);
      float k = 0.62 + clump * 0.5 + (blade - 0.5) * 0.3;
      col = vec3(k * (0.95 + dry * 0.35), k * (1.0 + dry * 0.1), k * 0.85); h = blade * 0.6 + clump * 0.4; rough = 0.8;
    } else if (L == 7) { // tiles
      vec2 f = fract(uv * 8.0);
      float g = (f.x < 0.05 || f.y < 0.05) ? 1.0 : 0.0;
      float tone = 0.9 + cellHash(floor(uv * 8.0), 61.0) * 0.15;
      float dirt = fbm(uv, 4.0, 63.0, 3);
      col = vec3(tone * (0.85 + dirt * 0.2)); grout = g; h = g > 0.5 ? 0.2 : 0.85; rough = g > 0.5 ? 0.9 : 0.25;
    } else if (L == 8) { // plaster
      float n = fbm(uv, 8.0, 71.0, 4);
      float stain = fbm(uv, 2.0, 73.0, 3);
      col = vec3(0.9 + n * 0.1 - max(0.0, stain - 0.6) * 0.5); h = n * 0.4; rough = 0.55;
    } else if (L == 9) { // metal: brushed + rust
      float brushed = fbm(vec2(uv.x * 0.05, uv.y), 64.0, 81.0, 2);
      float rust = fbm(uv, 5.0, 83.0, 4);
      float r = max(0.0, rust - 0.62) * 3.0;
      float b = 0.9 + brushed * 0.15;
      col = vec3(b * (1.0 + r * 0.25), b * (1.0 - r * 0.25), b * (1.0 - r * 0.45));
      h = 0.5 + brushed * 0.1 - r * 0.2; rough = 0.3 + r * 0.7;
    } else if (L == 10) { // fabric weave
      float w = 0.5 + 0.25 * (sin(uv.x * 6.2832 * 48.0) + sin(uv.y * 6.2832 * 48.0));
      float n = fbm(uv, 6.0, 91.0, 3);
      col = vec3(0.85 + w * 0.15 + n * 0.08); h = w; rough = 0.85;
    } else if (L == 11) { // roof gravel
      float gr = cellHash(floor(uv * 256.0), 101.0);
      float n = fbm(uv, 4.0, 103.0, 3);
      col = vec3(0.75 + gr * 0.3 + n * 0.1); h = gr; rough = 0.9;
    } else if (L == 12) { // sidewalk slabs
      vec2 f = fract(uv * 2.0);
      float joint = (f.x < 0.012 || f.y < 0.012) ? 1.0 : 0.0;
      float c = fbm(uv, 6.0, 111.0, 4);
      float cr = cracks(uv, 3.0, 113.0, 0.01);
      col = vec3(0.86 + c * 0.2 - cr * 0.3); grout = joint * 0.7; h = joint > 0.5 ? 0.15 : 0.6 + c * 0.2 - cr * 0.4; rough = 0.6;
    } else if (L == 13) { // bark
      float ridges = fbm(vec2(uv.x, uv.y * 0.15), 24.0, 121.0, 3);
      col = vec3(0.7 + ridges * 0.5); h = ridges; rough = 0.85;
    } else if (L == 14) { // leaves
      float clump = fbm(uv, 10.0, 131.0, 4);
      float k = 0.6 + clump * 0.65;
      col = vec3(k * 0.95, k * 1.05, k * 0.85); h = clump; rough = 0.7;
    } else { // plain
      float n = fbm(uv, 4.0, 1.0, 4);
      col = vec3(0.94 + n * 0.12); h = n * 0.3;
    }
  }
`;

const GenMaterial = (mode: 0 | 1) =>
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uLayer: { value: 0 } },
    vertexShader: /* glsl */ `
      out vec2 vUv;
      void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform int uLayer;
      in vec2 vUv;
      out vec4 outColor;
      ${GEN_GLSL}
      void main() {
        vec3 col; float grout, h, rough;
        surface(uLayer, vUv, col, grout, h, rough);
        ${
          mode === 0
            ? 'outColor = vec4(clamp(col * (160.0 / 255.0), 0.0, 1.0), grout);'
            : `
        // Normal from the height field (forward differences: 3 evaluations per texel).
        float e = 1.0 / ${SIZE}.0;
        vec3 c2; float g2, hx, hy, r2;
        surface(uLayer, fract(vUv + vec2(e, 0.0)), c2, g2, hx, r2);
        surface(uLayer, fract(vUv + vec2(0.0, e)), c2, g2, hy, r2);
        vec3 n = normalize(vec3((h - hx) * 6.0, (h - hy) * 6.0, 1.0));
        outColor = vec4(n * 0.5 + 0.5, clamp(rough, 0.0, 1.0));`
        }
      }`,
    depthTest: false,
    depthWrite: false,
  });

export interface SurfaceTextures {
  detail: THREE.Texture;
  normal: THREE.Texture;
}

/** Render every layer into two array textures on the GPU. */
export const generateSurfaceTextures = (renderer: THREE.WebGLRenderer): SurfaceTextures => {
  const n = LAYERS.length;
  const make = () => {
    const rt = new THREE.WebGLArrayRenderTarget(SIZE, SIZE, n, { depthBuffer: false });
    const t = rt.texture;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return rt;
  };
  const targets = [make(), make()];
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prevTarget = renderer.getRenderTarget();
  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = true;
  ([0, 1] as const).forEach((mode) => {
    const mat = GenMaterial(mode);
    quad.material = mat;
    for (let layer = 0; layer < n; layer++) {
      mat.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(targets[mode], layer);
      renderer.render(scene, cam);
    }
    mat.dispose();
  });
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAutoClear;
  quad.geometry.dispose();
  return { detail: targets[0].texture, normal: targets[1].texture };
};
