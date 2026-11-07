// figedits.mjs — a figure-editor batch, written down for the bots.
//
// Until 2026-11-06 a batch from the local figure editor travelled INSIDE the
// chat message: a readable list plus the whole batch as fenced JSON, capped at
// 100 edits and 60,000 characters so the message stayed a message. Now the
// batch is a FILE in the site's scratch folder (blog.scratchDir — inside the
// bots' write root, so they can read it and tick it), and the chat gets a
// short checklist summary that names the file. There is no batch cap; each
// edit keeps a size guard.
//
// The batch can hold three kinds of item (schema botference.figure-edits/2):
//   text     a retyped piece of figure text (or page prose the companion could
//            not place exactly — `routed` says why)
//   comment  the owner's note on ANY part of a figure (a bar, a line, a box, a
//            scrolly step, a picture), with the element's locator, so the bots
//            change the figure's script and rebuild — or, for a picture with
//            no source, add an overlay or annotation instead
//   (prose the companion wrote into the post itself is listed as done, so the
//   bots know about it and do nothing.)
//
// Everything here is pure except `writeBatch`.
import fs from 'node:fs';
import path from 'node:path';

export const FIELD_MAX = 2000;          // one edit's original / replacement / note
export const SUMMARY_LINES = 12;        // items listed in the chat message itself
export const BATCH_ID_RE = /^fte-\d{8}T\d{4}-[0-9a-f]{8}$/;

