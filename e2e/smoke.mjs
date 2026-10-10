// End-to-end smoke test, in a real browser:
//   1. peel the inviting sticker off the sheet, carry it to the notebook, drop it;
//   2. draw a sticker in "Make your own", get it in hand, click to stick it down;
// and fail on any error logged by the page.
//
//   npx playwright install chromium   (once)
//   npm run e2e
import { chromium } from 'playwright';
import { createServer } from 'vite';

const W = 1280;
const H = 800;
const failures = [];
const check = (ok, msg) => ok || failures.push(msg);

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH, // optional: use an existing Chrome/Chromium
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  // Reduced motion skips the intro shot and the idle flutter: deterministic,
  // and quick even on CI's software-rendered GPU.
  const page = await browser.newPage({ viewport: { width: W, height: H }, reducedMotion: 'reduce' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  // Wait on app state rather than wall-clock time: on a software GPU the
  // simulation can run slower than real time.
  const until = (fn, timeout = 60_000) =>
    page.waitForFunction(fn, null, { timeout }).then(
      () => true,
      () => false,
    );
  const toScreen = ({ x, y }) => ({ x: (x * 0.5 + 0.5) * W, y: (-y * 0.5 + 0.5) * H });

  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 60_000 });
  // A few frames in, every sticker has been placed and the invite corner lifted.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 300)))));
  if (!(await until(() => window.__peel.play.invitePoint(new window.__peel.THREE.Vector3()) !== null))) {
    throw new Error('the sheet never offered a sticker to peel');
  }

  const { corner, notebook } = await page.evaluate(() => {
    const { play, world, THREE } = window.__peel;
    const nb = world.notebookSurface;
    const c = play.invitePoint(new THREE.Vector3()).project(world.camera);
    const n = new THREE.Vector3(nb.x, nb.top, nb.z).project(world.camera);
    return { corner: { x: c.x, y: c.y }, notebook: { x: n.x, y: n.y } };
  });
  const from = toScreen(corner);
  const onto = toScreen(notebook);

  // 1. Peel, carry, drop.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y - 30, { steps: 8 });
  check(await until(() => window.__peel.play.stickers.some((s) => s.mode === 'peeling')), 'dragging the corner did not start a peel');
  await page.mouse.move(from.x + 120, from.y - 110, { steps: 12 });
  await page.mouse.move(onto.x, onto.y, { steps: 20 });
  check(await until(() => window.__peel.play.stickers.some((s) => s.mode === 'carried')), 'peeling across did not lift it off');
  // The held sticker trails the cursor on a spring; let it arrive over the notebook.
  await until(() => {
    const st = window.__peel.play.stickers.find((s) => s.mode === 'carried');
    const nb = window.__peel.world.notebookSurface;
    return !!st && Math.hypot(st.pivot.x - nb.x, st.pivot.z - nb.z) < 3;
  });
  await page.mouse.up();
  check(
    await until(() => window.__peel.play.stickers.some((s) => s.mode === 'stuck' && s.surface === 'notebook')),
    "the peeled sticker didn't stick to the notebook",
  );

  // 2. Make your own: draw, cut, it's in your hand, click to stick it down.
  await page.click('button[data-act=make]');
  const pad = await page.locator('.pad canvas').boundingBox();
  await page.mouse.move(pad.x + pad.width * 0.3, pad.y + pad.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(pad.x + pad.width * 0.7, pad.y + pad.height * 0.5, { steps: 10 });
  await page.mouse.up();
  await page.click('button[data-a=make]');
  check(
    await until(() => window.__peel.play.stickers.some((s) => s.src.key.startsWith('u-') && s.mode === 'carried')),
    'a made sticker did not land in hand',
  );
  await page.mouse.move(onto.x - 60, onto.y - 60, { steps: 10 });
  await page.mouse.down();
  await page.mouse.up();
  check(
    await until(() =>
      window.__peel.play.stickers.some((s) => s.src.key.startsWith('u-') && s.mode === 'stuck' && s.surface === 'notebook'),
    ),
    'clicking did not stick the made sticker to the notebook',
  );

  check(errors.length === 0, `errors in the page:\n  ${errors.join('\n  ')}`);
} finally {
  await browser.close();
  await server.close();
}

if (failures.length) {
  for (const f of failures) console.error(`✗ ${f}`);
  process.exitCode = 1;
} else {
  console.log('✓ peel → carry → drop, and make → hold → stick, with no errors');
}
