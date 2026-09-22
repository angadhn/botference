#!/usr/bin/env node
// review-build.mjs — an independent, sceptical reader for a commit you just made.
//
// THE FAILURE IT EXISTS FOR. The agent that wrote the code also wrote the
// commit message, also wrote the tests, and — asked whether the work is
// sound — is the worst possible witness, because it is holding all its own
// reasons. Asking it again is not a check; it is the same reasoning read
// twice. And two agents that have been talking to each other about the change
// are barely better: a shared premise gets stickier the longer the discussion,
// not weaker.
//
// So this spawns a reader that has seen NONE of that. It gets the diff, the
// commit message and the test files — the artefacts, not the conversation —
// and a brief whose whole content is scepticism: list what the message CLAIMS,
// then go and look. Nothing here is wired into a hook. It is a command the
// developer runs, because a check nobody chose to run is a check nobody reads.
//
// Usage:
//   node tools/review-build.mjs [<range>] [--dry-run] [--model <id>] [--out <dir>]
//   botference review-build [<range>] [--dry-run]
//
// <range> defaults to HEAD~1..HEAD. --dry-run prints the brief and spawns
// nothing, which is also how the brief is tested.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RANGE = 'HEAD~1..HEAD';
export const DEFAULT_MODEL = 'claude-opus-5';
// A brief bigger than this is a brief the reader skims. A commit that does not
// fit is a commit that should have been several, and saying so is more useful
// than quietly truncating in the middle of a hunk.
export const DIFF_MAX = 120_000;
export const WORD_CAP = 300;

export function parseArgs(argv) {
  const out = { range: '', dryRun: false, model: DEFAULT_MODEL, outDir: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '-n') out.dryRun = true;
    else if (a === '--model') out.model = String(argv[++i] || DEFAULT_MODEL);
    else if (a === '--out') out.outDir = String(argv[++i] || '');
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else rest.push(a);
  }
  out.range = rest[0] || DEFAULT_RANGE;
  return out;
}

const git = (args, cwd) => execFileSync('git', args, {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
}).replace(/\s+$/, '');

/** Everything the reader is given, and nothing else. */
export function collect(range, cwd = process.cwd()) {
  const sha = git(['rev-parse', range.includes('..') ? range.split('..').pop() || 'HEAD' : range], cwd);
  const messages = git(['log', '--format=%H%n%an%n%s%n%b%n--', `${range}`], cwd);
  const names = git(['diff', '--name-only', range], cwd).split('\n').filter(Boolean);
  let diff = git(['diff', range], cwd);
  let clipped = 0;
  if (diff.length > DIFF_MAX) { clipped = diff.length - DIFF_MAX; diff = diff.slice(0, DIFF_MAX); }
  // "the test files touched" — by path, the way every suite in this repo is
  // laid out. Named separately from the rest of the diff because one of the
  // three things the reader is asked to do is about them specifically.
  const tests = names.filter(p => /(^|\/)tests?\//.test(p) || /\.test\.(mjs|js|ts)$/.test(p)
    || /(^|\/)test_[^/]+\.py$/.test(p));
  return { sha, range, messages, names, tests, diff, clipped };
}

/**
 * The brief. Pure — given the collected facts it is the same text every time,
 * which is what makes `--dry-run` a real test of it rather than a smoke test.
 */
export function brief(c) {
  return `You are reviewing a commit you had no part in writing. You have not seen the
conversation that produced it and you are not being asked to agree with it.
Your job is to check its claims against the code.

Range: ${c.range}

--- The commit message(s) ---
${c.messages || '(none)'}

--- Files changed (${c.names.length}) ---
${c.names.join('\n') || '(none)'}

--- Test files touched (${c.tests.length}) ---
${c.tests.join('\n') || '(none — note this in your verdict if the change needed tests)'}

--- The diff ---
${c.diff || '(empty)'}
${c.clipped ? `\n(… ${c.clipped} further characters of diff were not included. Read the files\ndirectly for anything you need from them.)\n` : ''}
Do these four things, in this order:

(a) LIST EVERY CLAIM the commit message makes — each promise, each "now does
    X", each "fixes Y" — and mark each one verified or unverified BY READING
    THE CODE. Quote the line that verifies it. A claim you cannot tie to a
    line is unverified, however plausible it sounds.

(b) LOOK FOR TESTS THAT ASSERT THE IMPLEMENTATION RATHER THAN THE BEHAVIOUR:
    a test that restates the function it calls, that pins an internal shape
    nobody outside depends on, or that would pass just as happily against a
    stub. Name the file and line. These are the tests that go green while the
    feature is broken, which is the failure worth catching here.

(c) RUN THE RELEVANT SUITES YOURSELF and report what you saw — not what the
    commit message says you would have seen:
      pytest tests/ -q
      node frontends/plugin/test/run-all.mjs -j 2
      node --test tests/council-web.test.mjs
      (in ink-ui/: npm test)
    Run the ones the diff actually touches. One pre-existing environmental
    failure mentioning "plt.show()" is known and is not this commit's.

(d) A VERDICT on its own line — exactly one of:
      VERDICT: accept
      VERDICT: accept with notes
      VERDICT: reject
    with the exact file:line behind every note.

Under ${WORD_CAP} words for the whole report. No preamble, no summary of what
the commit was trying to do, no praise. If the change is sound, the shortest
honest report is the best one.`;
}

export function outPath(cwd, sha, outDir) {
  const dir = outDir || path.join(cwd, '.botference', 'reviews');
  return path.join(dir, `${String(sha).slice(0, 40)}.md`);
}

export function run(argv, { cwd = process.cwd() } = {}) {
  const opt = parseArgs(argv);
  if (opt.help) {
    process.stdout.write(
      'usage: node tools/review-build.mjs [<range>] [--dry-run] [--model <id>] [--out <dir>]\n'
      + `       (range defaults to ${DEFAULT_RANGE}; model defaults to ${DEFAULT_MODEL})\n`);
    return 0;
  }
  const c = collect(opt.range, cwd);
  const text = brief(c);
  if (opt.dryRun) {
    process.stdout.write(`${text}\n`);
    return 0;
  }
  // Headless Claude Code. `-p` is one prompt and one answer; the reader has
  // the repo in front of it, which is what (b) and (c) need.
  const r = spawnSync('claude', ['-p', text, '--model', opt.model], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (r.error) {
    process.stderr.write(`review-build: could not run \`claude\`: ${r.error.message}\n`);
    return 1;
  }
  const report = String(r.stdout || '').trim();
  if (!report) {
    process.stderr.write('review-build: the reviewer returned nothing.\n');
    return r.status || 1;
  }
  const file = outPath(cwd, c.sha, opt.outDir);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# Build review — ${c.range} (${c.sha.slice(0, 12)})\n\n${report}\n`);
  } catch (e) {
    process.stderr.write(`review-build: could not write ${file}: ${e.message}\n`);
  }
  process.stdout.write(`${report}\n\n— written to ${file}\n`);
  return /VERDICT:\s*reject/i.test(report) ? 2 : 0;
}

const invoked = process.argv[1] && fs.realpathSync(process.argv[1])
  === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) process.exit(run(process.argv.slice(2)));
