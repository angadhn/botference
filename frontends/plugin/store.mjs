// Page/thread persistence for the web-annotator companion.
// One JSON file per annotated page under <ROOT>/.botference/plugin/pages/,
// plus a small index the extension polls to know which pages have annotations.
// Every write is atomic (tmp + rename), same as the rest of the repo.
import fs from 'node:fs';
import os from 'node:os';
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

// Default vault: the nearest ancestor of the workspace that is an Obsidian
// vault (has .obsidian/), else the home directory — the export folder is
// created inside it either way. Only used to seed config.json on first run;
// an existing config always wins.
const isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };

function detectVault() {
  let dir = ROOT;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, '.obsidian'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return os.homedir();
}

export const DEFAULT_CONFIG = {
  vault_path: detectVault(),
  export_folder: 'Web Clippings',
  author: os.userInfo().username,
  // how long the bots' replies should run; the envelope carries the matching
  // instruction on every turn
  verbosity: 'short',
};
export const VERBOSITY_LEVELS = ['short', 'long'];

// The controller's session files, resolved exactly as core/paths.py resolves
// work_dir — we delete chats out of that directory when the bridge isn't
// running to be told about it, so guessing wrong would delete nothing (or,
// worse, something else).
export function workDir() {
  if (process.env.BOTFERENCE_WORK_DIR) return process.env.BOTFERENCE_WORK_DIR;
  if (process.env.BOTFERENCE_PROJECT_DIR) return process.env.BOTFERENCE_PROJECT_DIR;
  const projectDir = path.join(ROOT, 'botference');
  if (isDir(projectDir)) return projectDir;
  // ROOT is itself a botference state dir: its sessions/ is the real store
  if (isFile(path.join(ROOT, 'project.json'))) return ROOT;
  const work = path.join(ROOT, 'work');
  return isDir(work) ? work : ROOT;
}
export const sessionFile = sid => path.join(workDir(), 'sessions', `${String(sid)}.json`);

// Hard delete, no archive: the chat ceases to exist. A missing file is a
// success — the caller wanted it gone and it is.
export function deleteSessionFile(sid) {
  if (!sid || /[/\\]/.test(String(sid))) return false;
  try { fs.unlinkSync(sessionFile(sid)); return true; } catch { return false; }
}

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
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  // a hand-edited config must never make the envelope say something strange
  if (!VERBOSITY_LEVELS.includes(merged.verbosity)) merged.verbosity = DEFAULT_CONFIG.verbosity;
  return merged;
}

// settings the drawer can change (verbosity, today): merged over what is on
// disk and written atomically like everything else
export function saveConfig(patch) {
  const cfg = { ...readConfig(), ...patch };
  writeJson(CONFIG_FILE, cfg);
  return readConfig();
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

// The guest web view addresses pages by their key (the url is in the record,
// not in the link), so it needs the one lookup the extension never does.
// Goes through readPage so the same healing applies.
export function readPageByKey(key) {
  if (!/^[0-9a-f]{40}$/.test(String(key || ''))) return null;
  const raw = readJson(path.join(PAGES, `${key}.json`), null);
  return raw && raw.url ? readPage(raw.url) : null;
}

// the index is derived state: rewritten from the page record on every save,
// so a hand-deleted page file can never leave a phantom row behind
export function savePage(page) {
  page.updated_at = nowIso();
  writeJson(pageFile(page.url), page);
  const idx = readIndex();
  idx[pageKey(page.url)] = {
    url: page.url, title: page.title,
    threads: (page.threads || []).length,
    // the pages list badges the ones the bots have a chat about, and only the
    // index is loaded to draw it
    has_session: !!page.session_id,
    updated_at: page.updated_at,
  };
  writeJson(INDEX_FILE, idx);
  return page;
}

// The page is gone: its record and its index row go together, or the pages
// list keeps offering a row that opens onto nothing.
export function deletePage(url) {
  try { fs.unlinkSync(pageFile(url)); } catch { }
  const idx = readIndex();
  delete idx[pageKey(url)];
  writeJson(INDEX_FILE, idx);
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

// Two pages sharing one botference session is proof of the sid-inheritance
// bug, never a legitimate state: every page gets its own /new chat.
export function pageWithSession(sid, exceptUrl) {
  if (!sid) return null;
  const skip = exceptUrl ? pageKey(exceptUrl) : null;
  for (const key of Object.keys(readIndex())) {
    if (key === skip) continue;
    const p = readJson(path.join(PAGES, `${key}.json`), null);
    if (p && p.session_id === sid) return p.url;
  }
  return null;
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

// Markdown task-list items, in every marker style a bot might reach for:
// "- [ ]", "* [ ]", "+ [ ]", "1. [ ]", "2) [ ]". Only the box character is ever
// rewritten — indentation, marker, spacing and the item's words come back
// byte-for-byte, because the message being ticked is usually a bot's own reply.
const CHECKBOX_RE = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\])/gm;

// index-th checkbox of the message → checked/unchecked. null = no such box.
export function setCheckbox(text, index, checked) {
  const src = String(text || '');
  let n = 0;
  let hit = false;
  const out = src.replace(CHECKBOX_RE, (m, head, box, tail) => {
    if (n++ !== index) return m;
    hit = true;
    return head + (checked ? 'x' : ' ') + tail;
  });
  return hit ? out : null;
}

export function appendMsg(page, threadId, { author, text, ts, kind }) {
  const msgs = msgsOf(page, threadId);
  if (!msgs) return null;
  const msg = { author, ts: ts || nowIso(), text: String(text || '') };
  if (kind) msg.kind = String(kind); // "tools" — a bot's tool-activity summary
  msgs.push(msg);
  return msg;
}
