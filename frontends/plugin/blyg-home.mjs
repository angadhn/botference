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
//   commands   `plan`, `apply`, `publish` (and optional `prepare`, `discard` and `abandon`): argv arrays
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
// PUBLISHING AGAIN (a new version of a post already published from here) runs the same three steps in their EDIT form: optional
// commands of their own, all three or none, each with `{note}` and the changelog line as `{changelog}` (ONE argument: the companion's
// fixed line from the difference, or a small model's line that blyg-note changelogAnswerOk accepted, which always begins with a
// letter, so it can never be read as a flag). Example site: the same commands plus `--edit --generated-note {changelog}`.
export const EDIT_STEPS = Object.freeze(['plan_edit', 'apply_edit', 'publish_edit']);
/** Which command a step runs, by the run's kind (blyg-run RUN_KINDS): a new post, or a new version of one. */
export const COMMAND_FOR = Object.freeze({ new: Object.freeze({ plan: 'plan', apply: 'apply', publish: 'publish' }),
  edit: Object.freeze({ plan: 'plan_edit', apply: 'apply_edit', publish: 'publish_edit' }) });
// `prepare` (optional) runs before `plan`, after the note is written: for a site that has to stage the note or fetch what it
// quotes first. `discard` (optional) undoes whatever prepare or plan did, when the owner cancels or abandons before apply.
// `link_targets` (optional) is no step of a publish run: it prints the catalogue of the site's published posts, which a `/tk` passage
// may link to (tk-links.mjs runs it, with its own time and size limits; nothing here does).
export const COMMAND_KEYS = Object.freeze(['check', 'prepare', ...STEPS, ...EDIT_STEPS, 'discard', 'abandon', 'link_targets']);
export const TIME_LIMITS_MS = Object.freeze({ check: 15_000, prepare: 300_000, plan: 120_000, apply: 1_800_000, publish: 1_800_000,
  plan_edit: 120_000, apply_edit: 1_800_000, publish_edit: 1_800_000, discard: 60_000, abandon: 60_000 });
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
const CHANGELOG_TOKEN = '{changelog}';
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'csh', 'tcsh', 'ksh', 'ash', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'env', 'sudo', 'su', 'xargs']);
// `env_pass` is an ALLOW-list: BLYG_CHECKER (what the example site needs), plus any upper-case name the owner adds that is not one that
// changes what a step's programs load, trust, fetch through, or are told (ENV_REFUSED). Values only ever come from the companion's own
// launch environment; this list decides which of them a step may see.
export const ENV_EXPECTED = Object.freeze(['BLYG_CHECKER']);
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const ENV_REFUSED = new RegExp('^(' + [
  'PATH', 'HOME', 'PWD', 'OLDPWD', 'SHELL', 'IFS', 'ENV', 'BASH_ENV', 'ZDOTDIR', 'EDITOR', 'VISUAL', 'TZ', 'XDG_CONFIG_HOME',
  'LD_.*', 'DYLD_.*',
  'RUBYOPT', 'RUBYLIB', 'BUNDLE_.*', 'GEM_HOME', 'GEM_PATH', 'RBENV_.*', 'JEKYLL_ENV',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHON.*',
  'GIT_.*',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'FTP_PROXY',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  // the example site's own run variables (a step must never become a preparing or pinning run): only BLYG_CHECKER is expected
  'BLYG_(?!CHECKER$).*', 'LINK_CARD_.*',
].join('|') + ')$', 'i');
export const envPassable = n => typeof n === 'string' && (ENV_EXPECTED.includes(n) || (ENV_NAME.test(n) && !ENV_REFUSED.test(n)));

export const DEFAULT_FILENAME = '${slug}.md';

