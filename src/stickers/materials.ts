import * as THREE from 'three';
import type { Finish, StickerSource } from './factory';

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

  // Shattered-glass shards: Voronoi cells, each a tiny mirror at its own tilt.
  vec2 cg = uv * 8.0;
  vec2 gi = floor(cg);
  vec2 gf = fract(cg);
  float md = 8.0;
  vec2 cell = vec2(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 h = vec2(holoHash(gi + o), holoHash(gi + o + 7.31));
      vec2 r = o + h - gf;
      float d = dot(r, r);
      if (d < md) { md = d; cell = gi + o; }
    }
  }
  vec2 tilt = vec2(holoHash(cell + 3.1), holoHash(cell + 5.7)) - 0.5;

  // Where the colour sits in the spectrum depends mostly on the angle you
  // look from, so moving the camera (or the sticker) sweeps the rainbow.
  float view = Rv.x * 3.4 - Rv.y * 2.6 + dot(N, V) * 1.4;
  float phase = view + dot(tilt, vec2(0.9, 0.7)) + (uv.x - uv.y) * 0.9;
  vec3 spec = holoSpectrum(phase);
  spec = mix(spec, vec3(1.0), 0.18);

  vec3 printed = diffuseColor.rgb;
  float whiteness = smoothstep(0.75, 0.98, min(printed.r, min(printed.g, printed.b)));
  vec3 foilColor = mix(printed * spec * 1.5, spec, whiteness);
  diffuseColor.rgb = mix(diffuseColor.rgb, foilColor, foil);
  metalnessFactor = mix(metalnessFactor, 0.65, foil);
  roughnessFactor = mix(roughnessFactor, 0.16 + holoHash(cell + 1.3) * 0.1, foil);

  // A soft sheen band that slides across as the view changes.
  float bandPos = uv.x * 0.8 + uv.y * 0.45 - 0.62 + Rv.x * 2.4 + Rv.y * 1.6;
  float band = exp(-bandPos * bandPos * 14.0);

  // Glitter: only flashes when a fleck lines up with your eye.
  vec2 guv = uv * 150.0;
  vec2 gq = floor(guv);
  vec2 gr = fract(guv) - 0.5;
  float r1 = holoHash(gq);
  float r2 = holoHash(gq + 19.17);
  vec3 gn = normalize(vec3(r1 - 0.5, r2 - 0.5, 0.9));
  float glint = pow(max(0.0, sin(dot(Rv, gn) * 26.0 + r1 * 6.2831)), 60.0);
  float dotShape = smoothstep(0.42, 0.0, length(gr));
  totalEmissiveRadiance += (spec * (0.1 + band * 0.35) + vec3(1.0) * glint * dotShape * 1.6) * foil;
}
`;

export interface StickerMaterials {
  front: THREE.MeshPhysicalMaterial;
  back: THREE.MeshStandardMaterial;
  dispose(): void;
}

const shared = new WeakMap<StickerSource, { mats: StickerMaterials; users: number }>();

/**
 * Materials (and their textures) are shared by every sticker cut from the
 * same design, so a second "Peel Me" costs no extra texture memory or upload.
 * Released when the last user goes away.
 */
export function acquireMaterials(src: StickerSource, maxAniso: number): StickerMaterials {
  let entry = shared.get(src);
  if (!entry) {
    entry = { mats: stickerMaterials(src, maxAniso), users: 0 };
    shared.set(src, entry);
  }
  entry.users++;
  const e = entry;
  let released = false;
  return {
    front: e.mats.front,
    back: e.mats.back,
    dispose() {
      if (released) return;
      released = true;
      if (--e.users === 0) {
        e.mats.dispose();
        shared.delete(src);
      }
    },
  };
}

function stickerMaterials(src: StickerSource, maxAniso: number): StickerMaterials {
  const map = texture(src.front, true, maxAniso);
  const backMap = texture(src.back, true, maxAniso);
  const foilMap = texture(src.foil, false, maxAniso);

  const front = new THREE.MeshPhysicalMaterial({
    map,
    alphaTest: 0.5,
    alphaToCoverage: true,
    // A sticker is a thin sheet: cast from both faces so only this mesh needs
    // to be in the shadow pass (three defaults to back faces only).
    shadowSide: THREE.DoubleSide,
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
