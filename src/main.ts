import * as THREE from 'three';
import { Sfx } from './audio';
import { Library } from './library';
import { decode, encode, loadLocal, saveLocal, type Composition, type SavedSticker } from './persist';
import { Playground } from './playground';
import { World } from './scene/world';
import type { Finish, StickerSource } from './stickers/factory';
import { mountUi } from './ui';

async function main() {
  const stage = document.getElementById('stage')!;
  const world = new World(stage);
  const sfx = new Sfx();
  const lib = new Library();
  const play = new Playground(world, sfx);
  play.layout();
  // Handle for scripted browser tests during development.
  if (import.meta.env.DEV) (window as unknown as { __peel: unknown }).__peel = { play, world, THREE };

  const pack = await makePack(lib, 0);
  const placed = play.newPack(pack, 4);

  // Restore a shared link, or the last session.
  const fromHash = location.hash.startsWith('#c=') ? location.hash.slice(3) : null;
  const encoded = fromHash ?? loadLocal();
  let restored = 0;
  if (encoded) {
    const comp = await decode(encoded);
    if (comp) restored = await restore(play, lib, comp);
  }
  if (!restored) {
    // The opening shot: one corner, begging.
    const inviting = placed[9] ?? placed[0];
    play.setInvite(inviting);
  }

  let packSeed = 1;
  const ui = mountUi({
    sfx,
    lib,
    play,
    world,
    newPack: async () => {
      const p = await makePack(lib, packSeed++);
      play.newPack(p, Date.now());
    },
    serialize: () => serialize(play, lib),
  });
  play.onFirstPeel = () => ui.firstPeel();
  if (restored) ui.firstPeel();

  // Autosave after things settle.
  let saveTimer = 0;
  play.onChange = () => {
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => saveLocal(await encode(serialize(play, lib))), 600);
  };

  window.addEventListener('resize', () => play.layout());

  // Compile every shader up front (in parallel where the driver allows) so
  // the first frames don't hitch.
  await world.renderer.compileAsync(world.scene, world.camera);

  // The frame loop sleeps when nothing is moving and wakes on input, so an
  // idle tab costs nothing — not even a requestAnimationFrame tick.
  let last = performance.now();
  let running = false;
  let quiet = 0;
  let wakeTimer = 0;
  const wake = () => {
    quiet = 0;
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(loop);
  };
  const loop = () => {
    const now = performance.now();
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;
    play.update(dt);
    world.adapt(dt);
    ui.frame();
    const drew = world.render();
    quiet = drew || play.busy() ? 0 : quiet + 1;
    if (quiet > 8) {
      running = false;
      clearTimeout(wakeTimer);
      const t = play.nextWakeIn();
      if (t != null) wakeTimer = window.setTimeout(wake, t * 1000);
      return;
    }
    requestAnimationFrame(loop);
  };
  play.wake = wake;
  for (const ev of ['pointermove', 'pointerdown', 'pointerup', 'pointerout', 'wheel', 'keydown', 'resize', 'deviceorientation']) {
    window.addEventListener(ev, wake, { passive: true, capture: true });
  }
  document.body.classList.add('ready');
  wake();
  // Build the audio graph while nothing's happening, not in the first click.
  const idle = window.requestIdleCallback ?? ((cb: () => void) => window.setTimeout(cb, 1500));
  idle(() => sfx.prepare());
}

/** Ten characters plus two bonus pulls, shuffled. */
async function makePack(lib: Library, seed: number): Promise<StickerSource[]> {
  const all = lib.builtins;
  const order = shuffle(all.slice(), seed);
  const extra = shuffle(all.slice(), seed + 99).slice(0, 2);
  const list: { id: string; finish: Finish }[] = order.map((a) => ({ id: a.id, finish: a.finish }));
  // Bonus pulls come in a different finish: a holo version is the rare one.
  for (const e of extra) list.push({ id: e.id, finish: e.finish === 'holo' ? 'gloss' : 'holo' });
  return Promise.all(list.map((l) => lib.source(l.id, l.finish)));
}

function shuffle<T>(a: T[], seed: number) {
  if (seed === 0) return a;
  let s = seed * 9301 + 49297;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function notebookFrame(world: World) {
  const n = world.notebookSurface;
  return { x: n.x, z: n.z, c: Math.cos(n.yaw), s: Math.sin(n.yaw), yaw: n.yaw };
}

function serialize(play: Playground, lib: Library): Composition {
  const nb = notebookFrame(play.world);
  const sheet = play.getSheetName();
  const s: SavedSticker[] = [];
  const u: Record<string, string> = {};
  const list = play.stickers.filter((st) => st.mode === 'stuck' && st.surface !== sheet).sort((a, b) => a.layer - b.layer);
  for (const st of list) {
    const [design, finish] = st.src.key.split(':');
    const dx = st.x - nb.x;
    const dz = st.z - nb.z;
    s.push({ d: design, f: finish, x: nb.c * dx - nb.s * dz, z: nb.s * dx + nb.c * dz, a: st.yaw - nb.yaw, l: st.layer });
    if (lib.custom.has(design)) u[design] = lib.custom.get(design)!;
  }
  return { v: 1, s, u };
}

async function restore(play: Playground, lib: Library, comp: Composition) {
  const nb = notebookFrame(play.world);
  for (const [id, url] of Object.entries(comp.u ?? {})) await lib.addCustomFromUrl(id, url);
  let n = 0;
  for (const saved of comp.s) {
    let src: StickerSource;
    try {
      src = await lib.source(saved.d, saved.f as Finish);
    } catch {
      continue;
    }
    const st = play.add(src);
    st.x = nb.x + nb.c * saved.x + nb.s * saved.z;
    st.z = nb.z - nb.s * saved.x + nb.c * saved.z;
    st.yaw = saved.a + nb.yaw;
    st.layer = saved.l;
    const { top, surface } = play.footprint(st, st.x, st.z);
    st.surface = surface?.name ?? 'desk';
    st.support = surface;
    st.baseY = top + st.layer;
    st.dirty = true;
    n++;
  }
  return n;
}

main().catch((e) => {
  console.error(e);
  document.body.classList.add('failed');
  const el = document.getElementById('ui')!;
  el.innerHTML = `<div class="fatal">Couldn't start WebGL. Try another browser?<br><small>${String(e?.message ?? e)}</small></div>`;
});
