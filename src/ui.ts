import * as THREE from 'three';
import type { Sfx } from './audio';
import type { Library } from './library';
import { clearLocal, encode, type Composition } from './persist';
import type { Playground } from './playground';
import type { World } from './scene/world';
import { canvas, type Finish } from './stickers/factory';

interface UiDeps {
  sfx: Sfx;
  lib: Library;
  play: Playground;
  world: World;
  newPack: () => Promise<void>;
  serialize: () => Composition;
}

const icon = {
  pencil: '<path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 013 3L8 19l-4 1z"/><path d="M14.5 6.5l3 3"/>',
  pack: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="9.5" cy="10" r="2.5"/><path d="M14 8h3M14 12h3M7 16h10"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M17 9l5 6M22 9l-5 6"/>',
  trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
};

const svg = (d: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;

export function mountUi(deps: UiDeps) {
  const root = document.getElementById('ui')!;
  root.innerHTML = `
    <header class="brand">
      <div class="logo"><span>peel</span><i></i></div>
      <p>a ridiculously satisfying sticker playground</p>
    </header>
    <div class="corner">
      <button class="icon-btn" data-act="sound" title="Sound on/off" aria-label="Toggle sound">${svg(icon.sound)}</button>
    </div>
    <nav class="dock" aria-label="Tools">
      <button data-act="make">${svg(icon.pencil)}<span>Make your own</span></button>
      <button data-act="pack">${svg(icon.pack)}<span>New pack</span></button>
      <span class="sep"></span>
      <button data-act="save">${svg(icon.camera)}<span>Save image</span></button>
      <button data-act="share">${svg(icon.link)}<span>Share</span></button>
      <button data-act="clear" class="ghost" title="Peel everything off">${svg(icon.trash)}</button>
    </nav>
    <div class="hint" role="status"></div>
    <div class="note" aria-hidden="true">
      <svg viewBox="0 0 100 60" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 54C32 58 70 42 92 10"/>
        <path d="M80 12l12-2 0 12"/>
      </svg>
      <span>peel me</span>
    </div>
    <div class="toast" role="status"></div>
  `;

  const hint = root.querySelector<HTMLElement>('.hint')!;
  const note = root.querySelector<HTMLElement>('.note')!;
  const toastEl = root.querySelector<HTMLElement>('.toast')!;
  let stage = 0;
  const setHint = (text: string) => {
    hint.classList.remove('show');
    window.setTimeout(() => {
      hint.textContent = text;
      if (text) hint.classList.add('show');
    }, 180);
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  setHint(touch ? 'Press a sticker’s edge and drag across it to peel' : 'Grab a sticker by its edge and drag across it');

  let toastTimer = 0;
  const toast = (text: string) => {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => toastEl.classList.remove('show'), 2200);
  };

  const act = async (name: string, btn: HTMLButtonElement) => {
    deps.sfx.unlock();
    switch (name) {
      case 'sound': {
        deps.sfx.setMuted(!deps.sfx.muted);
        btn.innerHTML = svg(deps.sfx.muted ? icon.mute : icon.sound);
        break;
      }
      case 'pack':
        await deps.newPack();
        break;
      case 'save':
        saveImage(deps.world, root);
        break;
      case 'share': {
        const enc = await encode(deps.serialize());
        const url = `${location.origin}${location.pathname}#c=${enc}`;
        history.replaceState(null, '', `#c=${enc}`);
        try {
          await navigator.clipboard.writeText(url);
          toast(url.length > 6000 ? 'Link copied (it’s a big one: your art is inside)' : 'Link copied — anyone can open your notebook');
        } catch {
          toast('Link is in the address bar');
        }
        break;
      }
      case 'clear': {
        deps.play.peelAll();
        clearLocal();
        history.replaceState(null, '', location.pathname);
        break;
      }
      case 'make':
        openMaker(deps);
        break;
    }
  };
  root.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => void act(b.dataset.act!, b)),
  );

  const v = new THREE.Vector3();
  return {
    firstPeel() {
      if (stage > 0) return;
      stage = 1;
      note.classList.add('gone');
      setHint(touch ? 'Lift it off, then drop it on the notebook' : 'Drop it anywhere. Scroll to spin it while you hold it.');
      window.setTimeout(() => {
        if (stage === 1) setHint('Drag the empty desk to tilt the view and catch the holo');
        stage = 2;
        window.setTimeout(() => setHint(''), 6000);
      }, 7000);
    },
    frame() {
      const p = deps.play.invitePoint(v);
      if (!p || note.classList.contains('gone')) return;
      p.project(deps.world.camera);
      const r = deps.world.renderer.domElement.getBoundingClientRect();
      const x = (p.x * 0.5 + 0.5) * r.width;
      const y = (-p.y * 0.5 + 0.5) * r.height;
      note.style.transform = `translate(${x}px, ${y}px)`;
      note.classList.toggle('flip', x < 190);
      note.classList.add('show');
    },
  };
}

