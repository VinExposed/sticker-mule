import * as THREE from 'three';
import { Sfx } from './audio';
import { restore, serialize } from './composition';
import { Library } from './library';
import { startLoop } from './loop';
import { decode, encode, loadLocal, saveLocal } from './persist';
import { Playground } from './playground';
import { World } from './scene/world';
import type { Finish, StickerSource } from './stickers/factory';
import { mountUi } from './ui';

/** While you're dragging, draw every display frame; otherwise cap at ~60fps. */
const PASSIVE_FRAME_MS = 15.5;

async function main() {
  const world = new World(document.getElementById('stage')!);
  const sfx = new Sfx();
  const lib = new Library();
  const play = new Playground(world, sfx);
  play.layout();
  window.addEventListener('resize', () => play.layout());
  // Handle for scripted browser tests during development.
  if (import.meta.env.DEV) (window as unknown as { __peel: unknown }).__peel = { play, world, THREE };

  play.newPack(await makePack(lib, 0), 4);

  // Restore a shared link, or the last session. A link is consumed once:
  // after that, autosave owns the notebook and a reload shouldn't revert it.
  const link = location.hash.startsWith('#c=') ? await decode(location.hash.slice(3)) : null;
  dropLinkFromUrl();
  if (link) saveLocal(await encode(link));
  const saved = link ?? (await decode(loadLocal() ?? ''));
  const restored = saved ? await restore(play, lib, saved) : 0;
  // The opening shot: one corner, begging.
  if (!restored) play.inviteOnSheet();

  let packSeed = 1;
  const ui = mountUi({
    sfx,
    lib,
    play,
    world,
    // Resolves once the new sheet has slid into place.
    newPack: async () => play.newPack(await makePack(lib, packSeed++)),
    serialize: () => serialize(play, lib),
  });
  play.onFirstPeel = () => ui.firstPeel();
  if (restored) ui.firstPeel();

  // Autosave once things settle. Encoding is async, so number the saves and
  // let only the newest one write.
  let saveTimer = 0;
  let saveSeq = 0;
  play.onChange = () => {
    clearTimeout(saveTimer);
    // Anything shared via the address bar is now out of date.
    dropLinkFromUrl();
    saveTimer = window.setTimeout(async () => {
      const seq = ++saveSeq;
      const encoded = await encode(serialize(play, lib));
      if (seq === saveSeq) saveLocal(encoded);
    }, 600);
  };

  world.renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    showFatal('The graphics context was lost. Reload to keep peeling.');
  });

  // Compile every shader up front (in parallel where the driver allows) so
  // the first frames don't hitch.
  await world.renderer.compileAsync(world.scene, world.camera);

  let lastDraw = 0;
  play.wake = startLoop({
    update(dt, now) {
      play.update(dt, now);
      world.adapt(dt);
      ui.frame();
    },
    draw(now) {
      // Passive changes (parallax, settling springs, the intro) are capped at
      // ~60fps, which halves the cost on 120/144Hz screens.
      if (!play.manipulating() && now - lastDraw < PASSIVE_FRAME_MS) return false;
      const drew = world.render();
      if (drew) lastDraw = now;
      return drew;
    },
    pending: () => world.pending(),
    busy: () => play.busy(),
    nextWakeIn: () => play.nextWakeIn(),
  });
  document.body.classList.add('ready');
}

/** Ten characters plus two bonus pulls; pack 0 is in catalogue order. */
async function makePack(lib: Library, seed: number): Promise<StickerSource[]> {
  const all = lib.builtins;
  const list: { id: string; finish: Finish }[] = shuffle(all.slice(), seed).map((a) => ({ id: a.id, finish: a.finish }));
  // Bonus pulls come in a different finish: a holo version is the rare one.
  for (const e of shuffle(all.slice(), seed + 99).slice(0, 2)) list.push({ id: e.id, finish: e.finish === 'holo' ? 'gloss' : 'holo' });
  return Promise.all(list.map((l) => lib.source(l.id, l.finish)));
}

/** Deterministic shuffle (seed 0 leaves the order alone). */
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

function dropLinkFromUrl() {
  if (location.hash.startsWith('#c=')) history.replaceState(null, '', location.pathname + location.search);
}

function showFatal(message: string, detail = '') {
  const box = document.createElement('div');
  box.className = 'fatal';
  box.textContent = message;
  if (detail) box.append(document.createElement('br'), Object.assign(document.createElement('small'), { textContent: detail }));
  document.getElementById('ui')!.replaceChildren(box);
}

main().catch((e) => {
  console.error(e);
  showFatal('Couldn’t start WebGL. Try another browser?', String(e?.message ?? e));
});
