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
// A Codex run WITH tools (a /tk passage: web, web+notes) differs in three named ways, each below: its web search is on; on the CLI
// version it was verified on (CODEX_NOTES_VERSION) the CLI's own code-mode helper may start (the search and any tool server need it);
// and a notes run is given ONE tool server, the companion's read-only notes reader (tk-notes-reader.mjs), in a wrapper that also
// refuses every write outside the run's own folders.
//
// Both CLIs get a MINIMAL environment (oneshotEnv): HOME, PATH, TMPDIR, LANG, USER, LOGNAME and the variables that
// CLI reads to sign in (ONESHOT_AUTH_ENV, names only; their values are never logged). Nothing else of the companion's
// own environment (its passwords, tokens, the owner's other keys) reaches the child.
//
// Claude WITHOUT tools (the changelog line) is not jailed: it is already tool-less (`--tools ""`). Claude WITH tools (a /tk passage)
// is wrapped (claudeJail, below). Both get the minimal environment.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as realSpawn, execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TK_CAPS_TIME_MS } from './tk-read.mjs';

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
// the path as the disk has it (its names' own case on macOS), for the Claude wrapper's rules
const realNative = p => { try { return fs.realpathSync.native(p); } catch { return p; } };
/**
 * The jail a Codex one-shot runs in: → { ok: true, argv } (what goes before the CLI's own argv: sandbox-exec, the profile and its
 * parameters, the CLI's real path) or { ok: false, error } when it cannot be made here. Nothing is run.
 */
