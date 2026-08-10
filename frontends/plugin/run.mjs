// Running a python code block out of a message, on this Mac, as this user.
//
// There is no sandbox here and none is claimed. A fenced ```python block in any
// message — one the reader wrote, one a bot wrote — gets a Run button in the
// drawer, and pressing it starts `python3` with the reader's own privileges.
// The safety story is entirely social: the button says what it does, the
// feature is owner-only, and config.json can switch it off. See SPEC.md.
//
// Two rules make this narrower than it sounds:
//
//   1. The code that runs is the code that is STORED. The request names a
//      message (url + thread + ts, resolved by store.resolveMsg) and a block
//      ordinal; the companion re-parses that message's own text and takes the
//      block out of it. A client cannot post code — only an address.
//   2. Every run gets a fresh directory of its own under
//      .botference/plugin/runs/<pageKey>/<runId>/, which is the child's cwd,
//      the only place its figures can land, and the unit that is deleted when
//      the run is replaced or the message goes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// 30 seconds is long enough for a plot and short enough that a runaway loop is
// an annoyance rather than an incident. PLUGIN_RUN_TIMEOUT_MS is for the tests
// (a two-second timeout costs two seconds to prove).
export const DEFAULT_TIMEOUT_MS = 30000;
export const timeoutMs = () => {
  const n = Number(process.env.PLUGIN_RUN_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
};
export const pythonBin = () => process.env.PLUGIN_PYTHON || 'python3';

// Each stream is cut at 64KB. The marker is honest about it — a truncated
// traceback that pretends to be whole is worse than no output at all.
export const OUT_MAX = 64 * 1024;
// A figure is a picture of some numbers, not a video: anything past this is a
// mistake, and a mistake should not be loaded into a 420px drawer.
export const FIGURE_MAX = 8 * 1024 * 1024;
export const FIGURES_MAX = 12;

// ---- finding the block ---------------------------------------------------
// The same line-anchored fence rule the drawer's markdown renderer uses
// (drawer.js FENCE), because the ordinal in the request is the ordinal the
// drawer counted. Both sides count EVERY fenced block, not only the python
// ones: the language is what decides whether a block may run, never how the
// blocks are numbered, so the two sides cannot drift apart over a language tag.
const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
export const isPython = lang => /^(python|python3|py)$/i.test(String(lang || '').trim());

// `open`/`close` are LINE numbers in the (newline-normalised) source: the
// export writes a run's output immediately after the block it came from, and
// re-finding the block by its text would be a second, weaker parser.
export function codeBlocks(text) {
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (!open) continue;
    const closeRe = open[1][0] === '`' ? /^\s{0,3}```/ : /^\s{0,3}~~~/;
    const at = i;
    const buf = [];
    i++;
    while (i < lines.length && !closeRe.test(lines[i])) buf.push(lines[i++]);
    out.push({ index: out.length, lang: open[2] || '', code: buf.join('\n'), open: at, close: i });
  }
  return out;
}

// The block a /run request is asking for, or a sentence saying why not.
export function blockAt(text, index) {
  if (!Number.isInteger(index) || index < 0) return { error: 'block_index must be a non-negative integer' };
  const blocks = codeBlocks(text);
  const block = blocks[index];
  if (!block) return { error: `no code block #${index} in that message` };
  if (!isPython(block.lang)) return { error: `code block #${index} is not python` };
  if (!block.code.trim()) return { error: 'that code block is empty' };
  return { block };
}

export const newRunId = () =>
  `r-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
export const isRunId = id => /^r-[0-9a-z]{1,16}-[0-9a-f]{6}$/.test(String(id || ''));
// figures are named by the wrapper below, or by the snippet's own savefig()
export const isFigureName = n => /^[\w.-]{1,64}\.(png|svg)$/i.test(String(n || '')) && !String(n).includes('..');

// ---- the wrapper the child imports ---------------------------------------
// sitecustomize.py is imported by CPython at startup when it is importable, and
// the run directory is both the cwd and the whole of PYTHONPATH — so this file
// runs before the snippet does, and nothing outside the run directory is on the
// path to be shadowed by it.
//
// It does two small things: records the interpreter's version (so the result
// can say which python this was without a second process), and makes figures
// come out as files. plt.show() under the Agg backend draws nothing and keeps
// the figure open, so it is wrapped to save every open figure and close them;
// and whatever is still open at exit is saved too, which covers a snippet that
// never calls show() at all. Explicit savefig() into the cwd needs no help —
// the harvest below picks up any png/svg in the directory.
const SITECUSTOMIZE = `# written by botference Discuss for one run; deleted with it
import sys, os, atexit

_dir = os.environ.get('BFP_RUN_DIR') or os.getcwd()

try:
    with open(os.path.join(_dir, '_python'), 'w') as _f:
        _f.write(sys.version.split()[0])
except Exception:
    pass

_n = [0]

def _next():
    _n[0] += 1
    return os.path.join(_dir, 'figure-%02d.png' % _n[0])

def _save_all(plt):
    try:
        nums = list(plt.get_fignums())
    except Exception:
        return
    for num in nums:
        try:
            plt.figure(num).savefig(_next(), bbox_inches='tight')
        except Exception:
            pass

def _patch(plt):
    if getattr(plt, '_bfp_show', None) is not None:
        return
    plt._bfp_show = plt.show

    def show(*a, **k):
        _save_all(plt)
        try:
            plt.close('all')
        except Exception:
            pass
    plt.show = show

import builtins
_real_import = builtins.__import__

def _bfp_import(name, *a, **k):
    mod = _real_import(name, *a, **k)
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        _patch(plt)
    return mod

builtins.__import__ = _bfp_import

@atexit.register
def _bfp_flush():
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is not None:
        _save_all(plt)
`;

// The child's environment, built rather than inherited. Minimal, but not empty:
// PATH and HOME are what make a real interpreter with the reader's own packages
// work at all, and this feature is honestly "as you" — a stripped HOME would
// only break matplotlib's font cache while proving nothing about safety.
function childEnv(dir) {
  const src = process.env;
  const env = {
    PATH: src.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: src.HOME || '',
    LANG: src.LANG || 'en_US.UTF-8',
    TMPDIR: src.TMPDIR || '',
    // a headless backend, so a plot never tries to open a window
    MPLBACKEND: 'Agg',
    PYTHONPATH: dir,
    BFP_RUN_DIR: dir,
    PYTHONIOENCODING: 'utf-8',
    PYTHONDONTWRITEBYTECODE: '1',
    // unbuffered, so a snippet that dies mid-way still shows what it printed
    PYTHONUNBUFFERED: '1',
  };
  for (const k of Object.keys(env)) if (env[k] === '') delete env[k];
  return env;
}

function capture() {
  const parts = [];
  let kept = 0, total = 0;
  return {
    push(buf) {
      total += buf.length;
      if (kept >= OUT_MAX) return;
      const take = buf.slice(0, OUT_MAX - kept);
      parts.push(take);
      kept += take.length;
    },
    get truncated() { return total > kept; },
    text() {
      const s = Buffer.concat(parts).toString('utf8');
      return total > kept ? `${s}\n…truncated (${total} bytes of output in all)` : s;
    },
  };
}

// Every figure the run left behind: the wrapper's numbered saves and anything
// the snippet wrote itself, in name order so a run's plots come back in the
// order they were made.
function harvestFigures(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    if (!isFigureName(name)) continue;
    let st = null;
    try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
    if (!st.isFile() || st.size === 0 || st.size > FIGURE_MAX) continue;
    out.push(name);
    if (out.length >= FIGURES_MAX) break;
  }
  return out;
}

// ---- cancelling ----------------------------------------------------------
// A run is a process group (detached), so cancelling is one kill on the group:
// a snippet that spawned something of its own goes with it.
const live = new Map();     // cancel key -> child process
export const isRunning = key => live.has(key);
export function cancelRun(key) {
  const child = live.get(key);
  if (!child) return false;
  child.__bfpCancelled = true;
  killGroup(child);
  return true;
}
function killGroup(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}

/**
 * Run one snippet in its own directory and answer with the whole of what
 * happened. Never throws: a python3 that does not exist is a result with
 * status 'failed', not an exception for the route to guess at.
 */
export function runPython({ dir, code, runId, timeout = timeoutMs(), key = '' }) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sitecustomize.py'), SITECUSTOMIZE);
  fs.writeFileSync(path.join(dir, 'snippet.py'), String(code == null ? '' : code) + '\n');

  const started = Date.now();
  const ranAt = new Date().toISOString();
  const out = capture();
  const err = capture();

  return new Promise(resolve => {
    let child;
    try {
      child = spawn(pythonBin(), ['snippet.py'], {
        cwd: dir,
        env: childEnv(dir),
        detached: true,                      // its own process group, so it can be killed whole
        stdio: ['ignore', 'pipe', 'pipe'],   // stdin closed: input() ends the run, it does not hang it
      });
    } catch (e) {
      resolve(result({ status: 'failed', exit: null, signal: null,
        stderrExtra: `could not start ${pythonBin()}: ${(e && e.message) || e}` }));
      return;
    }
    if (key) live.set(key, child);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child, 'SIGTERM');
      // a snippet that ignores SIGTERM (or is stuck in C) gets no say
      setTimeout(() => killGroup(child, 'SIGKILL'), 1500).unref();
    }, timeout);

    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', e => {
      clearTimeout(timer);
      if (key) live.delete(key);
      resolve(result({ status: 'failed', exit: null, signal: null,
        stderrExtra: `could not start ${pythonBin()}: ${(e && e.message) || e}` }));
    });
    child.on('close', (exit, signal) => {
      clearTimeout(timer);
      if (key) live.delete(key);
      const status = timedOut ? 'timeout'
        : child.__bfpCancelled ? 'cancelled'
        : exit === 0 ? 'ok' : 'error';
      resolve(result({ status, exit, signal }));
    });

    function result({ status, exit, signal, stderrExtra }) {
      let python = '';
      try { python = fs.readFileSync(path.join(dir, '_python'), 'utf8').trim(); } catch { }
      try { fs.unlinkSync(path.join(dir, '_python')); } catch { }
      const stderr = [err.text(), stderrExtra].filter(Boolean).join(stderrExtra && err.text() ? '\n' : '');
      return {
        run_id: runId,
        status,
        exit: typeof exit === 'number' ? exit : null,
        signal: signal || null,
        stdout: out.text(),
        stderr: status === 'timeout'
          ? [stderr, `…stopped after ${Math.round(timeout / 1000)}s`].filter(Boolean).join('\n')
          : stderr,
        stdout_truncated: out.truncated,
        stderr_truncated: err.truncated,
        figures: harvestFigures(dir),
        ms: Date.now() - started,
        python,
        ran_at: ranAt,
      };
    }
  });
}
