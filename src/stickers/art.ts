// Peel — sticker pack illustrations.
//
// Every sticker is a self-contained 512x512 SVG with a transparent background.
// No die-cut border is drawn here: the engine dilates the alpha silhouette to
// make the white border, so each design keeps ~8% transparent margin and is a
// single connected, chunky silhouette.
//
// This module has no imports and only uses plain functions + template strings,
// so it can be loaded by Node's type stripping for previews.

export type Finish = 'gloss' | 'matte' | 'holo';

export interface StickerArt {
  id: string;
  name: string;
  svg: string;
  finish: Finish;
  foil?: string;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const INK = '#151317';
const C = {
  tangerine: '#ff6a1a',
  tangerineDark: '#e04a0c',
  pink: '#ff4f9a',
  pinkDark: '#e0307c',
  blush: '#ff8fbd',
  lemon: '#ffd23f',
  lemonDark: '#f5a524',
  mint: '#3ddc97',
  mintDark: '#1fb87a',
  cobalt: '#2f5bff',
  cobaltDark: '#1c3fd6',
  lilac: '#b69cff',
  lilacDark: '#8f6cf5',
  cream: '#fff4e0',
  creamDark: '#f6d9b0',
  crust: '#ff9d2e',
  crustDark: '#e27a12',
  pepperoni: '#ff3d47',
  pepperoniDark: '#d61f33',
  white: '#ffffff',
};

/** Outline width (at 512 scale). */
const S = 16;

// ---------------------------------------------------------------------------
// Tiny SVG helpers
// ---------------------------------------------------------------------------

type Pt = [number, number];

const n = (v: number): string => String(Math.round(v * 100) / 100);

const doc = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${body}</svg>`;

/** Ellipse as a path `d` so it can be used everywhere a path can. */
const ell = (cx: number, cy: number, rx: number, ry = rx): string =>
  `M${n(cx - rx)} ${n(cy)}a${n(rx)} ${n(ry)} 0 1 0 ${n(rx * 2)} 0a${n(rx)} ${n(ry)} 0 1 0 ${n(-rx * 2)} 0Z`;

/** Filled + outlined shape. */
const shape = (d: string, fill: string, w = S, extra = ''): string =>
  `<path d="${d}" fill="${fill}" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;

/** Fill only. */
const fill = (d: string, color: string, extra = ''): string => `<path d="${d}" fill="${color}"${extra}/>`;

/** Ink line (no fill). */
const line = (d: string, w = 14, color = INK, extra = ''): string =>
  `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;

/**
 * Ink underlay for a union of shapes: a fat stroke behind the fills so the
 * union gets ONE clean outer outline with no internal seams.
 */
const underlay = (ds: string[], w = S * 2): string =>
  ds.map((d) => `<path d="${d}" fill="${INK}" stroke="${INK}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`).join('');

/** Soft highlight. */
const hi = (d: string, opacity = 0.5): string => `<path d="${d}" fill="#ffffff" opacity="${opacity}"/>`;
const hiLine = (d: string, w = 14, opacity = 0.55): string =>
  `<path d="${d}" fill="none" stroke="#ffffff" stroke-width="${w}" stroke-linecap="round" opacity="${opacity}"/>`;

/** A shade shape clipped to a body shape (for volume). */
const shade = (id: string, clipD: string, d: string, color: string): string =>
  `<clipPath id="${id}"><path d="${clipD}"/></clipPath><path d="${d}" fill="${color}" clip-path="url(#${id})"/>`;

/** Clip arbitrary content to the union of one or more paths. */
const clip = (id: string, ds: string[], content: string): string =>
  `<clipPath id="${id}">${ds.map((d) => `<path d="${d}"/>`).join('')}</clipPath><g clip-path="url(#${id})">${content}</g>`;

const g = (transform: string, body: string): string => `<g transform="${transform}">${body}</g>`;

/** Polygon with rounded corners (radius per corner or one for all). */
function roundPoly(pts: Pt[], r: number | number[]): string {
  const len = pts.length;
  let d = '';
  for (let i = 0; i < len; i++) {
    const p0 = pts[(i - 1 + len) % len];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % len];
    const rr = Array.isArray(r) ? r[i] : r;
    const a = toward(p1, p0, rr);
    const b = toward(p1, p2, rr);
    d += `${i === 0 ? 'M' : 'L'}${n(a[0])} ${n(a[1])}Q${n(p1[0])} ${n(p1[1])} ${n(b[0])} ${n(b[1])}`;
  }
  return d + 'Z';
}