// A NOTES RUN (`roots` given: the capability set web+notes): the same profile with more rules AFTER it, so they decide (seatbelt: the
// last matching rule wins). What they add, and nothing else:
//   READ under each read root (and a look-up, never a listing, of the folders above it);
//   START two more programs: `reader` (the Node binary that runs tk-notes-reader.mjs, the CLI's only tool for notes; the script itself
//     is copied into the run's own fresh folder, so no folder of the companion's is opened to the run), and the CLI's own code-mode
//     helper beside its binary (CODEX_CODE_MODE_HOST, below: without it the CLI cannot call a tool server at all);
//   NO READ of other temporary folders (/private/tmp, /private/var/folders, /private/var/tmp) but the run's two and the roots;
//   NO WRITE at all but the CLI's own folder and the run's two (the profile above refuses writes under /Users and /Volumes only);
//   and LAST, no read or write of the private places under the home folder (CLAUDE_PRIVATE_PLACES, less the CLI's own folder), whatever
//     a root or a link says.
// There is still no shell and no write anywhere but the CLI's own folder and the run's two.
export function codexJail({ env = process.env, work, out, platform = process.platform, sandboxExec = SANDBOX_EXEC, profile = CODEX_JAIL_PROFILE,
  bin = '', roots = [], reader = '', codeMode = false } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(sandboxExec) || !fs.existsSync(profile)) return { ok: false, error: CODEX_UNCONTAINED };
  const home = env.HOME ? realOr(env.HOME) : '';
  if (!home || !path.isAbsolute(home)) return { ok: false, error: CODEX_UNCONTAINED };
  const cliHome = realOr(env.CODEX_HOME || path.join(home, '.codex'));
  const cli = bin || whichReal('codex', env);
  if (!cli) return { ok: false, error: 'could not start codex' };
  const params = ['-D', `HOME=${home}`, '-D', `CLI_HOME=${cliHome}`, '-D', `WORK=${realOr(work)}`, '-D', `OUT=${realOr(out)}`, '-D', `CLI_BIN=${cli}`];
  if (!roots.length && !codeMode) return { ok: true, argv: [sandboxExec, '-f', profile, ...params, cli] };
  // (`codeMode`: the run may start the CLI's own code-mode helper, CODEX_CODE_MODE_HOST below; a web run needs it to search, a notes
  // run to call its reader)
  const host = path.join(path.dirname(cli), CODEX_CODE_MODE_HOST);
  let hostRule;
  try { hostRule = codeMode && fs.existsSync(host) ? `(allow process-exec (literal ${q(realNative(host))}))` : ''; } catch { return { ok: false, error: CODEX_UNCONTAINED }; }
  if (!roots.length && !hostRule) return { ok: true, argv: [sandboxExec, '-f', profile, ...params, cli] };
  if (!roots.length) {
    let base;
    try { base = fs.readFileSync(profile, 'utf8'); } catch { return { ok: false, error: CODEX_UNCONTAINED }; }
    return { ok: true, argv: [sandboxExec, '-p', [base, '; oneshot.mjs codexJail: the CLI\'s own code-mode helper may start', hostRule].join('\n'), ...params, cli] };
  }
  let text;
  try {
    if (!reader || !path.isAbsolute(reader)) throw new Error('no reader');
    const real = roots.map(r => realNative(r));
    const node = realNative(reader);
    const priv = CLAUDE_PRIVATE_PLACES.filter(s => realNative(path.join(home, s)) !== realNative(cliHome)).map(s => `(subpath ${q(path.join(realNative(home), s))})`).join(' ');
    text = [fs.readFileSync(profile, 'utf8'),
      '; oneshot.mjs codexJail, a notes run: the rules below come after the profile above and decide',
      '(deny file-read* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))',
      // (a path there may be looked up, never listed or read: the run's own folders are found one name at a time)
      '(allow file-read-metadata (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))',
      '(allow file-read* (subpath (param "CLI_HOME")) (subpath (param "WORK")) (subpath (param "OUT")))',
      `(allow file-read* ${real.map(r => `(subpath ${q(r)})`).join(' ')})`,
      `(allow file-read-metadata ${[...new Set(real.flatMap(r => ancestorsOf(r)))].map(a => `(literal ${q(a)})`).join(' ')})`,
      // (a Node installed under the home folder: its own install may be read; one outside /Users is readable already)
      ...(/^\/(Users|Volumes)\//.test(node) ? [`(allow file-read* (subpath ${q(path.dirname(path.dirname(node)))}))`,
        `(allow file-read-metadata ${ancestorsOf(node).map(a => `(literal ${q(a)})`).join(' ')})`] : []),
      `(allow process-exec (literal ${q(node)}))`,
      hostRule,
      // NO WRITE ANYWHERE (not only under /Users and /Volumes: a root may be on any path) but the CLI's own folder and the run's two
      '(deny file-write*)',
      '(allow file-write* (subpath (param "CLI_HOME")) (subpath (param "WORK")) (subpath (param "OUT")) (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
      `(deny file-read* file-write* ${priv})`,
    ].join('\n');
  } catch { return { ok: false, error: CODEX_UNCONTAINED }; }
  return { ok: true, argv: [sandboxExec, '-p', text, ...params, cli] };
}
// THE READER a Codex notes run is given (tk-notes-reader.mjs): three read-only tools confined to the read roots, started by the CLI as
// a tool server, its calls approved on the command line for this run only (the owner's ~/.codex/config.toml is never read or
// changed: --ignore-user-config). Verified with real runs on Codex CLI 0.167.2 (2026-11-27): the `-c mcp_servers.<name>` table, its
// `default_tools_approval_mode` and `enabled_tools` are that version's; on any other version a Codex passage does not read notes
// (CODEX_NOTES_OFF_SAY) and runs with the web only. The version is asked once per companion start.
export const CODEX_NOTES_VERSION = '0.167.2';
// THE CLI'S OWN HELPER: on 0.167.2 the model reaches a tool server, AND THE WEB SEARCH, only through the CLI's "code mode", which runs
// in a second program shipped beside the CLI (with that feature off, every call of the reader fails: "code-mode host is disabled";
// with the program refused by the wrapper, as it was until 2026-11-27, a web passage answered "the web search tool was unavailable":
// real runs). So a run with tools (web, web+notes) on the verified version may start that one program too. It runs small scripts the model writes, in a bare script engine: asked in a real run
// to list everything it could reach, it showed the language's own objects and the CLI's tool bindings, and no file, process or network
// interface. THAT IS THE VENDOR'S DESIGN, NOT A RULE OF THIS WRAPPER: the helper runs under the same profile as the CLI, so the
// profile cannot stop it reading the CLI's own folder (sign-in included) if a later version gave its scripts a file interface. Hence
// the exact-version gate above, and SPEC "Codex reads notes" says so in the owner's words.
export const CODEX_CODE_MODE_HOST = 'codex-code-mode-host';
export const CODEX_NOTES_OFF_SAY = 'notes reading is off for Codex passages on this version of the Codex CLI';
export const CODEX_READER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tk-notes-reader.mjs');
export const CODEX_READER_TOOLS = Object.freeze(['list_notes', 'read_note', 'search_notes']);
export const parseCodexVersion = out => { const m = String(out || '').trim().match(/(?:^|\s)(\d+\.\d+\.\d+)\b/); return m ? m[1] : ''; };
let codexVersionOnce = null;
/** The installed Codex CLI's version ('' when it cannot be told), asked once per process and kept. */
export function codexVersion(env = process.env) {
  if (!codexVersionOnce) {
    codexVersionOnce = new Promise(resolve => {
      const e = oneshotEnv('codex', env);
      const bin = whichReal('codex', e);
      if (!bin) { resolve(''); return; }
      execFile(bin, ['--version'], { env: e, timeout: 15000, maxBuffer: 4096 }, (err, out) => resolve(err ? '' : parseCodexVersion(out)));
    });
  }
  return codexVersionOnce;
}
/** The same, at once (for `botference tk-read check`). */
export function codexVersionSync(env = process.env) {
  const e = oneshotEnv('codex', env);
  const bin = whichReal('codex', e);
  if (!bin) return '';
  const r = spawnSync(bin, ['--version'], { env: e, timeout: 15000, encoding: 'utf8' });
  return r.status === 0 ? parseCodexVersion(r.stdout) : '';
}
const tomlString = v => JSON.stringify(String(v));
/** The `-c` value that gives a Codex run its notes reader: `node`, the reader's copy in the run's folder, the roots. */
export const codexReaderConfig = ({ node, script, roots }) => `mcp_servers.notes={command=${tomlString(node)},args=[${tomlString(script)},${tomlString(JSON.stringify(roots))}],`
  + `default_tools_approval_mode="approve",enabled_tools=[${CODEX_READER_TOOLS.map(tomlString).join(',')}]}`;
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
// WHERE A NOTES RUN MAY FETCH (tk-read.mjs ownerHosts): a run that can read the owner's notes could carry them out in the address of a
// page it fetches, so it may fetch ONLY from the hosts the owner's own line names, by the CLI's own permission rules: an allow rule
// `WebFetch(domain:<host>)` for each (the syntax the CLI's own rule check names: "WebFetch permissions use domain format, not URLs …
// Use \"domain:hostname\"", checked in the 2.1.330 binary on this machine), never the bare `WebFetch`; with `dontAsk`, a fetch no allow
// rule covers is refused. The CLI also lets a fetch from its own list of documentation sites through without any rule (its
// "Preapproved host" check, after the allow rules); a deny rule is read before that, so in a notes run every one of those hosts the
// owner did not name is denied by name (CLAUDE_PREAPPROVED_FETCH_HOSTS: the host part of each entry of that list in 2.1.330). A notes
// run whose line names no host has no WebFetch at all. A web-only run (no notes) keeps an unrestricted WebFetch.
// (Whether a page found by a search may be fetched cannot be said by a rule fixed before the run starts: it is not, unless its host
// is one the owner named.)
export const CLAUDE_PREAPPROVED_FETCH_HOSTS = Object.freeze(['platform.claude.com', 'code.claude.com', 'claude.dev', 'www.claude.dev', 'claude.com',
  'modelcontextprotocol.io', 'github.com', 'raw.githubusercontent.com', 'agentskills.io', 'docs.python.org', 'en.cppreference.com', 'docs.oracle.com',
  'learn.microsoft.com', 'developer.mozilla.org', 'go.dev', 'www.php.net', 'docs.swift.org', 'kotlinlang.org', 'ruby-doc.org', 'doc.rust-lang.org',
  'www.typescriptlang.org', 'react.dev', 'angular.io', 'vuejs.org', 'nextjs.org', 'expressjs.com', 'nodejs.org', 'bun.sh', 'jquery.com',
  'getbootstrap.com', 'tailwindcss.com', 'd3js.org', 'threejs.org', 'redux.js.org', 'webpack.js.org', 'jestjs.io', 'reactrouter.com',
  'docs.djangoproject.com', 'flask.palletsprojects.com', 'fastapi.tiangolo.com', 'pandas.pydata.org', 'numpy.org', 'www.tensorflow.org', 'pytorch.org',
  'scikit-learn.org', 'matplotlib.org', 'requests.readthedocs.io', 'jupyter.org', 'laravel.com', 'symfony.com', 'wordpress.org', 'docs.spring.io',
  'hibernate.org', 'tomcat.apache.org', 'gradle.org', 'maven.apache.org', 'asp.net', 'dotnet.microsoft.com', 'blazor.net', 'reactnative.dev',
  'docs.flutter.dev', 'developer.apple.com', 'developer.android.com', 'keras.io', 'spark.apache.org', 'huggingface.co', 'www.kaggle.com',
  'www.mongodb.com', 'redis.io', 'www.postgresql.org', 'dev.mysql.com', 'www.sqlite.org', 'graphql.org', 'prisma.io', 'docs.getdbt.com',
  'docs.aws.amazon.com', 'cloud.google.com', 'kubernetes.io', 'www.docker.com', 'www.terraform.io', 'www.ansible.com', 'vercel.com', 'docs.stripe.com',
  'docs.netlify.com', 'devcenter.heroku.com', 'dev.wix.com', 'cypress.io', 'selenium.dev', 'docs.unity.com', 'docs.unrealengine.com', 'git-scm.com',
  'nginx.org', 'httpd.apache.org']);
