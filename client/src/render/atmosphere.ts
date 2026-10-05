import * as THREE from 'three';

/**
 * Art-directed hazy sky (gradient + sun glow, low dynamic range so it doesn't blow out bloom
 * or reflections), a warm sun with soft shadows, and image-based lighting baked from the sky.
 * setSun() is the hook for the day/night cycle (milestone 11).
 */
const SkyShader = {
  uniforms: {
    uZenith: { value: new THREE.Color(0x6f7d86) },
    uHorizon: { value: new THREE.Color(0xb8b8ad) },
    uGround: { value: new THREE.Color(0x77756c) },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color(1.0, 0.9, 0.75) },
  },
  vertexShader: /* glsl */ `
    varying vec3 vDir;
    void main() {
      vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz);
      vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      gl_Position = p.xyww; // always at the far plane
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uZenith, uHorizon, uGround, uSunDir, uSunColor;
    varying vec3 vDir;
    void main() {
      vec3 d = normalize(vDir);
      float h = d.y;
      vec3 sky = h > 0.0 ? mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55)) : mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));
      float s = max(dot(d, normalize(uSunDir)), 0.0);
      sky += uSunColor * (pow(s, 6.0) * 0.18 + pow(s, 64.0) * 0.35 + pow(s, 900.0) * 1.2);
      gl_FragColor = vec4(sky, 1.0);
      #include <colorspace_fragment>
    }`,
};

const makeSkyMesh = (): THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial> =>
  new THREE.Mesh(
    new THREE.SphereGeometry(1, 32, 16),
    new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(SkyShader.uniforms),
      vertexShader: SkyShader.vertexShader,
      fragmentShader: SkyShader.fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );

export class Atmosphere {
  readonly sky = makeSkyMesh();
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private readonly sunDir = new THREE.Vector3();
  private envTarget: THREE.WebGLRenderTarget | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    shadowExtent: number,
    shadowMapSize: number,
  ) {
    this.sky.scale.setScalar(100);
    this.sky.renderOrder = -1;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.hemi = new THREE.HemisphereLight(0xb9c0c2, 0x45403a, 0.55);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xffe2bd, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    const sc = this.sun.shadow.camera;
    sc.left = sc.bottom = -shadowExtent;
    sc.right = sc.top = shadowExtent;
    sc.near = 1;
    sc.far = 320;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 3;
    scene.add(this.sun, this.sun.target);

    // Haze matching the horizon colour.
    scene.fog = new THREE.FogExp2(0xb3b4aa, 0.0075);
    scene.background = null;

    this.setSun(34, 140);
  }

  /** Sun elevation / azimuth in degrees. Rebakes the reflection environment. */
  setSun(elevationDeg: number, azimuthDeg: number): void {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.sunDir.setFromSphericalCoords(1, phi, theta);
    this.sky.material.uniforms.uSunDir.value.copy(this.sunDir);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    const skyCopy = makeSkyMesh();
    skyCopy.material.uniforms.uSunDir.value.copy(this.sunDir);
    skyCopy.scale.setScalar(10);
    envScene.add(skyCopy);
    this.envTarget?.dispose();
    this.envTarget = pmrem.fromScene(envScene, 0, 0.1, 100);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.6;
    pmrem.dispose();
  }

  /** Keep the sky around the camera and the shadow box centred on the player. */
  update(camera: THREE.Camera, shadowExtent: number): void {
    this.sky.position.copy(camera.position);
    const texel = (shadowExtent * 2) / this.sun.shadow.mapSize.x;
    const x = Math.round(camera.position.x / texel) * texel;
    const z = Math.round(camera.position.z / texel) * texel;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + this.sunDir.x * 150, this.sunDir.y * 150, z + this.sunDir.z * 150);
  }
}
