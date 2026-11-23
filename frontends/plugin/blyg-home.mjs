// blyg-home.mjs — "Where my blyg lives": the owner's one setting for Publish as blyg.
//
// It names four things, all on the companion (never in the extension, never
// from a page or a guest; server.mjs `/blyg-home*` are owner-only):
//
//   folder     an absolute directory that exists and is inside a git work tree
//              (the notes folder of the owner's site checkout)
//   filename   a pattern for the note's file name: `${slug}` and `${date}`, ending in `.md`
//   template   the front matter (blyg-note.mjs checkTemplate), and `escape`
//              ('liquid' | 'none'): whether Jekyll's Liquid is made inert in the body
//   commands   `plan`, `apply`, `publish` (and an optional `discard`): argv arrays
//              with a `{note}` placeholder, run with execFile semantics (argv, shell: false),
//              never a shell, in the work tree, each under a time limit, with a minimal environment
//
// NOTHING RUNS UNLESS THESE ARE SET, and they are checked when they are saved
// (POST /blyg-home) and again every time a run starts and before every step
// (validateHome, called by blyg-run.mjs), so a hand-edited config.json gets the
// same scrutiny and a setting changed mid-run stops that run's next step.
//
// `{note}` is the note's path RELATIVE TO THE WORK TREE (what a site's own
// publish script wants: `_notes/<name>.md`), one argument however many spaces it
// has. `{note_abs}` is the absolute path, for a command that wants that.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { checkTemplate, DEFAULT_TEMPLATE, ESCAPES, DEFAULT_ESCAPE, validTimezone } from './blyg-note.mjs';

// ---- the limits, stated once ---------------------------------------------------
export const STEPS = Object.freeze(['plan', 'apply', 'publish']);
export const COMMAND_KEYS = Object.freeze([...STEPS, 'discard']);
export const TIME_LIMITS_MS = Object.freeze({ plan: 120_000, apply: 900_000, publish: 1_800_000, discard: 60_000 });
export const OUTPUT = Object.freeze({
  maxBuffer: 4 * 1024 * 1024,   // a command that prints more than this is stopped
  kept: 64 * 1024,              // what is stored and shown: the first 8 KiB and the last 56 KiB
  head: 8 * 1024,
});
export const ARGV = Object.freeze({ maxArgs: 32, maxArgChars: 400 });
export const FILENAME_MAX = 100;
const KILL_GRACE_MS = 5000;
const NOTE_TOKEN = '{note}';
const NOTE_ABS_TOKEN = '{note_abs}';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'csh', 'tcsh', 'ksh', 'ash', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'env', 'sudo', 'su', 'xargs']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ENV_REFUSED = /^(PATH|HOME|PWD|OLDPWD|SHELL|IFS|LD_.*|DYLD_.*|NODE_OPTIONS|BASH_ENV|ENV|GIT_(SSH|ASKPASS|EXEC_PATH|CONFIG.*|DIR|WORK_TREE))$/;

export const DEFAULT_FILENAME = '${slug}.md';

/**
 * The environment a command gets. EXACTLY these, and nothing else of the companion's:
 *   PATH, HOME, USER, LOGNAME, LANG, LC_ALL, TMPDIR   copied when set (a git or a ruby needs them)
 *   TERM=dumb, NO_COLOR=1, CI=1, GIT_TERMINAL_PROMPT=0   fixed: no colour, no prompts
 *   plus each name in `env_pass` (the owner's list) that is set in the companion's environment
 */
export const BASE_ENV_NAMES = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']);
export function minimalEnv(pass = [], from = process.env) {
  const env = {};
  for (const k of [...BASE_ENV_NAMES, ...pass]) if (typeof from[k] === 'string') env[k] = from[k];
  return { ...env, TERM: 'dumb', NO_COLOR: '1', CI: '1', GIT_TERMINAL_PROMPT: '0' };
}

const posix = p => p.split(path.sep).join('/');
const within = (root, p) => { const r = path.relative(root, p); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const realOrNull = p => { try { return fs.realpathSync(p); } catch { return null; } };
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

/** The file name pattern → { ok, error }. */
export function checkFilename(pattern) {
  const p = String(pattern == null ? '' : pattern);
  if (!p || p.length > FILENAME_MAX) return { ok: false, error: 'the file name pattern is empty or too long' };
  if (!/^[A-Za-z0-9 _.${}-]+$/.test(p)) return { ok: false, error: 'the file name pattern may hold letters, digits, space, _ . - and the placeholders ${slug} and ${date} only' };
  for (const m of p.matchAll(/\$\{([^}]*)\}/g)) if (!['slug', 'date'].includes(m[1])) return { ok: false, error: `the file name pattern has an unknown placeholder \${${m[1].slice(0, 20)}}` };
  if (/[${}]/.test(p.replace(/\$\{(slug|date)\}/g, ''))) return { ok: false, error: 'the file name pattern has a stray $, { or }' };
  if (!p.includes('${slug}')) return { ok: false, error: 'the file name pattern must contain ${slug}, so two notes never share a name' };
  if (!p.endsWith('.md')) return { ok: false, error: 'the file name pattern must end in .md' };
  if (p.startsWith('.') || p.includes('..')) return { ok: false, error: 'the file name pattern may not start with a dot or hold “..”' };
  return { ok: true, error: '' };
}
/** A file name from the pattern; throws if the result is not one plain name. */
export function filenameFor(pattern, { slug, date }) {
  const name = String(pattern).replace(/\$\{slug\}/g, slug).replace(/\$\{date\}/g, date);
  if (!name || name.length > FILENAME_MAX + 60 || name !== path.basename(name) || /[/\\\0]/.test(name) || name.startsWith('.') || name.includes('..')) {
    throw new Error('the file name came out unusable');
  }
  return name;
}