function toward(p: Pt, q: Pt, r: number): Pt {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const dist = Math.hypot(dx, dy);
  const t = Math.min(r, dist / 2) / dist;
  return [p[0] + dx * t, p[1] + dy * t];
}

/** Star / burst points around a centre, first point straight up. */
function starPts(cx: number, cy: number, points: number, outer: number, inner: number, rot = 0): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + rot + (i * Math.PI) / points;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

/** Scale an absolute-command path (M/L/C/Q/Z only) around a point. */
function scalePath(d: string, kx: number, ky: number, cx = 256, cy = 256): string {
  if (/[a-yA-Y]/.test(d.replace(/[MLCQZ]/g, ''))) throw new Error('scalePath: absolute M/L/C/Q/Z only');
  let i = 0;
  return d.replace(/-?\d+(?:\.\d+)?/g, (m) => {
    const v = parseFloat(m);
    const out = i % 2 === 0 ? cx + (v - cx) * kx : cy + (v - cy) * ky;
    i++;
    return n(out);
  });
}

const mirrorX = (d: string): string => `<g transform="translate(512 0) scale(-1 1)">${d}</g>`;

/** Foil mask document: white = foil. */
const foilDoc = (body: string): string => doc(body);

// ---------------------------------------------------------------------------
// 1. Mulligan the mule
// ---------------------------------------------------------------------------

function mule(): string {
  const earL = 'M240 182C242 124 220 64 186 46C158 34 138 56 140 96C142 140 154 180 178 212Z';
  const earLInner = 'M224 174C224 130 208 90 188 76C172 68 160 82 160 110C160 140 170 168 186 190Z';
  // One long donkey head: forehead, slight cheek pinch, wide muzzle.
  const head = scalePath(
    'M256 136C320 136 354 176 354 232C354 262 348 280 354 300C364 330 370 352 368 378' +
    'C364 426 318 450 256 450C194 450 148 426 144 378C142 352 148 330 158 300C164 280 158 262 158 232' +
    'C158 176 192 136 256 136Z',
    1.1,
    1,
  );
  const muzzleZone = 'M100 322C170 288 342 288 412 322L412 480L100 480Z';
  const mane = 'M212 162C200 140 204 118 222 116C220 92 240 80 254 96C262 74 290 76 292 100C310 88 330 104 320 126C334 132 332 152 316 160C282 148 240 148 212 162Z';
  const lensL = scalePath('M152 240Q152 230 162 230L238 230Q250 230 248 242L242 274Q238 296 214 296L184 296Q158 296 154 272Z', 1.08, 1);
  const lensR = scalePath('M360 240Q360 230 350 230L274 230Q262 230 264 242L270 274Q274 296 298 296L328 296Q354 296 358 272Z', 1.08, 1);

  return doc(
    g(
      'translate(0 6)',
    // ears (behind the head)
    shape(earL, C.tangerine) +
      fill(earLInner, C.pink) +
      mirrorX(shape(earL, C.tangerine) + fill(earLInner, C.pink)) +
      // mane (behind the head, peeking out between the ears)
      shape(mane, C.tangerineDark, 14) +
      line('M246 128Q252 112 262 106M276 128Q286 116 296 114', 8, INK, ' opacity="0.35"') +
      // head + muzzle zone with volume
      fill(head, C.tangerine) +
      clip(
        'mule-h',
        [head],
        fill('M330 140C390 220 380 330 340 470L420 470L420 140Z', C.tangerineDark) +
          fill(muzzleZone, C.cream) +
          fill('M120 420C190 470 330 470 400 400L400 480L120 480Z', C.creamDark) +
          line('M110 326C176 290 336 290 402 326', 14),
      ) +
      line(head, S) +
      hi(ell(192, 180, 24, 12), 0.5) +
      hiLine('M262 120Q270 108 282 106', 6, 0.5) +
      // eyes peeking over the shades
      shape(ell(208, 244, 27, 31), C.white, 12) +
      shape(ell(304, 244, 27, 31), C.white, 12) +
      fill(ell(214, 230, 12, 14), INK) +
      fill(ell(310, 230, 12, 14), INK) +
      fill(ell(210, 224, 4), C.white) +
      fill(ell(306, 224, 4), C.white) +
      line('M184 198Q204 190 224 196', 10) +
      line('M286 186Q308 172 330 186', 10) +
      // nostrils
      fill(ell(210, 352, 16, 9), INK, ' transform="rotate(-24 210 352)"') +
      fill(ell(302, 352, 16, 9), INK, ' transform="rotate(24 302 352)"') +
      // grin + buck teeth
      shape('M236 398L236 424Q246 430 256 424Q266 430 276 424L276 398Z', C.white, 10) +
      line('M256 402L256 422', 7) +
      line('M190 384Q256 418 322 384', 14) +
      // sunglasses slipping down the snout
      g(
        'translate(0 16) rotate(-5 256 262)',
        line('M150 244L124 234M362 244L388 234', 12) +
          shape(lensL, INK, 10) +
          shape(lensR, INK, 10) +
          line('M244 240Q256 232 268 240', 12) +
          hiLine('M164 248L192 248', 8, 0.9) +
          hiLine('M284 248L312 248', 8, 0.9) +
          hiLine('M166 264L176 264', 8, 0.6) +
          hiLine('M286 264L296 264', 8, 0.6),
      ) +
      // blush
      fill(ell(162, 384, 16, 8), C.pink, ' opacity="0.8"') +
      fill(ell(350, 384, 16, 8), C.pink, ' opacity="0.8"'),
    ),
  );
}