function saveImage(world: World, ui: HTMLElement) {
  world.render();
  world.renderer.domElement.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'peel-notebook.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }, 'image/png');
  ui.classList.add('flash');
  setTimeout(() => ui.classList.remove('flash'), 350);
}

// ---------------------------------------------------------------- maker

const COLORS = ['#151317', '#ff6a1a', '#ff4f9a', '#ffd23f', '#3ddc97', '#2f5bff', '#b69cff', '#ffffff'];

function openMaker(deps: UiDeps) {
  const wrap = document.createElement('div');
  wrap.className = 'maker';
  wrap.innerHTML = `
    <div class="maker-card" role="dialog" aria-label="Make your own sticker">
      <div class="maker-head">
        <h2>Make your own</h2>
        <button class="icon-btn close" aria-label="Close">${svg('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
      </div>
      <div class="pad"><canvas width="768" height="768"></canvas><p class="pad-empty">Draw something weird.<br><small>or drop an image here</small></p></div>
      <div class="tools">
        <div class="swatches">${COLORS.map((c, i) => `<button class="sw${i === 0 ? ' on' : ''}" data-c="${c}" style="--c:${c}" aria-label="${c}"></button>`).join('')}</div>
        <div class="sizes">
          ${[10, 22, 44].map((s, i) => `<button class="sz${i === 1 ? ' on' : ''}" data-s="${s}" aria-label="Brush ${s}"><i style="--s:${4 + i * 5}px"></i></button>`).join('')}
        </div>
      </div>
      <div class="tools">
        <div class="seg" role="radiogroup" aria-label="Finish">
          <button data-f="gloss" class="on">Gloss</button><button data-f="matte">Matte</button><button data-f="holo">Holo</button>
        </div>
        <div class="row">
          <label class="text-btn">Upload<input type="file" accept="image/*" hidden></label>
          <button class="text-btn" data-a="undo">Undo</button>
          <button class="text-btn" data-a="clear">Clear</button>
        </div>
      </div>
      <button class="primary" data-a="make" disabled>Turn it into a sticker</button>
    </div>
  `;
  document.body.appendChild(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));

  const cv = wrap.querySelector('canvas')!;
  const g = cv.getContext('2d')!;
  const empty = wrap.querySelector<HTMLElement>('.pad-empty')!;
  const makeBtn = wrap.querySelector<HTMLButtonElement>('[data-a="make"]')!;
  let color = COLORS[0];
  let size = 22;
  let finish: Finish = 'gloss';
  const history: ImageData[] = [];
  let dirty = false;
  const markDirty = () => {
    dirty = true;
    empty.style.opacity = '0';
    makeBtn.disabled = false;
  };

  const close = () => {
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 250);
    window.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
    if ((e.metaKey || e.ctrlKey) && e.key === 'z') undo();
  };
  window.addEventListener('keydown', onKey);
  wrap.addEventListener('pointerdown', (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector('.close')!.addEventListener('click', close);

  wrap.querySelectorAll<HTMLButtonElement>('.sw').forEach((b) =>
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.sw').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      color = b.dataset.c!;
    }),
  );
  wrap.querySelectorAll<HTMLButtonElement>('.sz').forEach((b) =>
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.sz').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      size = Number(b.dataset.s);
    }),
  );
  wrap.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) =>
    b.addEventListener('click', () => {
      wrap.querySelectorAll('.seg button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      finish = b.dataset.f as Finish;
    }),
  );

  const snapshot = () => {
    history.push(g.getImageData(0, 0, cv.width, cv.height));
    if (history.length > 30) history.shift();
  };
  const undo = () => {
    const last = history.pop();
    if (last) g.putImageData(last, 0, 0);
  };
  wrap.querySelector('[data-a="undo"]')!.addEventListener('click', undo);
  wrap.querySelector('[data-a="clear"]')!.addEventListener('click', () => {
    snapshot();
    g.clearRect(0, 0, cv.width, cv.height);
  });

  // Drawing: smoothed strokes with round caps, ink-like.
  let drawing = false;
  let last: { x: number; y: number } | null = null;
  const pos = (e: PointerEvent) => {
    const r = cv.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * cv.width, y: ((e.clientY - r.top) / r.height) * cv.height };
  };
  cv.addEventListener('pointerdown', (e) => {
    cv.setPointerCapture(e.pointerId);
    snapshot();
    drawing = true;
    last = pos(e);
    g.fillStyle = color;
    g.beginPath();
    g.arc(last.x, last.y, size / 2, 0, Math.PI * 2);
    g.fill();
    markDirty();
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const events = e.getCoalescedEvents?.() ?? [e];
    g.strokeStyle = color;
    g.lineWidth = size;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const ev of events) {
      const p = pos(ev);
      g.beginPath();
      g.moveTo(last.x, last.y);
      g.lineTo(p.x, p.y);
      g.stroke();
      last = p;
    }
  });
  const end = () => {
    drawing = false;
    last = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);

  const loadFile = async (file: File) => {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      snapshot();
      const cut = removeBackground(img);
      g.clearRect(0, 0, cv.width, cv.height);
      const s = Math.min(cv.width / cut.width, cv.height / cut.height) * 0.86;
      g.drawImage(cut, (cv.width - cut.width * s) / 2, (cv.height - cut.height * s) / 2, cut.width * s, cut.height * s);
      markDirty();
    } finally {
      URL.revokeObjectURL(url);
    }
  };
  wrap.querySelector<HTMLInputElement>('input[type=file]')!.addEventListener('change', (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void loadFile(f);
  });
  const pad = wrap.querySelector<HTMLElement>('.pad')!;
  pad.addEventListener('dragover', (e) => {
    e.preventDefault();
    pad.classList.add('drop');
  });
  pad.addEventListener('dragleave', () => pad.classList.remove('drop'));
  pad.addEventListener('drop', (e) => {
    e.preventDefault();
    pad.classList.remove('drop');
    const f = e.dataTransfer?.files?.[0];
    if (f && f.type.startsWith('image/')) void loadFile(f);
  });

  makeBtn.addEventListener('click', async () => {
    if (!dirty) return;
    const art = trim(cv);
    if (!art) return;
    makeBtn.disabled = true;
    makeBtn.textContent = 'Cutting…';
    const id = deps.lib.addCustom(art);
    const src = await deps.lib.source(id, finish);
    close();
    const st = deps.play.add(src);
    deps.play.give(st);
  });
}

