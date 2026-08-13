// The shoot.
//
// ONE unbroken pass over the REAL extension drawer running in the harness
// (which loads extension/drawer.js, content.js, anchor.js and adapters.js off
// disk — nothing here re-implements any of it), plus one still-life of the
// exported note. Every click is a real click on a real control; every state on
// screen is a state the drawer put there.
//
// The whole story is one take on purpose. The film is about a single thread
// living its whole life — highlighted, asked, answered, handed to the other
// agent, run, plotted, filed, summarised, greened — and a take per beat would
// let a viewer suspect the state was reset between them. The cuts are made
// later, in edit.json, out of this one continuous recording.
//
// v5 shoots for PHONES. The note back on the v4 cut was that on a phone the
// text could not be read, so the take is performed at 1280×720 CSS under
// deviceScaleFactor 1.5: the frame is still 1920×1080, but every pixel of UI
// in it is 1.5× the size it was. The cursor is driven in CSS px; the marks are
// scaled up to frame px on the way into shots.json (rig.mjs coordScale), so
// the edit's coordinate system does not change. And the take is performed at
// the FILM's pace this time — typing at reading speed, real holds on every
// payoff — because v5 is a ~95s film and its calm has to be lived in front of
// the camera, not simulated by cutting less.
//
//   node capture/capture.mjs             the thread take (+ note, + braid)
//   node capture/capture.mjs thread      just the long take
//
// Writes footage/<id>.mp4 and footage/shots.json (the action timestamps, so
// edit.json's label cues and camera moves are aimed at measured instants
// rather than at guesses).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { FOCUS_QUOTE, GREEN_QUOTE } from './page.mjs';
import {
  Recorder, installCursor, raiseCursor, moveTo, clickAt, clickShadow, shadowBox,
  lightBox, waitShadow, typeShadow, scrollShadowTo, scrollPageTo, scrollPageOver,
  sleep, FPS,
} from './rig.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FOOTAGE = path.join(ROOT, 'footage');
const TMP = path.join(HERE, '.tmp');

const plotDataUrl = 'data:image/png;base64,' +
  fs.readFileSync(path.join(HERE, 'fixtures/figure-01.png')).toString('base64');

// The harness ships its own developer toolbar across the top. It is a test
// instrument, not part of the product, so the camera does not see it. Everything
// else about the page's appearance is the site's own and is set up in
// capture/page.mjs; this is only the toolbar.
const HIDE_HARNESS_CHROME = `
  .bar { display: none !important; }
`;

// The shoot's geometry. CSS viewport × deviceScaleFactor = the 1920×1080 frame;
// DSF is what buys the phone legibility (see the header note).
const VIEW = { w: 1280, h: 720 };
const DSF = 1.5;

// ~1.4× the v1 rate — v4's 58cps was the thing viewers called "too fast".
// A sixty-character question at 30cps is about 2.5 seconds of typing, which is
// the speed a viewer reads it at. Still per-character, still jittered, still
// the drawer's own input events.
const TYPE = { cps: 30, jitter: 0.4 };

async function open(ctx, base, query) {
  const page = await ctx.newPage();
  await page.goto(`${base}/test/harness.html?${query}`, { waitUntil: 'load' });
  await page.addStyleTag({ content: HIDE_HARNESS_CHROME });
  await page.waitForFunction(() => window.__bfp && window.__bfp.drawer, null, { timeout: 20000 });
  await sleep(1400);                       // let restored highlights paint
  await installCursor(page);
  return page;
}

const shots = {};

async function take(ctx, base, id, query, body) {
  const page = await open(ctx, base, query);
  const rec = new Recorder(page, path.join(TMP, id), { coordScale: DSF });
  await rec.start();
  const notes = await body(page, rec) || {};
  await rec.stop();
  const out = path.join(FOOTAGE, `${id}.mp4`);
  await rec.encode(out);
  shots[id] = {
    clip: `footage/${id}.mp4`,
    seconds: Number(rec.duration.toFixed(3)),
    frames: Math.round(rec.duration * FPS),
    sourceFrames: rec.frames.length,
    harnessUrl: `test/harness.html?${query}`,
    marks: rec.marks.map(m => ({ ...m, frame: Math.round(m.t * FPS) })),
    ...notes,
  };
  console.log(`  ${id}: ${rec.duration.toFixed(2)}s (${rec.frames.length} source frames) -> ${out}`);
  await page.close();
  writeShots();          // after every take, so a later take failing costs one take
}

