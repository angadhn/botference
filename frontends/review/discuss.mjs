// The review page's half of the unified comment store.
//
// A review page already has a margin, and a visitor without the botference
// extension writes into it — `state/users/<handle>.json`, one entry per
// comment, anchored by section slug + block cid + the quoted words. That file
// is a fine record and a terrible destination: the owner's Discuss drawer
// cannot see it, the bots are not in it, `send review` does not gather it and
// the Obsidian export never hears about it. Meanwhile the owner, reading the
// same page with the extension, writes into the companion's store. Two
// records of one conversation, neither knowing about the other.
//
// So the comments MOVE, one way, into the companion's store:
//
//   review page  ──POST /review-comments──▶  companion   (every user-comment,
//                                                         under its own id)
//   review page  ◀───GET /page?url=──────    companion   (whatever was said
//                                                         back, folded into
//                                                         the margin as thread
//                                                         entries)
//
// WHY THIS DIRECTION. The companion's record is the one with the bots, the
// send-review digest, the pages library and the export hanging off it; the
// review record is a file beside a document. Moving the small thing into the
// big one costs one endpoint and leaves every reader on both surfaces looking
// at the same conversation. The reverse would have meant teaching the drawer,
// the digest, the library and the export about a second store.
//
// WHY IT IS OPT-IN. `review.config.json` grows one block:
//
//   "discuss": { "companion": "http://127.0.0.1:4189" }
//
// and without it NOTHING here runs — not a fetch, not a timer, not a branch.
// A paper reviewed on a machine with no companion, a collaborator's clone, a
// static `site/` opened over file: — all of them keep the silo they have
// always had, working exactly as it always has. Unification is what happens
// when the companion is there to unify with, and never a dependency on it.
//
// WHAT IS DELIBERATELY NOT DONE HERE:
//   · nothing is ever DELETED in the companion. A comment withdrawn on the
//     review page leaves its Discuss thread standing, because that thread may
//     by then hold a bot's answer and the owner's reply, and neither belongs
//     to the person who withdrew the question.
//   · resolving travels one way (see the companion's endpoint) and reopening
//     does not travel at all.
//   · the browser is not touched. Every byte of this crosses between two
//     servers on the loopback, so a guest's cookie, a tunnel's CORS rules and
//     the review page's own scriptless margin are all left out of it.
import fs from 'node:fs';
import path from 'node:path';

// how often the reply cache is refreshed while anybody is looking
const POLL_MS = 5000;
const TIMEOUT_MS = 4000;

const readJSON = (f, fallback) => {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; }
};
function writeJSON(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
    fs.renameSync(tmp, file);
  } catch { /* a state dir we cannot write is not a reason to stop serving */ }
}

// A url the companion will file under. The review server serves one page per
// section at `/<slug>.html`, and the browser's address bar says the same
// thing, so this is the identity the OWNER's extension gives that page too —
// which is the whole point: one key, one record, whether the comment arrived
// through the margin or through the drawer.
export const sectionUrl = (base, section) =>
  `${String(base || '').replace(/\/+$/, '')}/${encodeURIComponent(String(section))}.html`;

// The origin a request came in on — what the person who wrote the comment
// actually had in their address bar. `base` in the config overrides it, which
// is how a paper served on several addresses is pinned to one.
export function baseOf(req) {
  const host = String((req && req.headers && req.headers.host) || '').trim();
  if (!host || /[^\w.:\[\]-]/.test(host)) return '';
  const fwd = String((req && req.headers && req.headers['x-forwarded-proto']) || '');
  const proto = fwd.split(',')[0].trim() || 'http';
  return /^https?$/.test(proto) ? `${proto}://${host}` : '';
}

// every user-comment in every user's file, grouped by the section page it
// belongs to. The owner's own margin comments are in here too: they are
// comments on the document, and which surface they were typed on is not a
// reason for one of them to be invisible in the drawer.
export function collect(users) {
  const bySection = new Map();
  for (const [handle, decisions] of Object.entries(users || {})) {
    for (const [id, d] of Object.entries(decisions || {})) {
      if (!d || d.status !== 'user-comment') continue;
      const section = String(d.section || '');
      const text = String(d.comment || '');
      if (!section || !text.trim()) continue;
      if (!bySection.has(section)) bySection.set(section, []);
      bySection.get(section).push({
        id,
        author: handle,
        ts: d.ts || '',
        // the exact selection. A block-level comment has none — it is about
        // the document rather than a passage — and the companion files those
        // in page chat rather than minting an anchor onto nothing.
        quote: String(d.quote || ''),
        text,
        resolved: !!d.resolved,
        replies: (Array.isArray(d.thread) ? d.thread : [])
          .filter(t => t && t.ts && String(t.text || '').trim())
          .map(t => ({ author: handle, ts: t.ts, text: String(t.text) })),
      });
    }
  }
  // stable order: oldest first inside a section, so a page read for the first
  // time gets its threads in the order the conversation happened
  for (const list of bySection.values()) {
    list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)) || a.id.localeCompare(b.id));
  }
  return bySection;
}