// ---------------------------------------------------------------------------
// 2. Oggy the cyclops blob
// ---------------------------------------------------------------------------

function cyclops(): string {
  const body = 'M256 92C352 92 412 168 412 262C412 354 348 404 256 404C164 404 100 354 100 262C100 168 160 92 256 92Z';
  const legL = 'M190 380L190 438Q190 452 176 452L156 452Q136 452 140 436Q146 424 166 424L166 380Z';
  const legR = 'M322 380L322 438Q322 452 336 452L356 452Q376 452 372 436Q366 424 346 424L346 380Z';
  const armL = 'M112 270Q70 262 64 296Q66 322 112 312Z';
  const armR = 'M400 270Q442 262 448 296Q446 322 400 312Z';

  return doc(
    // antenna
    line('M256 104Q252 84 268 68', 34) +
      line('M256 104Q252 84 268 68', 14, C.mintDark) +
      shape(ell(274, 66, 21), C.pink, 14) +
      hi(ell(267, 59, 7, 5), 0.75) +
      shape(legL, C.mintDark) +
      shape(legR, C.mintDark) +
      shape(armL, C.mint) +
      shape(armR, C.mint) +
      shape(body, C.mint) +
      shade('cy-b', body, 'M80 300C140 380 380 380 440 260L440 420L80 420Z', C.mintDark) +
      line(body, S) +
      // spots
      fill(ell(146, 220, 14, 18), C.mintDark) +
      fill(ell(370, 214, 10, 13), C.mintDark) +
      fill(ell(382, 250, 7, 9), C.mintDark) +
      hiLine('M144 176Q166 132 206 116', 16, 0.5) +
      // eye
      shape(ell(256, 226, 78), C.white) +
      fill(ell(270, 236, 44), C.cobalt) +
      fill(ell(274, 240, 22), INK) +
      fill(ell(256, 222, 12), C.white) +
      fill(ell(288, 256, 5), C.white) +
      // mouth with one tooth
      shape('M214 330Q256 352 298 330Q290 368 256 370Q222 368 214 330Z', INK, 12) +
      fill('M262 336L282 334L276 352Z', C.white) +
      // blush
      fill(ell(170, 318, 18, 9), C.pink, ' opacity="0.65"') +
      fill(ell(342, 318, 18, 9), C.pink, ' opacity="0.65"'),
  );
}

