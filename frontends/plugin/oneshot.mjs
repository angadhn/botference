// oneshot.mjs — one question to a bot, in a fresh session with no tools.
//
// A TK gap (tkgaps.mjs) is filled by a bot that has read nothing of the page's
// conversation and can do nothing but write text: it is NOT a turn on the
// page's own agent session (which holds the page snapshot, every guest's
// message, every earlier bot reply, and the bots' ordinary tools). So the
// companion starts the bot's CLI itself, once, here:
//
//   claude -p, with no built-in tools at all (`--tools ""`, the form the
//   council's own title call and the Doc-comment watcher use), no MCP servers
//   (`--strict-mcp-config` with none given), no user, project or local
//   settings files (`--restricted`), every tool also denied by settings, no
//   session to resume, in a fresh empty folder; the prompt on stdin; the
//   answer read as plain text and cut at a hard limit; the process killed if
//   it runs past its time, so an abandoned gap is not left running.
//
// Codex (`codex exec`, the CLI's non-interactive form) has no tool-less switch, so it is LOCKED DOWN as far as
// its flags go (CODEX_LOCKDOWN, below): no user config (`--ignore-user-config`, so no MCP servers, profiles or
// rules from the owner's ~/.codex; auth still comes from there), no execpolicy rules, nothing saved
// (`--ephemeral`), a read-only sandbox, approvals never asked (`approval_policy="never"`), web search off, no MCP
// servers, and the tools that run or look at anything turned off as features (shell, unified exec, apps, plugins,
// browser and computer use, image tools, sub-agents, hooks, memories, goals). Recorded against a local mock provider
// (SPEC, "Containing the Codex one-shot"): with these flags the only tool the CLI offers the model is
// `request_user_input` (asks the user a question; nothing to run or read), and a call to `exec_command` is answered
// "unsupported call". The flags are not the whole lock: the CLI is also JAILED (codexJail, oneshot-codex.sb), so
// even a tool that slipped through could read no file under /Users or /Volumes but the CLI's own folder and its two
// fresh folders, start no program but the CLI, and reach no port but 443. Where that jail cannot be made (no
// sandbox-exec: anything but macOS) a Codex gap FAILS ("Codex cannot be contained on this system"); nothing runs.
//
// Both CLIs get a MINIMAL environment (oneshotEnv): HOME, PATH, TMPDIR, LANG, USER, LOGNAME and the variables that
// CLI reads to sign in (ONESHOT_AUTH_ENV, names only; their values are never logged). Nothing else of the companion's
// own environment (its passwords, tokens, the owner's other keys) reaches the child.
//
// Claude is not jailed: it is already tool-less (`--tools ""`), and whether its sign-in (the macOS keychain, its own
// folder) works inside a jail could only be shown by calling a model, which is not done here. It gets the minimal
// environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ONESHOT_AGENTS = Object.freeze(['claude', 'codex']);
// What makes `codex exec` as close to a tool-less one-shot as its flags allow (see above). Every item is checked by the tests.
export const CODEX_OFF_FEATURES = Object.freeze(['shell_tool', 'unified_exec', 'apps', 'plugins', 'browser_use', 'browser_use_external',
  'computer_use', 'in_app_browser', 'image_generation', 'view_image', 'multi_agent', 'hooks', 'memories', 'tool_suggest', 'skill_search',
  'skill_mcp_dependency_install', 'goals']);
export const CODEX_LOCKDOWN = Object.freeze(['--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
  '--sandbox', 'read-only', '--color', 'never',
  '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'sandbox_workspace_write.network_access=false',
  ...CODEX_OFF_FEATURES.flatMap(f => ['--disable', f])]);
