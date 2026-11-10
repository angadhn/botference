// rebuild.mjs — running the owner's own build command after a source changed.
//
// `jekyll serve` rebuilds a site by itself on every save, which is why the
// blog-source mechanism never waits for a builder: the tab is told the source
// moved and the site catches up underneath it. jupyter-book does not. It
// builds once and exits, so a book whose notebook has just had a card accepted
// into it would go on serving the old page until somebody ran the build.
//
// So a Jupyter Book's `blog_sites` row may carry the command the owner would
// type (`"rebuild": "jupyter-book build ."`), and this module runs it in the
// book's root when the census says a source moved. The rules, all of them:
//
//   · OPTIONAL. No `rebuild` on the row, nothing runs, and the drawer and the
//     envelope both say the reader rebuilds by hand.
//   · THE OWNER'S COMMAND, NEVER A BOT'S. It comes off the config row and
//     nowhere else — no request body, no reply, no card can name one — and
//     blog.rebuildOf has already refused anything that mentions git or gh.
//   · DEBOUNCED, ONE AT A TIME, PER ROOT. An accept-all of ten cards is one
//     build. A change that lands while a build runs queues exactly one more,
//     which starts when this one ends, because the build in flight may have
//     read the file before the change reached it.
//   · NEVER BLOCKS A REPLY. It is a detached child; the caller hears back
//     through `onDone` and does whatever it does then (server.mjs broadcasts
//     the reload the tab has been waiting for).
//   · ITS OUTPUT GOES TO THE COMPANION LOG (the companion's stdout — which is
//     .botference/logs/plugin-autostart.log when it runs in the background),
//     line-prefixed, and the last few lines ride the result so a failure can
//     be named in the drawer.
//
// It is the only place in the blog mechanism that starts a process, and it is
// kept out of blog.mjs on purpose: that file's promise is that every function
// in it reads.
import { spawn } from 'node:child_process';

export const REBUILD_DEBOUNCE_MS = 1500;
// a book with `execute_notebooks: force` re-runs every notebook on every
// build; long, but not forever
export const REBUILD_TIMEOUT_MS = 30 * 60 * 1000;
const TAIL_LINES = 12;

// THE MODES OF ONE ROOT, named, in one field, moved only by setMode:
//   idle                nothing asked for (the root has no record at all)
//   waiting             asked for; the debounce is running
//   building            the command is running
//   building-run-again  running, and a change landed meanwhile: one more
//                       build starts when this one ends
// The time limit ends `building` itself. It used to rely on the child's
// `close`, which never comes while anything the command started still holds
// its output open — so a build killed at the limit stayed "running" for ever
// and every later rebuild of that root waited behind it.
export const REBUILD_MODES = Object.freeze(['idle', 'waiting', 'building', 'building-run-again']);
const MOVES = Object.freeze({
  idle: ['waiting'],
  waiting: ['waiting', 'building'],
  building: ['building-run-again', 'idle'],
  'building-run-again': ['building-run-again', 'building'],
});
// how long a build killed at its time limit gets to go quietly before the
// whole process group is killed outright
const KILL_GRACE_MS = 5000;

/**
 * A scheduler. `schedule(site, waiter)` asks for a build of `site.root` with
 * `site.rebuild`; `waiter` (optional) is called with the result of the build
 * that covers this request: `{ok, code, signal, ms, tail, cmd, root}`.
 */