function writeShots() {
  fs.writeFileSync(path.join(FOOTAGE, 'shots.json'),
    JSON.stringify({ fps: FPS, width: 1920, height: 1080, shot: new Date().toISOString(), shots }, null, 2));
}

/** The per-agent working rings the drawer paints while a turn is in flight. */
const dialUp = page => page.waitForFunction(() => {
  const s = window.__bfp.drawer.shadow;
  return !!s.querySelector('.status-chip .avatar-ring.working, .status-chip .spin');
}, null, { timeout: 20000 });

// ===========================================================================
// The take — one thread, from nothing to filed
// ===========================================================================
async function thread(page, rec) {
  const PHRASE_START = 'For example, one of von';
  const PHRASE_END = 'Earth-like gravity at 5 rpm';
  if (!FOCUS_QUOTE.startsWith(PHRASE_START) || !FOCUS_QUOTE.endsWith(PHRASE_END)) {
    throw new Error('the drag no longer spans FOCUS_QUOTE — capture/page.mjs changed');
  }

  // ---- 0. the page, and the reader getting to the paragraph ---------------
  // The film opens at the top of the post, on the title and the byline, and
  // scrolls down to the passage. Nothing in the product happens in this beat and
  // it is still worth a second and a half: it is the only part of the film that
  // says WHERE this is happening. A drawer that opens on a paragraph nobody
  // watched arrive could be a screenshot of anything.
  await page.evaluate(() => window.scrollTo(0, 0));
  await moveTo(page, 720, 470, 0);
  await sleep(1900);
  rec.mark('entry');

  await scrollPageOver(page, 'content h2#the-difficulty-of-building-large-stations',
    { ms: 2200, block: 0.10 });
  rec.mark('scrolled');
  await sleep(1100);                                       // the reader arrives

  // ---- 1. the drag --------------------------------------------------------
  // where the sentence sits, so the sprite can be dragged across it for real
  const span = await page.evaluate(({ a, b }) => {
    const p = [...document.querySelectorAll('article p')].find(el => el.textContent.includes(a));
    const t = [...p.childNodes].find(n => n.nodeType === 3 && n.data.includes(a));
    const from = t.data.indexOf(a);
    const to = t.data.indexOf(b) + b.length;
    const r = document.createRange();
    r.setStart(t, from); r.setEnd(t, from + 1);
    const s = r.getBoundingClientRect();
    r.setStart(t, to - 1); r.setEnd(t, to);
    const e = r.getBoundingClientRect();
    window.__drag = { from, to, path: [t] };
    return { sx: s.left, sy: s.top + s.height * 0.72, ex: e.right, ey: e.top + e.height * 0.72 };
  }, { a: PHRASE_START, b: PHRASE_END });

  await moveTo(page, span.sx - 6, span.sy, 900);
  await sleep(380);
  rec.mark('drag-start');

  // the drag: sprite and Range advance together. Slower than v4 — the whole
  // proposition is that a sentence is a thing you can grab, so the grabbing
  // gets long enough to watch.
  await page.evaluate(() => window.__cam.sel(true));
  const STEPS = 26;
  for (let i = 1; i <= STEPS; i++) {
    const k = i / STEPS;
    await page.evaluate(({ k }) => {
      const { from, to, path } = window.__drag;
      const t = path[0];
      const end = Math.round(from + (to - from) * k);
      const r = document.createRange();
      r.setStart(t, from); r.setEnd(t, Math.max(from + 1, end));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      const box = r.getBoundingClientRect();
      window.__cam.to(box.right, box.bottom - 5, 0);
    }, { k });
    await sleep(60);
  }
  await page.evaluate(() => window.__cam.sel(false));
  await sleep(340);
  await page.evaluate(() => document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })));
  // the mark carries the box the sentence occupies, so the label that names
  // this action can be placed against it instead of at the top of the screen
  const selBox = await page.evaluate(() => {
    const r = getSelection().getRangeAt(0).getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
  rec.mark('selection-made', selBox);
  await waitShadow(page, '.selbtn');
  await sleep(700);

  // ---- 2. the floating pill ----------------------------------------------
  const pill = await shadowBox(page, '.selbtn');
  await clickAt(page, pill.x, pill.y, { travel: 420, hover: 420 });
  await page.evaluate(() => window.__bfp.drawer.shadow.querySelector('.selbtn').click());
  rec.mark('pill-clicked');
  await waitShadow(page, '.card.pending textarea');
  await sleep(1300);                                       // drawer slides in
  await raiseCursor(page);
  rec.mark('drawer-open');
  await sleep(500);                       // a beat on the arrived drawer

  // ---- 3. the question ----------------------------------------------------
  const composer = await shadowBox(page, '.card.pending textarea');
  await clickAt(page, composer.x, composer.y, { travel: 520, hover: 300 });
  await sleep(220);
  rec.mark('typing');
  // The question is the one this passage actually raises. The post states a
  // wheel, a diameter and two spin rates; artificial gravity is w^2 r; the
  // arithmetic is one line and the answer turns out to be interesting.
  await typeShadow(page, '.card.pending textarea',
    '@claude 3 rpm on a 75 m wheel — is that really lunar gravity?', TYPE);
  await sleep(600);

  // The thread ids already on the page. Without this the wait below matches a
  // reply that was ALREADY in another thread and the take runs on before the
  // new answer has said a word.
  const known = await page.evaluate(() =>
    [...window.__bfp.drawer.shadow.querySelectorAll('.card[data-thread]')]
      .map(c => c.getAttribute('data-thread')));

  const send = await shadowBox(page, '.card.pending [data-act="send"]');
  await clickAt(page, send.x, send.y, { travel: 460, hover: 420 });
  await page.evaluate(() => window.__bfp.drawer.shadow.querySelector('.card.pending [data-act="send"]').click());
  rec.mark('sent');

  const focus = await page.waitForFunction(seen => {
    const c = [...window.__bfp.drawer.shadow.querySelectorAll('.card[data-thread]')]
      .find(x => !seen.includes(x.getAttribute('data-thread')));
    return c ? c.getAttribute('data-thread') : null;
  }, known, { timeout: 20000 }).then(h => h.jsonValue());
  const card = `.card[data-thread="${focus}"]`;

  // ---- 4. claude thinks, then answers ------------------------------------
  // The dial is waited for BEFORE the hand moves, not after: the working chip
  // exists for as long as the turn takes to say its first word, and a camera
  // still travelling when it appears spends the whole of it in transit. This
  // ordering is what puts a settled shot on the dial rather than a glimpse.
  await dialUp(page);
  rec.mark('claude-thinking');
  await moveTo(page, 773, 627, 420);
  await waitShadow(page, `${card} .reply.bot.claude`, { timeout: 25000 });
  rec.mark('claude-streaming');
  await sleep(2600);
  await scrollShadowTo(page, `${card} .reply.bot.claude`, { block: 'end' });
  rec.mark('claude-landed');
  await sleep(3400);                        // long enough to read the bullets

  // ---- 4b. Claude's own handoff -------------------------------------------
  // The reply ends with the room-protocol footer {"status","summary","next"}
  // naming @codex, and the drawer lifts it out of the prose and draws it as
  // its own chip — "answered · 3 rpm is Mars, not the Moon · over to @codex"
  // (drawer.js envRow / ENV_NEXT). This is the one way the shipped UI shows a
  // bot handing a thread to the other bot, and the camera lands on it.
  await waitShadow(page, `${card} .envrow .env-next`, { timeout: 15000 });
  await scrollShadowTo(page, `${card} .envrow`, { block: 'center' });
  const chip = await shadowBox(page, `${card} .envrow .env`);
  rec.mark('handoff-chip', chip);
  await sleep(2400);

  // ---- 5. the reader ratifies the handoff ---------------------------------
  // The summon itself stays with the reader: bridge-system-prompt.md rule 6
  // forbids a bot @-tagging its counterpart TO SUMMON it, and the companion
  // only ever summons on a message a PERSON posted (server.mjs `summon`). So
  // Claude proposed the route in its footer, and the reader is the one who
  // routes — which is also the only version of this that is true.
  const reply = `${card} .composer textarea`;
  await scrollShadowTo(page, reply, { block: 'center' });
  const rbox = await shadowBox(page, reply);
  await clickAt(page, rbox.x, rbox.y, { travel: 560, hover: 300 });
  await sleep(200);
  rec.mark('typing-2');
  await typeShadow(page, reply,
    '@codex plot gravity vs radius at 2, 3 and 5 rpm?', TYPE);
  await sleep(500);
  const send2 = await shadowBox(page, `${card} [data-act="send"]`);
  await clickAt(page, send2.x, send2.y, { travel: 340, hover: 400 });
  await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(),
    `${card} [data-act="send"]`);
  rec.mark('sent-2');

  await dialUp(page);
  rec.mark('codex-thinking');
  await moveTo(page, 773, 633, 420);
  await waitShadow(page, `${card} .reply.bot.codex`, { timeout: 25000 });
  rec.mark('codex-streaming');
  await waitShadow(page, `${card} [data-act="run"]`, { timeout: 25000 });
  await sleep(1100);

  // Four drawn units (person, bot, person, bot) is one past the drawer's fold
  // threshold, so codex's answer landing folds claude's away behind "Show 1
  // earlier reply" — in a film whose whole subject is ONE continuous thread,
  // that line reads as the drawer hiding the beat we just watched. The reader
  // opens it back up, with the drawer's own control, and it stays open (a
  // manual fold outranks the rule in both directions, drawer.js FOLD_OPEN).
  const more = await shadowBox(page, `${card} [data-act="expand"]`);
  if (more) {
    await clickAt(page, more.x, more.y, { travel: 420, hover: 360 });
    await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(),
      `${card} [data-act="expand"]`);
    rec.mark('unfolded');
    await sleep(800);
  }

  await scrollShadowTo(page, `${card} [data-act="run"]`, { block: 'center' });
  await sleep(900);
  rec.mark('codex-landed');

  // ---- 6. run it ----------------------------------------------------------
  const run = await shadowBox(page, `${card} [data-act="run"]`);
  rec.mark('run-approach', run);
  await clickAt(page, run.x, run.y, { travel: 800, hover: 700 });
  await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(),
    `${card} [data-act="run"]`);
  rec.mark('run-clicked', run);

  // The status line prints directly under the button the cursor is sitting on,
  // so the hand has to come off it before the result arrives — otherwise the
  // sprite covers "✓ ran · 214 ms", which is half of what the shot is for.
  await moveTo(page, run.x - 160, run.y + 173, 380);
  await waitShadow(page, '.runstat');
  rec.mark('runstat');
  await sleep(1100);
  await waitShadow(page, '.runfigs img');
  rec.mark('figure-in');
  await sleep(1500);
  await scrollShadowTo(page, '.runstat', { block: 'center' });
  await sleep(1100);

  // full size, because a thumbnail in a 460px drawer is not a plot anybody reads
  const thumbSel = '.runfigs img';
  const thumb = await shadowBox(page, thumbSel);
  if (thumb) {
    await clickAt(page, thumb.x, thumb.y, { travel: 620, hover: 520 });
    await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(), thumbSel);
    // the lightbox scrim is painted by the drawer host; without re-raising, the
    // sprite ends up UNDER it and reads as a dimmed smudge
    await raiseCursor(page);
    rec.mark('lightbox');
    await sleep(500);
    await moveTo(page, 1080, 640, 640);
    await sleep(3600);
    await page.keyboard.press('Escape');
    rec.mark('lightbox-closed');
    await sleep(1400);
  }

  // ---- 7. file it ---------------------------------------------------------
  await scrollShadowTo(page, `${card} [data-act="resolve"]`, { block: 'center' });
  await sleep(400);
  const tick = await shadowBox(page, `${card} [data-act="resolve"]`);
  await clickAt(page, tick.x, tick.y, { travel: 700, hover: 620 });
  await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(),
    `${card} [data-act="resolve"]`);
  rec.mark('resolved', tick);
  await moveTo(page, 787, 640, 420);
  await waitShadow(page, '.resolved-sec');
  const filedCount = await page.evaluate(() =>
    window.__bfp.drawer.shadow.querySelector('.resolved-head .rcount').textContent.trim());
  rec.mark('filed');
  await sleep(1500);

  // ---- 8. the archive, and the written summary ---------------------------
  await scrollShadowTo(page, '.resolved-sec', { block: 'end' });
  await sleep(420);
  await clickShadow(page, '[data-act="resolved-toggle"]', { travel: 560, hover: 500 });
  await waitShadow(page, '.resolved-list');
  const filedCard = `.resolved-list .card.resolved[data-thread="${focus}"]`;
  await scrollShadowTo(page, filedCard, { block: 'center' });
  rec.mark('archive-open');
  await sleep(1200);

  // ask the agents for the written paragraph — it lands over the placeholder.
  // (The shipped companion queues this by itself on every resolve, server.mjs
  // summarizeThread; the harness only writes it when asked, so the film presses
  // the button the drawer offers for exactly that.)
  const sum = await shadowBox(page, `${filedCard} [data-act="summarize"]`);
  if (sum) {
    await clickAt(page, sum.x, sum.y, { travel: 500, hover: 460 });
    await page.evaluate(sel => window.__bfp.drawer.shadow.querySelector(sel).click(),
      `${filedCard} [data-act="summarize"]`);
    rec.mark('summarize');
    // The hand leaves BEFORE the paragraph arrives, not after. The digest lands
    // exactly where the button was, so a cursor that waits there is a cursor
    // sitting on top of the six lines this scene exists to let you read.
    await moveTo(page, 810, 657, 480);
    await page.waitForFunction(sel => {
      const p = window.__bfp.drawer.shadow.querySelector(sel + ' .digest');
      return !!(p && p.textContent.length > 240);
    }, filedCard, { timeout: 15000 });
    rec.mark('summary-landed');
    await sleep(3600);
  }

  // ---- 9. two green highlights in the page -------------------------------
  // Both threads live in the same paragraph — the pre-existing one two
  // sentences above the one the film made — so a single framing holds the pair,
  // and "green means settled" is shown rather than asserted.
  const green = await page.evaluate(() => document.querySelectorAll('mark.bfp-hl.bfp-done').length);
  await scrollPageTo(page, 'mark.bfp-hl.bfp-done', { block: 'center' });
  await sleep(600);
  await moveTo(page, 739, 672, 700);              // off the column, off the caption
  const greenBox = await page.evaluate(() => {
    const ms = [...document.querySelectorAll('mark.bfp-hl.bfp-done')];
    const rs = ms.map(m => m.getBoundingClientRect());
    return {
      left: Math.min(...rs.map(r => r.left)), top: Math.min(...rs.map(r => r.top)),
      right: Math.max(...rs.map(r => r.right)), bottom: Math.max(...rs.map(r => r.bottom)),
    };
  });
  rec.mark('green-visible', greenBox);
  await sleep(4200);

  return { newThread: focus, filedCount, greenMarks: green, quote: FOCUS_QUOTE };
}

