import * as THREE from 'three';

/**
 * Percentage-closer soft shadows for the key light.
 *
 * A sticker lying flat should cast a razor-thin contact line, the curl at a
 * peel front a slightly soft one, and a sticker held 3 cm up a wide, faint
 * blob. That's exactly what PCSS does: search the shadow map for blockers,
 * estimate how far above the receiver they are, and widen the filter with
 * that distance. Three's PCF path uses hardware-compare samplers which can't
 * read raw depth, so this replaces the BASIC shadow lookup instead.
 *
 * `frustum` is the width of the orthographic shadow camera (world units),
 * `depthRange` is far - near, and `lightSize` is the light's angular size as
 * tan(angle) — how fast the penumbra grows per unit of height.
 */
/** PCSS blocker-search radius in shadow-map uv (also used to size PcssMinMax). */
export const pcssSearchUv = (frustum: number, lightSize: number) => (lightSize * 5.0) / frustum;

export function installPcss(frustum: number, lightSize: number) {
  const f = (n: number) => n.toFixed(6);
  const pcss = /* glsl */ `
uniform sampler2D pcssMinMax;
// World height of a shadow-map sample: an affine function of (u, v, depth)
// because the shadow camera is orthographic.
uniform vec4 pcssHeight;
#define PCSS_BLOCKER_SAMPLES 8
#define PCSS_FILTER_SAMPLES 16
// A blocker must stand at least this far (cm) above the receiver. Comparing
// heights instead of raw depths means a flat surface lit at an angle never
// shadows itself, however wide the search.
#define PCSS_MIN_RISE 0.03
float pcssIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 pcssVogel(int i, int n, float phi) {
  float r = sqrt((float(i) + 0.5) / float(n));
  float t = float(i) * 2.399963229728653 + phi;
  return vec2(cos(t), sin(t)) * r;
}
float pcssH(vec2 uv, float z) { return dot(pcssHeight, vec4(uv, z, 1.0)); }
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowRadius;
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 || shadowCoord.y < 0.0 || shadowCoord.y > 1.0 || shadowCoord.z > 1.0) return 1.0;
  float zr = shadowCoord.z;
  float hr = pcssH(shadowCoord.xy, zr) + PCSS_MIN_RISE;
  // Min/max surface height within reach of the search (see PcssMinMax).
  // Nothing taller than us nearby: lit. Everything well above us: in shadow.
  // Either way that's one fetch instead of a 24-tap search.
  vec2 mm = texture2D(pcssMinMax, shadowCoord.xy).rg;
  if (mm.y <= hr) return 1.0;
  if (mm.x > hr + 1.0) {
    float h = 0.5 * (mm.x + mm.y) - hr;
    return mix(1.0, 0.0, shadowIntensity * (1.0 - clamp(h * 0.09, 0.0, 0.55)));
  }
  float phi = pcssIgn(gl_FragCoord.xy) * 6.2831853;
  // 1. Blocker search over the largest penumbra we care about.
  float searchUv = ${f(pcssSearchUv(frustum, lightSize))};
  float sum = 0.0;
  float count = 0.0;
  for (int i = 0; i < PCSS_BLOCKER_SAMPLES; i++) {
    vec2 uv = shadowCoord.xy + pcssVogel(i, PCSS_BLOCKER_SAMPLES, phi) * searchUv;
    float d = texture2D(shadowMap, uv).r;
    float h = pcssH(uv, d);
    if (d < zr && h > hr) { sum += h; count += 1.0; }
  }
  if (count < 0.5) return 1.0;
  // 2. Penumbra from blocker height (world units) -> uv radius.
  float height = sum / count - hr;
  float radiusUv = max(1.2 / shadowMapSize.x, height * ${f(lightSize)} / ${f(frustum)});
  radiusUv = min(radiusUv, searchUv);
  // 3. Filter.
  float lit = 0.0;
  for (int i = 0; i < PCSS_FILTER_SAMPLES; i++) {
    vec2 uv = shadowCoord.xy + pcssVogel(i, PCSS_FILTER_SAMPLES, phi + 1.7) * radiusUv;
    float d = texture2D(shadowMap, uv).r;
    lit += (d < zr && pcssH(uv, d) > hr) ? 0.0 : 1.0;
  }
  float shadow = lit / float(PCSS_FILTER_SAMPLES);
  // Higher blockers also let more skylight in underneath.
  float fade = clamp(height * 0.09, 0.0, 0.55);
  return mix(1.0, shadow, shadowIntensity * (1.0 - fade));
}
`;
  // Replace the BASIC getShadow (the one after the VSM branch).
  const chunk = THREE.ShaderChunk.shadowmap_pars_fragment;
  const vsm = chunk.indexOf('SHADOWMAP_TYPE_VSM');
  const sig = 'float getShadow( sampler2D shadowMap';
  const vsmFn = chunk.indexOf(sig, vsm);
  const start = vsmFn < 0 ? -1 : chunk.indexOf(sig, vsmFn + sig.length);
  const ret = start < 0 ? -1 : chunk.indexOf('return mix( 1.0, shadow, shadowIntensity );', start);
  const end = ret < 0 ? -1 : chunk.indexOf('}', ret) + 1;
  if (start < 0 || end <= 0) {
    console.warn('PCSS: shadow chunk layout changed; keeping default shadows');
    return false;
  }
  THREE.ShaderChunk.shadowmap_pars_fragment = chunk.slice(0, start) + pcss + chunk.slice(end);
  return true;
}