function checkArgv(key, argv, top, errors) {
  const at = `command “${key}”`;
  if (!Array.isArray(argv) || !argv.length) { errors.push(`${at} is not set (an argv list, for example ["scripts/publish", "{note}"])`); return null; }
  if (argv.length > ARGV.maxArgs) { errors.push(`${at} has more than ${ARGV.maxArgs} arguments`); return null; }
  if (!argv.every(a => typeof a === 'string' && !a.includes('\0') && a.length <= ARGV.maxArgChars)) {
    errors.push(`${at}: every argument must be a string of at most ${ARGV.maxArgChars} characters`); return null;
  }
  if (!argv[0].trim()) { errors.push(`${at}: the program is empty`); return null; }
  if (argv[0].includes(NOTE_TOKEN) || argv[0].includes(NOTE_ABS_TOKEN)) { errors.push(`${at}: the program itself may not hold {note}`); return null; }
  if (!argv.slice(1).some(a => a.includes(NOTE_TOKEN) || a.includes(NOTE_ABS_TOKEN))) { errors.push(`${at} must have {note} in one of its arguments`); return null; }
  if (SHELLS.has(path.basename(argv[0]).toLowerCase())) { errors.push(`${at}: a shell (or env, sudo, xargs) is not accepted as the program: name the program itself`); return null; }
  if (argv[0].includes('/')) {
    const abs = path.isAbsolute(argv[0]) ? argv[0] : path.resolve(top, argv[0]);
    const real = realOrNull(abs);
    let okFile = false;
    try { okFile = !!real && fs.statSync(real).isFile(); fs.accessSync(real, fs.constants.X_OK); } catch { okFile = false; }
    if (!okFile) { errors.push(`${at}: ${argv[0]} is not an executable file`); return null; }
    if (!path.isAbsolute(argv[0]) && !within(top, real)) { errors.push(`${at}: ${argv[0]} resolves outside the work tree`); return null; }
  }
  return argv.slice();
}

/**
 * Check the whole setting. → { ok, errors: [sentence…], settings } where `settings` is the
 * normalized form a run uses (folder as a real path, `top` the work tree's), or null.
 * Touches the disk (the folder, the work tree via `git rev-parse`, the program files).
 */