// Does the owner look at the note and the plan before anything goes live?
//   never   choosing "Publish as blyg" IS the publish: prepare, plan, apply, publish without stopping. The run still
//           stops by itself on a plan that exits non-zero, and `plan_guard` (below) can make the plan refuse anything but this note.
//   always  the run stops at `planned` and waits for an explicit, trusted Publish click (the confirmation)
export const CONFIRMS = Object.freeze(['never', 'always']);
// The default is `always` until a `plan_guard` is set: `never` is accepted only with one (validateHome refuses it otherwise).
export const DEFAULT_CONFIRM = 'always';
// `plan_guard`: extra FLAGS (each starts with `-`) added to the plan, apply and publish commands (every time they run,
// retries and resumes included) whenever it is set, in either confirm mode, so that the site's own command can refuse, with a non-zero exit, a
// plan that would change or publish more than this one note (an example site's `--only-note`). Never parsed here: the exit
// code is the verdict. `confirm: 'never'` is refused without one.
export const PLAN_GUARD = Object.freeze({ maxArgs: 8, maxArgChars: 80 });

/**
 * The environment a command gets. EXACTLY these, and nothing else of the companion's:
 *   PATH, HOME, USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TMPDIR   copied when set (a git or a ruby needs them)
 *   LANG and LC_ALL = UTF8_LOCALE when the companion's own environment names NO locale at all (none of LANG, LC_ALL,
 *     LC_CTYPE): a launch agent's environment often has none, and then Ruby reads every file as US-ASCII and a site's
 *     publish command fails on the first non-ASCII character (the owner's first real use did, in JSON.parse). A locale the
 *     owner did set is passed as it is (the example site's pre-flight says plainly when it is not UTF-8).
 *   TERM=dumb, NO_COLOR=1, CI=1, GIT_TERMINAL_PROMPT=0   fixed: no colour, no prompts
 *   plus each name in `env_pass` (the owner's list) that is set in the companion's environment
 */
export const BASE_ENV_NAMES = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']);
// en_US.UTF-8 is present on every macOS; C.UTF-8 on current Linux C libraries (glibc 2.35+, musl), where en_US needs generating
export const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
export function minimalEnv(pass = [], from = process.env) {
  const env = {};
  for (const k of [...BASE_ENV_NAMES, ...pass]) if (typeof from[k] === 'string') env[k] = from[k];
  const named = ['LANG', 'LC_ALL', 'LC_CTYPE'].some(k => typeof from[k] === 'string' && from[k].trim());
  if (!named) { env.LANG = UTF8_LOCALE; env.LC_ALL = UTF8_LOCALE; }
  return { ...env, TERM: 'dumb', NO_COLOR: '1', CI: '1', GIT_TERMINAL_PROMPT: '0' };
}

