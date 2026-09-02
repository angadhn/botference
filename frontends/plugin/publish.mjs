// publish.mjs — a project artifact goes public, on the reader's own website.
//
// The last step of the road that starts with a brochure in Downloads: the
// reader annotates a page, the bots make an artifact of it in a project
// (SPEC "from a page to a project artifact"), and then they want it at an
// address they can send to somebody. That address is their own site — a
// Jekyll repo that a host rebuilds when it sees a push — so publishing is
// exactly three things: copy one file in, commit it, push.
//
// ── WHAT THIS DOES NOT DO, AND WHY EACH ONE IS DELIBERATE ─────────────────
//
// · It does not TOUCH the artifact's bytes. Not a rewrite, not a template,
//   not an injected header. Jekyll copies a file with no front matter
//   through unchanged, which is precisely what a self-contained page wants
//   (the artifact instruction says: no external scripts, no external
//   stylesheets), so the honest thing is to hand the file over as it is. A
//   page that came out of the project folder and a page that is live are then
//   the same bytes, and "why does it look different on the site" cannot
//   happen.
// · It does not edit `_config.yml`, or any other file of the reader's site.
//   One file lands, in one directory the reader named, and nothing else in
//   that repository is written by this companion — ever. Site configuration
//   is the reader's, and a tool that quietly rewrites it is a tool nobody can
//   trust with a repo.
// · It does not resolve conflicts, rebase, or force anything. `git push` is
//   run once and whatever git says on failure is handed back VERBATIM, to be
//   read by the person who owns the repository. A push that fails leaves a
//   commit sitting on the branch, which is exactly the state the reader would
//   be in if they had done it themselves — and the one they know how to fix.
// · It commits only OUR file (`git add -- <that path>`). A repo with the
//   reader's own half-finished work in it publishes the artifact and leaves
//   their work alone, rather than refusing (unhelpful) or sweeping it into
//   the commit (unforgivable).
//
// Owner-only at the door, like everything else here that names a path on this
// machine: server.mjs POST /publish.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readConfig } from './store.mjs';

const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

// A git command that cannot hang the companion. A push against a dead remote
// otherwise sits there forever holding the reader's drawer on "publishing…",
// and there is no other timeout anywhere in this path.
export const GIT_TIMEOUT_MS = 60000;

// One directory inside the repo, and nothing above it. The reader writes this
// by hand into config.json, so it is checked the way every hand-written path
// in this tree is: relative, descending, no traversal, no absolutes.
const cleanDir = d => {
  const s = String(d == null ? '' : d).trim().replace(/^\/+|\/+$/g, '');
  if (!s || s.includes('\0') || path.isAbsolute(s)) return '';
  if (s.split('/').some(seg => !seg || seg === '.' || seg === '..')) return '';
  return s;
};

// The `.html` name this artifact takes on the site: its own file name, and
// only its own file name. `projects/lff/planner.html` publishes as
// `<dir>/planner.html` — the project's shape inside the council is nobody
// else's business, and a nested path would be a second directory decision
// the reader never made.
export const publishName = rel => {
  const base = path.basename(String(rel || '')).trim();
  // …and it has to be a FILE with an extension: `projects/lff/` basenames to
  // `lff`, which is a directory, and a site would serve it as neither.
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.[A-Za-z0-9]{1,8}$/.test(base) ? base : '';
};

/**
 * The publish targets in config.json, normalized. `[]` when none is set up,
 * which is the ordinary state and never an error — the drawer says so and
 * offers the shape.
 *
 * Two shapes are accepted because one of them costs nothing: a single target
 * written flat (`{repo, dir, url}`), which is what one site needs, or a map of
 * names to targets for a reader with two. The flat one is called "site".
 */