export function validateHome(raw, { env = process.env } = {}) {
  const errors = [];
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('“Where my blyg lives” is not set up yet');
  // folder
  let folder = '';
  let top = '';
  const given = typeof r.folder === 'string' ? r.folder.trim() : '';
  if (!given) errors.push('the notes folder is not set');
  else if (!path.isAbsolute(given) || given.includes('\0')) errors.push('the notes folder must be an absolute path');
  else if (!isDir(given)) errors.push('the notes folder does not exist');
  else {
    folder = realOrNull(given) || '';
    try {
      const inside = execFileSync('git', ['-C', folder, 'rev-parse', '--is-inside-work-tree'], { env: minimalEnv([], env), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      top = realOrNull(execFileSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { env: minimalEnv([], env), encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()) || '';
      if (inside !== 'true' || !top || !within(top, folder)) throw new Error('not in a work tree');
      if (posix(path.relative(top, folder)).split('/')[0] === '.git') throw new Error('inside .git');
    } catch {
      errors.push('the notes folder must be inside a git work tree (a checkout, not a bare repository or the .git folder)');
      folder = ''; top = '';
    }
  }
  const filename = r.filename === undefined || r.filename === '' ? DEFAULT_FILENAME : r.filename;
  const fn = checkFilename(filename); if (!fn.ok) errors.push(fn.error);
  const template = r.template === undefined || r.template === '' ? DEFAULT_TEMPLATE : r.template;
  if (typeof template !== 'string') errors.push('the template must be text'); else { const t = checkTemplate(template); if (!t.ok) errors.push(t.error); }
  const escape = r.escape === undefined || r.escape === '' ? DEFAULT_ESCAPE : r.escape;
  if (!ESCAPES.includes(escape)) errors.push(`escape must be one of ${ESCAPES.join(', ')}`);
  const timezone = r.timezone === undefined ? '' : r.timezone;
  if (typeof timezone !== 'string' || !validTimezone(timezone)) errors.push('the time zone is not a known IANA name (for example Europe/London)');
  const passRaw = r.env_pass === undefined ? [] : r.env_pass;
  const pass = Array.isArray(passRaw) && passRaw.every(n => typeof n === 'string' && ENV_NAME.test(n) && !ENV_REFUSED.test(n)) && passRaw.length <= 16 ? passRaw.slice() : null;
  if (!pass) errors.push('env_pass must be a list (at most 16) of upper-case variable names, none of PATH, HOME, LD_*, DYLD_*, NODE_OPTIONS, GIT_* paths and the like');
  // commands
  const cmds = r.commands && typeof r.commands === 'object' && !Array.isArray(r.commands) ? r.commands : {};
  if (!r.commands) errors.push('the commands (plan, apply, publish) are not set');
  const extra = Object.keys(cmds).filter(k => !COMMAND_KEYS.includes(k));
  if (extra.length) errors.push(`unknown command ${JSON.stringify(extra[0]).slice(0, 30)}: the commands are ${COMMAND_KEYS.join(', ')}`);
  const commands = {};
  for (const k of STEPS) { const a = checkArgv(k, cmds[k], top || process.cwd(), errors); if (a) commands[k] = a; }
  if (cmds.discard !== undefined && cmds.discard !== null) { const a = checkArgv('discard', cmds.discard, top || process.cwd(), errors); if (a) commands.discard = a; }
  if (errors.length) return { ok: false, errors, settings: null };
  return { ok: true, errors: [], settings: { folder, top, filename, template, escape, timezone, env_pass: pass, commands } };
}

/** What is stored: only the fields the owner set, not the derived paths. */
export const storable = raw => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { folder: r.folder, filename: r.filename, template: r.template, escape: r.escape, timezone: r.timezone, env_pass: r.env_pass, commands: r.commands };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
};
export const fingerprint = s => crypto.createHash('sha256').update(JSON.stringify([s.folder, s.top, s.filename, s.template, s.escape, s.timezone, s.env_pass, s.commands])).digest('hex');

/** `{note}` made into one argument each: → the argv to run. */
export function expandArgv(argv, { rel, abs }) {
  return argv.map((a, i) => (i === 0 ? a : a.split(NOTE_TOKEN).join(rel).split(NOTE_ABS_TOKEN).join(abs)));
}

// ---- running a command ---------------------------------------------------------------
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export function capOutput(text) {
  const s = String(text == null ? '' : text).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (s.length <= OUTPUT.kept) return { text: s, truncated: false };
  const tail = OUTPUT.kept - OUTPUT.head;
  return { text: `${s.slice(0, OUTPUT.head)}\n… ${s.length - OUTPUT.kept} characters cut …\n${s.slice(-tail)}`, truncated: true };
}

/**
 * Run one command: the program and its argv, `shell: false`, so no string of ours or the page's is ever parsed by a shell
 * (this is execFile's guarantee; `spawn` is used because execFile cannot start a process group, and a time limit has to
 * stop a command's children too). In its own process group; stdin closed (nothing can prompt); output read as it comes
 * and stopped past OUTPUT.maxBuffer. Never rejects.
 * → { exit, signal, timedOut, spawnError, output, truncated, ms }. `onChild(stop)` hands the caller a way to stop it.
 */
export function runCommand({ argv, cwd, env, limitMs, onChild }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let timedOut = false;
    let flooded = false;
    let settled = false;
    let timer = null;
    let killer = null;
    let spawnError = '';
    const out = [];
    const err = [];
    let size = 0;
    let child = null;
    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const capped = capOutput(`${stdout}${stderr ? `${stdout ? '\n' : ''}[stderr]\n${stderr}` : ''}${flooded ? '\n[stopped: the command printed more than it may]' : ''}`);
      resolve({ exit: typeof code === 'number' && !flooded ? code : (flooded ? null : null), signal: signal || '', timedOut, spawnError: spawnError || (flooded ? 'OUTPUT_LIMIT' : ''),
        output: capped.text, truncated: capped.truncated || flooded, ms: Date.now() - t0 });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { spawnError = 'SPAWN'; err.push(Buffer.from(String((e && e.message) || e))); return finish(null, ''); }
    const take = list => chunk => {
      if (flooded) return;
      size += chunk.length;
      if (size > OUTPUT.maxBuffer) { flooded = true; killGroup('SIGTERM'); killer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS); return; }
      list.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.on('error', e => { spawnError = (e && e.code) || 'SPAWN'; finish(null, ''); });
    child.on('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS); }, limitMs);
    if (typeof onChild === 'function') onChild(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref(); });
  });
}