// ---------------------------------------------------------------------------
// 3. Snooze the mushroom
// ---------------------------------------------------------------------------

function mushroom(): string {
  const cap = 'M60 262C56 140 152 58 256 58C360 58 456 140 452 262C450 290 420 296 256 296C92 296 62 290 60 262Z';
  const stem = 'M172 280C164 340 156 400 168 436Q174 456 200 456L312 456Q338 456 344 436C356 400 348 340 340 280Z';
  const grass = roundPoly(
    [
      [118, 458], [124, 418], [150, 440], [164, 402], [190, 436], [214, 420], [256, 436],
      [298, 420], [322, 436], [348, 402], [362, 440], [388, 418], [394, 458],
    ],
    12,
  );

  return doc(
    shape(stem, C.cream) +
      shade('mu-s', stem, 'M300 260C320 340 330 420 300 470L380 470L380 260Z', C.creamDark) +
      line(stem, S) +
      shape(grass, C.mint, 14) +
      clip('mu-g', [grass], fill('M100 446L420 446L420 480L100 480Z', C.mintDark)) +
      line(grass, 14) +
      shape(cap, C.pink) +
      shade('mu-c', cap, 'M40 230C140 300 380 300 470 220L470 320L40 320Z', C.pinkDark) +
      line(cap, S) +
      // spots
      shape(ell(170, 140, 30, 24), C.cream, 12) +
      shape(ell(300, 106, 24, 18), C.cream, 12) +
      shape(ell(372, 196, 28, 22), C.cream, 12) +
      shape(ell(118, 228, 16, 14), C.cream, 12) +
      shape(ell(244, 222, 18, 14), C.cream, 12) +
      hiLine('M100 196Q118 128 184 92', 16, 0.45) +
      // sleepy face
      line('M206 352Q222 366 238 352', 12) +
      line('M274 352Q290 366 306 352', 12) +
      line('M200 344L192 338', 10) +
      line('M312 344L320 338', 10) +
      fill(ell(256, 392, 10, 13), INK) +
      fill(ell(198, 378, 16, 9), C.pink, ' opacity="0.6"') +
      fill(ell(314, 378, 16, 9), C.pink, ' opacity="0.6"') +
      // snot bubble
      shape(ell(296, 398, 24), '#cfe9ff', 10) +
      hi(ell(288, 390, 7, 5), 0.9),
  );
}

// ---------------------------------------------------------------------------
// 4. Zappy the lightning bolt (holo)
// ---------------------------------------------------------------------------

const BOLT_PTS: Pt[] = [
  [246, 52],
  [384, 52],
  [320, 196],
  [414, 196],
  [200, 462],
  [242, 300],
  [118, 300],
];
const BOLT = roundPoly(BOLT_PTS, [18, 18, 14, 18, 26, 14, 18]);

const boltFace = (): string =>
  // eyes
  fill(ell(226, 238, 15, 20), INK) +
  fill(ell(290, 232, 15, 20), INK) +
  fill(ell(221, 230, 5), C.white) +
  fill(ell(285, 224, 5), C.white) +
  // big open grin
  shape('M214 268Q256 286 298 262Q296 312 258 314Q222 314 214 268Z', INK, 10) +
  fill('M234 300Q256 290 280 298Q270 312 256 312Q242 312 234 300Z', C.pink);

function bolt(): string {
  return doc(
    shape(BOLT, C.lemon) +
      shade('bo-s', BOLT, 'M200 300L414 192L440 192L200 500Z', C.lemonDark) +
      line(BOLT, S) +
      hiLine('M262 70L194 216', 16, 0.6) +
      boltFace() +
      fill(ell(194, 268, 14, 8), C.pink, ' opacity="0.7"') +
      fill(ell(324, 256, 14, 8), C.pink, ' opacity="0.7"'),
  );
}