/** Crop to content with a little breathing room, square-ish for the die cut. */
function trim(src: HTMLCanvasElement): HTMLCanvasElement | null {
  const { width: w, height: h } = src;
  const d = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > 16) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const bw = x1 - x0 + 1;
  const bh = y1 - y0 + 1;
  const side = Math.max(bw, bh);
  const pad = Math.round(side * 0.1);
  const out = canvas(bw + pad * 2, bh + pad * 2);
  out.getContext('2d')!.drawImage(src, x0, y0, bw, bh, pad, pad, bw, bh);
  return out;
}

/**
 * Photos and scans usually come on a plain background. Flood-fill from the
 * border, removing anything close to the border colour, then feather.
 */
function removeBackground(img: HTMLImageElement): HTMLCanvasElement {
  const max = 768;
  const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvas(img.naturalWidth * s, img.naturalHeight * s);
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, c.width, c.height);
  const { width: w, height: h } = c;
  const data = g.getImageData(0, 0, w, h);
  const d = data.data;

  // Already transparent? Keep it.
  let transparentEdge = 0;
  for (let x = 0; x < w; x++) if (d[x * 4 + 3] < 200) transparentEdge++;
  if (transparentEdge > w * 0.3) return c;

  // Background colour = median-ish of the border.
  const border: number[][] = [];
  for (let x = 0; x < w; x += 4) border.push(px(d, x, 0, w), px(d, x, h - 1, w));
  for (let y = 0; y < h; y += 4) border.push(px(d, 0, y, w), px(d, w - 1, y, w));
  const bg = [0, 1, 2].map((k) => border.map((p) => p[k]).sort((a, b) => a - b)[border.length >> 1]);
  const tol = 46;
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, x + (h - 1) * w);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i]) continue;
    const o = i * 4;
    const dist = Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]);
    if (dist > tol * 2) continue;
    seen[i] = 1;
    d[o + 3] = dist < tol ? 0 : Math.round(((dist - tol) / tol) * 255);
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  g.putImageData(data, 0, 0);
  return c;
}

function px(d: Uint8ClampedArray, x: number, y: number, w: number) {
  const o = (y * w + x) * 4;
  return [d[o], d[o + 1], d[o + 2]];
}