const s = v => (typeof v === 'string' ? v : '');
const one = v => s(v).replace(/\s+/g, ' ').trim();
const clip = (v, n) => { const t = one(v); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

export const isComment = e => !!e && e.kind === 'comment';
// a NEW paragraph the owner typed after an existing one (the editor's Enter
// or "+"): `replacement` is its text, `source.after_block` the paragraph it
// follows
export const isParagraph = e => !!e && e.kind === 'paragraph';

/** Where an item is, in a few words the owner recognises. */
export function whereOf(e) {
  const f = (e && e.figure) || {};
  const el = (e && e.element) || {};
  const c = (e && e.context) || null;
  const what = isComment(e)
    ? (el.kind === 'raster' ? 'picture' : el.tag ? `<${el.tag}>` : 'element')
    : isParagraph(e) ? 'new paragraph'
    : (el.kind === 'svg-text' ? 'SVG label' : 'text');
  const step = c && c.step != null && c.step !== 'cover'
    ? ` · step ${c.step}${c.of ? ` of ${c.of}` : ''}${c.step_title ? ` (“${clip(c.step_title, 60)}”)` : ''}`
    : c && c.step === 'cover' ? ' · cover (before step 1)' : c && c.tooltip ? ` · tooltip ${c.tooltip}` : '';
  return `${one(f.title) || one(f.id) || 'figure'} · ${what}${el.nearest_id ? ` in #${el.nearest_id}` : ''}${step}`;
}

function changeLine(e) {
  if (isComment(e)) return `💬 ${clip(e.note, 300)}`;
  if (isParagraph(e)) {
    const after = one((e.source && (e.source.after_block || e.source.block)) || '');
    return `add after the paragraph ending “…${after.slice(-80)}”, with a blank line between: “${clip(e.replacement, 400)}”`;
  }
  return `“${clip(e.original, 200)}” → “${clip(e.replacement, 200)}”`;
}

/**
 * The checklist file: one `- [ ]` per item the bots must act on, with every
 * locator the editor captured, and the items already written listed as done.
 */
export function checklist(batch, routes = []) {
  const byId = new Map(routes.map(r => [r.edit_id, r]));
  const page = (batch && batch.page) || {};
  const todo = [], done = [];
  for (const e of (batch && batch.edits) || []) {
    const r = byId.get(e.edit_id);
    (r && r.to === 'source' ? done : todo).push({ e, r });
  }
  const L = [];
  L.push(`# Figure edits — ${one(page.title) || one(page.path) || 'this page'}`);
  L.push('');
  L.push(`Batch \`${s(batch.batch_id)}\` from the local preview of ${s(page.url)}${page.source ? ` (source \`${s(page.source)}\`)` : ''}.`);
  L.push('');
  L.push('Work through the list. Tick each box (`- [x]`) in THIS file as you apply it, and say in the chat which ones you could not place and why.');
  L.push('Text edits are browser previews only: change the words in the source named, regenerate the listed exports, keep surrounding markup.');
  L.push('Comments are notes on a part of a figure: change the figure\'s script (its generator) and rebuild; for a picture with no source, add an overlay or annotation beside it instead of editing pixels.');
  L.push('The owner\'s prose in the post is theirs: if an item asks for a change to it, propose it as a ```suggest block rather than editing the markdown.');
  L.push('');
  L.push(`## To do (${todo.length})`);
  L.push('');
  todo.forEach(({ e, r }, i) => {
    L.push(`- [ ] **${i + 1}.** ${whereOf(e)}`);
    L.push(`  - ${isComment(e) ? 'note' : 'change'}: ${changeLine(e)}`);
    if (r && r.reason) L.push(`  - why it came to you: ${one(r.detail || r.reason)}`);
    const src = e.source || {};
    if (src.file) L.push(`  - source: \`${s(src.file)}\`${src.locator ? ` — ${one(src.locator)}` : ''}`);
    if (src.note) L.push(`  - note: ${one(src.note)}`);
    if (src.block) L.push(`  - in the block: “${clip(src.block, 300)}”`);
    const f = e.figure || {};
    if (f.generator) L.push(`  - generator: \`${s(f.generator)}\`${(f.exports || []).length ? `; exports: ${f.exports.map(x => `\`${s(x)}\``).join(', ')}` : ''}`);
    if (f.document) L.push(`  - figure document: \`${s(f.document)}\``);
    const el = e.element || {};
    const loc = [el.anchor_id ? `anchor #${el.anchor_id}` : '', el.selector ? `selector \`${s(el.selector)}\`` : '',
      el.path ? `path \`${s(el.path)}\`` : '', el.src ? `src \`${s(el.src)}\`` : '',
      el.occurrence && el.occurrence.count > 1 ? `occurrence ${el.occurrence.index} of ${el.occurrence.count}` : '']
      .filter(Boolean).join('; ');
    if (loc) L.push(`  - element: ${loc}`);
    if (el.text) L.push(`  - element text: “${clip(el.text, 200)}”`);
    if (el.kind === 'raster') L.push('  - no source script for this picture: add an overlay/annotation');
    if (e.context) L.push(`  - shown when: ${JSON.stringify(e.context)}`);
    if (e.supersedes) L.push(`  - supersedes an earlier edit: the source may already say “${clip(e.supersedes.replacement, 120)}”`);
  });
  if (done.length) {
    L.push('');
    L.push(`## Already written into the post by the companion (${done.length}) — nothing to do`);
    L.push('');
    for (const { e } of done) L.push(`- [x] ${whereOf(e)} — ${changeLine(e)}`);
  }
  L.push('');
  return L.join('\n');
}

/** The short message the chat gets: counts, the first few items, the file. */
export function summary(batch, routes, files) {
  const byId = new Map((routes || []).map(r => [r.edit_id, r]));
  const edits = (batch && batch.edits) || [];
  const todo = edits.filter(e => !(byId.get(e.edit_id) || {}).to || byId.get(e.edit_id).to !== 'source');
  const done = edits.length - todo.length;
  const page = (batch && batch.page) || {};
  const nComments = todo.filter(isComment).length;
  const L = [];
  L.push(`Figure edits from the local preview: ${edits.length} item${edits.length === 1 ? '' : 's'} on `
    + `${one(page.title) || one(page.path) || 'this page'} (batch ${s(batch.batch_id)}).`);
  if (done) L.push(`${done} prose edit${done === 1 ? ' was' : 's were'} written straight into the post by the companion — nothing to do for ${done === 1 ? 'it' : 'those'}.`);
  if (todo.length) {
    L.push(`For you: ${todo.length - nComments} text edit${todo.length - nComments === 1 ? '' : 's'}`
      + `${nComments ? ` and ${nComments} comment${nComments === 1 ? '' : 's'}` : ''}. `
      + `The whole checklist, with every locator, is in \`${files.md}\` — read it, tick each item there as you apply it, `
      + `and tell me any you could not place. (The same batch as JSON: \`${files.json}\`.)`);
    L.push('');
    todo.slice(0, SUMMARY_LINES).forEach((e, i) => {
      const r = byId.get(e.edit_id);
      L.push(`${i + 1}. ${whereOf(e)} — ${changeLine(e)}${r && r.reason ? ` _(${one(r.detail || r.reason)})_` : ''}`);
    });
    if (todo.length > SUMMARY_LINES) L.push(`…and ${todo.length - SUMMARY_LINES} more in the checklist.`);
  }
  return L.join('\n');
}

/** A refusal for one malformed or oversized item, or null. */
export function badEdit(e) {
  if (!e || typeof e !== 'object' || typeof e.edit_id !== 'string' || !e.edit_id) return 'an item has no id';
  if (isComment(e)) {
    if (!one(e.note)) return 'a comment has no note';
    if (s(e.note).length > FIELD_MAX) return `a comment is longer than ${FIELD_MAX} characters`;
    return null;
  }
  if (typeof e.original !== 'string' || typeof e.replacement !== 'string') return 'an edit is missing its text';
  if (isParagraph(e) && !one(e.replacement)) return 'a new paragraph is empty';
  if (e.original.length > FIELD_MAX || e.replacement.length > FIELD_MAX) return `an edit is longer than ${FIELD_MAX} characters`;
  return null;
}

/** Write the batch and its checklist; returns {json, md} absolute paths. */
export function writeBatch(dir, batch, routes) {
  const at = path.join(dir, 'figure-edits');
  fs.mkdirSync(at, { recursive: true });
  const id = BATCH_ID_RE.test(s(batch.batch_id)) ? batch.batch_id : `fte-${Date.now()}`;
  const json = path.join(at, `${id}.json`);
  const md = path.join(at, `${id}.md`);
  fs.writeFileSync(json, JSON.stringify({ ...batch, routes: routes || [] }, null, 1));
  // a checklist the bots have already started ticking is not overwritten by a
  // retry of the same batch
  if (!fs.existsSync(md)) fs.writeFileSync(md, checklist(batch, routes));
  return { json, md };
}
