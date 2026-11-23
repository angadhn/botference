// Article snapshots, made safe to serve.
//
// The extension sends the article's own HTML so a phone can read and annotate
// the page without visiting it. That HTML came off the open web, so none of it
// is trusted: this module rebuilds it from a token stream against an
// ALLOWLIST, and anything not named is either dropped whole (with its
// subtree, for the dangerous few) or unwrapped (tag gone, text kept).
//
// The rules, in the order that matters:
//   1. A small set of elements is dropped WITH THEIR CONTENTS — script, style,
//      iframe, svg and friends. Unwrapping those would leak their source text
//      into the page as prose, and for <style> it would leak CSS.
//   2. Every other element is either allowed (kept, tag and all) or unwrapped.
//      Unwrapping by default means a <marquee> or a Web Component loses its
//      tag and keeps its words, which is what a reader wants.
//   3. Attributes are an allowlist per element. That one rule removes every
//      on* handler, every `style`, every `srcset`, and everything a future
//      browser might invent, without a blocklist to keep up to date.
//   4. href/src must be literally http:// or https://. Not `javascript:`, not
//      `data:`, not protocol-relative, not `java\nscript:` — the test is a
//      prefix match on the trimmed value, so there is nothing to sneak past.
//   5. Text is re-escaped. The tokenizer consumes every well-formed `<…>`, so
//      any `<` still in a text run is a stray one, and it is written out as
//      &lt; rather than becoming a tag.
//
// The output is therefore a fragment built entirely of tags this file chose to
// write, which is a much stronger position than "we removed the bad parts".
// The article view serves it under a strict CSP as well (server.mjs) — belt
// and braces, because a sanitizer is exactly the kind of thing that should
// never be the only line of defence.

// dropped with everything inside them
const KILL = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript',
  'template', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track',
  'form', 'input', 'select', 'textarea', 'button', 'label', 'fieldset',
  'link', 'meta', 'base', 'head', 'title', 'applet', 'frame', 'frameset',
  'object', 'param', 'map', 'area', 'dialog', 'slot', 'portal']);

// kept, tag and all
const KEEP = new Set(['p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'blockquote', 'pre', 'code', 'kbd', 'samp',
  'em', 'strong', 'i', 'b', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'small', 'mark', 'span', 'div', 'a', 'img', 'figure', 'figcaption',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'time', 'abbr', 'cite', 'q', 'section', 'article', 'header', 'footer', 'aside',
  'main', 'address', 'ruby', 'rt', 'rp', 'bdi', 'bdo', 'wbr']);

// nothing inside them, so nothing to close
const VOID = new Set(['br', 'hr', 'img', 'wbr', 'col']);
// …and the VOID elements among the dropped ones. A browser serializes a void
// element as `<source srcset="…">` — no `/>`, and never a `</source>` — so
// treating one as the start of a subtree waited for a close tag that never
// comes and silently dropped EVERYTHING after it. That is how an NPR story
// (a byline photo is a <picture><source>…</picture>) was saved as its header
// and nothing else (2026-11-06). These are dropped as single tags.
const KILL_VOID = new Set(['source', 'track', 'input', 'link', 'meta', 'base',
  'embed', 'param', 'area', 'frame', 'keygen']);

// per-element attribute allowlist; '*' applies to everything kept
const ATTRS = {
  '*': new Set(['lang', 'dir']),
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  time: new Set(['datetime']),
  abbr: new Set(['title']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
  ol: new Set(['start', 'reversed', 'type']),
  li: new Set(['value']),
};
const URL_ATTRS = new Set(['href', 'src', 'cite']);

// Control characters and the bidirectional overrides and isolates (which can make text read as something it is not) are never kept
// in text or attribute values; ordinary whitespace is.
const stripBad = v => [...String(v)].filter(c => { const n = c.codePointAt(0);
  return !(n < 9 || n === 11 || n === 12 || (n >= 14 && n < 32) || n === 127 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069)); }).join('');
