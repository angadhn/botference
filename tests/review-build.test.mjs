// review-build — the independent, sceptical reader for a commit.
//
// The check that matters here is that --dry-run builds the whole brief and
// SPAWNS NOTHING: the brief is the product, the reader is interchangeable, and
// a test that needed an agent to run would be a test nobody runs. A throwaway
// git repo with two real commits in it, so `collect` is exercised against git
// rather than against a fake.
//
// Run:  node --test tests/review-build.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TOOL = path.join(HOME, 'tools', 'review-build.mjs');
const rb = await import(TOOL);

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bf-rb-')));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']);
  git(dir, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-q', '-m', 'init']);
  fs.mkdirSync(path.join(dir, 'tests'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'tests', 'a.test.mjs'), 'assert(1)\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'feat: a.txt gains a second line, and it is tested']);
  return dir;
}

test('the default range is the last commit, and the options parse', () => {
  assert.equal(rb.parseArgs([]).range, rb.DEFAULT_RANGE);
  assert.equal(rb.parseArgs([]).model, rb.DEFAULT_MODEL);
  assert.equal(rb.parseArgs([]).dryRun, false);
  const o = rb.parseArgs(['abc..def', '--dry-run', '--model', 'claude-sonnet-9', '--out', '/tmp/x']);
  assert.deepEqual([o.range, o.dryRun, o.model, o.outDir], ['abc..def', true, 'claude-sonnet-9', '/tmp/x']);
  assert.throws(() => rb.parseArgs(['--nope']), /unknown option/);
});

test('collect gathers the message, the files, the tests and the diff — and nothing else', t => {
  const dir = repo(t);
  const c = rb.collect('HEAD~1..HEAD', dir);
  assert.match(c.messages, /a\.txt gains a second line/);
  assert.deepEqual(c.names.sort(), ['a.txt', 'tests/a.test.mjs']);
  assert.deepEqual(c.tests, ['tests/a.test.mjs']);
  assert.match(c.diff, /\+two/);
  assert.equal(c.clipped, 0);
  assert.equal(c.sha, git(dir, ['rev-parse', 'HEAD']).trim());
});

test('the brief is sceptical by construction: claims, tests, run it, verdict', t => {
  const b = rb.brief(rb.collect('HEAD~1..HEAD', repo(t)));
  assert.match(b, /You have not seen the\nconversation/, 'it says what the reader does NOT have');
  assert.match(b, /LIST EVERY CLAIM the commit message makes/);
  assert.match(b, /verified or unverified BY READING\n    THE CODE/);
  assert.match(b, /TESTS THAT ASSERT THE IMPLEMENTATION RATHER THAN THE BEHAVIOUR/);
  assert.match(b, /RUN THE RELEVANT SUITES YOURSELF/);
  assert.match(b, /pytest tests\/ -q/);
  assert.match(b, /node frontends\/plugin\/test\/run-all\.mjs -j 2/);
  assert.match(b, /VERDICT: accept with notes/);
  assert.match(b, /VERDICT: reject/);
  assert.match(b, new RegExp(`Under ${rb.WORD_CAP} words`));
  assert.match(b, /a\.txt gains a second line/, 'the commit message is IN the brief');
  assert.match(b, /\+two/, 'and so is the diff');
});

test('a commit with no tests says so in the brief rather than staying quiet', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n');
  git(dir, ['commit', '-qam', 'fix: a third line']);
  const b = rb.brief(rb.collect('HEAD~1..HEAD', dir));
  assert.match(b, /Test files touched \(0\)/);
  assert.match(b, /none — note this in your verdict/);
});

test('a diff past DIFF_MAX is clipped, and the brief says how much it dropped', t => {
  const dir = repo(t);
  fs.writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(rb.DIFF_MAX + 5000) + '\n');
  git(dir, ['add', '.']); git(dir, ['commit', '-qm', 'chore: a big file']);
  const c = rb.collect('HEAD~1..HEAD', dir);
  assert.ok(c.clipped > 0);
  assert.equal(c.diff.length, rb.DIFF_MAX);
  assert.match(rb.brief(c), /further characters of diff were not included/);
});

test('--dry-run prints the brief to stdout and spawns nothing at all', t => {
  const dir = repo(t);
  const seen = [];
  const write = process.stdout.write;
  process.stdout.write = s => { seen.push(String(s)); return true; };
  let code;
  try { code = rb.run(['HEAD~1..HEAD', '--dry-run'], { cwd: dir }); }
  finally { process.stdout.write = write; }
  assert.equal(code, 0);
  const out = seen.join('');
  assert.match(out, /LIST EVERY CLAIM/);
  assert.match(out, /VERDICT: accept/);
  // nothing was written, and in particular no review file was left behind
  assert.equal(fs.existsSync(path.join(dir, '.botference', 'reviews')), false);
});

test('a report is filed under .botference/reviews/<sha>.md', t => {
  const dir = repo(t);
  const sha = git(dir, ['rev-parse', 'HEAD']).trim();
  assert.equal(rb.outPath(dir, sha, ''), path.join(dir, '.botference', 'reviews', `${sha}.md`));
  assert.equal(rb.outPath(dir, sha, '/tmp/elsewhere'), path.join('/tmp/elsewhere', `${sha}.md`));
});