// ===========================================================================
// The exported note — a still life, not an application
// ===========================================================================
// capture/note.mjs runs the plugin's own export.mjs over the record this take
// leaves behind and writes footage/note.html: the exporter's own markdown, set
// inside a recreation of Obsidian's dark reading view. The frame is the point of
// the beat — the claim is not "here is a document", it is "this ends up in your
// vault", and a vault is a place. The v2 cut dropped the frame and the one thing
// the user missed from v1 was exactly this.
//
// The note is taller than the frame. A pan down it is a whoosh nobody can read,
// so the beat is two held framings with a hard cut between them — the film's own
// rule, applied to a document: the head (the tab, the tree, the properties, the
// title, the passage and "Resolved by angadh") and the foot (the code cell and
// the plot, with the copied figure visible in attachments/ in the sidebar).
//
// Each framing DRIFTS rather than freezing. A held still of a document is dead
// air — ffmpeg's freezedetect says so and a viewer reads it as a stalled video —
// and the usual fix, a slow camera push, cannot be used here: any scale above
// 1.0 crops the frame, and the frame is the ribbon and the file tree, which is
// the half of this beat that is doing the work. So the motion is the note's own
// scroll, 130px over two and a half seconds. Obsidian scrolls; the window does
// not move.
const DRIFT = 150;

