import * as THREE from 'three';
import type { Finish, StickerSource } from './factory';

export const holoUniforms = {
  uTime: { value: 0 },
};

function texture(c: HTMLCanvasElement, srgb: boolean, maxAniso: number) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = maxAniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const HOLO_PARS = /* glsl */ `
uniform sampler2D foilMap;
uniform float uTime;
float holoHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
vec3 holoSpectrum(float t) {
  return 0.5 + 0.5 * cos(6.28318 * (t + vec3(0.0, 0.33, 0.67)));
}
`;

// Runs after normals are known and before lighting, so the foil is lit like a
// real metallised film: a spectral tint that shifts with the angle you see it
// from, fine shards, and glitter that only flashes at the right angle.
const HOLO_MAIN = /* glsl */ `
float foil = texture2D(foilMap, vMapUv).r;
if (foil > 0.002) {
  vec3 V = normalize(vViewPosition);
  vec3 N = normal;
  vec3 Rv = reflect(-V, N);
  vec2 uv = vMapUv;
  float facing = dot(N, V);

  // Shards: a jittered grid, each cell a slightly different grating angle.
  vec2 cuv = uv * 11.0;
  vec2 ci = floor(cuv + 0.5 * vec2(holoHash(floor(cuv.yy)), 0.0));
  float shard = holoHash(ci);

  float phase = facing * 2.6 + Rv.x * 1.9 - Rv.y * 1.4 + (uv.x * 1.2 - uv.y * 0.9) + shard * 0.22 + uTime * 0.015;
  vec3 spec = holoSpectrum(phase);
  vec3 spec2 = holoSpectrum(phase * 1.7 + 0.31);
  spec = mix(spec, spec2, 0.35);
  // Keep it pastel-bright like real holographic vinyl, not neon.
  spec = mix(vec3(dot(spec, vec3(0.333))), spec, 0.9) * 0.85 + 0.25;

  vec3 printed = diffuseColor.rgb;
  float whiteness = smoothstep(0.75, 0.98, min(printed.r, min(printed.g, printed.b)));
  vec3 foilColor = mix(printed * spec * 1.45, spec, whiteness);
  diffuseColor.rgb = mix(diffuseColor.rgb, foilColor, foil);
  metalnessFactor = mix(metalnessFactor, 0.7, foil);
  roughnessFactor = mix(roughnessFactor, 0.2 + shard * 0.08, foil);

  // Glitter.
  vec2 guv = uv * 150.0;
  vec2 gi = floor(guv);
  vec2 gf = fract(guv) - 0.5;
  float r1 = holoHash(gi);
  float r2 = holoHash(gi + 19.17);
  vec3 gn = normalize(vec3(r1 - 0.5, r2 - 0.5, 0.9));
  float glint = pow(max(0.0, sin(dot(Rv, gn) * 26.0 + r1 * 6.2831)), 60.0);
  float dotShape = smoothstep(0.42, 0.0, length(gf));
  totalEmissiveRadiance += (spec * 0.12 + vec3(1.0) * glint * dotShape * 1.6) * foil;
}
`;

export interface StickerMaterials {
  front: THREE.MeshPhysicalMaterial;
  back: THREE.MeshStandardMaterial;
  dispose(): void;
}

export function stickerMaterials(src: StickerSource, maxAniso: number): StickerMaterials {
  const map = texture(src.front, true, maxAniso);
  const backMap = texture(src.back, true, maxAniso);
  const foilMap = texture(src.foil, false, maxAniso);

  const front = new THREE.MeshPhysicalMaterial({
    map,
    alphaTest: 0.5,
    alphaToCoverage: true,
    ...finishParams(src.finish),
  });
  applyFinish(front, src.finish, foilMap);

  const back = new THREE.MeshStandardMaterial({
    map: backMap,
    alphaTest: 0.5,
    alphaToCoverage: true,
    roughness: 0.62,
    metalness: 0,
    side: THREE.BackSide,
  });

  return {
    front,
    back,
    dispose() {
      map.dispose();
      backMap.dispose();
      foilMap.dispose();
      front.dispose();
      back.dispose();
    },
  };
}

function finishParams(finish: Finish) {
  switch (finish) {
    case 'matte':
      return { roughness: 0.82, clearcoat: 0, metalness: 0 };
    case 'holo':
      return { roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.06, metalness: 0 };
    default:
      return { roughness: 0.48, clearcoat: 1, clearcoatRoughness: 0.08, metalness: 0 };
  }
}

export function applyFinish(m: THREE.MeshPhysicalMaterial, finish: Finish, foilMap: THREE.Texture) {
  m.setValues(finishParams(finish));
  if (finish === 'holo') {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.foilMap = { value: foilMap };
      shader.uniforms.uTime = holoUniforms.uTime;
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${HOLO_PARS}`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${HOLO_MAIN}`);
    };
    m.customProgramCacheKey = () => 'holo';
  } else {
    m.onBeforeCompile = () => {};
    m.customProgramCacheKey = () => finish;
  }
  m.needsUpdate = true;
}