// The jail's profile (macOS seatbelt), shipped beside this file.
export const CODEX_JAIL_PROFILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'oneshot-codex.sb');
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const CODEX_UNCONTAINED = 'Codex cannot be contained on this system';
// What a one-shot's child gets of the companion's environment: these names, when set, and nothing else.
export const ONESHOT_BASE_ENV = Object.freeze(['HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'LOGNAME']);
// …plus the names each CLI reads to sign in (an API key, a token, its own folder). Names only: values are never logged.
export const ONESHOT_AUTH_ENV = Object.freeze({
  claude: Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR']),
  codex: Object.freeze(['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_HOME']),
});
const UTF8 = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
/** The environment a one-shot of `agent` runs with, from `from` (the companion's own). */
export function oneshotEnv(agent, from = process.env) {
  const env = {};
  for (const k of [...ONESHOT_BASE_ENV, ...(ONESHOT_AUTH_ENV[agent] || [])]) if (typeof from[k] === 'string' && from[k] !== '') env[k] = from[k];
  if (!env.LANG) env.LANG = UTF8;
  return env;
}
// a program's real path on PATH, or ''
export function whichReal(name, env = process.env) {
  if (path.isAbsolute(name)) { try { return fs.realpathSync(name); } catch { return ''; } }
  for (const d of String(env.PATH || '').split(path.delimiter)) {
    if (!d) continue;
    const f = path.join(d, name);
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return fs.realpathSync(f); } catch { /* next */ }
  }
  return '';
}
const realOr = p => { try { return fs.realpathSync(p); } catch { return p; } };
/**
 * The jail a Codex one-shot runs in: → { ok: true, argv } (what goes before the CLI's own argv: sandbox-exec, the profile and its
 * parameters, the CLI's real path) or { ok: false, error } when it cannot be made here. Nothing is run.
 */
export function codexJail({ env = process.env, work, out, platform = process.platform, sandboxExec = SANDBOX_EXEC, profile = CODEX_JAIL_PROFILE,
  bin = '' } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(sandboxExec) || !fs.existsSync(profile)) return { ok: false, error: CODEX_UNCONTAINED };
  const home = env.HOME ? realOr(env.HOME) : '';
  if (!home || !path.isAbsolute(home)) return { ok: false, error: CODEX_UNCONTAINED };
  const cliHome = realOr(env.CODEX_HOME || path.join(home, '.codex'));
  const cli = bin || whichReal('codex', env);
  if (!cli) return { ok: false, error: 'could not start codex' };
  return { ok: true, argv: [sandboxExec, '-f', profile, '-D', `HOME=${home}`, '-D', `CLI_HOME=${cliHome}`, '-D', `WORK=${realOr(work)}`,
    '-D', `OUT=${realOr(out)}`, '-D', `CLI_BIN=${cli}`, cli] };
}
// the efforts each CLI is given (the owner's chat setting; medium when none is set)
export const DEFAULT_EFFORT = 'medium';

// ---- WHAT A `/tk` PASSAGE MAY USE (tk-read.mjs TK_CAPS): the tools each capability set allows, by the CLI's own controls -----------
// Claude: an explicit allow-list (`--tools`, and the same names allowed in --settings with every other tool denied), `--restricted`
// (no command-running tools; no user, project or local settings files; the file tools confined to the working folder and the
// `--add-dir` folders), `--strict-mcp-config` with none given (no MCP servers), `--no-session-persistence` (nothing saved), and the
// stream of events (`--output-format stream-json --verbose`) so what it fetched and read can be recorded. Verified against
// `claude --help` (2.1.330) on the owner's machine, 2026-11-27.
export const CAPS_TOOLS = Object.freeze({ none: Object.freeze([]), web: Object.freeze(['WebSearch', 'WebFetch']),
  'web+notes': Object.freeze(['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']) });
const DENY_ALWAYS = ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'mcp__*'];
/** How long a one-shot may run: a run with tools reads and searches, so longer; never past the ceiling of its set. */
export function timeLimitFor(caps, asked = 0) {
  const ceiling = caps === 'none' ? 90000 : 180000;
  return asked > 0 ? Math.min(asked, ceiling) : ceiling;
}
const DENY_ALL = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'mcp__*'];

/** The command for a one-shot of `agent`, or null when there is none. `dir` is the fresh working folder, `out` the file codex
 *  writes its last message to (outside that folder). */
