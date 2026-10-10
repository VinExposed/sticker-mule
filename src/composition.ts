import type { Library } from './library';
import { rotateToLocal, rotateToWorld } from './math';
import type { Composition, SavedSticker } from './persist';
import type { Playground } from './playground';
import type { Finish, StickerSource } from './stickers/factory';

/**
 * Converting between the live desk and a saved Composition. Positions are
 * stored relative to the notebook, so a layout made on a phone (notebook at
 * the top) restores correctly on a laptop (notebook on the left).
 */

const FINISHES: Finish[] = ['gloss', 'matte', 'holo'];

/** Everything stuck down that isn't on a sheet, bottom layer first. */
export function serialize(play: Playground, lib: Library): Composition {
  const nb = play.world.notebookSurface;
  const s: SavedSticker[] = [];
  const u: Record<string, string> = {};
  const list = play.stickers.filter((st) => st.mode === 'stuck' && !play.isOnSheet(st)).sort((a, b) => a.layer - b.layer);
  for (const st of list) {
    const [design, finish] = st.src.key.split(':');
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
      src = await lib.source(
        saved.d,
        FINISHES.find((f) => f === saved.f),
      );
    } catch {
      continue; // unknown design (e.g. from a newer version): skip it
    }
    const st = play.add(src);
    const p = rotateToWorld(saved.x, saved.z, nb.yaw);
    st.x = nb.x + p.x;
    st.z = nb.z + p.y;
    st.yaw = saved.a + nb.yaw;
    st.layer = saved.l;
    // Never onto the sheet: it isn't saved, and leaves with the next pack.
    const { top, surface } = play.footprint(st, st.x, st.z, { sheets: false });
    st.surface = surface?.name ?? 'desk';
    st.support = surface;
    st.baseY = top + st.layer;
    st.dirty = true;
    placed++;
  }
  return placed;
}
