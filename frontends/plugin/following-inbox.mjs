// following-inbox.mjs — the owner's mentions inbox, read for the Mentions tab.
//
// The owner's own site keeps a private inbox of responses to their posts, read
// over HTTPS with a bearer token: GET <inbox_api_url> with `Authorization:
// Bearer <token>` returns JSON of the shape
//   { generated_at, count, capacity:{…}, failure_log:{…, never_verified:K},
//     never_verified:[…], blocked:[…], mentions:[{…}] }.
// THE REAL SHAPE OF A MENTION IS UNVERIFIED. Only the fields a command-line
// listing showed are known: who (author name), their blyg's title, what they did
// (replied / quoted / linked), the version of the owner's post, a timestamp, the
// quoted passage, the source URL, the owner's post title and URL. So the parser is
// defensive and the whole mapping from the inbox's field names to ours is ONE table,
// MENTION_FIELDS, which is the place to correct it: each of our names lists the
// inbox keys it may arrive under, first present wins.
//
// THE TOKEN. It lives in a local file (first line), named by the setting
// `inbox_token_file`. It is read when a fetch is about to be made, held in a local
// variable, sent as a header by netguard (only to the inbox's own origin), and never
// stored in settings, in following.json, in a response to the browser, in a log or in
// an error message; anything quoted back from the inbox is scrubbed of it first.
// The file may not be inside the repository or the companion's data folders.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Our name → the inbox's keys it may arrive under (first present wins). The one table to correct. */
export const MENTION_FIELDS = Object.freeze({
  id: ['id', 'mention_id'],
  who: ['who', 'author', 'author_name', 'from', 'name'],
  blyg_title: ['blyg_title', 'blyg', 'site_title', 'source_title', 'site'],
  action: ['action', 'relation', 'type', 'kind', 'what', 'verb'],
  version: ['version', 'target_version', 'my_version', 'post_version', 'item_version'],
  at: ['at', 'timestamp', 'received_at', 'created', 'time', 'when', 'date'],
  passage: ['passage', 'quote', 'quoted', 'excerpt', 'text'],
  source_url: ['source_url', 'source', 'url', 'from_url', 'page'],
  post_title: ['post_title', 'target_title', 'my_post_title', 'item_title', 'title'],
  post_url: ['post_url', 'target_url', 'my_post_url', 'item_url', 'target'],
  explicit_class: ['class', 'mention_class', 'tier'],
});

// What the owner did / the relation → the spec's class (§15.5). Anything not here is 'unknown',
// shown as such, never guessed.
//   response — a verified mention, relation stub / transclusion / fork / source, with words of its own
//   notice   — relation link, or a repost (a stub or transclusion with no words of its own)
//   plain    — a source that is not a blyg item, verified the W3C way (§15.6): a lower class
export const MENTION_CLASSES = Object.freeze(['response', 'notice', 'plain', 'unknown']);
export const ACTION_CLASSES = Object.freeze({
  replied: 'response', reply: 'response', stub: 'response', quoted: 'response', quote: 'response',
  transclusion: 'response', transcluded: 'response', fork: 'response', forked: 'response', source: 'response', sourced: 'response',
  linked: 'notice', link: 'notice', reposted: 'notice', repost: 'notice',
  plain: 'plain', webmention: 'plain', 'plain mention': 'plain',
});
export const REPOST_RE = /repost/i;

const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const clean = (v, n = 300) => String(typeof v === 'string' ? v : '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
  .replace(BIDI, '').replace(/\s+/g, ' ').trim().slice(0, n);
const webUrl = v => { try { const u = new URL(String(v || '').trim()); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch { return ''; } };

function pick(obj, keys) {
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  return undefined;
}
function textOf(v, n = 300, depth = 0) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return clean(v, n);
  if (typeof v === 'number' || typeof v === 'boolean') return clean(String(v), n);
  // an object is read one or two levels down (an author given as { name }), never further
  if (typeof v === 'object' && depth < 3 && !Array.isArray(v)) return textOf(pick(v, ['name', 'title', 'text', 'url']), n, depth + 1);
  return '';
}
function urlOf(v) {
  if (v && typeof v === 'object') return webUrl(pick(v, ['url', 'href', 'page', 'source']));
  return webUrl(v);
}
function whenOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) { const d = new Date(v < 1e12 ? v * 1000 : v); return Number.isNaN(d.getTime()) ? '' : d.toISOString(); }
  const s = textOf(v, 40);
  return s;
}

/** One inbox mention → ours. Tolerates anything: a missing field is '' (never invented). `redact` scrubs a secret out of the raw copy. */
export function normaliseMention(raw, redact = s => s) {
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { text: raw };
  const f = Object.fromEntries(Object.entries(MENTION_FIELDS).map(([k, keys]) => [k, pick(m, keys)]));
  const action = textOf(f.action, 40).toLowerCase();
  const explicit = textOf(f.explicit_class, 20).toLowerCase();
  const klass = MENTION_CLASSES.includes(explicit) && explicit !== 'unknown' ? explicit
    : Object.prototype.hasOwnProperty.call(ACTION_CLASSES, action) ? ACTION_CLASSES[action] : 'unknown';
  const out = { class: klass, action, who: textOf(f.who, 160), blyg_title: textOf(f.blyg_title, 200),
    version: Number.isInteger(f.version) ? f.version : (/^\d{1,6}$/.test(textOf(f.version, 8)) ? Number(textOf(f.version, 8)) : 0),
    at: whenOf(f.at), passage: textOf(f.passage, 600), source_url: urlOf(f.source_url), post_title: textOf(f.post_title, 200), post_url: urlOf(f.post_url) };
  // anything of a secret the inbox might echo back is scrubbed from every field we keep
  for (const k of Object.keys(out)) if (typeof out[k] === 'string') out[k] = redact(out[k]);
  const id = textOf(f.id, 120);
  out.ident = id ? `id:${id}` : 'h:' + crypto.createHash('sha1').update(JSON.stringify([out.source_url, out.at, out.action, out.post_url, out.passage, out.who])).digest('hex').slice(0, 24);
  let rawText = '';
  try { rawText = JSON.stringify(m, null, 2) || ''; } catch { rawText = ''; }
  out.raw = clean2(redact(rawText), 4000);
  return out;
}
// the raw copy keeps its line breaks (it is shown in a <pre>, escaped) but loses control and override characters
const clean2 = (s, n) => String(s).replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ' ').replace(BIDI, '').slice(0, n);

