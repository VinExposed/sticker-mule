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
export function installPcss(frustum: number, depthRange: number, lightSize: number) {
  const f = (n: number) => n.toFixed(6);
  const pcss = /* glsl */ `
#define PCSS_BLOCKER_SAMPLES 12
#define PCSS_FILTER_SAMPLES 24
float pcssIgn(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
vec2 pcssVogel(int i, int n, float phi) {
  float r = sqrt((float(i) + 0.5) / float(n));
  float t = float(i) * 2.399963229728653 + phi;
  return vec2(cos(t), sin(t)) * r;
}
float getShadow( sampler2D shadowMap, vec2 shadowMapSize, float shadowIntensity, float shadowBias, float shadowRadius, vec4 shadowCoord ) {
  shadowRadius;
  shadowCoord.xyz /= shadowCoord.w;
  shadowCoord.z += shadowBias;
  if (shadowCoord.x < 0.0 || shadowCoord.x > 1.0 || shadowCoord.y < 0.0 || shadowCoord.y > 1.0 || shadowCoord.z > 1.0) return 1.0;
  float phi = pcssIgn(gl_FragCoord.xy) * 6.2831853;
  float zr = shadowCoord.z;
  // 1. Blocker search over the largest penumbra we care about.
  float searchUv = ${f((lightSize * 6.0) / frustum)};
  float sum = 0.0;
  float count = 0.0;
  for (int i = 0; i < PCSS_BLOCKER_SAMPLES; i++) {
    float d = texture2D(shadowMap, shadowCoord.xy + pcssVogel(i, PCSS_BLOCKER_SAMPLES, phi) * searchUv).r;
    if (d < zr) { sum += d; count += 1.0; }
  }
  if (count < 0.5) return 1.0;
  float zb = sum / count;
  // 2. Penumbra from blocker height (world units) -> uv radius.
  float height = (zr - zb) * ${f(depthRange)};
  float radiusUv = max(1.2 / shadowMapSize.x, height * ${f(lightSize)} / ${f(frustum)});
  radiusUv = min(radiusUv, searchUv);
  // 3. Filter.
  float lit = 0.0;
  for (int i = 0; i < PCSS_FILTER_SAMPLES; i++) {
    float d = texture2D(shadowMap, shadowCoord.xy + pcssVogel(i, PCSS_FILTER_SAMPLES, phi + 1.7) * radiusUv).r;
    lit += step(zr, d);
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
