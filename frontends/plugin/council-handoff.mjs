// "Continue in council": carry a page's conversation into the reader's council
// as a chat of its own.
//
// THE GAP THIS CROSSES. A page chat already IS a botference session — but in
// the companion's OWN workspace (the plugin workspace, filed under "Plugin
// pages"), while the council web UI the reader uses every day runs against a
// different workspace (their vault). So a page chat never shows up in the
// council at all, and a conversation that turned into an idea worth keeping
// stays stranded on the page it started on.
//
// WHAT CROSSES IT. Not the plugin's session file. Its transcript is this
// companion's wire format (every user turn an envelope of page excerpts and
// length rules), its system prompt is the margin-note one, and its native
// claude/codex sessions were started from another folder. Resuming that in
// the council would give the bots the wrong job and a session they cannot
// reach. Instead this module builds a CLEAN conversation from the page record
// — the reader's own words, the bots' replies, the margin comments, and a note
// saying where it all came from — and core/session_import.py writes it as a
// brand-new council session through the council's own SessionStore (locked,
// atomic, index-publishing; no running council process needs a restart).
//
// It is a COPY. The page keeps its chat and its comments and goes on working
// exactly as before; the council chat is a fork the reader now owns. Nothing
// in the copy summons a bot: both bots start fresh and are handed the whole
// carried-over conversation as backfill on the reader's FIRST message there.
//
// Two callers, one implementation: POST /continue-in-council (server.mjs, the
// drawer's button) and `botference discuss continue <url>` (continue-cli.mjs,
// for when the companion is not the thing you have in front of you).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

// How many copies a page remembers. A receipt list, not an archive: the chats
// themselves live in the council.
export const COPIES_MAX = 10;
// a quoted passage is context, not the point — enough to recognise it by
export const QUOTE_MAX = 400;
export const COUNCIL_WEB_DEFAULT = 'http://localhost:4187';

const BOT_RE = /^(claude|codex|gemini)\b/i;
const MORE_RE = /^[ \t]*<!--more-->[ \t]*$/gm;

// The page's `<!--more-->` fold is a drawer affordance; the council has no
// "▸ more", so the marker goes and the long half simply follows the short one.
const clean = t => String(t == null ? '' : t).replace(MORE_RE, '').replace(/\n{3,}/g, '\n\n').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// The messages that are the conversation: no tool-run summaries (they are a
// collapsed "Explored · N steps" row in the drawer and noise anywhere else),
// nothing set aside by an edit (the reader rewrote that turn; the old branch
// is not what was said), nothing empty.
const spoken = msgs => (Array.isArray(msgs) ? msgs : [])
  .filter(m => m && m.text && m.kind !== 'tools' && !m.superseded);

// Who said it, in a council transcript's terms. The owner is "user". A bot is
// itself (gemini has no seat in the council transcript, so it speaks as a
// labelled system line). Anyone else — a guest on a hosted companion — is the
// user too, but named, so the bots never mistake a visitor for the reader.
function speakerOf(author, owner) {
  const a = String(author || '').trim();
  const bot = BOT_RE.exec(a);
  if (bot) {
    const name = bot[1].toLowerCase();
    return name === 'gemini' ? { speaker: 'system', label: 'Gemini' } : { speaker: name, label: '' };
  }
  if (!a || !owner || a === owner) return { speaker: 'user', label: '' };
  return { speaker: 'user', label: a };
}

function msgLine(m, owner) {
  const { label } = speakerOf(m.author, owner);
  const who = BOT_RE.test(String(m.author || '')) ? String(m.author).trim() : (label || 'reader');
  return `- ${who}: ${clean(m.text).replace(/\n+/g, ' ')}`;
}

/**
 * The margin comments as ONE system entry: every thread that has anything in
 * it, in page order, quote first, then who said what in it. Answers '' for a
 * page with no comments — no empty heading in the chat.
 */
export function commentsBlock(page, owner = '') {
  const threads = (Array.isArray(page && page.threads) ? page.threads : [])
    .filter(t => t && spoken(t.msgs).length);
  if (!threads.length) return '';
  const out = [`The reader's margin comments on the page (${threads.length} thread${threads.length === 1 ? '' : 's'}):`];
  threads.forEach((t, i) => {
    const state = t.resolved ? 'resolved' : t.deleted ? 'passage since deleted' : 'open';
    const kind = t.mark === 'strike' ? 'strike-through' : 'comment';
    const quote = clean(t.quote).replace(/\s+/g, ' ');
    out.push('');
    out.push(`${i + 1}. ${kind}, ${state}${quote ? ` — on “${cut(quote, QUOTE_MAX)}”` : ''}`);
    for (const m of spoken(t.msgs)) out.push(msgLine(m, owner));
  });
  return out.join('\n');
}

/**
 * The conversation the council chat will hold, as {speaker, text} entries:
 *   1. a system note — where this came from (title, address) and what it is now;
 *   2. the margin comments, if there are any (one system entry);
 *   3. the page chat itself, turn by turn, in the council's own speakers.
 * `body` is everything but the dated note, which is what decides whether a
 * second click has anything new to carry.
 */
