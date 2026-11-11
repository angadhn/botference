// The Doc-comment watcher's keeper (docs/google-doc-watcher.md).
//
// The hosted council server starts core/gdoc_watch.py `run` as a child
// process, starts it again after a pause if it dies, and stops it when the
// server exits. BOTFERENCE_GDOC_WATCH=0 switches it off.
//
// The keeper has one mode at a time, from MODES, kept in one field and
// changed only through moveTo(), which refuses an illegal move.
//
// Env:  BOTFERENCE_GDOC_WATCH=0         do not start the watcher
//       BOTFERENCE_PYTHON_BIN           python to run it with (python3)
//       COUNCIL_GDOC_WATCH_CMD          tests: JSON argv replacing the watcher
//       COUNCIL_GDOC_WATCH_RESTART_MS   tests: the pause before a restart
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MODES = Object.freeze({
  IDLE: 'idle',         // made, not started yet
  OFF: 'off',           // switched off: never starts
  RUNNING: 'running',   // the watcher process is alive
  PAUSING: 'pausing',   // it died; waiting before starting it again
  STOPPED: 'stopped',   // the server is exiting: never starts again
});

const MOVES = Object.freeze({
  [MODES.IDLE]: [MODES.OFF, MODES.RUNNING, MODES.STOPPED],
  [MODES.OFF]: [MODES.STOPPED],
  [MODES.RUNNING]: [MODES.PAUSING, MODES.STOPPED],
  [MODES.PAUSING]: [MODES.RUNNING, MODES.STOPPED],
  [MODES.STOPPED]: [],
});

export const RESTART_PAUSE_MS = 30_000;

export function createGdocWatchKeeper({ home, env = process.env, log = console.log } = {}) {
  let mode = MODES.IDLE;
  let child = null;
  let timer = null;
  const pause = Number(env.COUNCIL_GDOC_WATCH_RESTART_MS) || RESTART_PAUSE_MS;

  function moveTo(next) {
    if (!MOVES[mode].includes(next)) throw new Error(`gdoc watch keeper: illegal move ${mode} -> ${next}`);
    mode = next;
  }

  function command() {
    if (env.COUNCIL_GDOC_WATCH_CMD) return JSON.parse(env.COUNCIL_GDOC_WATCH_CMD);
    return [env.BOTFERENCE_PYTHON_BIN || 'python3', path.join(home, 'core', 'gdoc_watch.py'), 'run'];
  }

  function launch() {
    moveTo(MODES.RUNNING);
    const [cmd, ...args] = command();
    // its own process group, so stopping it also stops a bot it is running
    child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'], env: { ...env }, detached: true });
    const proc = child;
    let gone = false;
    const onGone = (why) => {
      if (gone) return;
      gone = true;
      if (child === proc) child = null;
      if (mode !== MODES.RUNNING) return; // stopping: expected
      moveTo(MODES.PAUSING);
      log(`[council] Doc-comment watcher ${why}; starting it again in ${Math.round(pause / 1000)} s`);
      timer = setTimeout(() => { timer = null; if (mode === MODES.PAUSING) launch(); }, pause);
      timer.unref();
    };
    proc.on('exit', code => onGone(`stopped (exit ${code})`));
    proc.on('error', err => onGone(`could not start (${err.code || err.message})`));
  }

  return {
    get mode() { return mode; },
    start() {
      if (env.BOTFERENCE_GDOC_WATCH === '0') {
        moveTo(MODES.OFF);
        log('[council] Doc-comment watcher off (BOTFERENCE_GDOC_WATCH=0)');
        return;
      }
      launch();
      log('[council] Doc-comment watcher started (log: ~/.botference/logs/gdoc-watch.log)');
    },
    stop() {
      if (mode === MODES.STOPPED) return;
      moveTo(MODES.STOPPED);
      if (timer) { clearTimeout(timer); timer = null; }
      if (child) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { } }
        child = null;
      }
    },
  };
}

// The server's one call: start the keeper and stop it when the server exits.
export function startGdocWatch({ home }) {
  const keeper = createGdocWatchKeeper({ home });
  keeper.start();
  process.on('exit', () => keeper.stop());
  return keeper;
}