function boltFoil(): string {
  return foilDoc(
    fill(BOLT, '#ffffff') +
      line(BOLT, S + 2, '#000000') +
      fill(ell(226, 238, 19, 24), '#000000') +
      fill(ell(290, 232, 19, 24), '#000000') +
      shape('M214 268Q256 286 298 262Q296 312 258 314Q222 314 214 268Z', '#000000', 14).replace(INK, '#000000'),
  );
}

// ---------------------------------------------------------------------------
// 5. Boo Lou the ghost
// ---------------------------------------------------------------------------

function ghost(): string {
  const body =
    'M108 412L108 236C108 134 176 66 256 66C336 66 404 134 404 236L404 412' +
    'Q368 474 330 422Q292 474 256 422Q220 474 182 422Q144 474 108 412Z';
  const heart = 'M256 384C206 352 186 326 192 300C198 274 232 268 256 294C280 268 314 274 320 300C326 326 306 352 256 384Z';
  const armL = ell(188, 314, 30, 19);
  const armR = ell(324, 314, 30, 19);

  return doc(
    g(
      'rotate(-6 256 260)',
      shape(body, C.lilac) +
        shade('gh-b', body, 'M330 60C420 120 430 300 340 470L460 470L460 60Z', C.lilacDark) +
        line(body, S) +
        hiLine('M152 190Q164 128 216 102', 18, 0.5) +
        // face
        fill(ell(214, 206, 17, 25), INK) +
        fill(ell(298, 206, 17, 25), INK) +
        fill(ell(208, 196, 6), C.white) +
        fill(ell(292, 196, 6), C.white) +
        shape(ell(256, 250, 12, 14), INK, 6) +
        fill(ell(180, 246, 18, 9), C.pink, ' opacity="0.7"') +
        fill(ell(332, 246, 18, 9), C.pink, ' opacity="0.7"') +
        // heart + little arms
        shape(heart, C.pink) +
        hi(ell(222, 300, 10, 7), 0.7) +
        shape(armL, C.lilac, 14, ' transform="rotate(-28 188 314)"') +
        shape(armR, C.lilac, 14, ' transform="rotate(28 324 314)"'),
    ),
  );
}

// ---------------------------------------------------------------------------
// 6. Sly Slice the pizza
// ---------------------------------------------------------------------------

function pizza(): string {
  const cheese = 'M96 138L416 138L268 440Q256 462 244 440Z';
  const dripR = 'M396 170C404 180 406 196 404 220L402 304C402 334 368 334 370 304L372 240C372 228 372 222 374 214Z';
  const dripL = 'M120 180C112 190 110 206 110 226L110 266C110 294 142 294 142 266L144 248C146 240 148 234 148 228Z';
  const crust = 'M96 138Q256 66 416 138';
  const goo = [cheese, dripR, dripL];
  const pep = (cx: number, cy: number, r: number) =>
    shape(ell(cx, cy, r), C.pepperoni, 12) +
    fill(ell(cx - r * 0.3, cy - r * 0.25, r * 0.2), C.pepperoniDark) +
    fill(ell(cx + r * 0.32, cy + r * 0.2, r * 0.16), C.pepperoniDark) +
    fill(ell(cx - r * 0.1, cy + r * 0.45, r * 0.12), C.pepperoniDark);

  return doc(
    underlay(goo) +
      line(crust, 56 + S * 2) +
      goo.map((d) => fill(d, C.lemon)).join('') +
      clip('pz-c', goo, fill('M300 120L440 120L440 330L262 470L200 470Z', C.lemonDark) + pep(130, 178, 34) + pep(388, 170, 32) + pep(256, 392, 26)) +
      hiLine('M384 230L384 290', 9, 0.5) + hiLine('M120 220L120 250', 8, 0.5) +
      line(crust, 56, C.crust) +
      line('M114 128Q256 70 398 128', 12, C.crustDark, ' opacity="0.6"') +
      hiLine('M140 116Q196 94 244 90', 12, 0.6) +
      // evil face
      fill('M184 200L240 224Q236 254 212 252Q184 248 184 200Z', INK) +
      fill('M328 200L272 224Q276 254 300 252Q328 248 328 200Z', INK) +
      fill(ell(216, 234, 5), C.white) +
      fill(ell(296, 234, 5), C.white) +
      line('M176 190L242 216', 14) +
      line('M336 190L270 216', 14) +
      shape('M186 272Q256 302 326 272Q316 344 256 348Q196 344 186 272Z', INK, 10) +
      fill('M198 284L210 302L222 289L234 306L246 293L256 308L266 293L278 306L290 289L302 302L314 284Q256 304 198 284Z', C.white) +
      fill('M226 336Q256 318 286 336Q272 344 256 344Q240 344 226 336Z', C.pink),
  );
}

