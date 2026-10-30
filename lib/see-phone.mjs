// botference see, phone-width lane.
//
//   node lib/see-phone.mjs <chrome> <url> <width> <height> <out.png>
//
// Headless Chrome will not make a window narrower than 500 CSS px: ask
// for 390 and the page lays out at 500 and the screenshot cuts off the
// right edge. So a "phone" shot taken with --window-size is a fake.
//
// This helper drives Chrome over its DevTools pipe instead and tells it
// to emulate a phone screen of exactly <width> x <height> CSS px, with a
// phone's device pixel ratio, a mobile user agent and touch input. The
// page sees innerWidth = <width>. The PNG is <width> x <height> pixels
// (drawn at the phone's pixel ratio, then scaled to 1 PNG pixel per CSS
// px so the file size and the reading cost stay the same as before).
//
// Why not an iframe of the right width on a wider host page: an iframe
// cannot carry --basic-auth (Chrome blocks credentials in frame URLs)
// and pages that send X-Frame-Options or frame-ancestors refuse to be
// framed. Emulation has neither problem.
//
// Exit 0 with the PNG written, or nonzero with a reason on stderr (the
// caller then falls back to a plain window render and says so).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [chrome, url, wArg, hArg, out] = process.argv.slice(2);
const W = Number(wArg), H = Number(hArg);
if (!chrome || !url || !(W > 0) || !(H > 0) || !out) {
  console.error('usage: see-phone.mjs <chrome> <url> <width> <height> <out.png>');
  process.exit(2);
}
const DPR = 3;              // typical phone (iPhone 15: 3, Pixel 8: 2.625)
const BUDGET_MS = 8000;     // same virtual-time budget as the window lane
const HARD_LIMIT_MS = 60000;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'see-phone-'));
const proc = spawn(chrome, [
  '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--remote-debugging-pipe',
  `--user-data-dir=${profile}`, '--window-size=500,' + H, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

function finish(code, msg) {
  if (msg) console.error(msg);
  try { proc.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(code);
}
const timer = setTimeout(() => finish(1, 'see-phone: Chrome did not finish within 60s'), HARD_LIMIT_MS);
proc.on('error', e => finish(1, `see-phone: cannot start Chrome: ${e.message}`));
proc.on('exit', () => finish(1, 'see-phone: Chrome exited early'));

// DevTools pipe protocol: JSON messages separated by a NUL byte.
const toChrome = proc.stdio[3], fromChrome = proc.stdio[4];
let nextId = 1, buf = '';
const pending = new Map(), waiters = [];
fromChrome.setEncoding('utf8');
fromChrome.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\0')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id && pending.has(msg.id)) {
      const { method, resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) {
      for (const w of waiters.slice()) {
        if (w.method === msg.method) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
      }
    }
  }
});
function send(method, params = {}, sessionId) {
  const id = nextId++;
  toChrome.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
}
function once(method) {
  return new Promise(resolve => waiters.push({ method, resolve }));
}

try {
  const { product } = await send('Browser.getVersion');
  const major = (/\/(\d+)/.exec(product) || [])[1] || '120';
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);

  await s('Page.enable');
  await s('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: DPR, mobile: true,
    screenWidth: W, screenHeight: H,
  });
  await s('Emulation.setUserAgentOverride', {
    userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    platform: 'Android',
  });
  await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s('Emulation.setScrollbarsHidden', { hidden: true });

  const loaded = once('Page.loadEventFired');
  const nav = await s('Page.navigate', { url });
  if (nav.errorText) finish(1, `see-phone: could not load ${url.replace(/\/\/[^@/]*@/, '//')}: ${nav.errorText}`);
  await Promise.race([loaded, new Promise(r => setTimeout(r, 20000))]);
  // Same idea as --virtual-time-budget: fast-forward timers so pages that
  // draw on the client (charts) finish before the shot.
  const budgetDone = once('Emulation.virtualTimeBudgetExpired');
  await s('Emulation.setVirtualTimePolicy', {
    policy: 'pauseIfNetworkFetchesPending', budget: BUDGET_MS,
  });
  await Promise.race([budgetDone, new Promise(r => setTimeout(r, 20000))]);

  // Capture what the phone screen shows. A page without a
  // <meta name="viewport"> lays out 980 px wide and is zoomed out to fit,
  // exactly as on a real phone, so clip to the visible area in page px
  // and scale it to W x H PNG pixels.
  const { cssVisualViewport: v } = await s('Page.getLayoutMetrics');
  const { data } = await s('Page.captureScreenshot', {
    format: 'png',
    clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: W / v.clientWidth / DPR },
  });
  fs.writeFileSync(out, Buffer.from(data, 'base64'));
  clearTimeout(timer);
  proc.removeAllListeners('exit');
  finish(0);
} catch (e) {
  finish(1, `see-phone: ${e.message}`);
}