// THE LIST ABOVE IS ONE VERSION'S: the deny rules match Claude Code 2.1.330 exactly. On any other version the CLI's own list may differ
// (a site added to it would pass a notes run's fetch unasked), so a notes run there gets NO WebFetch at all (WebSearch still), and its
// private record says so (FETCH_OFF_SAY); `botference tk-read check` says it too. Web-only runs are unaffected. The version is read
// with `claude --version`, once per companion start (claudeVersion, cached), never per run.
export const CLAUDE_FETCH_RULES_VERSION = '2.1.330';
export const FETCH_OFF_SAY = 'page fetching is off for notes runs on this version of Claude Code';
export const parseClaudeVersion = out => { const m = String(out || '').trim().match(/^(\d+\.\d+\.\d+)\b/); return m ? m[1] : ''; };
const fetchRulesHold = v => v === CLAUDE_FETCH_RULES_VERSION;
let versionOnce = null;
/** The installed Claude Code's version ('' when it cannot be told), asked once per process and kept. */
export function claudeVersion(env = process.env) {
  if (!versionOnce) {
    versionOnce = new Promise(resolve => {
      const e = oneshotEnv('claude', env);
      const bin = whichReal('claude', e);
      if (!bin) { resolve(''); return; }
      execFile(bin, ['--version'], { env: e, timeout: 15000, maxBuffer: 4096 }, (err, out) => resolve(err ? '' : parseClaudeVersion(out)));
    });
  }
  return versionOnce;
}
/** The same, at once (for `botference tk-read check`). */
export function claudeVersionSync(env = process.env) {
  const e = oneshotEnv('claude', env);
  const bin = whichReal('claude', e);
  if (!bin) return '';
  const r = spawnSync(bin, ['--version'], { env: e, timeout: 15000, encoding: 'utf8' });
  return r.status === 0 ? parseClaudeVersion(r.stdout) : '';
}
const FETCH_HOST_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** How long a one-shot may run: a run with tools reads and searches, so longer; never past the ceiling of its set (tk-read.mjs
 *  TK_CAPS_TIME_MS, the one place the limits are written). */
export function timeLimitFor(caps, asked = 0) {
  const ceiling = TK_CAPS_TIME_MS[caps] || TK_CAPS_TIME_MS.none;
  return asked > 0 ? Math.min(asked, ceiling) : ceiling;
}
const DENY_ALL = ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TodoWrite', 'mcp__*'];

/** The command for a one-shot of `agent`, or null when there is none. `dir` is the fresh working folder, `out` the file codex
 *  writes its last message to (outside that folder). `fetchHosts`: for a notes run, the hosts its owner's line names (above). */