export function createRebuilder({
  log = line => console.log(line),
  delayMs = REBUILD_DEBOUNCE_MS,
  timeoutMs = REBUILD_TIMEOUT_MS,
  // /bin/sh with the companion's own PATH — which, started from a launch agent,
  // may not be the reader's interactive one. The README says to name the
  // builder by its absolute path for exactly that reason.
  shell = '/bin/sh',
} = {}) {
  const roots = new Map();   // root → {mode, timer, cmd, waiters}; absent = idle
  const modeOf = root => (roots.get(root) || { mode: 'idle' }).mode;

  // The one way a root's mode changes. An illegal move is a bug here, never
  // a reader's doing, so it throws rather than carrying on in a mode nobody
  // can name.
  function setMode(root, next) {
    if (!REBUILD_MODES.includes(next)) throw new Error(`rebuild: unknown mode ${next}`);
    const from = modeOf(root);
    if (!MOVES[from].includes(next)) throw new Error(`rebuild: ${root}: ${from} → ${next} is not a move`);
    if (next === 'idle') { roots.delete(root); return; }
    let st = roots.get(root);
    if (!st) { st = { mode: next, timer: null, cmd: '', waiters: [] }; roots.set(root, st); }
    st.mode = next;
  }

  // A process group, so the time limit reaches whatever the command started
  // (a shell's children are what hold the pipes open), with the child itself
  // as the fallback where there is no group to signal.
  const killTree = (child, sig) => {
    try { process.kill(-child.pid, sig); return; } catch { /* no group */ }
    try { child.kill(sig); } catch { /* gone */ }
  };

  function start(root) {
    const st = roots.get(root);
    if (!st) return;
    st.timer = null;
    setMode(root, 'building');
    const waiters = st.waiters;
    st.waiters = [];
    const cmd = st.cmd;
    const t0 = Date.now();
    const tail = [];
    const tag = `[rebuild ${root}]`;
    log(`${tag} $ ${cmd}`);
    let child;
    const feed = buf => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue;
        log(`${tag} ${line}`);
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
      }
    };
    // Once per build: whichever of close, error or the time limit comes first
    // ends it, and the others find it ended.
    let ended = false;
    let limit = null;
    const finish = res => {
      if (ended) return;
      ended = true;
      clearTimeout(limit);
      const out = { ...res, ms: Date.now() - t0, tail: tail.slice(), cmd, root };
      log(`${tag} ${out.ok ? 'done' : 'FAILED'} in ${(out.ms / 1000).toFixed(1)}s${out.ok ? '' : ` (${out.error || out.signal || `exit ${out.code}`})`}`);
      for (const w of waiters) { try { w(out); } catch { /* a waiter's fault is its own */ } }
      if (modeOf(root) === 'building-run-again') { start(root); return; }
      setMode(root, 'idle');
    };
    try {
      child = spawn(shell, ['-c', cmd], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
        detached: process.platform !== 'win32' });
    } catch (e) {
      finish({ ok: false, code: null, signal: null, error: String(e.message || e) });
      return;
    }
    limit = setTimeout(() => {
      killTree(child, 'SIGTERM');
      const hard = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS);
      hard.unref?.();
      // nothing more from this build is waited for: its output stops here
      try { child.stdout.destroy(); child.stderr.destroy(); } catch { /* gone */ }
      finish({ ok: false, code: null, signal: 'SIGTERM',
        error: `stopped after ${Math.round(timeoutMs / 1000)}s, the time limit` });
    }, timeoutMs);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', e => {
      feed(String(e.message || e));
      finish({ ok: false, code: null, signal: null, error: String(e.message || e) });
    });
    child.on('close', (code, signal) => finish({ ok: code === 0, code, signal }));
  }

  function schedule(site, waiter) {
    const root = site && site.root;
    const cmd = site && site.rebuild;
    if (!root || !cmd) return false;
    const mode = modeOf(root);
    if (mode === 'building' || mode === 'building-run-again') {
      setMode(root, 'building-run-again');
    } else {
      setMode(root, 'waiting');
    }
    const st = roots.get(root);
    st.cmd = cmd;
    if (typeof waiter === 'function') st.waiters.push(waiter);
    if (st.mode === 'waiting') {
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => start(root), delayMs);
    }
    return true;
  }

  const busy = root => modeOf(root) !== 'idle';
  return { schedule, busy, mode: modeOf };
}