const escText = s => stripBad(s).replace(/&(?!#?[a-zA-Z0-9]{1,31};)/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => stripBad(s).replace(/&(?!#?[a-zA-Z0-9]{1,31};)/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An absolute http(s) URL, or nothing. Control characters and whitespace are
// stripped FIRST — `java\tscript:x` is a real attack and a real browser reads
// it as a scheme — and then the value has to start with the scheme in full.
export function safeUrl(raw) {
  // U+0000..U+0020 covers NUL, tab, newline, form feed and the space itself
  const v = String(raw == null ? '' : raw).replace(/[\u0000-\u0020\u007f]/g, '');
  return /^https?:\/\/[^\s]/i.test(v) ? v : '';
}

// A link's target: http(s) as above, or mailto:. (An image's source is stricter, httpsImageUrl.)
export function safeLinkUrl(raw) {
  const v = String(raw == null ? '' : raw).replace(/[\u0000-\u0020\u007f]/g, '');
  if (/^mailto:[^\s]/i.test(v)) return v;
  return safeUrl(raw);
}
// An image's source: https only. A page served over https must not pull an image over http (and the article
// view's Content-Security-Policy would block it anyway), so it is not kept.
export function httpsImageUrl(raw) {
  const u = safeUrl(raw);
  return /^https:\/\//i.test(u) ? u : '';
}

// A tolerant tokenizer: comments, doctypes, close tags, open tags, text.
// Deliberately not a spec parser — it only has to agree with browsers about
// what IS a tag, and be conservative about everything else.
function* tokens(html) {
  const s = String(html || '');
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { yield { t: 'text', v: s.slice(i) }; return; }
    if (lt > i) yield { t: 'text', v: s.slice(i, lt) };
    if (s.startsWith('<!--', lt)) {
      const end = s.indexOf('-->', lt + 4);
      i = end < 0 ? s.length : end + 3;
      continue;
    }
    if (s.startsWith('<!', lt) || s.startsWith('<?', lt)) {
      const end = s.indexOf('>', lt);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(s.slice(lt));
    if (!m) { // a stray '<' that begins no tag: it is text
      yield { t: 'text', v: '<' };
      i = lt + 1;
      continue;
    }
    // find the '>' that ends this tag, respecting quoted attribute values
    let j = lt + m[0].length, quote = '';
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '>') break;
    }
    const inner = s.slice(lt + m[0].length, j);
    i = j < s.length ? j + 1 : s.length;
    const name = m[2].toLowerCase();
    if (m[1]) yield { t: 'close', name };
    else yield { t: 'open', name, attrs: inner, self: /\/\s*$/.test(inner) };
  }
}

function* attrPairs(src) {
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : '';
    yield [m[1].toLowerCase(), value];
  }
}

export const SNAPSHOT_MAX = 2 * 1024 * 1024; // 2 MB of sanitized HTML

// WELL-FORMED BY CONSTRUCTION. What this writes is built from a stack of its own: every element it opens it closes, and the
// rules HTML's own parser applies (an <li> ends the <li> before it, a <p> ends at a block, a <td> needs a <tr>, a <table> holds
// only table parts) are applied HERE, so a browser that parses the output finds nothing to repair, moves nothing, and closes
// nothing it did not open. `/>` is a way to close an element only for the void ones (br, hr, img, wbr, col): on anything else a
// browser ignores the slash, so it is ignored here too.
//
// `landmarks: false` is for a followed post, which has no business emitting page structure: main, header, footer, section,
// article, aside and address are then unwrapped (their words kept), so a post cannot add chrome to the page it is shown in.
// (A PDF snapshot, which uses <section> per page, keeps them: the default.)
const LANDMARKS = new Set(['main', 'header', 'footer', 'section', 'article', 'aside', 'address']);
// elements an opening <li>, <dd>, <dt> or heading may close its way through: not special in HTML's parsing (plus div, p, address)
const THROUGH = new Set(['div', 'p', 'address', 'span', 'a', 'b', 'i', 'em', 'strong', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup',
  'small', 'mark', 'code', 'kbd', 'samp', 'q', 'cite', 'abbr', 'time', 'bdi', 'bdo', 'ruby', 'rt', 'rp']);
