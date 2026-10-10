import * as THREE from 'three';
import type { StickerSource } from './factory';

/**
 * A resting sticker is drawn as two flat meshes cut from its silhouette:
 *
 * - core: cells entirely inside the die line. Drawn opaque, with no alpha
 *   test, so the GPU's early depth test / hidden-surface removal can skip
 *   everything underneath it (other stickers, the notebook).
 * - edge: the thin band of cells the die line passes through. Alpha-tested
 *   with alpha-to-coverage for a smooth edge.
 *
 * With dozens of overlapping stickers this is the difference between shading
 * every layer and shading roughly one.
 */
export interface SplitGeometry {
  core: THREE.BufferGeometry;
  edge: THREE.BufferGeometry;
}

const cache = new WeakMap<StickerSource, SplitGeometry>();

export function splitGeometry(src: StickerSource): SplitGeometry {
  let g = cache.get(src);
  if (!g) {
    g = build(src);
    cache.set(src, g);
  }
  return g;
}

function build(src: StickerSource): SplitGeometry {
  const { mask, mw, mh, width: w, height: h } = src;
  // Cells of `k` mask texels (~1mm). Bigger cells keep the triangles large
  // enough for the GPU to shade efficiently; one texel of margin keeps the
  // core strictly inside the alpha.
  const k = 3;
  const cw = Math.ceil(mw / k);
  const ch = Math.ceil(mh / k);
  const covered = (x: number, y: number) => x >= 0 && y >= 0 && x < mw && y < mh && mask[y * mw + x] === 1;
  const kind = new Uint8Array(cw * ch); // 0 empty, 1 edge, 2 core
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let any = false;
      let all = true;
      for (let y = cy * k - 1; y <= cy * k + k; y++) {
        for (let x = cx * k - 1; x <= cx * k + k; x++) {
          const c = covered(x, y);
          any ||= c;
          all &&= c;
        }
      }
      kind[cy * cw + cx] = all ? 2 : any ? 1 : 0;
    }
  }
  return { core: quads(kind, 2, cw, ch, k, mw, mh, w, h), edge: quads(kind, 1, cw, ch, k, mw, mh, w, h) };
}

/** Quads for every cell of `want`, merging horizontal runs into one quad. */
function quads(kind: Uint8Array, want: number, cw: number, ch: number, k: number, mw: number, mh: number, w: number, h: number) {
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  const u = (x: number) => Math.min(1, (x * k) / mw);
  const v = (y: number) => Math.min(1, (y * k) / mh);
  for (let cy = 0; cy < ch; cy++) {
    let cx = 0;
    while (cx < cw) {
      if (kind[cy * cw + cx] !== want) {
        cx++;
        continue;
      }
      let end = cx;
      while (end + 1 < cw && kind[cy * cw + end + 1] === want) end++;
      const u0 = u(cx);
      const u1 = u(end + 1);
      const v0 = v(cy);
      const v1 = v(cy + 1);
      const base = pos.length / 3;
      // Sticker space: x right, y down -> local X, Z; texture v is flipped.
      for (const [uu, vv] of [
        [u0, v0],
        [u1, v0],
        [u0, v1],
        [u1, v1],
      ]) {
        pos.push((uu - 0.5) * w, 0, (vv - 0.5) * h);
        uv.push(uu, 1 - vv);
      }
      // Counter-clockwise seen from +Y.
      idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
      cx = end + 1;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const n = new Float32Array(pos.length);
  for (let i = 1; i < n.length; i += 3) n[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}
