// The camera and the hand.
//
// Camera: CDP Page.startScreencast, which emits a frame whenever the compositor
// paints and nothing at all when the screen is still. That is the right shape
// for a screen recording — but it is variable-rate, so every frame is stamped
// and the whole take is resampled to a hard 30fps by ffmpeg at the end. A still
// second costs one frame on disk and holds correctly on screen.
//
// Hand: the extension's drawer lives in a shadow root under a host pinned at
// z-index 2147483647, so nothing can be layered above it by z-index alone. The
// cursor is therefore appended to <html> AFTER the drawer host and given the
// same z-index: equal z-index, later in tree order, painted on top. It is a
// sprite, not the real pointer — CDP renders no pointer — so it is moved by
// transform on a transition and the real event is dispatched when it arrives.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const FPS = 30;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------
export class Recorder {
  constructor(page, dir, { coordScale = 1 } = {}) {
    this.page = page;
    this.dir = dir;
    this.frames = [];       // { file, t }  t = seconds, monotonic
    this.marks = [];        // { label, t } — the action timestamps for shots.json
    this.n = 0;
    this.t0 = null;
    // v5 shoots at 1280×720 CSS under deviceScaleFactor 1.5, so the FRAME is
    // still 1920×1080 but getBoundingClientRect speaks CSS px. Marks are the
    // edit's coordinate system — they must land in frame px, so every measured
    // position is multiplied through by this on the way into shots.json.
    this.coordScale = coordScale;
  }

  async start() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    fs.mkdirSync(this.dir, { recursive: true });
    this.client = await this.page.context().newCDPSession(this.page);
    // Frames are stamped on the RECORDER's wall clock, not on the compositor's.
    // The screencast emits nothing at all while the screen is still, so a
    // compositor-relative stamp silently deletes every pause from the timeline —
    // a four-second hold on a finished reply became 0.4s of footage before this
    // was fixed. On the wall clock a still second is simply one frame with a
    // one-second duration, which is what it should be.
    this.wall0 = Date.now();
    this.client.on('Page.screencastFrame', async ({ data, sessionId }) => {
      const t = (Date.now() - this.wall0) / 1000;
      const file = path.join(this.dir, `f${String(this.n++).padStart(6, '0')}.png`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      this.frames.push({ file, t });
      try { await this.client.send('Page.screencastFrameAck', { sessionId }); } catch { /* stopped */ }
    });
    await this.client.send('Page.startScreencast', {
      format: 'png', everyNthFrame: 1, maxWidth: 1920, maxHeight: 1080,
    });
    // the first frame only arrives on the next paint; nudge one out so t0 is
    // pinned to the top of the take rather than to whatever moves first
    await this.page.evaluate(() => document.documentElement.style.setProperty('--bfp-tick', String(Date.now())));
    await sleep(120);
  }

  /**
   * Name the instant something happened, for shots.json and for cueing labels.
   *
   * `at` is the optional PLACE it happened — a box or point in viewport pixels.
   * The v4 labels are not lower thirds; each one is a small flash of type beside
   * the thing it names, so the edit has to know where that thing was. Measuring
   * it here, at the moment of the action, is the only way it cannot drift: a
   * co-ordinate typed into edit.json is a guess that survives a re-shoot.
   */
  mark(label, at) {
    const t = (Date.now() - this.wall0) / 1000;
    const m = { label, t: Number(t.toFixed(3)) };
    if (at) {
      const k = this.coordScale;
      m.x = Math.round((at.x ?? (at.left + at.right) / 2) * k);
      m.y = Math.round((at.y ?? (at.top + at.bottom) / 2) * k);
      if (at.left != null) {
        m.box = [Math.round(at.left * k), Math.round(at.top * k),
                 Math.round(at.right * k), Math.round(at.bottom * k)];
      }
    }
    this.marks.push(m);
    return t;
  }

  async stop() {
    this.wallEnd = Date.now();
    try { await this.client.send('Page.stopScreencast'); } catch { /* already gone */ }
    await sleep(200);
  }