async function scrollElOver(page, from, to, ms) {
  const t0 = Date.now();
  for (;;) {
    const u = Math.min(1, (Date.now() - t0) / ms);
    const k = 0.5 - Math.cos(Math.PI * u) / 2;
    await page.evaluate(y => document.getElementById('scroller').scrollTo({ top: y, behavior: 'instant' }),
      from + (to - from) * k);
    if (u >= 1) break;
    await sleep(16);
  }
}

async function note(page, rec) {
  const travel = await page.evaluate(() => {
    const s = document.getElementById('scroller');
    return s.scrollHeight - s.clientHeight;
  });
  await sleep(1000);
  rec.mark('head');
  await sleep(900);
  await scrollElOver(page, 0, DRIFT, 4600);
  await sleep(600);
  // the hard cut down the document: the foot is set up one drift above the end
  await page.evaluate(y => document.getElementById('scroller').scrollTo({ top: y, behavior: 'instant' }),
    travel - DRIFT);
  await sleep(300);
  rec.mark('foot');
  await sleep(900);
  await scrollElOver(page, travel - DRIFT, travel, 4600);
  await sleep(900);
  return { travel, drift: DRIFT };
}

// ===========================================================================
async function main() {
  const only = process.argv.slice(2);
  const want = id => !only.length || only.includes(id);
  fs.mkdirSync(FOOTAGE, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const { server, base } = await startServer({ plotDataUrl });
  const browser = await chromium.launch({
    headless: true,
    args: ['--force-color-profile=srgb', '--font-render-hinting=none',
           '--disable-lcd-text', '--hide-scrollbars=false'],
  });
  // 1280×720 CSS × 1.5 device scale = 1920×1080 frames with 1.5× larger UI —
  // the phone-legibility fix (see the header note). The braid is NOT shot in
  // this context's geometry: it was filmed at 1:1 for v4 and is reused as-is,
  // so `npm run capture -- thread note` is the usual v5 re-shoot.
  const ctx = await browser.newContext({
    viewport: { width: VIEW.w, height: VIEW.h }, deviceScaleFactor: DSF,
    reducedMotion: 'no-preference',
  });

  if (fs.existsSync(path.join(FOOTAGE, 'shots.json'))) {
    Object.assign(shots, JSON.parse(fs.readFileSync(path.join(FOOTAGE, 'shots.json'), 'utf8')).shots || {});
  }

  console.log('shooting…');
  if (want('thread')) await take(ctx, base, 'thread', 'closed=1', thread);

  // The braid, filmed off the site's own markup. One 14s clip: the write-in,
  // the fuse, and enough ambient that the close can enter it late.
  if (want('braid')) {
    const bp = await ctx.newPage();
    await bp.goto(`file://${path.join(FOOTAGE, 'braid.html')}`, { waitUntil: 'load' });
    const rec = new Recorder(bp, path.join(TMP, 'braid'));
    await rec.start();
    // restart every CSS animation so frame 0 of the take is frame 0 of the draw
    await bp.evaluate(() => {
      for (const an of document.getAnimations()) { an.cancel(); an.play(); }
    });
    rec.mark('draw-start');
    await sleep(2500); rec.mark('sweeps-done');
    await sleep(1400); rec.mark('fuse');
    await sleep(10500);
    await rec.stop();
    await rec.encode(path.join(FOOTAGE, 'braid.mp4'));
    shots.braid = {
      clip: 'footage/braid.mp4',
      seconds: Number(rec.duration.toFixed(3)),
      frames: Math.round(rec.duration * FPS),
      sourceFrames: rec.frames.length,
      harnessUrl: 'footage/braid.html (svg + css lifted from site/index.html)',
      marks: rec.marks.map(m => ({ ...m, frame: Math.round(m.t * FPS) })),
    };
    console.log(`  braid: ${rec.duration.toFixed(2)}s (${rec.frames.length} source frames)`);
    await bp.close();
    writeShots();
  }

  if (want('note')) {
    const np = await ctx.newPage();
    await np.goto(`file://${path.join(FOOTAGE, 'note.html')}`, { waitUntil: 'load' });
    await sleep(900);
    const rec = new Recorder(np, path.join(TMP, 'note'), { coordScale: DSF });
    await rec.start();
    await note(np, rec);
    await rec.stop();
    await rec.encode(path.join(FOOTAGE, 'note.mp4'));
    shots.note = {
      clip: 'footage/note.mp4',
      seconds: Number(rec.duration.toFixed(3)),
      frames: Math.round(rec.duration * FPS),
      sourceFrames: rec.frames.length,
      harnessUrl: 'footage/note.html (frontends/plugin/export.mjs renderNote() output, typeset)',
      marks: rec.marks.map(m => ({ ...m, frame: Math.round(m.t * FPS) })),
    };
    console.log(`  note: ${rec.duration.toFixed(2)}s`);
    await np.close();
    writeShots();
  }

  writeShots();
  await browser.close();
  server.close();
  console.log('done -> footage/shots.json');
}

main().catch(e => { console.error(e); process.exit(1); });