export function handoffEntries(page, { owner = '', snapshotPath = '', now = new Date() } = {}) {
  const title = String((page && (page.custom_title || page.title)) || (page && page.url) || 'a web page');
  const url = String((page && page.url) || '');
  const chat = spoken(page && page.page_chat);
  const comments = commentsBlock(page, owner);
  const body = [];
  if (comments) body.push({ speaker: 'system', text: comments });
  for (const m of chat) {
    const { speaker, label } = speakerOf(m.author, owner);
    const text = clean(m.text);
    if (!text) continue;
    body.push({ speaker, text: label ? `[${label}] ${text}` : text });
  }
  const counts = [
    chat.length ? `${chat.length} chat message${chat.length === 1 ? '' : 's'}` : '',
    comments ? 'the margin comments' : '',
  ].filter(Boolean).join(' and ');
  const note = [
    `Carried over from Discuss on ${now.toISOString().slice(0, 10)}: the reader's conversation about “${title}”${url ? ` (${url})` : ''}${counts ? ` — ${counts}` : ''}.`,
    'This is now the reader’s own chat in the council, not a margin note on the page: continue it as their idea, at whatever length the work needs. What follows is the conversation so far.',
    snapshotPath ? `The full text of the page, as it was when they read it, is saved at ${snapshotPath} — read it if you need the article itself.` : '',
  ].filter(Boolean).join('\n');
  return { note: { speaker: 'system', text: note }, body };
}

// What a copy is a copy OF: the conversation, not the date it was made. Two
// clicks with nothing said in between are one chat in the council, not two.
export const fingerprint = body =>
  crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex').slice(0, 16);

/** The copies this page has made, oldest first. */
export function copiesOf(page) {
  const raw = page && page.council_copies;
  return (Array.isArray(raw) ? raw : []).filter(c => c && c.root && c.session_id);
}

export const councilLink = (base, sid) =>
  `${String(base || COUNCIL_WEB_DEFAULT).replace(/\/+$/, '')}/#/chat/${encodeURIComponent(sid)}`;

// The project the copy is filed in, when the caller named none: the ONE
// project this page is filed under in that council, or nowhere (the council's
// Inbox) — never a guess between two.
export function defaultProject(filed, root) {
  const here = (Array.isArray(filed) ? filed : []).filter(f => f && f.root === root && f.id);
  return here.length === 1 ? here[0].id : '';
}

/**
 * Make (or find) the council copy of this page's conversation.
 *
 *   page        the page record (mutated: a receipt is pushed onto
 *               `council_copies`; the CALLER saves it)
 *   root        the council root to write into (absolute)
 *   projectId   project to file it under, or '' for unfiled
 *   home        BOTFERENCE_HOME (where core/session_import.py lives)
 *   python      interpreter
 *   councilWeb  base address of the council web UI, for the link
 *   owner       the reader's handle (whose messages are "user")
 *   snapshotPath  where the page's full text is saved, or ''
 *   fresh       true = always make a new copy, even if nothing changed
 *
 * Answers {ok, session_id, url, project_id, reused, entries} or {ok:false, error}.
 */
export function continueInCouncil(page, {
  root, projectId = '', home, python = 'python3', councilWeb = COUNCIL_WEB_DEFAULT,
  owner = '', snapshotPath = '', fresh = false, run = spawnSync,
} = {}) {
  if (!page) return { ok: false, error: 'no such page' };
  if (!root) return { ok: false, error: 'no council to continue in' };
  const { note, body } = handoffEntries(page, { owner, snapshotPath });
  if (!body.length) return { ok: false, error: 'nothing to carry over yet — this page has no chat and no comments' };
  const fp = fingerprint(body);
  const copies = copiesOf(page);
  const last = copies.length ? copies[copies.length - 1] : null;
  // Nothing new since the last copy, and that copy is still there: hand back
  // the same chat. A copy the reader has since deleted (or archived) in the
  // council is not "still there", and a fresh one is made instead.
  if (!fresh && last && last.root === root && last.fingerprint === fp
      && (!last.session_file || fs.existsSync(last.session_file))) {
    return { ok: true, reused: true, session_id: last.session_id, project_id: last.project_id || '',
      url: councilLink(councilWeb, last.session_id), entries: body.length + 1 };
  }
  const spec = {
    title: String(page.custom_title || page.title || page.url || 'From Discuss'),
    project_id: projectId || '',
    entries: [note, ...body],
  };
  // Every inherited BOTFERENCE_* variable goes: they describe THIS companion's
  // workspace, and the one thing the script must resolve is the council's —
  // exactly as a council bridge started in `root` would (chat.mjs scrubs a
  // bridge child's environment for the same reason).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('BOTFERENCE_')));
  const r = run(python, [path.join(home, 'core', 'session_import.py')], {
    input: JSON.stringify(spec),
    env: { ...env, BOTFERENCE_HOME: home, BOTFERENCE_PROJECT_ROOT: root },
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  let out = null;
  try { out = JSON.parse(String(r.stdout || '').trim().split('\n').pop() || 'null'); } catch { out = null; }
  if (!out || !out.ok) {
    const why = (out && out.error) || String(r.stderr || '').trim().split('\n').pop()
      || (r.error && r.error.message) || 'the council did not take it';
    return { ok: false, error: why };
  }
  // The receipt: enough to hand the same chat back on a click with nothing new
  // (root + fingerprint + the file that proves it still exists), and the link
  // the drawer draws as "open the council copy".
  const link = councilLink(councilWeb, out.session_id);
  page.council_copies = copies.concat([{
    root, session_id: out.session_id, project_id: out.project_id || '', url: link,
    session_file: out.session_file || '', fingerprint: fp, at: new Date().toISOString(),
  }]).slice(-COPIES_MAX);
  return { ok: true, reused: false, session_id: out.session_id, project_id: out.project_id || '',
    url: link, entries: out.entries || body.length + 1 };
}