  /**
   * Resample the variable-rate frames to a constant 30fps mp4.
   * The concat demuxer holds each frame for its real duration; -r 30 then
   * lays that timeline onto an even grid. Both are needed: concat alone
   * produces a variable-rate file Remotion would sample unevenly.
   */
  async encode(out) {
    if (this.frames.length < 2) throw new Error('nothing recorded');
    // the last frame holds until the take actually ended, so a final hold on a
    // motionless screen survives into the file
    const total = ((this.wallEnd || Date.now()) - this.wall0) / 1000;
    const tail = Math.max(0.2, total - this.frames[this.frames.length - 1].t);
    const list = path.join(this.dir, 'concat.txt');
    const lines = [];
    for (let i = 0; i < this.frames.length; i++) {
      const dur = i + 1 < this.frames.length
        ? Math.max(1 / 240, this.frames[i + 1].t - this.frames[i].t)
        : tail;
      lines.push(`file '${path.basename(this.frames[i].file)}'`, `duration ${dur.toFixed(4)}`);
    }
    // the concat demuxer ignores the final duration unless the last file repeats
    lines.push(`file '${path.basename(this.frames[this.frames.length - 1].file)}'`);
    fs.writeFileSync(list, lines.join('\n') + '\n');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await run('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `fps=${FPS},format=yuv420p,scale=1920:1080:flags=lanczos`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-r', String(FPS), out]);
    return out;
  }

  get duration() { return ((this.wallEnd || Date.now()) - this.wall0) / 1000; }
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let err = '';
    p.stdout.on('data', d => { err += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', c => (c === 0 ? resolve(err) : reject(new Error(`${cmd} exited ${c}\n${err}`))));
  });
}

// ---------------------------------------------------------------------------
// The cursor
// ---------------------------------------------------------------------------
const CURSOR_SVG = `<svg width="30" height="44" viewBox="0 0 30 44" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 2 L4 32 L11.5 25 L16.5 36.5 L21.5 34.2 L16.7 23 L26 22.5 Z"
        fill="#fff" stroke="#12181f" stroke-width="2.2" stroke-linejoin="round"/>
</svg>`;

export async function installCursor(page) {
  await page.evaluate(({ svg }) => {
    const old = document.getElementById('bfp-cam-cursor');
    if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'bfp-cam-cursor';
    wrap.innerHTML =
      '<div class="ring"></div><div class="arrow">' + svg + '</div>';
    const css = document.createElement('style');
    css.textContent = `
      #bfp-cam-cursor { position: fixed; left: 0; top: 0; width: 0; height: 0;
        z-index: 2147483647; pointer-events: none;
        transform: translate3d(-100px,-100px,0); }
      #bfp-cam-cursor .arrow { position:absolute; left:-3px; top:-2px;
        filter: drop-shadow(0 3px 6px rgba(0,0,0,.45)); }
      #bfp-cam-cursor .ring { position:absolute; left:-26px; top:-26px;
        width:52px; height:52px; border-radius:50%;
        border:3px solid rgba(255,255,255,.95);
        background: rgba(255,255,255,.16);
        opacity:0; transform: scale(.35); }
      #bfp-cam-cursor.click .ring { animation: bfpClick .42s ease-out 1; }
      @keyframes bfpClick {
        0%   { opacity:.95; transform: scale(.3); }
        70%  { opacity:.5;  transform: scale(1.05); }
        100% { opacity:0;   transform: scale(1.25); }
      }
      #bfp-cam-cursor.sel .ring { opacity:.55; transform: scale(.55); border-color: rgba(255,214,64,.95); }
    `;
    document.documentElement.appendChild(css);
    document.documentElement.appendChild(wrap);   // after #bfp-root => painted over it
    window.__cam = {
      el: wrap,
      x: -100, y: -100,
      to(x, y, ms) {
        wrap.style.transition = ms ? `transform ${ms}ms cubic-bezier(.33,.02,.2,1)` : 'none';
        wrap.style.transform = `translate3d(${x}px,${y}px,0)`;
        this.x = x; this.y = y;
      },
      flash() { wrap.classList.remove('click'); void wrap.offsetWidth; wrap.classList.add('click'); },
      sel(on) { wrap.classList.toggle('sel', !!on); },
      raise() { document.documentElement.appendChild(css); document.documentElement.appendChild(wrap); },
    };
  }, { svg: CURSOR_SVG });
}

/** Keep the sprite last in tree order — the drawer re-mounts its host on some paths. */
export const raiseCursor = page => page.evaluate(() => window.__cam && window.__cam.raise());

export async function moveTo(page, x, y, ms = 700) {
  await page.evaluate(({ x, y, ms }) => window.__cam.to(x, y, ms), { x, y, ms });
  await sleep(ms + 40);
}

