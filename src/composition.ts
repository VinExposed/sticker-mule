import type { Library } from './library';
import { rotateToLocal, rotateToWorld } from './math';
import type { Composition, SavedSticker } from './persist';
import type { Playground } from './playground';
import { isFinish, type StickerSource } from './stickers/factory';

/**
 * Converting between the live desk and a saved Composition. Positions are
 * stored relative to the notebook, so a layout made on a phone (notebook at
 * the top) restores correctly on a laptop (notebook on the left).
 */

/** Everything stuck down that isn't on a sheet, bottom layer first. */
export function serialize(play: Playground, lib: Library): Composition {
  const nb = play.world.notebookSurface;
  const s: SavedSticker[] = [];
  const u: Record<string, string> = {};
  const list = play.stickers.filter((st) => st.mode === 'stuck' && !play.isOnSheet(st)).sort((a, b) => a.layer - b.layer);
  for (const st of list) {
    const [design, f] = st.src.key.split(':');
    const finish = isFinish(f) ? f : 'gloss';
    const p = rotateToLocal(st.x - nb.x, st.z - nb.z, nb.yaw);
    s.push({ d: design, f: finish, x: p.x, z: p.y, a: st.yaw - nb.yaw, l: st.layer });
    const art = lib.custom.get(design);
    if (art) u[design] = art;
  }
  return { v: 1, s, u };
}

/** Put a saved composition back on the desk. Returns how many stickers it placed. */
export async function restore(play: Playground, lib: Library, comp: Composition) {
  const nb = play.world.notebookSurface;
  for (const [id, url] of Object.entries(comp.u ?? {})) lib.addCustomFromUrl(id, url);
  let placed = 0;
  for (const saved of comp.s) {
    let src: StickerSource;
    try {
      src = await lib.source(saved.d, saved.f);
    } catch {
      continue; // unknown design (e.g. from a newer version): skip it
    }
    const p = rotateToWorld(saved.x, saved.z, nb.yaw);
    play.place(src, { x: nb.x + p.x, z: nb.z + p.y, yaw: saved.a + nb.yaw, layer: saved.l });
    placed++;
  }
  return placed;
}