/**
 * A tiny texture holding, for each block of the shadow map, the nearest and
 * farthest depth within reach of the PCSS blocker search. Rebuilt only when
 * the shadow map is (two cheap passes on a 64 x 64 target).
 */
export class PcssMinMax {
  readonly uniform: { value: THREE.Texture | null } = { value: null };
  readonly height = { value: new THREE.Vector4(0, 0, 0, 0) };
  private inv = new THREE.Matrix4();
  private reduce: THREE.WebGLRenderTarget;
  private dilate: THREE.WebGLRenderTarget;
  private reduceMat: THREE.ShaderMaterial;
  private dilateMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  /**
   * `searchTexels` is the PCSS blocker-search radius in shadow-map texels;
   * each cell's summary is dilated to cover it.
   */
  constructor(
    private renderer: THREE.WebGLRenderer,
    mapSize: number,
    searchTexels: number,
    cells = 128,
  ) {
    const opts = {
      type: THREE.FloatType,
      format: THREE.RGFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      generateMipmaps: false,
    } as const;
    this.reduce = new THREE.WebGLRenderTarget(cells, cells, opts);
    this.dilate = new THREE.WebGLRenderTarget(cells, cells, opts);
    const block = mapSize / cells;
    const reach = Math.max(1, Math.ceil(searchTexels / block));
    const vertexShader = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    this.reduceMat = new THREE.ShaderMaterial({
      uniforms: { depth: { value: null }, pcssHeight: this.height },
      vertexShader,
      fragmentShader: `
        uniform sampler2D depth;
        uniform vec4 pcssHeight;
        varying vec2 vUv;
        void main() {
          ivec2 base = ivec2(gl_FragCoord.xy) * ${block};
          float lo = 1e9;
          float hi = -1e9;
          for (int y = 0; y < ${block}; y++) {
            for (int x = 0; x < ${block}; x++) {
              ivec2 p = base + ivec2(x, y);
              float d = texelFetch(depth, p, 0).r;
              vec2 uv = (vec2(p) + 0.5) / ${mapSize.toFixed(1)};
              float h = dot(pcssHeight, vec4(uv, d, 1.0));
              lo = min(lo, h);
              hi = max(hi, h);
            }
          }
          gl_FragColor = vec4(lo, hi, 0.0, 1.0);
        }`,
    });
    this.dilateMat = new THREE.ShaderMaterial({
      uniforms: { src: { value: this.reduce.texture } },
      vertexShader,
      fragmentShader: `
        uniform sampler2D src;
        varying vec2 vUv;
        void main() {
          ivec2 p = ivec2(gl_FragCoord.xy);
          ivec2 last = ivec2(${cells - 1});
          float lo = 1e9;
          float hi = -1e9;
          for (int y = -${reach}; y <= ${reach}; y++) {
            for (int x = -${reach}; x <= ${reach}; x++) {
              vec2 v = texelFetch(src, clamp(p + ivec2(x, y), ivec2(0), last), 0).rg;
              lo = min(lo, v.x);
              hi = max(hi, v.y);
            }
          }
          gl_FragColor = vec4(lo, hi, 0.0, 1.0);
        }`,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.reduceMat);
    // Without float render targets, fall back to "always search" (lo=0, hi=1).
    this.supported = renderer.extensions.has('EXT_color_buffer_float');
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
    if (this.supported) this.uniform.value = this.dilate.texture;
    else {
      const t = new THREE.DataTexture(new Float32Array([-1e9, 1e9]), 1, 1, THREE.RGFormat, THREE.FloatType);
      t.needsUpdate = true;
      this.uniform.value = t;
    }
  }

  private supported: boolean;

  /**
   * `shadowMatrix` maps world -> (u, v, depth); its inverse's second row
   * gives world height from shadow-map coordinates.
   */
  update(depth: THREE.Texture, shadowMatrix: THREE.Matrix4) {
    const e = this.inv.copy(shadowMatrix).invert().elements;
    this.height.value.set(e[1], e[5], e[9], e[13]);
    if (!this.supported) return;
    const r = this.renderer;
    const prev = r.getRenderTarget();
    const auto = r.autoClear;
    r.autoClear = false;
    this.reduceMat.uniforms.depth.value = depth;
    this.quad.material = this.reduceMat;
    r.setRenderTarget(this.reduce);
    r.render(this.scene, this.cam);
    this.quad.material = this.dilateMat;
    r.setRenderTarget(this.dilate);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prev);
    r.autoClear = auto;
  }

  /** Give a material access to the min/max texture. Safe to call twice. */
  patch(m: THREE.Material) {
    if (m.userData.pcss) return;
    m.userData.pcss = true;
    const prev = m.onBeforeCompile;
    const uniform = this.uniform;
    const height = this.height;
    m.onBeforeCompile = function (shader, renderer) {
      shader.uniforms.pcssMinMax = uniform;
      shader.uniforms.pcssHeight = height;
      prev.call(this, shader, renderer);
    };
  }
}