export function oneshotCommand(agent, { model = '', effort = '', dir = '', out = '', caps = 'none', roots = [] } = {}) {
  if (agent === 'claude' && caps !== 'none') {
    const tools = CAPS_TOOLS[caps] || [];
    const deny = [...DENY_ALWAYS, ...['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].filter(t => !tools.includes(t))];
    return { cmd: 'claude', stream: true, args: ['-p', '--tools', tools.join(','), '--strict-mcp-config', '--restricted', '--no-session-persistence',
      '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: tools.slice(), deny } }),
      '--output-format', 'stream-json', '--verbose',
      ...(caps === 'web+notes' ? roots.flatMap(r => ['--add-dir', String(r)]) : []),
      ...(model ? [`--model=${String(model)}`] : []), ...(effort ? [`--effort=${String(effort)}`] : [])] };
  }
  if (agent === 'claude') {
    return { cmd: 'claude', args: ['-p', '--tools', '', '--strict-mcp-config', '--restricted',
      '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: [], deny: DENY_ALL } }),
      '--output-format', 'text', ...(model ? [`--model=${String(model)}`] : []), ...(effort ? [`--effort=${String(effort)}`] : [])] };
  }
  if (agent === 'codex') {
    // (web: the model provider's own search tool, run on its side; Codex reads files only through its shell, which it never gets, so
    // it is never given notes. `--json`: its events on stdout, to record what it searched)
    const lock = caps === 'none' ? CODEX_LOCKDOWN : CODEX_LOCKDOWN.map(a => (a === 'web_search="disabled"' ? 'web_search="live"' : a));
    return { cmd: 'codex', args: ['exec', ...lock, ...(caps === 'none' ? [] : ['--json']), '--cd', dir, '-o', out,
      ...(model ? [`--model=${String(model)}`] : []), '-c', `model_reasoning_effort="${String(effort || DEFAULT_EFFORT).replace(/[^\w-]/g, '')}"`, '-'],
      lastMessage: out };
  }
  return null;
}

/**
 * → Promise<{ ok: true, text, model? } | { ok: false, error }>. Never throws.
 * `spawn` is injectable for the tests (a stand-in that records what it was
 * given and answers, or never answers).
 */
export function runOneShot(agent, prompt, { model = '', effort = '', timeoutMs = 0, maxBytes = 64 * 1024, spawn = realSpawn,
  env: fromEnv = process.env, jail = codexJail, claudeJail: jailClaude = claudeJail, caps = 'none', roots = [] } = {}) {
  const limit = timeLimitFor(caps, timeoutMs || 0);
  if (!ONESHOT_AGENTS.includes(agent)) return Promise.resolve({ ok: false, error: `${agent} cannot fill gaps here` });
  // a model name is one argument and never a flag (store.mjs MODEL_RE says the same for what is stored)
  if (/^-/.test(String(model))) return Promise.resolve({ ok: false, error: 'the model name may not begin with -' });
  return new Promise(resolve => {
    let dir = '';
    let outDir = '';
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-')); } catch { resolve({ ok: false, error: 'could not make a folder for the agent' }); return; }
    try { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-out-')); } catch { outDir = ''; }
    const c = oneshotCommand(agent, { model, effort, dir, out: outDir ? path.join(outDir, 'last.txt') : '', caps, roots });
    const drop = error => { for (const d of [dir, outDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } resolve({ ok: false, error }); };
    if (!c || (c.lastMessage === '' && agent === 'codex')) { drop(`could not start ${agent}`); return; }
    const env = oneshotEnv(agent, fromEnv);
    if (agent === 'codex') {
      // jailed, or not run at all
      const j = jail({ env, work: dir, out: outDir });
      if (!j || !j.ok) { drop((j && j.error) || CODEX_UNCONTAINED); return; }
      c.args = [...j.argv.slice(1), ...c.args];
      c.cmd = j.argv[0];
    }
    if (agent === 'claude' && caps !== 'none') {
      // with tools, Claude is wrapped too (claudeJail): it writes nowhere but its own folders and starts no other program
      const j = jailClaude({ env, work: dir, roots: caps === 'web+notes' ? roots : [] });
      if (!j || !j.ok) { drop((j && j.error) || CLAUDE_UNCONTAINED); return; }
      c.args = [...j.argv.slice(1), ...c.args];
      c.cmd = j.argv[0];
    }
    let child;
    let out = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => { for (const d of [dir, outDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a temp folder */ } } };
    const done = r => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    // the wait abandoned is the run stopped: nothing keeps running (or billing)
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch { /* gone */ } done({ ok: false, error: caps === 'none' ? 'the agent took too long' : `the agent took too long (the limit is ${limit >= 1000 ? `${Math.round(limit / 1000)} s` : `${limit} ms`})` }); }, limit);
    try { child = spawn(c.cmd, c.args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch (e) { done({ ok: false, error: `could not start ${agent}` }); return; }
    child.on('error', () => done({ ok: false, error: `could not start ${agent}` }));
    child.stdout.on('data', d => {
      // claude answers on stdout; codex's stdout is its progress, read only to stop a flood
      out = Buffer.concat([out, d]);
      if (out.length > maxBytes) { try { child.kill('SIGKILL'); } catch { /* gone */ } out = out.subarray(0, maxBytes); }
    });
    child.on('close', code => {
      if (settled) return;
      let text = '';
      let full = false;
      let usedOf = null;
      if (c.lastMessage) {
        // codex: the last message only, from its own file, as text, under the same cap
        try { const buf = fs.readFileSync(c.lastMessage); full = buf.length >= maxBytes; text = buf.subarray(0, maxBytes).toString('utf8').trim(); } catch { text = ''; }
        if (caps !== 'none') usedOf = usedFromCodex(out.toString('utf8'));
      } else if (c.stream) {
        // claude with tools: its events, one JSON object a line; the text is the final result's, and the tools it used are recorded
        const s = readStream(out.toString('utf8'));
        if (s.error) { done({ ok: false, error: s.error }); return; }
        text = s.text; usedOf = s.used; full = out.length >= maxBytes;
      } else { text = out.toString('utf8').trim(); full = out.length >= maxBytes; }
      const extra = usedOf ? { used: usedOf.used, sources: usedOf.sources } : {};
      if (code === 0 || (text && full)) { done(text ? { ok: true, text, ...(model ? { model } : {}), ...extra } : { ok: false, error: 'the agent wrote nothing' }); return; }
      done({ ok: false, error: `the agent stopped (exit ${code})` });
    });
    try { child.stdin.end(String(prompt)); } catch { /* the close handler answers */ }
  });
}

// ---- what a passage used, from the CLI's own events (kept privately on the gap; never in the post) ---------------------------------
export const TK_USED = Object.freeze(['none', 'web', 'notes', 'both']);
const usedOfSources = sources => (sources.web.length && sources.notes.length ? 'both' : sources.web.length ? 'web' : sources.notes.length ? 'notes' : 'none');
const clip = (v, n = 500) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
/** Claude's stream (`--output-format stream-json --verbose`): → { text, used: { used, sources } } or { error } */
export function readStream(raw) {
  const sources = { web: [], notes: [] };
  let result = null;
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev && ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
      for (const b of ev.message.content) {
        if (!b || b.type !== 'tool_use' || !b.input) continue;
        if (b.name === 'WebFetch' && b.input.url) sources.web.push(clip(b.input.url));
        else if (b.name === 'WebSearch' && b.input.query) sources.web.push(`search: ${clip(b.input.query, 200)}`);
        else if (b.name === 'Read' && b.input.file_path) sources.notes.push(clip(b.input.file_path));
        else if ((b.name === 'Glob' || b.name === 'Grep') && (b.input.path || b.input.pattern)) sources.notes.push(clip(`${b.name.toLowerCase()}: ${b.input.path || ''} ${b.input.pattern || ''}`.trim()));
      }
    }
    if (ev && ev.type === 'result') result = ev;
  }
  for (const k of ['web', 'notes']) sources[k] = [...new Set(sources[k])].slice(0, 50);
  if (!result) return { error: 'the agent wrote nothing' };
  if (result.is_error || result.subtype !== 'success' || typeof result.result !== 'string') return { error: 'the agent stopped before it finished' };
  return { text: result.result.trim(), used: { used: usedOfSources(sources), sources } };
}
/** Codex's events (`--json`): searches recorded where its events name them (best effort: the event format is the CLI's) */
export function usedFromCodex(raw) {
  const sources = { web: [], notes: [] };
  for (const line of String(raw).split('\n')) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    const item = ev && (ev.item || ev.msg || ev);
    const kind = String((item && (item.type || item.item_type)) || '');
    if (/web_search/.test(kind)) sources.web.push(`search: ${clip(item.query || (item.action && item.action.query) || '', 200)}`);
  }
  sources.web = [...new Set(sources.web)].slice(0, 50);
  return { used: usedOfSources(sources), sources };
}

// ---- THE CLAUDE WRAPPER (macOS seatbelt), for a run with tools ------------------------------------------------------------------------
// What it makes true at the OS level, whatever the CLI does: NO WRITE anywhere but the run's own folder, the CLI's own folder and its
// state file (~/.claude, ~/.claude.json: the CLI writes them as it runs); NO PROGRAM but the CLI's own install; NO READ of the secret
// places (SECRET_PLACES) or of other temporary folders. Reads elsewhere under the home folder are NOT refused at this level: Claude's
// sign-in reads files under the home folder that cannot be listed here (a profile limiting reads to the CLI's folders and the roots
// left it signed out), so "no read outside the roots" rests on the CLI's own confinement (--restricted: its file tools see only the
// working folder and the --add-dir roots) and on its tools being only Read, Glob and Grep. The network is allowed (web search).
export const CLAUDE_UNCONTAINED = 'Claude cannot be contained on this system';
export const SECRET_PLACES = Object.freeze(['.ssh', '.botference', '.botference-backup', '.blyg-inbox-token', '.aws', '.gnupg', '.codex', '.supabase',
  '.cloudflared', '.netrc', '.npmrc', '.pypirc', '.docker', '.kube', 'Library/Keychains']);
const SAFE_PROFILE_PATH = /^\/[A-Za-z0-9 ._@+,()'&~/-]+$/;
const q = p => { if (!SAFE_PROFILE_PATH.test(p) || /["\\]/.test(p)) throw new Error('a path a sandbox rule cannot hold'); return `"${p}"`; };
const reEsc = p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** → { ok: true, argv } (sandbox-exec -p <profile> <claude>) or { ok: false, error }. `install`: the CLI's own folder (tests: a stub's). */
export function claudeJail({ env = process.env, work, roots = [], platform = process.platform, sandboxExec = SANDBOX_EXEC, bin = '', install = '' } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(sandboxExec)) return { ok: false, error: CLAUDE_UNCONTAINED };
  const home = env.HOME ? realOr(env.HOME) : '';
  if (!home || !path.isAbsolute(home)) return { ok: false, error: CLAUDE_UNCONTAINED };
  const cli = bin || whichReal('claude', env);
  if (!cli) return { ok: false, error: 'could not start claude' };
  const dir = install || path.dirname(cli);
  const cliHome = realOr(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  let profile;
  try {
    profile = [
      '(version 1)',
      '; oneshot.mjs claudeJail: a /tk passage\'s Claude with tools (see the comment there for what it does and does not refuse)',
      '(allow default)',
      `(deny file-read* ${SECRET_PLACES.map(s => `(subpath ${q(path.join(home, s))})`).join(' ')} (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))`,
      `(allow file-read* (subpath ${q(realOr(work))})${roots.map(r => ` (subpath ${q(realOr(r))})`).join('')})`,
      '(deny file-write*)',
      `(allow file-write* (subpath ${q(realOr(work))}) (subpath ${q(cliHome)}) (regex #"^${reEsc(home)}/\\.claude\\.json") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
      '(deny process-exec)',
      `(allow process-exec (subpath ${q(realOr(dir))}))`,
    ].join('\n');
  } catch (e) { return { ok: false, error: CLAUDE_UNCONTAINED }; }
  return { ok: true, argv: [sandboxExec, '-p', profile, cli] };
}
