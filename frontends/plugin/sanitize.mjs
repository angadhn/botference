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

const escText = s => String(s).replace(/&(?!#?[a-zA-Z0-9]{1,31};)/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => String(s).replace(/&(?!#?[a-zA-Z0-9]{1,31};)/g, '&amp;')
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// An absolute http(s) URL, or nothing. Control characters and whitespace are
// stripped FIRST — `java\tscript:x` is a real attack and a real browser reads
// it as a scheme — and then the value has to start with the scheme in full.
export function safeUrl(raw) {
  // U+0000..U+0020 covers NUL, tab, newline, form feed and the space itself
  const v = String(raw == null ? '' : raw).replace(/[\u0000-\u0020\u007f]/g, '');
  return /^https?:\/\/[^\s]/i.test(v) ? v : '';
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

// sanitizeArticle(html, {allowImages}) -> {html, dropped, tooBig}
// `dropped` counts the elements that were removed outright, which the tests
// assert on and the companion logs — a snapshot that lost half the page is
// worth noticing.
export function sanitizeArticle(html, { allowImages = true, max = SNAPSHOT_MAX } = {}) {
  const out = [];
  const open = [];            // stack of emitted element names
  let killDepth = 0;          // >0 while inside a dropped subtree
  let killTag = '';
  let dropped = 0;
  let size = 0;
  let tooBig = false;
  const push = (s) => {
    if (tooBig) return;
    size += s.length;
    if (size > max) { tooBig = true; return; }
    out.push(s);
  };

  for (const tok of tokens(html)) {
    if (tooBig) break;
    if (killDepth > 0) {
      // inside a dropped subtree: the only thing that matters is finding its end
      if (tok.t === 'open' && tok.name === killTag && !tok.self && !VOID.has(tok.name)) killDepth++;
      else if (tok.t === 'close' && tok.name === killTag) killDepth--;
      continue;
    }
    if (tok.t === 'text') { push(escText(tok.v)); continue; }

    if (tok.t === 'open') {
      const name = tok.name;
      if (KILL.has(name)) {
        dropped++;
        if (!tok.self && !VOID.has(name)) { killDepth = 1; killTag = name; }
        continue;
      }
      if (!KEEP.has(name)) { dropped++; continue; } // unwrap: keep the words
      if (name === 'img' && !allowImages) { dropped++; continue; }

      const allow = ATTRS[name] || null;
      const kept = [];
      for (const [k, v] of attrPairs(tok.attrs)) {
        if (!(ATTRS['*'].has(k) || (allow && allow.has(k)))) continue;
        if (URL_ATTRS.has(k)) {
          const u = safeUrl(v);
          if (!u) continue;
          kept.push(` ${k}="${escAttr(u)}"`);
          continue;
        }
        kept.push(` ${k}="${escAttr(v)}"`);
      }
      // an <img> we could not resolve a source for is not worth a broken icon
      if (name === 'img' && !kept.some(a => a.startsWith(' src='))) { dropped++; continue; }
      // links always leave this site safely, and never in place
      const extra = name === 'a' ? ' rel="noreferrer noopener" target="_blank"' : '';
      if (VOID.has(name) || tok.self) { push(`<${name}${kept.join('')}${extra}>`); continue; }
      push(`<${name}${kept.join('')}${extra}>`);
      open.push(name);
      continue;
    }

    // close
    const at = open.lastIndexOf(tok.name);
    if (at < 0) continue;                     // a close with no open: ignore it
    for (let k = open.length - 1; k >= at; k--) push(`</${open[k]}>`);
    open.length = at;
  }
  for (let k = open.length - 1; k >= 0; k--) push(`</${open[k]}>`);
  return { html: out.join(''), dropped, tooBig };
}