// ---------------------------------------------------------------------------
// 7. Stella the star (holo)
// ---------------------------------------------------------------------------

const STAR = roundPoly(starPts(256, 272, 5, 214, 112), [34, 16, 34, 16, 34, 16, 34, 16, 34, 16]);

const starFaceShapes = {
  eyeL: ell(218, 258, 18, 24),
  eyeR: ell(294, 258, 18, 24),
  mouth: 'M226 306Q256 320 286 306Q284 344 256 346Q228 344 226 306Z',
};

function star(): string {
  return doc(
    shape(STAR, C.lilac) +
      shade('st-s', STAR, 'M256 290L520 200L520 520L256 520Z', C.lilacDark) +
      line(STAR, S) +
      hiLine('M140 214L200 214', 14, 0.6) +
      hiLine('M246 112L232 152', 14, 0.6) +
      fill(starFaceShapes.eyeL, INK) +
      fill(starFaceShapes.eyeR, INK) +
      fill(ell(212, 248, 7), C.white) +
      fill(ell(288, 248, 7), C.white) +
      fill(ell(224, 270, 3), C.white) +
      fill(ell(300, 270, 3), C.white) +
      shape(starFaceShapes.mouth, INK, 10) +
      fill('M240 334Q256 322 272 334Q264 342 256 342Q248 342 240 334Z', C.pink) +
      fill(ell(182, 300, 18, 10), C.pink, ' opacity="0.75"') +
      fill(ell(330, 300, 18, 10), C.pink, ' opacity="0.75"'),
  );
}

function starFoil(): string {
  return foilDoc(
    fill(STAR, '#ffffff') +
      line(STAR, S + 2, '#000000') +
      fill(ell(218, 258, 22, 28), '#000000') +
      fill(ell(294, 258, 22, 28), '#000000') +
      line(starFaceShapes.mouth, 14, '#000000') +
      fill(starFaceShapes.mouth, '#000000'),
  );
}

// ---------------------------------------------------------------------------
// 8. Drippy the melting sun
// ---------------------------------------------------------------------------

function sunRays(cx: number, cy: number, tip: number, base: number, angles: number[], spread: number): Pt[] {
  // angles in degrees, clockwise from straight up
  const at = (deg: number, r: number): Pt => [cx + Math.sin((deg * Math.PI) / 180) * r, cy - Math.cos((deg * Math.PI) / 180) * r];
  const pts: Pt[] = [at(angles[0] - spread, base)];
  for (const a of angles) {
    pts.push(at(a, tip), at(a + spread, base));
  }
  pts.push([cx, cy + 40]);
  return pts;
}

