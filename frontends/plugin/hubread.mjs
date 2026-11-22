// hubread.mjs — a followed post, kept as an annotatable page ("Read here").
//
// The Hub holds a post's sanitised text (following.mjs: a body per post). Reading it here makes that text the SNAPSHOT of a
// page record in the ordinary page store, keyed by the post's canonical page URL, so highlights made in the Hub and highlights
// made later on the original site with the extension are one record and one thread list. The article view (views.mjs) then
// shows it, highlights, comments, page chat, TK gaps and export all work as on any article. Nothing here fetches anything;
// following.mjs fetchPost / heldPost say where the text came from.
//
// THE IDENTITY ON THE RECORD (origin, id, version, version_state) is the item document's: the text came from it, not from a
// page's say-so, so the answer's source is 'item-document' (following.mjs ANSWER_SOURCES).
//
// WHERE THE TEXT CAME FROM, one field on the record (page.hub.text_from), one of HUB_TEXT_FROM:
//   item-document — the held or freshly fetched sanitised item content
//   captured      — a copy the extension captured from the original page was already there under highlights, so it was KEPT
//                   (nothing is swapped under a reader's highlights without their say-so: the "load" button replaces it)
import { createRequire } from 'node:module';
import { textContent } from './blyg.mjs';
import { formatDate } from './following.mjs';

const A = createRequire(import.meta.url)('./extension/anchor.js');
export const HUB_TEXT_FROM = Object.freeze(['item-document', 'captured']);

/**
 * Put `post` ({ page_url, title, html, result, meta, text_state }) on its page record. `replace` is the reader's explicit
 * request for the text to be swapped (loading a newer version). → { page, key, kept, text_from, orphaned }.
 *   · a record already held from the Hub is left alone unless `replace`;
 *   · a record with highlights and a captured copy keeps that copy unless `replace`;
 *   · otherwise the text is written, and every highlight on the record is re-located in it by the existing anchoring
 *     (anchor.js locate: quote, prefix, suffix); those that no longer match are marked orphaned, as for any changed page.
 */
export function holdPost({ store, applyAnswer, post, replace = false, now = () => new Date() }) {
  const page = store.upsertPage({ url: post.page_url, title: post.title });
  const key = store.pageKey(page.url);
  const had = !!page.hub;
  const threads = page.threads || [];
  if (had && !replace) return { page, key, kept: true, text_from: page.hub.text_from, orphaned: 0 };
  const mayReplace = replace || !threads.length || !store.hasSnapshot(key);
  let textFrom = 'captured', orphaned = 0;
  if (mayReplace) {
    store.saveSnapshot(page.url, post.html);
    textFrom = 'item-document';
    const raw = textContent(post.html);
    for (const t of threads) {
      const ok = !!A.locate(raw, t).ok;
      if (!ok) orphaned++;
      store.setOrphaned(t, !ok);
    }
  }
  page.hub = { ...post.meta, text_from: textFrom, text_state: mayReplace ? (post.text_state || 'whole') : 'whole', fetched_at: now().toISOString() };
  delete page.hub.key; // the engine's key for a record is not a property of the page
  applyAnswer(page, post.result);
  store.savePage(page);
  return { page, key, kept: false, text_from: textFrom, orphaned };
}

/** What the article view shows above a Hub page's text. null for any other page. */
export function hubInfoOf(page, { following, locale = 'en-US' } = {}) {
  const h = page && page.hub;
  if (!h) return null;
  const held = following ? following.heldVersion(h.origin, h.id) : 0;
  const key = following ? following.keyFor(h.origin, h.id) : '';
  const versions = Array.isArray(h.versions) ? h.versions : [];
  const pinned = versions.filter(v => v.pin === 'pinned').map(v => v.version);
  const resp = following ? following.responseOf(h.stub_of) : null;
  return {
    blyg_title: h.blyg_title || '', author: h.author || '', kind: h.kind || '', date: formatDate(h.updated || h.created, locale),
    version: h.version, versions_note: h.version > 1 ? `${h.version} versions` : '', pinned,
    in_response_to: resp ? resp.label : '', text_from: h.text_from, text_state: h.text_state || 'whole',
    key, newer: held > h.version && key ? { version: held, key } : null,
    source_note: h.text_from === 'captured' ? 'This copy was captured from the original page.' : '',
  };
}
