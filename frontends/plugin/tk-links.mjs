// tk-links.mjs — A `/tk` PASSAGE MAY LINK TO THE OWNER'S OWN PUBLISHED POSTS (the owner's decision, 2026-11-27): "use a backlink to my
// essay on X to explain this" in a `/tk-claude …` or `/tk-codex …` instruction gives a passage holding `[[<note name>|<visible text>]]`,
// which the owner's site makes a real link only when the name is one of its own published posts.
//
// WHERE THE NAMES COME FROM: a CATALOGUE the owner's site prints, by the command set as `link_targets` in "Where my blyg lives"
// (blyg-home.mjs; `botference blyg-home`): JSON on stdout, the published posts only (docs/blygger.md, "The catalogue of your published
// posts"). It is run for each passage with a time limit and a size limit, never through a shell, in the site's work tree, with the
// same minimal environment as the publish commands; its output is checked field by field (validateCatalogue) and anything that does
// not fit is dropped. No setting, a failure, or nothing usable in it means NO CATALOGUE, and the passage runs exactly as it did before.
//
// IT IS NOT NOTES READING: it does not need `tk_read_roots` or `hub_link_tk_notes`, both agents get it, and it works with the
// capability set `web` (tk-read.mjs). When a run MAY read notes (`web+notes`), each post whose file lies under a read root is
// also given with that file's path, so the agent can read the post in full first; a `web` run is never given a path.
//
// A PASSAGE'S LINKING, one named value in one list (TK_LINKING), chosen by ONE function (tkLinkingFor) from what the catalogue
// command gave, kept in one field on the gap (`gap.links.catalogue`) with the counts of what the check after the run did; never a
// pile of flags:
//   none        no catalogue was given: the prompt says nothing about links (as before)
//   catalogue   the catalogue was put in the prompt as quoted data, with the rule for when and how to link
// AFTER THE RUN, in either case (checkLinks): a wikilink whose name is not exactly one the catalogue gave (every one, when none was
// given), and every embed (`![[…]]`), is reduced to its visible text before the passage is stored; the gap records how many links
// were kept and how many reduced. So nothing the companion stores names a note the catalogue did not offer.
import path from 'node:path';
import { spawn as realSpawn } from 'node:child_process';
import { pathKey } from './tk-read.mjs';

