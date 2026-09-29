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
  const roots = new Map();   // root → {timer, running, again, cmd, waiters, next}

  function start(root) {
    const st = roots.get(root);
    if (!st) return;
    st.timer = null;
    st.running = true;
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
    const finish = res => {
      const out = { ...res, ms: Date.now() - t0, tail: tail.slice(), cmd, root };
      log(`${tag} ${out.ok ? 'done' : 'FAILED'} in ${(out.ms / 1000).toFixed(1)}s${out.ok ? '' : ` (${out.signal || `exit ${out.code}`})`}`);
      st.running = false;
      for (const w of waiters) { try { w(out); } catch { /* a waiter's fault is its own */ } }
      if (st.again) { st.again = false; start(root); return; }
      if (!st.waiters.length && !st.timer) roots.delete(root);
    };
    try {
      child = spawn(shell, ['-c', cmd], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (e) {
      finish({ ok: false, code: null, signal: null, error: String(e.message || e) });
      return;
    }
    const kill = setTimeout(() => { try { child.kill('SIGTERM'); } catch { } }, timeoutMs);
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    let done = false;
    child.on('error', e => {
      if (done) return; done = true; clearTimeout(kill);
      feed(String(e.message || e));
      finish({ ok: false, code: null, signal: null, error: String(e.message || e) });
    });
    child.on('close', (code, signal) => {
      if (done) return; done = true; clearTimeout(kill);
      finish({ ok: code === 0, code, signal });
    });
  }

  function schedule(site, waiter) {
    const root = site && site.root;
    const cmd = site && site.rebuild;
    if (!root || !cmd) return false;
    let st = roots.get(root);
    if (!st) { st = { timer: null, running: false, again: false, cmd, waiters: [] }; roots.set(root, st); }
    st.cmd = cmd;
    if (typeof waiter === 'function') st.waiters.push(waiter);
    if (st.running) { st.again = true; return true; }
    if (st.timer) clearTimeout(st.timer);
    st.timer = setTimeout(() => start(root), delayMs);
    return true;
  }

  const busy = root => { const st = roots.get(root); return !!(st && (st.running || st.timer)); };
  return { schedule, busy };
}