export function publishTargets() {
  const raw = readConfig().publish;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rows = typeof raw.repo === 'string'
    ? [['site', raw]]
    : Object.entries(raw).filter(([, v]) => v && typeof v === 'object');
  const out = [];
  for (const [name, t] of rows) {
    const repo = String(t.repo || '').trim();
    const dir = cleanDir(t.dir);
    if (!repo || !path.isAbsolute(repo) || !isDir(repo) || !isDir(path.join(repo, '.git'))) continue;
    if (!dir) continue;
    out.push({
      name: String(name),
      repo,
      dir,
      // the public address of that directory, trailing slash and all, so the
      // link the reader is handed is one join away
      url: String(t.url || '').trim().replace(/\/+$/, '') + '/',
      branch: String(t.branch || 'main').trim() || 'main',
      // `push: false` is a real answer: commit here, push it yourself later
      push: t.push !== false,
    });
  }
  return out;
}

/** The target a request named, or the only one there is. */
export function targetNamed(name) {
  const all = publishTargets();
  const want = String(name || '').trim();
  if (!want) return all.length === 1 ? all[0] : (all[0] || null);
  return all.find(t => t.name === want) || null;
}

const git = (repo, args) => {
  const r = spawnSync('git', args, {
    cwd: repo, timeout: GIT_TIMEOUT_MS, encoding: 'utf8',
    // a git that stops to ask for a password over a tunnel is a git that
    // hangs; there is nobody at this terminal to answer it
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const text = `${String(r.stdout || '')}${String(r.stderr || '')}`.trim();
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { ok: false, text: `git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000}s` };
  }
  if (r.error) return { ok: false, text: String(r.error.message || r.error) };
  return { ok: r.status === 0, text, status: r.status };
};

/**
 * Copy, commit, push. Returns
 * `{ok, public_url, rel, commit, committed, pushed, error}` — and `ok` is
 * about the COPY AND COMMIT, not the push: a push that failed still leaves the
 * page committed, and the reader is told which of the two happened rather than
 * being handed one word for both.
 */
export function publishArtifact({ target, srcPath, title = '' }) {
  const t = target;
  if (!t) return { ok: false, error: 'no publish target is set up' };
  const name = publishName(srcPath);
  if (!name) return { ok: false, error: 'that file has no name a website could use' };
  let bytes = null;
  try { bytes = fs.readFileSync(srcPath); } catch (e) {
    return { ok: false, error: `could not read the page: ${e && e.message}` };
  }
  const rel = `${t.dir}/${name}`;
  const dest = path.join(t.repo, t.dir, name);
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // AS IT IS. No front matter, no rewriting: a file Jekyll finds with no
    // front matter is copied to the built site byte for byte, which is what a
    // self-contained page needs and is why nothing here has to know anything
    // about the reader's site.
    fs.writeFileSync(dest, bytes);
  } catch (e) {
    return { ok: false, error: `could not write into the site: ${e && e.message}` };
  }
  const add = git(t.repo, ['add', '--', rel]);
  if (!add.ok) return { ok: false, error: add.text || 'git add failed' };
  const subject = `publish: ${String(title || name).replace(/\s+/g, ' ').trim().slice(0, 72)} (${rel})`;
  const commit = git(t.repo, ['commit', '-m', subject, '--', rel]);
  // "nothing to commit" is not a failure: the page has not changed since the
  // last publish, the site already has it, and the reader wants the link
  // rather than an error about a no-op.
  const nothing = !commit.ok && /nothing to commit|no changes added/i.test(commit.text);
  if (!commit.ok && !nothing) {
    return { ok: false, error: commit.text || 'git commit failed' };
  }
  const head = git(t.repo, ['rev-parse', '--short', 'HEAD']);
  const sha = head.ok ? head.text.split('\n').pop().trim() : '';
  const out = {
    ok: true,
    public_url: `${t.url}${name}`,
    rel,
    target: t.name,
    commit: sha,
    committed: !nothing,
    unchanged: nothing,
    pushed: false,
  };
  if (!t.push) return out;
  const push = git(t.repo, ['push', 'origin', `HEAD:${t.branch}`]);
  if (!push.ok) return { ...out, error: push.text || 'git push failed' };
  return { ...out, pushed: true };
}