/** Hover beat, then the ripple, then the real event — in that order, always. */
export async function clickAt(page, x, y, { travel = 700, hover = 520, after = 260 } = {}) {
  await moveTo(page, x, y, travel);
  await sleep(hover);
  await page.evaluate(() => window.__cam.flash());
  await sleep(150);
  return after;
}

/** Centre of an element inside the drawer's shadow root, in viewport pixels. */
export function shadowBox(page, selector) {
  return page.evaluate(sel => {
    const d = window.__bfp && window.__bfp.drawer;
    const el = d && d.shadow.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
             left: r.left, top: r.top, bottom: r.bottom, right: r.right };
  }, selector);
}

export function lightBox(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height,
             left: r.left, top: r.top, bottom: r.bottom, right: r.right };
  }, selector);
}

export async function waitShadow(page, selector, { timeout = 15000, gone = false } = {}) {
  const t0 = Date.now();
  for (;;) {
    const hit = await page.evaluate(sel => {
      const d = window.__bfp && window.__bfp.drawer;
      return !!(d && d.shadow.querySelector(sel));
    }, selector);
    if (hit !== gone) return true;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${gone ? 'absence of ' : ''}${selector}`);
    await sleep(60);
  }
}

/** Click an element in the shadow root, with the sprite driven to it first. */
export async function clickShadow(page, selector, opts = {}) {
  const box = await shadowBox(page, selector);
  if (!box) throw new Error(`no shadow element ${selector}`);
  const after = await clickAt(page, box.x, box.y, opts);
  await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(), selector);
  await sleep(after);
  return box;
}

/** Type into a shadow textarea one character at a time, the way a person does. */
export async function typeShadow(page, selector, text, { cps = 22, jitter = 0.45 } = {}) {
  const base = 1000 / cps;
  for (let i = 1; i <= text.length; i++) {
    await page.evaluate(({ sel, v }) => {
      const ta = window.__bfp.drawer.shadow.querySelector(sel);
      ta.focus();
      ta.value = v;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, { sel: selector, v: text.slice(0, i) });
    const ch = text[i - 1];
    let d = base * (1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * jitter);
    if (ch === ' ') d *= 1.15;
    if ('.,?!'.includes(ch)) d *= 3.2;
    await sleep(Math.round(d));
  }
}

/** Scroll the drawer's own scroller (not the page) to bring a node into view. */
export async function scrollShadowTo(page, selector, { block = 'center' } = {}) {
  await page.evaluate(({ sel, block }) => {
    const el = window.__bfp.drawer.shadow.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block });
  }, { sel: selector, block });
  await sleep(900);
}

/**
 * Scroll the PAGE the way a reader does: over a fixed span of time, eased, in
 * one motion.
 *
 * `scrollIntoView({behavior:'smooth'})` will not do for this. Chrome picks its
 * own duration — a few hundred milliseconds however far it has to go — so a
 * 2,600px journey down the article arrives as a blur and is over before a
 * viewer has registered that the page moved. The film's second beat is a
 * person reading their way to a paragraph, and that is a second and a half of
 * deliberate motion, so the duration is stated and the position is stepped
 * frame by frame with a cosine ease at both ends.
 */
export async function scrollPageOver(page, selector, { ms = 1600, block = 0.34 } = {}) {
  const target = await page.evaluate(({ sel, block }) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const y = window.scrollY + r.top - window.innerHeight * block;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return { from: window.scrollY, to: Math.max(0, Math.min(max, y)) };
  }, { sel: selector, block });
  if (!target) throw new Error(`no element ${selector} to scroll to`);
  const t0 = Date.now();
  for (;;) {
    const u = Math.min(1, (Date.now() - t0) / ms);
    const k = 0.5 - Math.cos(Math.PI * u) / 2;          // ease in and out
    await page.evaluate(y => window.scrollTo(0, y),
      target.from + (target.to - target.from) * k);
    if (u >= 1) break;
    await sleep(16);
  }
  return target;
}

export async function scrollPageTo(page, selector, { block = 'center' } = {}) {
  await page.evaluate(({ sel, block }) => {
    const el = document.querySelector(sel);
    if (el) el.scrollIntoView({ behavior: 'smooth', block });
  }, { sel: selector, block });
  await sleep(1000);
}
