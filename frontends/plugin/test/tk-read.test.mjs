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
import { spawnSync } from 'node:child_process';
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
  assert.equal(T.validateTkRead({ hub_link_tk_notes: 'on' }, { home }).hubLinkNotes, 'on');
});

test('botference tk-read check: says the roots and the hub link setting, every problem; exit 1 when invalid', async () => {
  const { main } = await import('../tk-read-cli.mjs');
  const home = tmp();
  fs.mkdirSync(path.join(home, 'Notes'));
  const run = cfg => { const out = []; const code = main(['check'], { config: () => cfg, configPath: '/x/config.json', home, say: s => out.push(s) }); return { code, text: out.join('\n') }; };
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
  const notes = O.oneshotCommand('claude', { caps: 'web+notes', roots: ['/r/one', '/r/two'] }).args;
  assert.equal(notes[notes.indexOf('--tools') + 1], 'WebSearch,WebFetch,Read,Glob,Grep');
  const ns = JSON.parse(notes[notes.indexOf('--settings') + 1]).permissions;
  assert.deepEqual(ns.allow, ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep']);
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
  for (const place of O.SECRET_PLACES) assert.ok(p.includes(`(subpath "${path.join(fs.realpathSync(os.homedir()), place)}")`), place);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(deny process-exec\)/);
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
  const r = await O.runOneShot('claude', 'p', { caps: 'web+notes', roots: ['/r/one'], spawn: streamSpawn(lines), claudeJail: noJail });
  assert.deepEqual(r, { ok: true, text: 'The passage, written.', used: 'both', sources: { web: ['search: ships', 'https://www.example.com/a'], notes: ['/r/one/n.md'] } });
  const w = await O.runOneShot('claude', 'p', { caps: 'web', spawn: streamSpawn([{ type: 'result', subtype: 'success', result: 'Plain.' }]), claudeJail: noJail });
  assert.deepEqual(w, { ok: true, text: 'Plain.', used: 'none', sources: { web: [], notes: [] } });
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