// `preview_url` (optional): where the owner's own PREVIEW site shows a note at its address before it is published (for the example
// blog, its local preview server, which serves the working branch's drafts). A template with `{permalink}` (the post's path, from the
// run's own note) and optionally `{slug}` and `{id}`; it must make an absolute http(s) address. The drawer offers it as one link, built
// here from the setting and the run, never from anything a page supplied.
export const PREVIEW_TOKENS = Object.freeze(['{permalink}', '{slug}', '{id}']);
export function previewUrlProblem(t) {
  if (t === undefined || t === null || t === '') return '';
  if (typeof t !== 'string' || t.length > 300 || /[\s\u0000-\u001f]/.test(t)) return 'preview_url must be one address of at most 300 characters, without spaces';
  const rest = t.replace(/\{(permalink|slug|id)\}/g, '');
  if (/[{}]/.test(rest)) return 'preview_url may hold only the placeholders {permalink}, {slug} and {id}';
  if (!t.includes('{permalink}') && !t.includes('{id}') && !t.includes('{slug}')) return 'preview_url must hold {permalink} (or {id} or {slug}), so it names this post';
  let u;
  try { u = new URL(t.replace(/\{permalink\}/g, '/b/x').replace(/\{slug\}/g, 'x').replace(/\{id\}/g, 'x')); } catch { return 'preview_url is not an address'; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'preview_url must be an http or https address';
  if (u.username || u.password) return 'preview_url may not carry a user name or password';
  return '';
}
/** The preview address for a run's post, or '' (no setting, or the parts are not plain). */
export function previewUrlFor(template, { permalink = '', slug = '', id = '' } = {}) {
  if (!template || previewUrlProblem(template)) return '';
  if (!/^\/[A-Za-z0-9/_.-]*$/.test(permalink) || !/^[a-z0-9-]*$/.test(slug) || !/^[0-9a-z]*$/.test(id)) return '';
  try {
    const u = new URL(template.replace(/\{permalink\}/g, permalink).replace(/\{slug\}/g, slug).replace(/\{id\}/g, id));
    return (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password ? u.href : '';
  } catch { return ''; }
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

// `{note}` is required in every command, `abandon` too: the site's own end-the-run command is told WHICH note's run to end, so it
// cannot end a run the owner started by hand for another note
function checkArgv(key, argv, top, errors, { needNote = true, changelog = false } = {}) {
  const at = `command “${key}”`;
  if (!Array.isArray(argv) || !argv.length) { errors.push(`${at} is not set (an argv list, for example ["scripts/publish", "{note}"])`); return null; }
  if (argv.length > ARGV.maxArgs) { errors.push(`${at} has more than ${ARGV.maxArgs} arguments`); return null; }
  if (!argv.every(a => typeof a === 'string' && !a.includes('\0') && a.length <= ARGV.maxArgChars)) {
    errors.push(`${at}: every argument must be a string of at most ${ARGV.maxArgChars} characters`); return null;
  }
  if (!argv[0].trim()) { errors.push(`${at}: the program is empty`); return null; }
  if (argv[0].includes(NOTE_TOKEN) || argv[0].includes(NOTE_ABS_TOKEN)) { errors.push(`${at}: the program itself may not hold {note}`); return null; }
  if (needNote && !argv.slice(1).some(a => a.includes(NOTE_TOKEN) || a.includes(NOTE_ABS_TOKEN))) { errors.push(`${at} must have {note} in one of its arguments`); return null; }
  if (argv[0].includes(CHANGELOG_TOKEN)) { errors.push(`${at}: the program itself may not hold {changelog}`); return null; }
  if (!changelog && argv.some(a => a.includes(CHANGELOG_TOKEN))) { errors.push(`${at}: {changelog} is only for the edit commands (${EDIT_STEPS.join(', ')})`); return null; }
  if (changelog && argv.some(a => a.includes(CHANGELOG_TOKEN) && a !== CHANGELOG_TOKEN)) { errors.push(`${at}: {changelog} must be an argument of its own`); return null; }
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
  const confirm = r.confirm === undefined || r.confirm === '' ? DEFAULT_CONFIRM : r.confirm;
  if (!CONFIRMS.includes(confirm)) errors.push(`confirm must be one of ${CONFIRMS.join(', ')}`);
  const guardRaw = r.plan_guard === undefined || r.plan_guard === null ? [] : r.plan_guard;
  const guardOk = Array.isArray(guardRaw) && guardRaw.length <= PLAN_GUARD.maxArgs
    && guardRaw.every(a => typeof a === 'string' && /^-[A-Za-z0-9=_.:-]*$/.test(a) && a.length <= PLAN_GUARD.maxArgChars);
  if (confirm === 'never' && guardOk && guardRaw.length === 0) errors.push('confirm “never” (one click publishes) needs a plan_guard: flags that make your site\'s plan refuse anything but this one note; set one, or use “always”');
  if (!guardOk) errors.push(`plan_guard must be a list (at most ${PLAN_GUARD.maxArgs}) of flags, each starting with “-” and holding only letters, digits and = _ . : -`);
  // `published_marker`: the line the publish command prints (as its LAST `State:` line) when it is really done, e.g. `State: merged_back`.
  // With it, a publish that exits 0 without it (the site's command applied afresh and stopped) is a failure, not a publish.
  const marker = r.published_marker === undefined || r.published_marker === null ? '' : r.published_marker;
  if (typeof marker !== 'string' || marker.length > 80 || /[\n\r\u0000]/.test(marker)) errors.push('published_marker must be one line of at most 80 characters (for example “State: merged_back”)');
  const passRaw = r.env_pass === undefined ? [] : r.env_pass;
  const pass = Array.isArray(passRaw) && passRaw.every(envPassable) && passRaw.length <= 16 ? passRaw.slice() : null;
  if (!pass) {
    const bad = Array.isArray(passRaw) ? passRaw.filter(n => !envPassable(n)).map(n => JSON.stringify(n).slice(0, 40)) : [];
    errors.push(`env_pass must be a list (at most 16) of upper-case names a step may see: BLYG_CHECKER, or a name of your own that is not one that changes what programs load or trust (PATH, HOME, RUBYOPT, BUNDLE_*, GEM_*, NODE_*, PYTHON*, PERL5*, GIT_*, proxies, CA files, TZ, BLYG_* run variables and the like)${bad.length ? `; refused: ${bad.join(', ')}` : ''}`);
  }
  // commands
  const cmds = r.commands && typeof r.commands === 'object' && !Array.isArray(r.commands) ? r.commands : {};
  if (!r.commands) errors.push('the commands (plan, apply, publish) are not set');
  const extra = Object.keys(cmds).filter(k => !COMMAND_KEYS.includes(k));
  if (extra.length) errors.push(`unknown command ${JSON.stringify(extra[0]).slice(0, 30)}: the commands are ${COMMAND_KEYS.join(', ')}`);
  const commands = {};
  for (const k of STEPS) { const a = checkArgv(k, cmds[k], top || process.cwd(), errors); if (a) commands[k] = a; }
  if (cmds.prepare && !cmds.discard) errors.push('a prepare command needs a discard command, so that cancelling undoes what prepare did');
  for (const k of ['prepare', 'discard', 'abandon']) {
    if (cmds[k] !== undefined && cmds[k] !== null) { const a = checkArgv(k, cmds[k], top || process.cwd(), errors); if (a) commands[k] = a; }
  }
  // the edit commands: all three, or none (then publishing again is not offered)
  const editsSet = EDIT_STEPS.filter(k => cmds[k] !== undefined && cmds[k] !== null);
  if (editsSet.length && editsSet.length !== EDIT_STEPS.length) errors.push(`the edit commands go together: set all of ${EDIT_STEPS.join(', ')}, or none`);
  for (const k of editsSet) { const a = checkArgv(k, cmds[k], top || process.cwd(), errors, { changelog: true }); if (a) commands[k] = a; }
  // `check` (optional): the pre-flight, run before ANYTHING is written; about the environment, so it has no {note}
  if (cmds.check !== undefined && cmds.check !== null) { const a = checkArgv('check', cmds.check, top || process.cwd(), errors, { needNote: false }); if (a) commands.check = a; }
  // `link_targets` (optional): prints the catalogue of the site's published posts (JSON on stdout); read only, so it has no {note}
  if (cmds.link_targets !== undefined && cmds.link_targets !== null) { const a = checkArgv('link_targets', cmds.link_targets, top || process.cwd(), errors, { needNote: false }); if (a) commands.link_targets = a; }
  const preview = r.preview_url === undefined || r.preview_url === null ? '' : r.preview_url;
  { const p = previewUrlProblem(preview); if (p) errors.push(p); }
  // `preview_selector`: the element of the preview page that IS the post (the picture is cropped to it); default `article`
  const selector = r.preview_selector === undefined || r.preview_selector === null || r.preview_selector === '' ? 'article' : r.preview_selector;
  if (typeof selector !== 'string' || selector.length > 120 || !/^[A-Za-z0-9 .#_>:()\[\]="'-]+$/.test(selector)) errors.push('preview_selector must be a CSS selector of at most 120 characters (for example “article”)');
  // `preview_theme_attribute` (optional): the attribute on <html> by which the site picks its theme (the example blog: data-theme)
  const themeAttr = r.preview_theme_attribute === undefined || r.preview_theme_attribute === null ? '' : r.preview_theme_attribute;
  if (typeof themeAttr !== 'string' || (themeAttr && !/^[a-z][a-z0-9-]{0,40}$/.test(themeAttr))) errors.push('preview_theme_attribute must be an attribute name such as “data-theme”');
  // `changelog_model` (optional): the Claude model asked for a new version's one-line changelog (the cheapest current one by default);
  // its own setting, never the model set for /tk
  const clModel = r.changelog_model === undefined || r.changelog_model === null || r.changelog_model === '' ? DEFAULT_CHANGELOG_MODEL : r.changelog_model;
  if (typeof clModel !== 'string' || !/^[\w.][\w.-]{0,63}$/.test(clModel)) errors.push('changelog_model must be a model name such as “claude-haiku-5-5”');
  if (errors.length) return { ok: false, errors, settings: null };
  return { ok: true, errors: [], settings: { folder, top, filename, template, escape, timezone, env_pass: pass, commands, confirm, plan_guard: guardRaw.slice(), published_marker: marker, preview_url: preview, preview_selector: selector, preview_theme_attribute: themeAttr, changelog_model: clModel } };
}

/** The model asked for a new version's changelog line unless the setting names another (blyg-run CHANGELOG_FROM). */
export const DEFAULT_CHANGELOG_MODEL = 'claude-haiku-5-5';
/** What is stored: only the fields the owner set, not the derived paths. */
export const storable = raw => {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = { folder: r.folder, filename: r.filename, template: r.template, escape: r.escape, timezone: r.timezone, env_pass: r.env_pass, commands: r.commands, confirm: r.confirm, plan_guard: r.plan_guard, published_marker: r.published_marker, preview_url: r.preview_url, preview_selector: r.preview_selector, preview_theme_attribute: r.preview_theme_attribute, changelog_model: r.changelog_model };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out;
};
// (preview_url is left out of the fingerprint: it changes nothing that runs, and a run started before it was set may still show it;
// so is the `link_targets` command, which no publish run ever runs)
const runCommands = c => { const { link_targets: _catalogue, ...steps } = c || {}; return steps; };
export const fingerprint = s => crypto.createHash('sha256').update(JSON.stringify([s.folder, s.top, s.filename, s.template, s.escape, s.timezone, s.env_pass, runCommands(s.commands), s.confirm, s.plan_guard, s.published_marker])).digest('hex');

/** `{note}` (and `{changelog}`) made into one argument each: → the argv to run. */
export function expandArgv(argv, { rel, abs, changelog = '' }) {
  return argv.map((a, i) => (i === 0 ? a : a === CHANGELOG_TOKEN ? String(changelog) : a.split(NOTE_TOKEN).join(rel).split(NOTE_ABS_TOKEN).join(abs)));
}

// ---- running a command ---------------------------------------------------------------
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
export function capOutput(text) {
  const s = String(text == null ? '' : text).replace(ANSI, '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (s.length <= OUTPUT.kept) return { text: s, truncated: false };
  const tail = OUTPUT.kept - OUTPUT.head;
  return { text: `${s.slice(0, OUTPUT.head)}\n… ${s.length - OUTPUT.kept} characters cut …\n${s.slice(-tail)}`, truncated: true };
}

// A command's life, as ONE named list in ONE field (`cmd.state`), changed only by `moveCmd`, which refuses a move the table does not
// list. The state it ENDS in says how it ended, so there is nothing else to remember; the result is made only on the move into an
// ending state, which nothing leaves, so it is made exactly once.
//   running       started
//   timing-out    its time limit passed: its process group was told to stop
//   flooding      it printed more than OUTPUT.maxBuffer: its process group was told to stop
//   spawn-failing the program could not be started
//   done | timed-out | flooded | failed-to-start     the four endings
export const CMD_STATES = Object.freeze(['running', 'timing-out', 'flooding', 'spawn-failing', 'done', 'timed-out', 'flooded', 'failed-to-start']);
export const CMD_MOVES = Object.freeze({
  running: Object.freeze(['timing-out', 'flooding', 'spawn-failing', 'done']),
  'timing-out': Object.freeze(['timed-out']),
  flooding: Object.freeze(['flooded']),
  'spawn-failing': Object.freeze(['failed-to-start']),
  done: Object.freeze([]), 'timed-out': Object.freeze([]), flooded: Object.freeze([]), 'failed-to-start': Object.freeze([]),
});
/** The ending each state reaches when the process is gone. */
export const CMD_ENDING = Object.freeze({ running: 'done', 'timing-out': 'timed-out', flooding: 'flooded', 'spawn-failing': 'failed-to-start' });
export function moveCmd(cmd, to) {
  if (!CMD_STATES.includes(to)) throw new Error(`command: no such state ${String(to).slice(0, 20)}`);
  if (!CMD_MOVES[cmd.state].includes(to)) throw new Error(`command: cannot go from ${cmd.state} to ${to}`);
  cmd.state = to;
  return cmd;
}

/**
 * Run one command: the program and its argv, `shell: false`, so no string of ours or the page's is ever parsed by a shell
 * (this is execFile's guarantee; `spawn` is used because execFile cannot start a process group, and a time limit has to
 * stop a command's children too). In its own process group; stdin closed (nothing can prompt); output read as it comes
 * and stopped past OUTPUT.maxBuffer. Never rejects.
 * → { exit, signal, timedOut, spawnError, output, truncated, ms }. `onChild(stop)` hands the caller a way to stop it.
 */
export function runCommand({ argv, cwd, env, limitMs, onChild, onLine }) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const cmd = { state: 'running' };
    let spawnCode = '';
    let timer = null;
    let killer = null;
    const out = [];
    const err = [];
    let size = 0;
    let child = null;
    const killGroup = sig => { try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch { /* gone */ } } };
    const stop = to => { moveCmd(cmd, to); killGroup('SIGTERM'); killer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS); };
    // THE one place a result is made: only a move into an ending gets here, and nothing leaves an ending
    const finish = (code, signal) => {
      if (!CMD_ENDING[cmd.state]) return;
      moveCmd(cmd, CMD_ENDING[cmd.state]);
      clearTimeout(timer); clearTimeout(killer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      const capped = capOutput(`${stdout}${stderr ? `${stdout ? '\n' : ''}[stderr]\n${stderr}` : ''}${cmd.state === 'flooded' ? '\n[stopped: the command printed more than it may]' : ''}`);
      resolve({ exit: typeof code === 'number' && cmd.state !== 'flooded' ? code : null, signal: signal || '', timedOut: cmd.state === 'timed-out',
        spawnError: cmd.state === 'failed-to-start' ? (spawnCode || 'SPAWN') : (cmd.state === 'flooded' ? 'OUTPUT_LIMIT' : ''),
        output: capped.text, truncated: capped.truncated || cmd.state === 'flooded', ms: Date.now() - t0 });
    };
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { moveCmd(cmd, 'spawn-failing'); spawnCode = 'SPAWN'; err.push(Buffer.from(String((e && e.message) || e))); return finish(null, ''); }
    let partial = '';
    const take = list => chunk => {
      if (cmd.state !== 'running') return;
      if (typeof onLine === 'function') { partial += chunk.toString('utf8'); const ls = partial.split('\n'); partial = ls.pop().slice(-400); for (const l of ls) if (l.trim()) { try { onLine(l.replace(ANSI, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, 200)); } catch { /* a bad listener never stops the command */ } } }
      size += chunk.length;
      if (size > OUTPUT.maxBuffer) { stop('flooding'); return; }
      list.push(chunk);
    };
    child.stdout.on('data', take(out));
    child.stderr.on('data', take(err));
    child.on('error', e => { if (cmd.state === 'running') { moveCmd(cmd, 'spawn-failing'); spawnCode = (e && e.code) || 'SPAWN'; } finish(null, ''); });
    child.on('close', (code, signal) => finish(code, signal));
    timer = setTimeout(() => { if (cmd.state === 'running') stop('timing-out'); }, limitMs);
    if (typeof onChild === 'function') onChild(() => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref(); }, child.pid);
  });
}

/**
 * The pre-flight: run the owner's `check` command ONCE, before a run writes anything. Asynchronous (the companion keeps answering while
 * it runs), in its own process group like every step, stopped at TIME_LIMITS_MS.check. → Promise<{ ok, message }>: `message` is the
 * command's own plain words (the tail of what it printed), or why it could not run or did not answer.
 */
export async function runCheck({ argv, cwd, env, exec = runCommand }) {
  const r = await exec({ argv, cwd, env, limitMs: TIME_LIMITS_MS.check });
  const text = String(r.output || '').split('\n').filter(l => l !== '[stderr]').join('\n').trim();
  if (r.timedOut) return { ok: false, message: `The check did not answer within ${TIME_LIMITS_MS.check / 1000} seconds.` };
  if (r.spawnError) return { ok: false, message: `The check could not be started (${r.spawnError}).` };
  if (r.exit !== 0) return { ok: false, message: text.split('\n').slice(-60).join('\n') || `The check failed (exit ${r.exit}).` };
  return { ok: true, message: text };
}