// What the companion said back. Every message in a mirrored thread EXCEPT the
// ones that came from here — a mirrored message carries `origin`, so the round
// trip stops at the first turn rather than echoing forever — rendered in the
// exact shape the review page already draws bot replies in
// (`state/threads.json`: `{author, ts, text}` under the comment's own id).
// That is why the margin needs no new rendering code at all.
export function repliesFrom(page) {
  const out = {};
  for (const t of (page && page.threads) || []) {
    const o = t && t.origin;
    if (!o || o.system !== 'review' || !o.id) continue;
    const back = (t.msgs || []).slice(1)
      .filter(m => m && !m.origin && m.kind !== 'tools' && String(m.text || '').trim())
      .map(m => ({ author: String(m.author || ''), ts: m.ts, text: String(m.text) }));
    if (back.length) out[o.id] = back;
  }
  // …and the page chat, where the block-level comments went. Their answers
  // belong to the comment they answer, which is the message carrying the
  // origin: everything after it, up to the next mirrored message, is the reply
  // to it.
  const chat = (page && page.page_chat) || [];
  let held = '';
  for (const m of chat) {
    if (!m) continue;
    const o = m.origin;
    if (o && o.system === 'review' && o.id) { held = o.id; continue; }
    if (!held || m.kind === 'tools' || !String(m.text || '').trim()) continue;
    (out[held] = out[held] || []).push({ author: String(m.author || ''), ts: m.ts, text: String(m.text) });
  }
  return out;
}

// Merge the companion's answers into the review record's own bot threads.
// Additive and non-destructive: an id the companion knows nothing about keeps
// exactly the entries `threads.json` holds for it.
export function mergeThreads(threads, extra) {
  if (!extra || !Object.keys(extra).length) return threads;
  const out = { ...(threads || {}) };
  for (const [id, list] of Object.entries(extra)) {
    const have = Array.isArray(out[id]) ? out[id] : [];
    const seen = new Set(have.map(e => `${e.author}|${e.ts}`));
    const add = list.filter(e => !seen.has(`${e.author}|${e.ts}`));
    if (add.length) {
      out[id] = [...have, ...add].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    }
  }
  return out;
}

export function createDiscuss({ reviewDir, cfg, onChange = () => { }, fetchImpl = globalThis.fetch }) {
  const block = (cfg && cfg.discuss) || null;
  const companion = block && typeof block.companion === 'string'
    ? block.companion.replace(/\/+$/, '') : '';
  const enabled = !!companion;
  const stateFile = path.join(reviewDir, 'state', 'discuss-mirror.json');
  // { base, sections: {slug: {digest, threads:{id: thread_id}}} } — the digest
  // is the only reason this file exists: the browser mirrors its WHOLE store
  // on a 400 ms debounce, and re-posting an unchanged page on every keystroke
  // would be a great deal of noise for no news.
  let mem = enabled ? (readJSON(stateFile, null) || { base: '', sections: {} }) : { base: '', sections: {} };
  let cache = {};        // id -> [{author, ts, text}] read back from the companion
  let timer = null;
  let watchers = 0;
  let inFlight = false;

  const digestOf = list => JSON.stringify(list);

  async function post(url, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${companion}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(t); }
  }
  async function get(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetchImpl(`${companion}${url}`, { signal: ctrl.signal });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(t); }
  }

  // One pass over every section that has comments. Returns what it did, which
  // is what the tests read; the server ignores it.
  async function mirror(users, { base, summon = false } = {}) {
    if (!enabled) return null;
    const b = (block.base || base || mem.base || '').replace(/\/+$/, '');
    if (!b) return null;
    if (b !== mem.base) { mem = { base: b, sections: {} }; }
    const bySection = collect(users);
    const sent = [];
    for (const [section, comments] of bySection) {
      const digest = digestOf(comments);
      const prev = mem.sections[section];
      if (prev && prev.digest === digest) continue;
      const r = await post('/review-comments', {
        url: sectionUrl(b, section),
        title: section,
        summon,
        comments,
      });
      if (!r || r.ok === false) continue; // the companion is asleep; try again next time
      mem.sections[section] = { digest, threads: r.threads || {} };
      sent.push({ section, created: r.created || 0, appended: r.appended || 0, refusals: r.refusals || [] });
    }
    if (sent.length) writeJSON(stateFile, mem);
    return { base: b, sent };
  }

  // The other direction, on a timer rather than on demand: `/data` is answered
  // from this cache synchronously, because a request that waited on another
  // server's http would make the margin as slow as the slowest hop.
  async function pull() {
    if (!enabled || inFlight) return cache;
    const b = (block.base || mem.base || '').replace(/\/+$/, '');
    if (!b) return cache;
    inFlight = true;
    try {
      const next = {};
      for (const section of Object.keys(mem.sections || {})) {
        const page = await get(`/page?url=${encodeURIComponent(sectionUrl(b, section))}`);
        if (!page || !page.threads) continue;
        Object.assign(next, repliesFrom(page));
      }
      const changed = JSON.stringify(next) !== JSON.stringify(cache);
      cache = next;
      if (changed) onChange();
    } finally { inFlight = false; }
    return cache;
  }

  return {
    enabled,
    companion,
    mirror,
    pull,
    replies: () => cache,
    // the poll runs only while somebody is connected: a review page nobody has
    // open is a review page with nothing to refresh
    watch(n) {
      watchers = Math.max(0, n);
      if (!enabled) return;
      if (watchers && !timer) {
        timer = setInterval(() => { pull(); }, Number(block.poll_ms) || POLL_MS);
        if (timer.unref) timer.unref();
        pull();
      } else if (!watchers && timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    stop() { if (timer) { clearInterval(timer); timer = null; } },
    // tests reach in for these
    _state: () => mem,
  };
}