export function oneshotCommand(agent, { model = '', effort = '', dir = '', out = '', caps = 'none', roots = [], fetchHosts = [], cliVersion = '',
  reader = null } = {}) {
  if (agent === 'claude' && caps !== 'none') {
    const notes = caps === 'web+notes';
    // (a notes run on a CLI version whose pre-approved list is not the one above: no host, so no WebFetch)
    const hosts = notes && fetchRulesHold(cliVersion) ? [...new Set((fetchHosts || []).map(h => String(h).toLowerCase()).filter(h => FETCH_HOST_RE.test(h)))] : [];
    const tools = (CAPS_TOOLS[caps] || []).filter(t => !(notes && t === 'WebFetch' && !hosts.length));
    const allow = tools.flatMap(t => (notes && t === 'WebFetch' ? hosts.map(h => `WebFetch(domain:${h})`) : [t]));
    const deny = [...DENY_ALWAYS, ...['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'].filter(t => !tools.includes(t)),
      ...(notes && hosts.length ? CLAUDE_PREAPPROVED_FETCH_HOSTS.filter(h => !hosts.includes(h)).map(h => `WebFetch(domain:${h})`) : [])];
    return { cmd: 'claude', stream: true, args: ['-p', '--tools', tools.join(','), '--strict-mcp-config', '--restricted', '--no-session-persistence',
      '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow, deny } }),
      '--output-format', 'stream-json', '--verbose',
      ...(notes ? roots.flatMap(r => ['--add-dir', String(r)]) : []),
      ...(model ? [`--model=${String(model)}`] : []), ...(effort ? [`--effort=${String(effort)}`] : [])] };
  }
  if (agent === 'claude') {
    return { cmd: 'claude', args: ['-p', '--tools', '', '--strict-mcp-config', '--restricted',
      '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: [], deny: DENY_ALL } }),
      '--output-format', 'text', ...(model ? [`--model=${String(model)}`] : []), ...(effort ? [`--effort=${String(effort)}`] : [])] };
  }
  if (agent === 'codex') {
    // (web: the model provider's own search tool, run on its side. notes: Codex reads files only through a shell, which it never
    // gets; it is given the read-only reader instead (`reader`: { node, script }, above), in place of "no tool servers". `--json`: its
    // events on stdout, to record what it searched and read)
    const web = caps === 'none' ? CODEX_LOCKDOWN : CODEX_LOCKDOWN.map(a => (a === 'web_search="disabled"' ? 'web_search="live"' : a));
    const notes = caps === 'web+notes' && !!reader && roots.length > 0;
    const lock = notes ? web.map(a => (a === 'mcp_servers={}' ? codexReaderConfig({ node: reader.node, script: reader.script, roots }) : a)) : web;
    return { cmd: 'codex', args: ['exec', ...lock, ...(caps === 'none' ? [] : ['--json']), '--cd', dir, '-o', out,
      ...(model ? [`--model=${String(model)}`] : []), '-c', `model_reasoning_effort="${String(effort || DEFAULT_EFFORT).replace(/[^\w-]/g, '')}"`, '-'],
      lastMessage: out };
  }
  return null;
}

// ---- READING A RUN'S EVENTS AS THEY ARRIVE (Claude's stream-json, Codex's --json) ----------------------------------------------------
// The events carry every tool's result (a note's full text, a fetched page), so they are never kept: each line is read as it comes,
// what is wanted is taken out of it (the final result's text, the tool-use inputs: addresses, paths, queries), capped, and the line is
// dropped. A line longer than lineBytes is skipped unread (no event worth keeping is that long); a run whose events pass totalBytes is
// stopped (a flood, not a passage).
export const STREAM_LIMITS = Object.freeze({ lineBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, sources: 50 });
/** Splits a byte stream into lines, holding at most `lineBytes` of the line under way. The line under way is in one of LINE_MODES, in
 *  one field, moved only by `to`: keeping (held, to be read at its end) or skipping (past lineBytes: dropped up to its end). */
export const LINE_MODES = Object.freeze(['keeping', 'skipping']);
const LINE_MOVES = Object.freeze({ keeping: Object.freeze(['keeping', 'skipping']), skipping: Object.freeze(['keeping']) });
export function lineSplitter(onLine, { lineBytes = STREAM_LIMITS.lineBytes } = {}) {
  let parts = [];
  let held = 0;
  let mode = 'keeping';
  const to = next => { if (!LINE_MOVES[mode].includes(next)) throw new Error(`line: cannot go from ${mode} to ${next}`); mode = next; };
  const keep = b => { parts.push(b); held += b.length; if (held > lineBytes) { parts = []; held = 0; to('skipping'); } };
  // a line's end: read it if it was kept; the next line starts kept
  const lineEnd = () => { if (mode === 'keeping' && held) onLine(Buffer.concat(parts).toString('utf8')); parts = []; held = 0; to('keeping'); };
  return {
    push(buf) {
      let from = 0;
      for (let nl = buf.indexOf(10, from); nl !== -1; nl = buf.indexOf(10, from)) {
        if (mode === 'keeping') keep(buf.subarray(from, nl));
        lineEnd();
        from = nl + 1;
      }
      if (from < buf.length && mode === 'keeping') keep(buf.subarray(from));
    },
    end() { lineEnd(); },
  };
}
// ---- what a passage used, from the CLI's own events (kept privately on the gap; never in the post) ---------------------------------
export const TK_USED = Object.freeze(['none', 'web', 'notes', 'both']);
const usedOfSources = sources => (sources.web.length && sources.notes.length ? 'both' : sources.web.length ? 'web' : sources.notes.length ? 'notes' : 'none');
const clip = (v, n = 500) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, n);
const addCapped = (list, v) => { if (v && list.length < STREAM_LIMITS.sources && !list.includes(v)) list.push(v); };
const cutBytes = (s, n) => { const b = Buffer.from(String(s), 'utf8'); return b.length <= n ? String(s) : b.subarray(0, n).toString('utf8').replace(/\uFFFD$/, ''); };
// THE WEB SEARCH TOOL'S OWN BOILERPLATE: Claude's web search asks the model to end its answer with a "Sources:" list of links. A passage
// is the owner's text with the agent's words: that list is taken off its end (only when it is exactly that: a "Sources:" line and
// then nothing but list items of links) and its addresses are kept in the private record instead.
const SOURCES_HEAD = /^\s*(?:\*\*|__)?(?:#+\s*)?sources:?(?:\*\*|__)?\s*$/i;
const SOURCE_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[^\]\n]*\]\((https?:\/\/[^\s)]+)\)|<?(https?:\/\/[^\s>]+)>?)\s*$/;
export function stripSourcesList(text) {
  const lines = String(text).replace(/\s+$/, '').split('\n');
  for (let i = lines.length - 1; i >= 1; i--) {
    if (!SOURCES_HEAD.test(lines[i])) continue;
    const items = lines.slice(i + 1).filter(l => l.trim());
    if (!items.length || !items.every(l => SOURCE_ITEM.test(l))) return { text: String(text).trim(), cited: [] };
    const cited = items.map(l => { const m = l.match(SOURCE_ITEM); return m[1] || m[2]; });
    const body = lines.slice(0, i).join('\n').trim();
    return body ? { text: body, cited } : { text: String(text).trim(), cited: [] };
  }
  return { text: String(text).trim(), cited: [] };
}
const toolText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && typeof x.text === 'string' ? x.text : '')).join(' ') : '').slice(0, 400);
/** Claude's stream (`--output-format stream-json --verbose`), a line at a time: push(line), then end() → { text, used: { used, sources } }
 *  or { error }. `sources`: web (searches, fetched addresses, the addresses a stripped "Sources:" list cited), notes (paths read,
 *  globs, greps), refused (fetches the permission rules refused). */