export const SCRUB_DEPTH = 24;
/**
 * A copy of a parsed JSON document with `token` replaced, in every string and every key, BEFORE anything is
 * extracted or clipped (so a token cut by a clip limit cannot leave a prefix of itself). Nesting deeper than
 * SCRUB_DEPTH is replaced by a marker, so a hostile document cannot overflow the stack.
 */
export function scrubDeep(value, token, depth = 0) {
  const fix = s => (token ? String(s).split(token).join('[redacted]') : String(s));
  if (typeof value === 'string') return fix(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= SCRUB_DEPTH) return '[too deeply nested]';
  if (Array.isArray(value)) return value.map(v => scrubDeep(v, token, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[fix(k)] = scrubDeep(v, token, depth + 1);
  return out;
}

/** The whole inbox answer → { generated_at, count, never_verified: [label], never_verified_count, blocked_count, mentions: [normalised] } */
export function parseInbox(json, redact = s => s, limit = 500) {
  const j = json && typeof json === 'object' ? json : {};
  const list = Array.isArray(j.mentions) ? j.mentions : [];
  const label = e => (e && typeof e === 'object'
    ? clean([textOf(pick(e, MENTION_FIELDS.who), 100), urlOf(pick(e, MENTION_FIELDS.source_url)) || textOf(pick(e, MENTION_FIELDS.source_url), 200)].filter(Boolean).join(' ') || redact(JSON.stringify(e)), 240)
    : clean(redact(String(e ?? '')), 240));
  const nv = Array.isArray(j.never_verified) ? j.never_verified : [];
  const fl = j.failure_log && typeof j.failure_log === 'object' ? j.failure_log : {};
  return {
    generated_at: textOf(j.generated_at, 40), count: Number.isInteger(j.count) ? j.count : list.length,
    never_verified: nv.slice(0, 50).map(label),
    never_verified_count: Number.isInteger(fl.never_verified) ? fl.never_verified : nv.length,
    blocked_count: Array.isArray(j.blocked) ? j.blocked.length : 0,
    mentions: list.slice(0, limit).map(m => normaliseMention(m, redact)),
  };
}

// ---- the token file ---------------------------------------------------------
// the real path, symlinks followed as far as the path exists (a file that is not there yet is judged by its folder)
function real(p) {
  const abs = path.resolve(p);
  try { return fs.realpathSync(abs); } catch { /* not there: resolve the part that is */ }
  const up = path.dirname(abs);
  return up === abs ? abs : path.join(real(up), path.basename(abs));
}
const inside = (child, dir) => { const d = real(dir); return child === d || child.startsWith(d.endsWith(path.sep) ? d : d + path.sep); };
/** Why this path may not hold the token, or ''. Not absolute, a directory, or inside a place that is shared or synced. */
export function tokenPathRefusal(file, forbidden = []) {
  const s = String(file || '');
  if (!path.isAbsolute(s)) return 'the token file must be an absolute path';
  const r = real(s);
  for (const dir of forbidden) if (dir && inside(r, dir)) return 'the token file may not be inside the repository or the companion\'s data folders';
  return '';
}
/** The token: the file's first line. Throws (with no token in the message) when it may not be used. */
export function readTokenFile(file, forbidden = []) {
  const why = tokenPathRefusal(file, forbidden);
  if (why) throw new Error(why);
  let st;
  try { st = fs.statSync(file); } catch { throw new Error('the token file cannot be read'); }
  if (!st.isFile()) throw new Error('the token file is not a file');
  let text;
  try { text = fs.readFileSync(file, 'utf8').slice(0, 4096); } catch { throw new Error('the token file cannot be read'); }
  const token = text.split(/\r?\n/)[0].trim();
  if (!token) throw new Error('the token file is empty');
  // a first line that is too long is refused, never truncated (a truncated token is a different, wrong one)
  if (token.length > TOKEN_MAX) throw new Error(`the token file's first line is longer than ${TOKEN_MAX} characters`);
  if (token.length < TOKEN_MIN) throw new Error("the token file's first line is too short to be a token");
  // visible ASCII only, and neither a quote nor a backslash: such a token would survive, escaped, in a JSON copy
  if (!/^[!#-\[\]-~]+$/.test(token)) throw new Error("the token file's first line is not a usable token");
  return token;
}
export const TOKEN_MAX = 512, TOKEN_MIN = 8;
/** A warning, or '', about who else can read the token file (group or others): never a refusal. Reads no content. */
export function tokenFileWarning(file) {
  try {
    const st = fs.statSync(String(file || ''));
    if (st.isFile() && (st.mode & 0o077) !== 0) return 'this token file can be read by other users of this computer; make it readable by you alone (chmod 600)';
  } catch { /* not there: readTokenFile says so when it is used */ }
  return '';
}
/** A scrubber for one token: replaces every occurrence with a marker. */
export const redactor = token => (token ? s => String(s).split(token).join('[redacted]') : s => s);
