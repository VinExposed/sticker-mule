// End-to-end smoke test: peel the inviting sticker off the sheet, carry it to
// the notebook, drop it, and check it stuck there and nothing logged an error.
//
//   npx playwright install chromium   (once)
//   npm run e2e
import { chromium } from 'playwright';
import { createServer } from 'vite';

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH, // optional: use an existing Chrome/Chromium
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(url);
  await page.waitForFunction(() => document.body.classList.contains('ready'), null, { timeout: 30_000 });
  // Let the intro shot finish so the invite corner is where it'll stay.
  await page.waitForFunction(() => window.__peel.play.invitePoint(new window.__peel.THREE.Vector3()) !== null, null, {
    timeout: 10_000,
  });

  const toScreen = (p) => ({ x: (p.x * 0.5 + 0.5) * 1280, y: (-p.y * 0.5 + 0.5) * 800 });
  const corner = toScreen(
    await page.evaluate(() => {
      const { play, world, THREE } = window.__peel;
      const v = play.invitePoint(new THREE.Vector3()).project(world.camera);
      return { x: v.x, y: v.y };
    }),
  );
  const notebook = toScreen(
    await page.evaluate(() => {
      const { world, THREE } = window.__peel;
      const n = world.notebookSurface;
      const v = new THREE.Vector3(n.x, n.top, n.z).project(world.camera);
      return { x: v.x, y: v.y };
    }),
  );
  const modes = () => page.evaluate(() => window.__peel.play.stickers.map((s) => `${s.mode}@${s.surface}`));

  // Grab the corner and drag back across the sticker until it pops free.
  await page.mouse.move(corner.x, corner.y);
  await page.mouse.down();
  await page.mouse.move(corner.x + 30, corner.y - 30, { steps: 8 });
  if (!(await modes()).some((m) => m.startsWith('peeling'))) fail('dragging the corner did not start a peel');
  await page.mouse.move(corner.x + 120, corner.y - 110, { steps: 12 });
  await page.mouse.move(notebook.x, notebook.y, { steps: 20 });
  if (!(await modes()).some((m) => m.startsWith('carried'))) fail('peeling across the sticker did not lift it off');
  // The held sticker trails the cursor on a spring; let it catch up.
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(800);

  const onNotebook = (await modes()).filter((m) => m === 'stuck@notebook').length;
  if (onNotebook !== 1) fail(`expected one sticker on the notebook, found ${onNotebook}`);
  if (errors.length) fail(`errors in the page:\n  ${errors.join('\n  ')}`);
  if (!process.exitCode) console.log('✓ peel → carry → drop works, no errors');
} finally {
  await browser.close();
  await server.close();
}
