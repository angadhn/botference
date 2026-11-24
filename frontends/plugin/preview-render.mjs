// preview-render.mjs — a picture of the owner's draft post, as their own preview site shows it, for the publish dialog.
//
// The COMPANION makes the picture (so it works for a remote owner too: the drawer only ever gets pixels). Headless Chrome, driven
// over its DevTools pipe the way lib/see-phone.mjs (`botference see`) does, in a THROWAWAY profile (a fresh folder, removed after):
//   · JavaScript OFF (Emulation.setScriptExecutionDisabled): the example blog's short post renders without it, and the page holds
//     quoted text from a hostile page;
//   · ONLY the configured preview origin is fetched: every request is paused (Fetch.enable) and anything to another origin is failed
//     (BlockedByClient) before it leaves; no credentials are given, none are in the profile;
//   · a phone-like width (WIDTH_CSS, 420 CSS px) at 2x, in the drawer's theme through prefers-color-scheme (light by default);
//   · cropped to the post's own element (`selector`, found with the DOM domain, no page script), at most MAX_HEIGHT_CSS tall;
//   · bounded: LOAD_MS for the page, HARD_MS for everything; a PNG over MAX_PNG_BYTES is refused.
// → { state: 'ready', png } | { state: 'unavailable', why }   (why: one plain line, for the log; the owner sees "Preview not available")
// A page that is not there yet (404, or the selector matches nothing) is `missing`, which the caller may try again a few times.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WIDTH_CSS = 420;
export const DPR = 2;
export const MAX_HEIGHT_CSS = 2400;
export const MAX_PNG_BYTES = 4 * 1024 * 1024;
export const LOAD_MS = 12000;
export const HARD_MS = 30000;
export const RENDER_ENDINGS = Object.freeze(['ready', 'missing', 'unavailable']);

/** Chrome on this machine (BOTFERENCE_CHROME, the macOS app, then PATH), or ''. */
export function findChrome(env = process.env) {
  const c = env.BOTFERENCE_CHROME;
  if (c && fs.existsSync(c)) return c;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (process.platform === 'darwin' && fs.existsSync(mac)) return mac;
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    for (const n of ['google-chrome', 'chromium', 'chromium-browser', 'chrome']) { const p = path.join(d, n); try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ } }
  }
  return '';
}

export function renderPreview({ chrome, url, selector, theme = 'light', loadMs = LOAD_MS, hardMs = HARD_MS }) {
  return new Promise(resolve => {
    let origin = '';
    try { const u = new URL(url); if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme'); origin = u.origin; } catch { resolve({ state: 'unavailable', why: 'the preview address is not an http(s) address' }); return; }
    if (!chrome) { resolve({ state: 'unavailable', why: 'no headless Chrome on this machine' }); return; }
    let profile = '';
    try { profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-preview-')); } catch { resolve({ state: 'unavailable', why: 'could not make a profile folder' }); return; }
    let proc;
    let ended = false;
    const finish = r => {
      if (ended) return;
      ended = true;
      clearTimeout(hard);
      try { proc && proc.kill('SIGKILL'); } catch { /* gone */ }
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* temp */ } }, 200).unref();
      resolve(r);
    };
    const hard = setTimeout(() => finish({ state: 'unavailable', why: `the render did not finish within ${hardMs / 1000} s` }), hardMs);
    try {
      proc = spawn(chrome, ['--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
        '--no-pings', '--incognito', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--window-size=500,900', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
    } catch (e) { finish({ state: 'unavailable', why: `could not start Chrome: ${e.message}` }); return; }
    proc.on('error', e => finish({ state: 'unavailable', why: `could not start Chrome: ${e.message}` }));
    proc.on('exit', () => finish({ state: 'unavailable', why: 'Chrome exited early' }));
    const to = proc.stdio[3];
    const from = proc.stdio[4];
    let next = 1;
    let buf = '';
    const pending = new Map();
    const listeners = [];
    from.setEncoding('utf8');
    from.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        let msg; try { msg = JSON.parse(buf.slice(0, i)); } catch { msg = null; }
        buf = buf.slice(i + 1);
        if (!msg) continue;
        if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.reject(new Error(`${p.method}: ${msg.error.message}`)) : p.resolve(msg.result); }
        else if (msg.method) for (const l of listeners.slice()) l(msg);
      }
    });
    const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
      const id = next++;
      pending.set(id, { method, resolve: res, reject: rej });
      try { to.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); } catch (e) { pending.delete(id); rej(e); }
    });
    (async () => {
      const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
      const s = (m, p) => send(m, p, sessionId);
      let mainStatus = 0;
      let loaded = false;
      listeners.push(msg => {
        if (msg.sessionId !== sessionId) return;
        if (msg.method === 'Fetch.requestPaused') {
          const p = msg.params;
          let ok = false; try { ok = new URL(p.request.url).origin === origin; } catch { ok = false; }
          s(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
        } else if (msg.method === 'Network.responseReceived' && msg.params.type === 'Document' && !mainStatus) mainStatus = msg.params.response.status;
        else if (msg.method === 'Page.loadEventFired') loaded = true;
      });
      await s('Network.enable');
      await s('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
      await s('Page.enable');
      await s('Emulation.setScriptExecutionDisabled', { value: true });
      await s('Emulation.setDeviceMetricsOverride', { width: WIDTH_CSS, height: 900, deviceScaleFactor: DPR, mobile: true, screenWidth: WIDTH_CSS, screenHeight: 900 });
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: theme === 'dark' ? 'dark' : 'light' }] });
      const nav = await s('Page.navigate', { url });
      if (nav.errorText) return finish({ state: 'unavailable', why: `the preview site did not answer (${nav.errorText})` });
      const t0 = Date.now();
      while (!loaded && Date.now() - t0 < loadMs) await new Promise(r => setTimeout(r, 100));
      if (mainStatus === 404) return finish({ state: 'missing', why: 'the preview site has no page at that address yet' });
      if (mainStatus && (mainStatus < 200 || mainStatus >= 400)) return finish({ state: 'unavailable', why: `the preview site answered ${mainStatus}` });
      const { root } = await s('DOM.getDocument', { depth: 0 });
      const { nodeId } = await s('DOM.querySelector', { nodeId: root.nodeId, selector: String(selector || 'article') });
      if (!nodeId) return finish({ state: 'missing', why: `nothing on the page matches ${String(selector).slice(0, 60)}` });
      const { model } = await s('DOM.getBoxModel', { nodeId });
      const q = model.border;
      const x = Math.min(q[0], q[6]);
      const y = Math.min(q[1], q[3]);
      const w = Math.max(q[2], q[4]) - x;
      const h = Math.min(MAX_HEIGHT_CSS, Math.max(q[5], q[7]) - y);
      if (!(w > 0 && h > 0)) return finish({ state: 'missing', why: 'the post has no size on the page' });
      const { data } = await s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x, y, width: w, height: h, scale: 1 } });
      const png = Buffer.from(data, 'base64');
      if (png.length > MAX_PNG_BYTES) return finish({ state: 'unavailable', why: 'the picture is too large' });
      finish({ state: 'ready', png });
    })().catch(e => finish({ state: 'unavailable', why: String((e && e.message) || e).slice(0, 200) }));
  });
}
