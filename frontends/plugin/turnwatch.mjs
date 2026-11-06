// turnwatch.mjs — every version of a post the companion saw during a bot turn,
// and who most likely wrote each one.
//
// ownership.mjs needs the turn as a sequence of versions, not a before/after
// pair, because the reader may be typing in their editor while the bots work
// and their words must survive the backstop. This file supplies that sequence.
//
// WHO WROTE A VERSION. Bytes do not say. Three sources, in this order:
//
//   1. the companion's own journal — a write the companion makes for the
//      reader (an accepted suggestion card, a ✎ prose edit from the figure
//      editor, the backstop's own put-back) is recorded before it happens, by
//      the hash of the text it produces. A version with that hash is the
//      reader's, exactly.
//   2. the reader's editor being in front — on macOS the companion asks the
//      system which app is frontmost (`lsappinfo`, no permission needed) once a
//      second while a watch is running. A version that landed while a text
//      editor (Obsidian, VS Code, …) was frontmost within the last few seconds
//      is taken as the reader's. For Obsidian, if its vault's workspace says the
//      reader is looking at a DIFFERENT note, the version is the bots'.
//   3. otherwise, the bots'.
//
// The rule errs towards the reader: a bot write that lands while the reader is
// typing in the same post is kept as theirs (and is still visible as a change),
// never the other way round. Where no probe is available (not macOS, or
// PLUGIN_EDITOR_PROBE=none) every unjournalled version is the bots'; the
// put-back still turns it into a card, so nothing is lost — it is one Accept
// away.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex');

// ---- 1. the journal ---------------------------------------------------------
const journal = new Map();   // abs file → [{hash, at}]
const JOURNAL_MS = 60000;
/** The companion is about to write `text` into `file` on the reader's behalf. */
export function noteUserWrite(file, text) {
  const key = path.resolve(file);
  const now = Date.now();
  const list = (journal.get(key) || []).filter(e => now - e.at < JOURNAL_MS);
  list.push({ hash: hash(text), at: now });
  journal.set(key, list);
  // a watch already running sees it at once, rather than at the next poll
  for (const w of watches) if (w.file === key) w.check();
}
const journalled = (file, text) => (journal.get(file) || []).some(e => e.hash === hash(text));

// ---- 2. which app is in front -------------------------------------------------
export const EDITOR_APPS = ['Obsidian', 'Code', 'Visual Studio Code', 'Cursor', 'Zed', 'Sublime Text',
  'BBEdit', 'TextEdit', 'Typora', 'iA Writer', 'MacVim', 'Emacs', 'Nova', 'CotEditor', 'MarkText'];
const SAMPLE_MS = 1000;
const RECENT_MS = 6000;
const samples = [];   // {at, app, obsidianFile}
let sampler = null;
const probeMode = () => String(process.env.PLUGIN_EDITOR_PROBE || (process.platform === 'darwin' ? 'lsappinfo' : 'none'));

function frontApp() {
  return new Promise(resolve => {
    execFile('lsappinfo', ['front'], { timeout: 800 }, (e, asn) => {
      if (e || !String(asn).trim()) return resolve('');
      execFile('lsappinfo', ['info', '-only', 'name', String(asn).trim()], { timeout: 800 }, (e2, out) => {
        const m = /"LSDisplayName"="([^"]*)"/.exec(String(out || ''));
        resolve(e2 || !m ? '' : m[1]);
      });
    });
  });
}

// Obsidian's idea of the note in front: the vault's workspace.json `active`
// leaf. '' when it cannot be read — which counts as "maybe this post".
function obsidianActive(file) {
  try {
    let dir = path.dirname(file);
    for (let i = 0; i < 12 && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      const ws = path.join(dir, '.obsidian', 'workspace.json');
      if (!fs.existsSync(ws)) continue;
      const j = JSON.parse(fs.readFileSync(ws, 'utf8'));
      let hit = '';
      const walk = n => {
        if (!n || typeof n !== 'object' || hit) return;
        if (n.id === j.active && n.state && n.state.state && n.state.state.file) hit = n.state.state.file;
        for (const c of n.children || []) walk(c);
      };
      walk(j.main); walk(j.left); walk(j.right);
      return hit ? path.join(dir, hit) : '';
    }
  } catch { /* unreadable: maybe this post */ }
  return '';
}

function startSampler() {
  if (sampler || probeMode() !== 'lsappinfo') return;
  const tick = async () => {
    const app = await frontApp();
    const s = { at: Date.now(), app };
    samples.push(s);
    while (samples.length && Date.now() - samples[0].at > RECENT_MS * 2) samples.shift();
  };
  void tick();
  sampler = setInterval(() => { if (!watches.size) { clearInterval(sampler); sampler = null; return; } void tick(); }, SAMPLE_MS);
  sampler.unref?.();
}

/** 'user' | 'bot' for an unjournalled version of `file` seen at `at`. */
export function classify(file, at = Date.now()) {
  const mode = probeMode();
  if (mode === 'user') return 'user';
  if (mode !== 'lsappinfo') return 'bot';
  const recent = samples.filter(s => s.at <= at + SAMPLE_MS && at - s.at <= RECENT_MS && EDITOR_APPS.includes(s.app));
  if (!recent.length) return 'bot';
  if (recent.every(s => s.app === 'Obsidian')) {
    const active = obsidianActive(file);
    if (active && path.resolve(active) !== path.resolve(file)) return 'bot';
  }
  return 'user';
}

// ---- the watch itself ---------------------------------------------------------
const watches = new Set();
const POLL_MS = 400;

/**
 * Start watching `file`. Returns {stop(): steps, file, check()} where steps is
 * [{text, by, at}] — every version seen after the start, in order.
 */
export function watchFile(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  const key = path.resolve(file);
  const read = () => {
    try {
      const st = fs.statSync(key);
      if (!st.isFile() || st.size > maxBytes) return null;
      return fs.readFileSync(key, 'utf8');
    } catch { return null; }
  };
  let last = read();
  const steps = [];
  const w = {
    file: key,
    base: last,
    check() {
      const now = read();
      if (now == null || now === last) return;
      last = now;
      steps.push({ text: now, at: Date.now(), by: journalled(key, now) ? 'user' : classify(key) });
    },
    stop() {
      w.check();
      watches.delete(w);
      clearInterval(timer);
      try { fsw && fsw.close(); } catch { /* gone */ }
      return steps.slice();
    },
  };
  let fsw = null;
  try {
    fsw = fs.watch(path.dirname(key), (ev, name) => { if (!name || name === path.basename(key)) w.check(); });
    fsw.on('error', () => {});
  } catch { fsw = null; }
  const timer = setInterval(() => w.check(), POLL_MS);
  timer.unref?.();
  watches.add(w);
  startSampler();
  return w;
}
