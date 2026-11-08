#!/usr/bin/env node
// turnwatch — who wrote a version of a post that changed during a bot turn.
//
// Only Obsidian, in front, with THIS post open, counts as the reader. Any
// other editor in front, Obsidian on another note, or an Obsidian whose
// workspace cannot be read is the bots' — the safe default, because a bot
// version is put back and offered as a card, while a "reader" version is kept
// with no card at all. The companion's own journal still wins over all of it.
//
//   node frontends/plugin/test/turnwatch.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// the live probe asks which app is in front of THIS desk; the watch test below
// must not depend on that (the rule itself is tested pure, via classifyFrom)
process.env.PLUGIN_EDITOR_PROBE = 'none';
const T = await import('../turnwatch.mjs');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}

const vault = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-turnwatch-')));
const post = path.join(vault, '_posts', '2026-11-07-a-post.md');
const other = path.join(vault, '_posts', '2026-11-01-another.md');
fs.mkdirSync(path.dirname(post), { recursive: true });
fs.writeFileSync(post, 'hello\n');
fs.writeFileSync(other, 'other\n');
const openIn = rel => {
  fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
  fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), JSON.stringify({
    active: 'leaf1', main: { children: [{ id: 'leaf1', state: { state: { file: rel } } }] },
  }));
};
const now = Date.now();
const front = app => [{ at: now - 500, app }];

console.log('\nturnwatch — who wrote it');

await test('Obsidian in front with this post open is the reader', async () => {
  openIn('_posts/2026-11-07-a-post.md');
  assert.equal(T.classifyFrom(front('Obsidian'), post, now), 'user');
});

await test('any other editor in front is the bots\', whatever it has open', async () => {
  for (const app of ['Code', 'Visual Studio Code', 'Cursor', 'Zed', 'Sublime Text', 'TextEdit', 'Typora']) {
    assert.equal(T.classifyFrom(front(app), post, now), 'bot', app);
  }
  assert.equal(T.classifyFrom(front('Safari'), post, now), 'bot', 'and a browser, as before');
  assert.equal(T.classifyFrom([], post, now), 'bot', 'and nothing sampled at all');
});

await test('Obsidian on a different note, or with an unreadable workspace, is the bots\'', async () => {
  openIn('_posts/2026-11-01-another.md');
  assert.equal(T.classifyFrom(front('Obsidian'), post, now), 'bot', 'another note');
  fs.writeFileSync(path.join(vault, '.obsidian', 'workspace.json'), '{ not json');
  assert.equal(T.classifyFrom(front('Obsidian'), post, now), 'bot', 'cannot tell which note — not the reader');
  fs.rmSync(path.join(vault, '.obsidian'), { recursive: true });
  assert.equal(T.classifyFrom(front('Obsidian'), post, now), 'bot', 'no vault at all');
});

await test('Obsidian in front too long ago does not count', async () => {
  openIn('_posts/2026-11-07-a-post.md');
  assert.equal(T.classifyFrom([{ at: now - 60000, app: 'Obsidian' }], post, now), 'bot');
});

await test('a journalled write is the reader\'s whatever is in front', async () => {
  const w = T.watchFile(post);
  T.noteUserWrite(post, 'the reader accepted a card\n');
  fs.writeFileSync(post, 'the reader accepted a card\n');
  w.check();
  fs.writeFileSync(post, 'and then a bot wrote\n');
  w.check();
  const steps = w.stop();
  const byText = Object.fromEntries(steps.map(s => [s.text, s.by]));
  assert.equal(byText['the reader accepted a card\n'], 'user', 'the journal names it');
  assert.equal(byText['and then a bot wrote\n'], 'bot', 'unjournalled is the bots\'');
});

fs.rmSync(vault, { recursive: true, force: true });
console.log(`\n✓ turnwatch.test.mjs — ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(failures.map(f => `  · ${f}`).join('\n')); process.exit(1); }
process.exit(0);