function melt(): string {
  const cx = 256;
  const cy = 234;
  const raysPts = sunRays(cx, cy, 184, 128, [-120, -90, -60, -30, 0, 30, 60, 90, 120], 15);
  const rays = roundPoly(raysPts, raysPts.map((_, i) => (i % 2 === 1 ? 20 : 8)));
  const face = ell(cx, cy, 118);
  const drips =
    'M147 280L142 314Q142 344 164 344Q186 344 186 318Q192 306 204 312L204 402Q204 432 228 432Q252 432 252 402L252 370Q260 358 270 368L270 376Q270 402 290 402Q310 402 310 376L310 350Q318 340 328 346L328 326Q328 350 346 350Q364 350 364 326L365 280L256 236Z';
  const goo = [face, drips];

  return doc(
    shape(rays, C.tangerine) +
      clip('me-r', [rays], fill(ell(cx + 40, cy + 30, 200), C.tangerineDark) + fill(ell(cx - 10, cy - 6, 200), C.tangerine)) +
      line(rays, S) +
      underlay(goo) +
      clip('me-f', goo, goo.map((d) => fill(d, C.lemonDark)).join('') + g('translate(-12 -9)', goo.map((d) => fill(d, C.lemon)).join(''))) +
      hiLine('M164 170Q186 130 232 116', 18, 0.6) +
      hiLine('M220 362L220 396', 10, 0.55) +
      // face: one eye sliding off
      fill(ell(210, 212, 17, 25), INK) +
      fill('M286 204Q302 190 318 204L320 262Q320 280 308 280Q296 280 298 264Q288 256 286 236Z', INK) +
      fill(ell(204, 202, 6), C.white) +
      fill(ell(296, 208, 5), C.white) +
      line('M186 266Q212 300 248 288Q280 276 296 292Q310 304 328 278', 14) +
      fill(ell(166, 254, 17, 9), C.pink, ' opacity="0.75"') +
      fill(ell(348, 252, 17, 9), C.pink, ' opacity="0.75"'),
  );
}

// ---------------------------------------------------------------------------
// 9. Spike the cactus
// ---------------------------------------------------------------------------

function cactus(): string {
  const body = 'M200 200Q200 146 256 146Q312 146 312 200L312 380L200 380Z';
  const armL = 'M204 318L156 318Q124 318 124 286L124 238Q124 212 148 212Q172 212 172 238L172 272L204 272Z';
  const armR = 'M308 282L344 282L344 206Q344 180 368 180Q392 180 392 206L392 290Q392 326 356 326L308 326Z';
  const pot = 'M158 384L354 384L336 450Q332 464 318 464L194 464Q180 464 176 450Z';
  const rim = 'M144 372Q144 358 158 358L354 358Q368 358 368 372L368 392Q368 406 354 406L158 406Q144 406 144 392Z';
  const hat = 'M202 162L302 154L262 68Z';
  const greens = [body, armL, armR];

  return doc(
    underlay(greens) +
      greens.map((d) => fill(d, C.mint)).join('') +
      clip('ca-g', greens, fill('M282 120L330 120L330 390L282 390Z', C.mintDark) + fill('M366 160L420 160L420 340L366 340Z', C.mintDark) + fill('M100 296L210 296L210 330L100 330Z', C.mintDark)) +
      line('M256 210L256 250M256 290L256 340', 8, C.mintDark) +
      hiLine('M220 200L220 250', 14, 0.5) +
      hiLine('M142 236L142 262', 10, 0.5) +
      hiLine('M362 204L362 226', 10, 0.5) +
      // spines
      line('M226 300l-10 -6M290 304l10 -6M234 346l-9 6M286 350l9 6M138 286l-10 2M378 270l10 -2M150 230l8 -6', 7) +
      // pot
      shape(pot, C.tangerine) +
      clip('ca-p', [pot], fill('M300 380L380 380L380 470L292 470Z', C.tangerineDark)) +
      line(pot, S) +
      shape(rim, C.tangerine) +
      hiLine('M166 372L214 372', 9, 0.55) +
      // party hat
      shape(hat, C.cobalt, 14) +
      clip('ca-h', [hat], line('M218 136L296 130', 12, C.lemon) + line('M234 104L284 100', 10, C.lemon) + fill('M272 60L320 160L290 160Z', C.cobaltDark, ' opacity="0.6"')) +
      line(hat, 14) +
      shape(ell(262, 66, 18), C.pink, 12) +
      hi(ell(256, 60, 6, 4), 0.8) +
      // face
      line('M220 240Q232 226 244 240', 11) +
      line('M268 240Q280 226 292 240', 11) +
      shape('M240 262Q256 272 272 262Q268 284 256 284Q244 284 240 262Z', INK, 8) +
      fill(ell(216, 264, 13, 7), C.pink, ' opacity="0.75"') +
      fill(ell(296, 264, 13, 7), C.pink, ' opacity="0.75"'),
  );
}