export function claudeStream({ maxText = 64 * 1024 } = {}) {
  const sources = { web: [], notes: [], refused: [] };
  const fetches = new Map();   // WebFetch tool_use id → its address, to name a refused one
  let result = null;
  return {
    push(line) {
      if (!line || !line.trim()) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      if (ev.type === 'assistant') {
        for (const b of content) {
          if (!b || b.type !== 'tool_use' || !b.input) continue;
          if (b.name === 'WebFetch' && b.input.url) { addCapped(sources.web, clip(b.input.url)); if (b.id && fetches.size < 500) fetches.set(String(b.id), clip(b.input.url)); }
          else if (b.name === 'WebSearch' && b.input.query) addCapped(sources.web, `search: ${clip(b.input.query, 200)}`);
          else if (b.name === 'Read' && b.input.file_path) addCapped(sources.notes, clip(b.input.file_path));
          else if ((b.name === 'Glob' || b.name === 'Grep') && (b.input.path || b.input.pattern)) addCapped(sources.notes, clip(`${b.name.toLowerCase()}: ${b.input.path || ''} ${b.input.pattern || ''}`.trim()));
        }
      } else if (ev.type === 'user') {
        // (a tool's result: only whether a fetch was refused is looked at; its text is never kept)
        for (const b of content) {
          if (!b || b.type !== 'tool_result' || !b.is_error || !fetches.has(String(b.tool_use_id))) continue;
          if (/permission|denied|haven't granted|not allowed/i.test(toolText(b.content))) addCapped(sources.refused, fetches.get(String(b.tool_use_id)));
        }
      } else if (ev.type === 'result') {
        result = { ok: !ev.is_error && ev.subtype === 'success' && typeof ev.result === 'string', text: typeof ev.result === 'string' ? cutBytes(ev.result, maxText) : '' };
        for (const d of Array.isArray(ev.permission_denials) ? ev.permission_denials : []) {
          if (d && d.tool_name === 'WebFetch' && d.tool_input && d.tool_input.url) addCapped(sources.refused, clip(d.tool_input.url));
        }
      }
    },
    end() {
      if (!result) return { error: 'the agent wrote nothing' };
      if (!result.ok) return { error: 'the agent stopped before it finished' };
      const s = stripSourcesList(result.text);
      for (const u of s.cited) addCapped(sources.web, clip(u));
      sources.web = sources.web.filter(u => !sources.refused.includes(u));
      return { text: s.text, used: { used: usedOfSources(sources), sources } };
    },
  };
}
/** The whole of a Claude stream at once (the same reader). */
export function readStream(raw) {
  const r = claudeStream();
  for (const line of String(raw).split('\n')) r.push(line);
  return r.end();
}
/** Codex's events (`--json`), a line at a time: searches recorded where its events name them (best effort: the format is the CLI's) */
export function codexStream() {
  const sources = { web: [], notes: [], refused: [] };
  return {
    push(line) {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      const item = ev && (ev.item || ev.msg || ev);
      const kind = String((item && (item.type || item.item_type)) || '');
      // (a search's first event carries no words yet: only one that names its query is recorded)
      if (/web_search/.test(kind)) { const query = clip(item.query || (item.action && item.action.query) || '', 200).trim(); if (query) addCapped(sources.web, `search: ${query}`); }
      // (the notes reader's calls: what was asked for, never what came back)
      else if (kind === 'mcp_tool_call' && item.server === 'notes' && CODEX_READER_TOOLS.includes(item.tool)) {
        const a = item.arguments && typeof item.arguments === 'object' ? item.arguments : {};
        const what = item.tool === 'read_note' ? clip(a.path) : item.tool === 'search_notes' ? `search: ${clip(a.query, 200)}${a.folder ? ` in ${clip(a.folder)}` : ''}` : `list: ${clip(a.folder || '')}`.trim();
        if (what) addCapped(sources.notes, what);
      }
    },
    end() { return { used: usedOfSources(sources), sources }; },
  };
}
export function usedFromCodex(raw) {
  const r = codexStream();
  for (const line of String(raw).split('\n')) r.push(line);
  return r.end();
}

export const RUN_STATES = Object.freeze(['running', 'flooded', 'done']);
const RUN_MOVES = Object.freeze({ running: Object.freeze(['flooded', 'done']), flooded: Object.freeze(['done']), done: Object.freeze([]) });
/**
 * → Promise<{ ok: true, text, model?, used?, sources? } | { ok: false, error }>. Never throws.
 * `spawn` is injectable for the tests (a stand-in that records what it was given and answers, or never answers).
 * The child is started as the leader of its own process group, so a run stopped (past its time, or flooding) is stopped whole: the
 * CLI and anything it started.
 */
export async function runOneShot(agent, prompt, { model = '', effort = '', timeoutMs = 0, maxBytes = 64 * 1024, spawn = realSpawn,
  env: fromEnv = process.env, jail = codexJail, claudeJail: jailClaude = claudeJail, caps = 'none', roots = [], fetchHosts = [],
  cliVersion: versionOf = () => claudeVersion(fromEnv), codexCliVersion: codexVersionOf = () => codexVersion(fromEnv), node = process.execPath } = {}) {
  // A CODEX RUN WITH TOOLS needs the CLI version its tools were verified on (CODEX_NOTES_VERSION): only there may the CLI's code-mode
  // helper start (codexJail `codeMode`), and only there does a notes run read notes; on any other version a notes run is a web run and
  // its private record says so (and its search, which needs the helper, will not work). Chosen here once for the whole run.
  let codexNotesOff = false;
  let codexCodeMode = false;
  if (agent === 'codex' && caps !== 'none') {
    let v = '';
    try { v = String((await codexVersionOf()) || ''); } catch { v = ''; }
    codexCodeMode = v === CODEX_NOTES_VERSION;
    if (caps === 'web+notes' && (!codexCodeMode || !roots.length)) { caps = 'web'; roots = []; codexNotesOff = true; }
  }
  const limit = timeLimitFor(caps, timeoutMs || 0);
  if (!ONESHOT_AGENTS.includes(agent)) return { ok: false, error: `${agent} cannot fill gaps here` };
  // a model name is one argument and never a flag (store.mjs MODEL_RE says the same for what is stored)
  if (/^-/.test(String(model))) return { ok: false, error: 'the model name may not begin with -' };
  // the CLI's version matters only to a notes run's fetch rules (asked only then; cached by claudeVersion)
  let cliVersion = '';
  if (agent === 'claude' && caps === 'web+notes') { try { cliVersion = String((await versionOf()) || ''); } catch { cliVersion = ''; } }
  const fetchOff = agent === 'claude' && caps === 'web+notes' && !fetchRulesHold(cliVersion);
  return new Promise(resolve => {
    let dir = '';
    let outDir = '';
    try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-')); } catch { resolve({ ok: false, error: 'could not make a folder for the agent' }); return; }
    try { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-oneshot-out-')); } catch { outDir = ''; }
    // (a Codex notes run: the reader, copied into the run's own second folder, and the Node that runs it)
    let reader = null;
    if (agent === 'codex' && caps === 'web+notes' && outDir) {
      try { const script = path.join(realOr(outDir), 'tk-notes-reader.mjs'); fs.copyFileSync(CODEX_READER, script); reader = { node: realNative(node), script }; }
      catch { reader = null; }
    }
    const c = oneshotCommand(agent, { model, effort, dir, out: outDir ? path.join(outDir, 'last.txt') : '', caps, roots, fetchHosts, cliVersion, reader });
    const drop = error => { for (const d of [dir, outDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } } resolve({ ok: false, error }); };
    if (!c || (c.lastMessage === '' && agent === 'codex')) { drop(`could not start ${agent}`); return; }
    const env = oneshotEnv(agent, fromEnv);
    if (agent === 'codex') {
      // jailed, or not run at all (a notes run without its reader is not run: it would only be a web run that says it read notes)
      if (caps === 'web+notes' && !reader) { drop(CODEX_UNCONTAINED); return; }
      if (caps === 'web+notes') env.TMPDIR = realOr(outDir);   // (other temporary folders are closed to a notes run)
      const j = jail({ env, work: dir, out: outDir, ...(caps === 'web+notes' ? { roots, reader: reader.node } : {}), ...(codexCodeMode ? { codeMode: true } : {}) });
      if (!j || !j.ok) { drop((j && j.error) || CODEX_UNCONTAINED); return; }
      c.args = [...j.argv.slice(1), ...c.args];
      c.cmd = j.argv[0];
    }
    if (agent === 'claude' && caps !== 'none') {
      // with tools, Claude is wrapped too (claudeJail): it writes nowhere but its own folders and starts no other program
      // (its own temporary folder, CLAUDE_CODE_TMPDIR: the run's second fresh folder, not the shared one under /tmp, which the wrapper
      // keeps it out of; without it the CLI cannot start inside the wrapper)
      if (!outDir) { drop(`could not start ${agent}`); return; }
      env.CLAUDE_CODE_TMPDIR = outDir;
      env.TMPDIR = outDir;   // (the system's temporary folder is shared with every other program: the wrapper keeps the CLI out of it)
      const j = jailClaude({ env, work: dir, tmp: outDir, roots: caps === 'web+notes' ? roots : [] });
      if (!j || !j.ok) { drop((j && j.error) || CLAUDE_UNCONTAINED); return; }
      c.args = [...j.argv.slice(1), ...c.args];
      c.cmd = j.argv[0];
    }
    // the events, read as they arrive (Claude with tools; Codex with web search), or the plain answer (a tool-less run), capped
    const events = c.stream ? claudeStream({ maxText: maxBytes }) : (agent === 'codex' && caps !== 'none') ? codexStream() : null;
    const lines = events ? lineSplitter(l => events.push(l)) : null;
    let child;
    let out = Buffer.alloc(0);
    let total = 0;
    // THE RUN, in one of RUN_STATES, one field, moved only by runTo: running; flooded (its events passed totalBytes: stopped, its close
    // answers so); done (answered: nothing more is read or said)
    let state = 'running';
    const runTo = next => { if (!RUN_MOVES[state].includes(next)) throw new Error(`run: cannot go from ${state} to ${next}`); state = next; };
    const cleanup = () => { for (const d of [dir, outDir]) if (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* a temp folder */ } } };
    // the whole group: the CLI and whatever it started (a stand-in without a pid: itself)
    const stop = () => {
      try { if (child && Number.isInteger(child.pid) && child.pid > 0) { process.kill(-child.pid, 'SIGKILL'); return; } } catch { /* not a group: the child */ }
      try { child && child.kill('SIGKILL'); } catch { /* gone */ }
    };
    const done = r => {
      if (state === 'done') return;
      runTo('done');
      clearTimeout(timer);
      cleanup();
      resolve(r);
    };
    // the wait abandoned is the run stopped: nothing keeps running (or billing)
    const timer = setTimeout(() => { stop(); done({ ok: false, error: caps === 'none' ? 'the agent took too long' : `the agent took too long (the limit is ${limit >= 1000 ? `${Math.round(limit / 1000)} s` : `${limit} ms`})` }); }, limit);
    try { child = spawn(c.cmd, c.args, { cwd: dir, env, stdio: ['pipe', 'pipe', 'ignore'], detached: true }); }
    catch (e) { done({ ok: false, error: `could not start ${agent}` }); return; }
    child.on('error', () => done({ ok: false, error: `could not start ${agent}` }));
    child.stdout.on('data', d => {
      if (lines) {
        if (state !== 'running') return;
        total += d.length;
        if (total > STREAM_LIMITS.totalBytes) { runTo('flooded'); stop(); return; }
        lines.push(d);
        return;
      }
      // a tool-less run: claude answers on stdout; codex's stdout is its progress, read only to stop a flood
      out = Buffer.concat([out, d]);
      if (out.length > maxBytes) { stop(); out = out.subarray(0, maxBytes); }
    });
    child.on('close', code => {
      if (state === 'done') return;
      if (state === 'flooded') { done({ ok: false, error: 'the agent wrote too much and was stopped' }); return; }
      let text = '';
      let full = false;
      let usedOf = null;
      if (lines) lines.end();
      if (c.lastMessage) {
        // codex: the last message only, from its own file, as text, under the same cap
        try { const buf = fs.readFileSync(c.lastMessage); full = buf.length >= maxBytes; text = buf.subarray(0, maxBytes).toString('utf8').trim(); } catch { text = ''; }
        if (events) usedOf = events.end();
      } else if (c.stream) {
        // claude with tools: the final result's text, and the tools it used
        const s = events.end();
        if (s.error) { done({ ok: false, error: s.error }); return; }
        text = s.text; usedOf = s.used;
      } else { text = out.toString('utf8').trim(); full = out.length >= maxBytes; }
      if (usedOf && fetchOff) usedOf.sources.note = FETCH_OFF_SAY;
      if (usedOf && codexNotesOff) usedOf.sources.note = CODEX_NOTES_OFF_SAY;
      const extra = usedOf ? { used: usedOf.used, sources: usedOf.sources } : {};
      if (code === 0 || (text && full)) { done(text ? { ok: true, text, ...(model ? { model } : {}), ...extra } : { ok: false, error: 'the agent wrote nothing' }); return; }
      done({ ok: false, error: `the agent stopped (exit ${code})` });
    });
    try { child.stdin.end(String(prompt)); } catch { /* the close handler answers */ }
  });
}

// ---- THE CLAUDE WRAPPER (macOS seatbelt), for a run with tools ------------------------------------------------------------------------
// What it makes true at the OS level, whatever the CLI does:
//   NO WRITE anywhere but the run's own folder and its own temporary folder (CLAUDE_CODE_TMPDIR), the CLI's own folder (~/.claude, or CLAUDE_CONFIG_DIR) and its state file
//     (~/.claude.json exactly, with the CLI's own temporary names for writing it whole: `.tmp.<pid>.<hex>`, `.tmp.<8 hex>`, `.lock`);
//   NO PROGRAM but the CLI's own install;
//   NO READ (or write) of the private places (CLAUDE_PRIVATE_PLACES, under the home folder: keys, tokens, shell history, browser
//     profiles and cookies, past Claude transcripts, all of ~/.config but CLAUDE_CONFIG_KEEP) or of other temporary folders. These
//     rules come LAST in the profile, so they win over every allow before them: a root that is, holds or leads (through a link, or a
//     name in another case) into a private place still cannot read it (seatbelt matches a path as the disk has it, whatever case it
//     was asked in, and the last matching rule decides).
// Reads elsewhere under the home folder are NOT refused at this level (Claude's sign-in reads files there that cannot all be listed;
// a profile limiting reads to the CLI's folders and the roots left it signed out), so "no read outside the roots" also rests on the
// CLI's own confinement (--restricted: its file tools see only the working folder and the --add-dir roots) and on its tools being only
// Read, Glob and Grep. The network is allowed (web search).
export const CLAUDE_UNCONTAINED = 'Claude cannot be contained on this system';
export const CLAUDE_PRIVATE_PLACES = Object.freeze([
  // keys, tokens and the tools that hold them
  '.ssh', '.botference', '.botference-backup', '.blyg-inbox-token', '.aws', '.gnupg', '.codex', '.supabase', '.cloudflared', '.netrc', '.npmrc',
  '.pypirc', '.docker', '.kube', '.git-credentials', '.env', '.config',
  // what the owner typed in a shell
  '.zsh_history', '.zhistory', '.zsh_sessions', '.bash_history', '.bash_sessions', '.sh_history', '.history', '.python_history',
  '.node_repl_history', '.psql_history', '.mysql_history', '.sqlite_history', '.irb_history', '.lesshst', '.local/share/fish',
  // browsers: profiles, cookies, history, saved passwords; mail and messages
  'Library/Cookies', 'Library/Safari', 'Library/Mail', 'Library/Messages', 'Library/Application Support/Google',
  'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Microsoft Edge',
  'Library/Application Support/Arc', 'Library/Application Support/Vivaldi', 'Library/Application Support/Chromium',
  'Library/Application Support/com.operasoftware.Opera',
  // the owner's past Claude sessions (every transcript)
  '.claude/projects']);
// what of ~/.config stays readable because the CLI's sign-in needs it, narrowed with `claude auth status` and `claude --version` under
// this wrapper (2026-11-27, Claude Code 2.1.330; no model called, no file's contents read): with all of ~/.config denied the CLI is
// signed out; with ~/.config/anthropic allowed again it is signed in. Nothing else under ~/.config is readable.
export const CLAUDE_CONFIG_KEEP = Object.freeze(['anthropic']);
// THE CLI'S SIGN-IN, as a real run showed it (2026-11-27): with a subscription the CLI reads its token from the macOS keychain by
// starting /usr/bin/security (which reads ~/Library/Keychains: the items stay encrypted, each behind the keychain's own access rules),
// and it writes its sign-in state under ~/.config/anthropic (and its own state under ~/.local/state/claude). Refused any of these, every API call failed and was retried for about three
// minutes, and the passage ended "the agent stopped before it finished". So that program may start, and that folder may be written.
export const CLAUDE_SIGN_IN_PROGRAMS = Object.freeze(['/usr/bin/security']);
// (kept for the earlier name)
export const SECRET_PLACES = CLAUDE_PRIVATE_PLACES;
const SAFE_PROFILE_PATH = /^\/[A-Za-z0-9 ._@+,()'&~/-]+$/;
const q = p => { if (!SAFE_PROFILE_PATH.test(p) || /["\\]/.test(p)) throw new Error('a path a sandbox rule cannot hold'); return `"${p}"`; };
const ancestorsOf = p => { const out = []; for (let d = path.dirname(p); d !== path.dirname(d); d = path.dirname(d)) out.push(d); return out; };
const reEsc = p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** → { ok: true, argv } (sandbox-exec -p <profile> <claude>) or { ok: false, error }. `install`: the CLI's own folder (tests: a stub's). */
export function claudeJail({ env = process.env, work, tmp = '', roots = [], platform = process.platform, sandboxExec = SANDBOX_EXEC, bin = '', install = '' } = {}) {
  if (platform !== 'darwin' || !fs.existsSync(sandboxExec)) return { ok: false, error: CLAUDE_UNCONTAINED };
  const home = env.HOME ? realNative(env.HOME) : '';
  if (!home || !path.isAbsolute(home)) return { ok: false, error: CLAUDE_UNCONTAINED };
  const cli = bin || whichReal('claude', env);
  if (!cli) return { ok: false, error: 'could not start claude' };
  const dir = install || path.dirname(cli);
  const cliHome = realNative(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'));
  let profile;
  try {
    const priv = CLAUDE_PRIVATE_PLACES.map(s => `(subpath ${q(path.join(home, s))})`).join(' ');
    profile = [
      '(version 1)',
      '; oneshot.mjs claudeJail: a /tk passage\'s Claude with tools (see the comment there for what it does and does not refuse)',
      '(allow default)',
      '(deny file-read* (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/private/var/tmp"))',
      `(allow file-read* (subpath ${q(realNative(work))})${tmp ? ` (subpath ${q(realNative(tmp))})` : ''}${roots.map(r => ` (subpath ${q(realNative(r))})`).join('')})`,
      // (the folders above each root may be looked up, never listed or read: a path is resolved one name at a time)
      ...(roots.length ? [`(allow file-read-metadata ${[...new Set(roots.flatMap(r => ancestorsOf(realNative(r))))].map(a => `(literal ${q(a)})`).join(' ')})`] : []),
      '(deny file-write*)',
      `(allow file-write* (subpath ${q(realNative(work))})${tmp ? ` (subpath ${q(realNative(tmp))})` : ''} (subpath ${q(cliHome)}) (subpath ${q(path.join(home, '.local', 'state', 'claude'))}) (regex #"^${reEsc(home)}/\\.claude\\.json(\\.tmp\\.[0-9]+\\.[0-9a-f]+|\\.tmp\\.[0-9a-f]{8}|\\.lock)?$") (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper"))`,
      '(deny process-exec)',
      `(allow process-exec (subpath ${q(realNative(dir))}) ${CLAUDE_SIGN_IN_PROGRAMS.map(p => `(literal ${q(p)})`).join(' ')})`,
      '; LAST, so nothing above outranks them: the private places, whatever a root or a link says',
      `(deny file-read* file-write* ${priv})`,
      ...(CLAUDE_CONFIG_KEEP.length ? [`(allow file-read* file-write* ${CLAUDE_CONFIG_KEEP.map(k => `(subpath ${q(path.join(home, '.config', k))})`).join(' ')})`] : []),
    ].join('\n');
  } catch (e) { return { ok: false, error: CLAUDE_UNCONTAINED }; }
  return { ok: true, argv: [sandboxExec, '-p', profile, cli] };
}
