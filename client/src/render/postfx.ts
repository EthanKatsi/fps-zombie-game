import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

import type { GraphicsQuality } from '../settings';
export type { GraphicsQuality };

/** Final colour grade in display space: desaturated, teal shadows / warm highlights, grain, vignette. */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uSaturation: { value: 0.78 },
    uContrast: { value: 1.12 },
    uVignette: { value: 0.38 },
    uGrain: { value: 0.045 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uSaturation, uContrast, uVignette, uGrain;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, uSaturation);
      // Split toning: cool shadows, warm highlights.
      c += mix(vec3(-0.012, 0.004, 0.018), vec3(0.02, 0.008, -0.015), smoothstep(0.2, 0.8, l));
      c = (c - 0.5) * uContrast + 0.5;
      // Vignette.
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.25, 0.85, dot(d, d) * 2.2);
      // Film grain (animated).
      c += (rand(vUv * 1000.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/**
 * Post-processing chain: scene -> ambient occlusion (high) -> subtle bloom -> tone mapping /
 * sRGB -> colour grade. 'low' skips the chain entirely.
 */
export class PostFX {
  private readonly composer: EffectComposer;
  private readonly gtao: GTAOPass;
  private readonly bloom: UnrealBloomPass;
  private readonly grade: ShaderPass;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    private quality: GraphicsQuality,
  ) {
    const w = window.innerWidth, h = window.innerHeight;
    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(scene, camera));
    this.gtao = new GTAOPass(scene, camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.9;
    this.gtao.updateGtaoMaterial({ radius: 0.9, distanceExponent: 1.4, thickness: 1.5, scale: 1.0, samples: 12 });
    this.gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.composer.addPass(this.gtao);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.16, 0.5, 0.9);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.setQuality(quality);
  }

  setQuality(q: GraphicsQuality): void {
    this.quality = q;
    this.gtao.enabled = q === 'high';
    this.bloom.enabled = q === 'high' || q === 'medium';
  }

  setSize(w: number, h: number): void {
    this.composer.setSize(w, h);
  }

  render(dt: number): void {
    if (this.quality === 'low' || this.quality === 'performance') {
      this.renderer.clear();
      this.renderer.render((this.composer.passes[0] as RenderPass).scene, (this.composer.passes[0] as RenderPass).camera);
      return;
    }
    this.grade.uniforms.uTime.value = (this.grade.uniforms.uTime.value + dt) % 100;
    this.composer.render(dt);
  }
}