// start tags that end an open <p> (HTML's "close a p element")
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'div', 'dl', 'figcaption', 'figure', 'footer', 'header', 'main',
  'ol', 'p', 'section', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'li', 'dd', 'dt', 'table', 'hr']);
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const SECTIONS = new Set(['thead', 'tbody', 'tfoot']);
const TABLE_CONTEXT = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'colgroup']);
const TABLE_PARTS = new Set(['caption', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'col']);
const BARRIERS = new Set(['table', 'td', 'th', 'caption']);

// sanitizeArticle(html, {allowImages, max, truncate, landmarks}) -> {html, dropped, tooBig}
// `dropped` counts the elements that were removed outright, which the tests
// assert on and the companion logs — a snapshot that lost half the page is
// worth noticing.
export function sanitizeArticle(html, { allowImages = true, max = SNAPSHOT_MAX, truncate = false, landmarks = true } = {}) {
  const out = [];
  const stack = [];           // names of the elements emitted and not yet closed
  let killDepth = 0;          // >0 while inside a dropped subtree
  let killTag = '';
  let dropped = 0;
  let size = 0;
  let tooBig = false;
  // → whether it was written (a piece that would cross the limit is not, and nothing after it is)
  const push = (s) => {
    if (tooBig) return false;
    size += s.length;
    if (size > max) { tooBig = true; return false; }
    out.push(s);
    return true;
  };
  const close = (name) => { if (truncate) out.push(`</${name}>`); else push(`</${name}>`); };
  const popTo = (n) => { while (stack.length > n) close(stack.pop()); };
  const top = () => stack[stack.length - 1];
  const lastIndex = (name, stopAt) => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k] === name) return k;
      if (stopAt && stopAt.has(stack[k])) return -1;
    }
    return -1;
  };
  // the stack holds only what was WRITTEN: a start tag refused for the size limit is not on it, so its end tag is never written alone
  const open = (name, attrs) => { if (push(`<${name}${attrs}>`)) stack.push(name); };
  // text or any non-table element directly inside a table, a section or a row would be moved out of it by a browser: give it a cell
  const intoCell = () => {
    if (top() === 'colgroup') close(stack.pop());
    if (SECTIONS.has(top()) || top() === 'table') open('tr', '');
    if (top() === 'tr') open('td', '');
  };
  // an element's start tag, with HTML's implied end tags applied first. false: not valid here, unwrap it (its words stay).
  const startTag = (name) => {
    if (TABLE_PARTS.has(name)) {
      const ti = lastIndex('table');
      if (ti < 0) return false;
      if (name === 'col') return top() === 'colgroup' || top() === 'table';
      if (name === 'caption' || name === 'colgroup' || SECTIONS.has(name)) { popTo(ti + 1); return true; }
      if (name === 'tr') {
        let k = stack.length;
        while (k > ti + 1 && !SECTIONS.has(stack[k - 1])) k--;
        popTo(k);
        return true;
      }
      // td, th: in a row; a row is made if there is none
      let ri = -1;
      for (let k = stack.length - 1; k > ti; k--) { if (stack[k] === 'tr') { ri = k; break; } if (stack[k] === 'table') break; }
      if (ri >= 0) { popTo(ri + 1); return true; }
      let k = stack.length;
      while (k > ti + 1 && !SECTIONS.has(stack[k - 1])) k--;
      popTo(k);
      open('tr', '');
      return true;
    }
    if (TABLE_CONTEXT.has(top())) intoCell();
    if (CLOSES_P.has(name)) { const pi = lastIndex('p', BARRIERS); if (pi >= 0) popTo(pi); }
    if (name === 'li' || name === 'dd' || name === 'dt') {
      const same = name === 'li' ? ['li'] : ['dd', 'dt'];
      for (let k = stack.length - 1; k >= 0; k--) {
        if (same.includes(stack[k])) { popTo(k); break; }
        if (!THROUGH.has(stack[k])) break;
      }
    }
    if (HEADINGS.has(name)) {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (HEADINGS.has(stack[k])) { popTo(k); break; }
        if (!THROUGH.has(stack[k])) break;
      }
    }
    if (name === 'a') { const ai = lastIndex('a'); if (ai >= 0) popTo(ai); }
    if (name === 'rt' || name === 'rp') while (top() === 'rt' || top() === 'rp') close(stack.pop());
    return true;
  };
  const endTag = (name) => {
    const stopAt = TABLE_PARTS.has(name) || name === 'table' ? new Set(name === 'table' ? [] : ['table']) : BARRIERS;
    const k = lastIndex(name, stopAt);
    if (k >= 0) popTo(k);
  };

  for (const tok of tokens(html)) {
    if (tooBig) break;
    if (killDepth > 0) {
      // inside a dropped subtree: the only thing that matters is finding its end
      if (tok.t === 'open' && tok.name === killTag && !VOID.has(tok.name)) killDepth++;
      else if (tok.t === 'close' && tok.name === killTag) killDepth--;
      continue;
    }
    if (tok.t === 'text') {
      if (TABLE_CONTEXT.has(top())) { if (!/\S/.test(tok.v)) continue; intoCell(); }
      push(escText(tok.v));
      continue;
    }

    if (tok.t === 'open') {
      const name = tok.name;
      if (KILL.has(name)) {
        dropped++;
        // a browser ignores the slash of <script/>: the element runs on, so it is dropped on, to its end tag
        if (!VOID.has(name) && !KILL_VOID.has(name)) { killDepth = 1; killTag = name; }
        continue;
      }
      if (!KEEP.has(name) || (!landmarks && LANDMARKS.has(name))) { dropped++; continue; } // unwrap: keep the words
      if (name === 'img' && !allowImages) { dropped++; continue; }

      const allow = ATTRS[name] || null;
      const kept = [];
      for (const [k, v] of attrPairs(tok.attrs)) {
        if (!(ATTRS['*'].has(k) || (allow && allow.has(k)))) continue;
        if (URL_ATTRS.has(k)) {
          const u = name === 'img' ? httpsImageUrl(v) : name === 'a' ? safeLinkUrl(v) : safeUrl(v);
          if (!u) continue;
          kept.push(` ${k}="${escAttr(u)}"`);
          continue;
        }
        kept.push(` ${k}="${escAttr(v)}"`);
      }
      // an <img> we could not resolve a source for is not worth a broken icon
      if (name === 'img' && !kept.some(a => a.startsWith(' src='))) { dropped++; continue; }
      if (!startTag(name)) { dropped++; continue; }
      // links always leave this site safely, and never in place; an image is fetched lazily, sending no Referer
      const extra = name === 'a' ? ' rel="noreferrer noopener" target="_blank"'
        : name === 'img' ? ' loading="lazy" decoding="async" referrerpolicy="no-referrer"' : '';
      if (VOID.has(name)) { push(`<${name}${kept.join('')}${extra}>`); continue; }
      open(name, `${kept.join('')}${extra}`);
      continue;
    }

    // close
    endTag(tok.name);
  }
  // `truncate`: an over-long article is cut at the limit and its open elements are closed, rather than refused
  while (stack.length) { const n = stack.pop(); if (truncate) out.push(`</${n}>`); else push(`</${n}>`); }
  return { html: out.join(''), dropped, tooBig };
}

/**
 * Sanitise until the output is stable (at most `passes`): what comes out is what the sanitiser would write again, so a second
 * reading of it (the article view reads a Hub snapshot again) can change nothing. → { html, dropped, tooBig }.
 */
export function sanitizeStable(html, opts = {}, passes = 3) {
  let r = sanitizeArticle(html, opts);
  for (let k = 1; k < passes; k++) {
    const again = sanitizeArticle(r.html, opts);
    if (again.html === r.html) break;
    r = { ...again, dropped: r.dropped + again.dropped, tooBig: r.tooBig || again.tooBig };
  }
  return r;
}