// ---------------------------------------------------------------------------
// 10. Peel Me badge (holo)
// ---------------------------------------------------------------------------

function letters(): string {
  // Skeleton strokes for chunky bubble lettering (round caps/joins).
  const h = 84;
  const P = (x: number, y: number, w: number) =>
    `M${x} ${y + h}L${x} ${y}L${x + w * 0.5} ${y}Q${x + w} ${y} ${x + w} ${y + h * 0.27}Q${x + w} ${y + h * 0.54} ${x + w * 0.5} ${y + h * 0.54}L${x} ${y + h * 0.54}`;
  const E = (x: number, y: number, w: number) =>
    `M${x + w} ${y}L${x} ${y}L${x} ${y + h}L${x + w} ${y + h}M${x} ${y + h / 2}L${x + w * 0.8} ${y + h / 2}`;
  const L = (x: number, y: number, w: number) => `M${x} ${y}L${x} ${y + h}L${x + w} ${y + h}`;
  const M = (x: number, y: number, w: number) => `M${x} ${y + h}L${x} ${y}L${x + w / 2} ${y + h * 0.58}L${x + w} ${y}L${x + w} ${y + h}`;
  const bang = (x: number, y: number) => `M${x} ${y}L${x} ${y + h * 0.56}M${x} ${y + h}L${x} ${y + h}`;

  const y1 = 156;
  const y2 = 280;
  return (
    P(116, y1, 46) +
    E(196, y1, 42) +
    E(272, y1, 42) +
    L(348, y1, 44) +
    M(172, y2, 76) +
    E(282, y2, 42) +
    bang(356, y2)
  );
}

const BURST = roundPoly(starPts(256, 256, 14, 212, 184), Array.from({ length: 28 }, (_, i) => (i % 2 === 0 ? 20 : 12)));
const DISC = ell(256, 256, 160);

function badge(): string {
  const text = letters();
  return doc(
    shape(BURST, C.pink) +
      shade('ba-b', BURST, 'M256 256L520 120L520 520L120 520Z', C.pinkDark) +
      line(BURST, S) +
      shape(DISC, C.cobalt) +
      line(ell(256, 256, 142), 4, '#ffffff', ' opacity="0.35" stroke-dasharray="2 14"') +
      g(
        'rotate(-8 256 256)',
        // drop shadow + outline + fill strokes
        g('translate(6 8)', line(text, 50, INK)) +
          line(text, 50, INK) +
          line(text, 24, C.lemon),
      ),
  );
}

function badgeFoil(): string {
  // Foil on the scalloped ring and inside the lettering; the cobalt disc and all ink stay plain.
  return foilDoc(
    fill(BURST, '#ffffff') +
      line(BURST, S + 2, '#000000') +
      shape(DISC, '#000000', S + 4).replace(INK, '#000000') +
      g('rotate(-8 256 256)', line(letters(), 20, '#ffffff')),
  );
}

// ---------------------------------------------------------------------------
// Pack
// ---------------------------------------------------------------------------

export const STICKER_ART: StickerArt[] = [
  { id: 'mule', name: 'Mulligan', svg: mule(), finish: 'gloss' },
  { id: 'cyclops', name: 'Oggy', svg: cyclops(), finish: 'gloss' },
  { id: 'mushroom', name: 'Snooze', svg: mushroom(), finish: 'gloss' },
  { id: 'bolt', name: 'Zappy', svg: bolt(), finish: 'holo', foil: boltFoil() },
  { id: 'ghost', name: 'Boo Lou', svg: ghost(), finish: 'gloss' },
  { id: 'pizza', name: 'Sly Slice', svg: pizza(), finish: 'gloss' },
  { id: 'star', name: 'Stella', svg: star(), finish: 'holo', foil: starFoil() },
  { id: 'melt', name: 'Drippy', svg: melt(), finish: 'matte' },
  { id: 'cactus', name: 'Spike', svg: cactus(), finish: 'matte' },
  { id: 'peel-me', name: 'Peel Me', svg: badge(), finish: 'holo', foil: badgeFoil() },
];
