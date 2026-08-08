// Page/thread persistence for the web-annotator companion.
// One JSON file per annotated page under <ROOT>/.botference/plugin/pages/,
// plus a small index the extension polls to know which pages have annotations.
// Every write is atomic (tmp + rename), same as the rest of the repo.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(PLUGIN, '..', '..');
export const HOME = process.env.BOTFERENCE_HOME || REPO;
export const ROOT = process.env.BOTFERENCE_PROJECT_ROOT || REPO;
export const DIR = path.join(ROOT, '.botference', 'plugin');
const PAGES = path.join(DIR, 'pages');
const INDEX_FILE = path.join(DIR, 'index.json');
const CONFIG_FILE = path.join(DIR, 'config.json');

export const DEFAULT_CONFIG = {
  vault_path: '/Users/angadhnanjangud/MySiteFromObsidianVault',
  export_folder: 'Web Clippings',
  author: 'angadh',
};

const nowIso = () => new Date().toISOString();

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// url identity: no hash, no campaign params, no trailing slash. Two tabs on
// the same article — one arriving from a newsletter link — must land on one
// page file, or half the annotations vanish.
//
// This function is duplicated in the extension (background.js, content.js):
// the content script can't import server code, and the three copies must
// agree exactly or events address pages nobody is looking at. Keep them in
// lockstep — SPEC.md defines the rule.
const STRIP_PARAM = /^(utm_[^=]*|fbclid|gclid)$/i;
export function normUrl(raw) {
  try {
    const url = new URL(String(raw));
    url.hash = '';
    const keep = [];
    for (const [k, v] of url.searchParams) if (!STRIP_PARAM.test(k)) keep.push([k, v]);
    url.search = '';
    for (const [k, v] of keep) url.searchParams.append(k, v);
    let s = url.toString();
    s = s.replace(/\?$/, '');
    if (s.endsWith('/') && !/^[a-z]+:\/\/[^/]+\/$/i.test(s)) s = s.slice(0, -1);
    return s;
  } catch {
    return String(raw || '').split('#')[0];
  }
}
export const pageKey = url => crypto.createHash('sha1').update(normUrl(url)).digest('hex');
export const pageFile = url => path.join(PAGES, `${pageKey(url)}.json`);
export const siteOf = url => { try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; } };
export const newThreadId = () =>
  `t-${Date.now()}-${crypto.randomBytes(2).toString('hex')}`;

export function readConfig() {
  const cfg = readJson(CONFIG_FILE, null);
  if (!cfg) { writeJson(CONFIG_FILE, DEFAULT_CONFIG); return { ...DEFAULT_CONFIG }; }
  return { ...DEFAULT_CONFIG, ...cfg };
}

export const readIndex = () => readJson(INDEX_FILE, {});

// Reading heals: a thread whose last message was deleted is a highlight that
// opens onto nothing. Records damaged before deletes pruned at the source are
// repaired (and re-indexed) the first time anything touches them.
export function readPage(url) {
  const page = readJson(pageFile(url), null);
  if (!page) return null;
  const kept = (page.threads || []).filter(t => (t.msgs || []).length);
  if (kept.length !== (page.threads || []).length) {
    page.threads = kept;
    savePage(page);
  }
  return page;
}

// the index is derived state: rewritten from the page record on every save,
// so a hand-deleted page file can never leave a phantom row behind
export function savePage(page) {
  page.updated_at = nowIso();
  writeJson(pageFile(page.url), page);
  const idx = readIndex();
  idx[pageKey(page.url)] = {
    url: page.url, title: page.title,
    threads: (page.threads || []).length, updated_at: page.updated_at,
  };
  writeJson(INDEX_FILE, idx);
  return page;
}

export function blankPage({ url, title, site }) {
  const ts = nowIso();
  return {
    version: 1,
    url: normUrl(url),
    title: String(title || url || '').trim() || normUrl(url),
    site: site || siteOf(url),
    created_at: ts, updated_at: ts,
    session_id: null,
    threads: [],
    page_chat: [],
  };
}

// POST /page: create the shell or refresh title/site. Never touches threads,
// page_chat or session_id — a re-visit must not disturb the conversation.
export function upsertPage({ url, title, site }) {
  const page = readPage(url) || blankPage({ url, title, site });
  if (title) page.title = String(title).trim();
  if (site) page.site = String(site);
  if (!page.site) page.site = siteOf(url);
  return savePage(page);
}

export const PAGE_CHAT = '__page__';
export const findThread = (page, id) => (page.threads || []).find(t => t.id === id) || null;
// both comment threads and the page chat are "a list of msgs" to every caller
// that appends, edits or deletes — resolve once, here
export function msgsOf(page, threadId) {
  if (threadId === PAGE_CHAT) return page.page_chat;
  const t = findThread(page, threadId);
  return t ? t.msgs : null;
}

export function addThread(page, { quote, prefix, suffix, text, author, index }) {
  const thread = {
    id: newThreadId(),
    quote: String(quote || ''),
    prefix: String(prefix || '').slice(-32),
    suffix: String(suffix || '').slice(0, 32),
    orphaned: false,
    msgs: [{ author, ts: nowIso(), text: String(text || '') }],
  };
  // the extension knows the page order of its highlights; when it tells us
  // where the new one sits we honor it, otherwise the thread appends
  const at = Number.isInteger(index) && index >= 0 && index <= page.threads.length
    ? index : page.threads.length;
  page.threads.splice(at, 0, thread);
  return thread;
}

export function appendMsg(page, threadId, { author, text, ts, kind }) {
  const msgs = msgsOf(page, threadId);
  if (!msgs) return null;
  const msg = { author, ts: ts || nowIso(), text: String(text || '') };
  if (kind) msg.kind = String(kind); // "tools" — a bot's tool-activity summary
  msgs.push(msg);
  return msg;
}