export const TK_LINKING = Object.freeze(['none', 'catalogue']);
export const LINK_LIMITS = Object.freeze({
  timeMs: 10_000,          // the catalogue command
  outputBytes: 512 * 1024, // …and what it may print
  posts: 200,              // posts read from it
  promptBytes: 48 * 1024,  // the catalogue as it goes into a prompt (the newest posts that fit)
  name: 200, title: 200, excerpt: 200, tags: 12, tag: 40, page: 300, file: 300,
});
const ID_RE = /^[0-9a-hjkmnp-tv-z]{26}$/;
const DATE_RE = /^\d{4}-\d\d-\d\d$/;
// characters that can hide or reorder text (tkgaps cleanData's list), and controls
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g;
const line = (v, max) => String(v).replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// a name a wikilink can carry: one line, no bracket, bar or hash, not an embed
const nameOk = n => !!n && n.length <= LINK_LIMITS.name && !/[\[\]|#\n]/.test(n);
/** A note name as two sides compare it. */
export const nameKey = n => String(n == null ? '' : n).normalize('NFC').trim();

/**
 * The catalogue command's output, checked field by field. → { ok, posts, truncated, dropped, error }.
 * A post is kept only with a usable `name` (unique) and `id`; every other field is optional and is dropped alone when it does not fit.
 * `file` is kept only as a relative path with no `..` (it is joined to the work tree by the caller, never trusted further).
 */
export function validateCatalogue(text) {
  const bad = error => ({ ok: false, posts: [], truncated: false, dropped: 0, error });
  let raw;
  try { raw = JSON.parse(String(text)); } catch { return bad('the catalogue is not JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.posts)) return bad('the catalogue has no list of posts');
  const posts = [];
  const seen = new Set();
  let dropped = 0;
  for (const p of raw.posts.slice(0, LINK_LIMITS.posts)) {
    const name = p && typeof p === 'object' && typeof p.name === 'string' ? nameKey(p.name.replace(INVISIBLE, '')) : '';
    if (!nameOk(name) || seen.has(name) || typeof p.id !== 'string' || !ID_RE.test(p.id)) { dropped++; continue; }
    seen.add(name);
    const post = { name, id: p.id };
    if (typeof p.title === 'string' && line(p.title, LINK_LIMITS.title)) post.title = line(p.title, LINK_LIMITS.title);
    if (typeof p.date === 'string' && DATE_RE.test(p.date)) post.date = p.date;
    const tags = Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string').map(t => line(t, LINK_LIMITS.tag)).filter(Boolean).slice(0, LINK_LIMITS.tags) : [];
    if (tags.length) post.tags = tags;
    if (typeof p.excerpt === 'string' && line(p.excerpt, LINK_LIMITS.excerpt)) post.excerpt = line(p.excerpt, LINK_LIMITS.excerpt);
    if (typeof p.file === 'string' && p.file.length <= LINK_LIMITS.file && !path.isAbsolute(p.file) && !/[\u0000-\u001f\\]/.test(p.file)
      && !p.file.split('/').some(s => s === '..' || s === '')) post.file = p.file;
    posts.push(post);
  }
  if (!posts.length) return bad('the catalogue lists no usable post');
  return { ok: true, posts, truncated: raw.truncated === true || raw.posts.length > LINK_LIMITS.posts, dropped, error: '' };
}

// THE COMMAND'S LIFE, one of CATALOGUE_RUN_STATES in one field, moved only by `to` (which refuses a move the table does not list).
// The answer is made in ONE place, when the process is gone (`ended`), from the state it was in: so it is made once.
//   running      started
//   timing-out   past its time: its process group was told to stop
//   flooding     it printed more than it may: its process group was told to stop
//   not-started  the program could not be started
//   ended        answered; nothing follows
export const CATALOGUE_RUN_STATES = Object.freeze(['running', 'timing-out', 'flooding', 'not-started', 'ended']);
const CATALOGUE_RUN_MOVES = Object.freeze({ running: Object.freeze(['timing-out', 'flooding', 'not-started', 'ended']),
  'timing-out': Object.freeze(['ended']), flooding: Object.freeze(['ended']), 'not-started': Object.freeze(['ended']), ended: Object.freeze([]) });
const CATALOGUE_RUN_FAILS = Object.freeze({ 'timing-out': 'the catalogue command took too long', flooding: 'the catalogue command printed too much',
  'not-started': 'the catalogue command could not be started' });
/**
 * Run the catalogue command: argv, never a shell, stdin closed, its own process group, stopped at the time limit or past the size
 * limit. Only stdout is read. → Promise<{ ok, text } | { ok: false, error }>. Never rejects.
 */
export function runCatalogueCommand({ argv, cwd, env, limitMs = LINK_LIMITS.timeMs, maxBytes = LINK_LIMITS.outputBytes, spawn = realSpawn }) {
  return new Promise(resolve => {
    let child = null;
    let size = 0;
    const out = [];
    let state = 'running';
    const to = next => { if (!CATALOGUE_RUN_MOVES[state].includes(next)) throw new Error(`catalogue: cannot go from ${state} to ${next}`); state = next; };
    const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    // the process is gone (or never was): the one place an answer is made
    const ended = code => {
      if (state === 'ended') return;
      const was = state;
      to('ended');
      clearTimeout(timer);
      if (CATALOGUE_RUN_FAILS[was]) resolve({ ok: false, error: CATALOGUE_RUN_FAILS[was] });
      else resolve(code === 0 ? { ok: true, text: Buffer.concat(out).toString('utf8') } : { ok: false, error: `the catalogue command failed (exit ${code})` });
    };
    const timer = setTimeout(() => { if (state === 'running') { to('timing-out'); stop(); } }, limitMs);
    try { child = spawn(argv[0], argv.slice(1), { cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch { to('not-started'); ended(null); return; }
    child.on('error', () => { if (state === 'running') to('not-started'); ended(null); });
    child.stdout.on('data', d => {
      if (state !== 'running') return;
      size += d.length;
      if (size > maxBytes) { to('flooding'); stop(); return; }
      out.push(d);
    });
    child.on('close', code => ended(code));
  });
}

/**
 * The catalogue for a passage, from the owner's setting (`home`: blyg-home validateHome's answer; `envFor`: blyg-home minimalEnv).
 * → { ok: true, posts, truncated, top } or { ok: false, error } (no setting, the command failed, nothing usable): no catalogue.
 */
export async function loadCatalogue({ home, envFor, run = runCatalogueCommand } = {}) {
  const S = home && home.ok ? home.settings : null;
  const argv = S && S.commands && S.commands.link_targets;
  if (!argv) return { ok: false, error: 'no catalogue command is set' };
  let r;
  try { r = await run({ argv, cwd: S.top, env: envFor(S.env_pass) }); } catch { r = { ok: false, error: 'the catalogue command could not be run' }; }
  if (!r || !r.ok) return { ok: false, error: (r && r.error) || 'the catalogue command failed' };
  const v = validateCatalogue(r.text);
  return v.ok ? { ok: true, posts: v.posts, truncated: v.truncated, dropped: v.dropped, top: S.top } : { ok: false, error: v.error };
}

/** THE ONE FUNCTION that says how a passage links: `catalogue` only with a catalogue that holds a post; anything else `none`. */
export function tkLinkingFor({ catalogue } = {}) {
  return catalogue && catalogue.ok === true && Array.isArray(catalogue.posts) && catalogue.posts.length ? 'catalogue' : 'none';
}
/** Refuses a value that is not one of TK_LINKING (a gap, a prompt and a check are only ever handed one of them). */
export function linkingOf(value) {
  if (!TK_LINKING.includes(value)) throw new Error(`links: no such linking ${JSON.stringify(String(value)).slice(0, 40)} (one of ${TK_LINKING.join(', ')})`);
  return value;
}

/**
 * The catalogue as it goes into a prompt: for each post its name, title, id, date, tags and first words; and, ONLY for a run that may
 * read notes (`caps` web+notes), the path of the post's own file when it lies under a read root. Newest first, as the site gave them;
 * cut to LINK_LIMITS.promptBytes (`cut` says so).
 */
export function promptCatalogue(catalogue, { caps = 'web', roots = [] } = {}) {
  const notes = caps === 'web+notes' && roots.length > 0 && !!catalogue.top;
  const under = f => roots.some(r => { const a = pathKey(f), b = pathKey(r); return a.startsWith(`${b}/`); });
  const all = catalogue.posts.map(p => {
    const e = { name: p.name, ...(p.title ? { title: p.title } : {}), id: p.id, ...(p.date ? { date: p.date } : {}),
      ...(p.tags ? { tags: p.tags } : {}), ...(p.excerpt ? { first_words: p.excerpt } : {}) };
    if (notes && p.file) { const abs = path.join(catalogue.top, p.file); if (under(abs)) e.file = abs; }
    return e;
  });
  const posts = [];
  let bytes = 2;
  for (const e of all) {
    const n = Buffer.byteLength(JSON.stringify(e), 'utf8') + 1;
    if (bytes + n > LINK_LIMITS.promptBytes) break;
    posts.push(e); bytes += n;
  }
  return { posts, cut: posts.length < all.length || !!catalogue.truncated, files: posts.some(e => e.file) };
}

// ---- after the run -------------------------------------------------------------------------------------------------------------
const fenceOf = l => /^ {0,3}(`{3,}|~{3,})/.exec(l);
// WHAT COUNTS AS A WIKILINK, exactly as the owner's site reads one in an agent passage (the example site's AgentMarkdown::WIKILINK,
// _plugins/blygger_agent_markdown.rb; the two are kept the same): `[[` + one line of text with no bracket in it + `]]`, optionally
// after `!`, NOT directly after a letter, a digit, `_` or `]` (so `matrix[[0]]` and `a[[i]][[j]]` are prose, as typed) and NOT
// directly before another `]` (so a nested `[[A|[[B]]]]` is no wikilink at all, as typed).
// (the `!` of an embed is part of it only when IT does not follow such a character: `wow![[A]]` is prose too)
const WIKILINK = /(?:(?<![A-Za-z0-9_\]])(!)|(?<![A-Za-z0-9_\]!]))\[\[([^\[\]\n]{1,400})\]\](?!\])/g;
/** A wikilink's parts as written: its name, and its visible text (the words after the bar, else the name). */
export function wikilinkParts(inner) {
  const at = inner.search(/\\?\|/);
  const name = nameKey(at === -1 ? inner : inner.slice(0, at));
  const label = at === -1 ? '' : inner.slice(at).replace(/^\\?\|/, '').trim();
  return { name, shown: label || name };
}
/**
 * The passage's text with every wikilink outside code checked against the names that were offered: one whose name is exactly a
 * catalogue name stays as written; any other, and every embed, becomes its visible text. → { text, kept, reduced }.
 * `linking` none: no name was offered, so every wikilink is reduced.
 */
export function checkLinks(text, { linking = 'none', names = [] } = {}) {
  const offered = linkingOf(linking) === 'catalogue' ? new Set(names.map(nameKey)) : new Set();
  let kept = 0;
  let reduced = 0;
  let fence = null;
  const lines = String(text == null ? '' : text).split('\n').map(l => {
    const f = fenceOf(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length && /^ {0,3}[`~]+[ \t]*$/.test(l)) fence = null; return l; }
    if (f) { fence = f[1]; return l; }
    if (!l.includes(']]')) return l;
    // (code spans on the line: a wikilink that starts inside one is left as typed)
    const spans = [...l.matchAll(/(`+).*?\1/g)].map(m => [m.index, m.index + m[0].length]);
    return l.replace(WIKILINK, (m, bang, inner, at) => {
      if (spans.some(([a, b]) => at >= a && at < b)) return m;
      const { name, shown } = wikilinkParts(inner);
      if (!bang && offered.has(name)) { kept++; return m; }
      reduced++;
      return shown;
    });
  });
  return { text: lines.join('\n'), kept, reduced };
}
