#!/usr/bin/env node
// The snapshot sanitizer (sanitize.mjs). A page snapshot is arbitrary HTML off
// the open web, re-served from the owner's own hostname to the owner's own
// browser — so everything here is about what must NOT survive that trip.
//
//   node frontends/plugin/test/sanitize.test.mjs
import assert from 'node:assert/strict';
import { sanitizeArticle, safeUrl, SNAPSHOT_MAX } from '../sanitize.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL ${name}\n       ${e && e.message}`); }
}
const clean = (h, o) => sanitizeArticle(h, o).html;

// --- the things that must never come through ---------------------------
test('a script is removed with everything inside it', () => {
  const out = clean('<p>before</p><script>alert(1)</script><p>after</p>');
  assert.equal(out, '<p>before</p><p>after</p>');
  assert.ok(!/alert/.test(out), 'not even as text — unwrapping a script leaks its source as prose');
});

test('nested and unclosed scripts do not let anything escape', () => {
  assert.ok(!/alert/.test(clean('<script><script>alert(1)</script></script><p>x</p>')));
  assert.ok(!/alert/.test(clean('<div><script>alert(1)')), 'an unclosed script eats the rest, not the reverse');
  const out = clean('<script src="https://evil.test/x.js"></script><p>kept</p>');
  assert.equal(out, '<p>kept</p>');
});

test('style blocks and style attributes both go', () => {
  assert.equal(clean('<style>body{display:none}</style><p>x</p>'), '<p>x</p>');
  assert.equal(clean('<p style="position:fixed;inset:0">x</p>'), '<p>x</p>');
});

test('every event handler goes, whatever its spelling', () => {
  for (const attr of ['onclick', 'ONCLICK', 'onerror', 'onmouseover', 'onfocus', 'onload']) {
    const out = clean(`<p ${attr}="alert(1)">x</p>`);
    assert.equal(out, '<p>x</p>', attr);
  }
  // an allowlist means even one nobody has invented yet is gone
  assert.equal(clean('<p onfuturething="alert(1)" data-x="1" class="y" id="z">x</p>'), '<p>x</p>');
});

test('iframes, objects, embeds and svg are removed with their contents', () => {
  for (const tag of ['iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'video', 'audio',
    'form', 'input', 'button', 'template', 'noscript', 'link', 'meta', 'base']) {
    const out = clean(`<p>a</p><${tag}>inner</${tag}><p>b</p>`);
    assert.ok(!out.includes(`<${tag}`), `${tag} survived`);
    assert.ok(!out.includes('inner'), `${tag} contents survived`);
    assert.ok(out.includes('<p>a</p>') && out.includes('<p>b</p>'), `${tag} ate the prose`);
  }
});

test('javascript: and data: URLs never become links', () => {
  for (const bad of ['javascript:alert(1)', 'JaVaScript:alert(1)', 'data:text/html,<script>x</script>',
    'vbscript:x', '//evil.test/x', '/relative', 'x.html', 'file:///etc/passwd']) {
    const out = clean(`<a href="${bad}">click</a>`);
    assert.equal(out, '<a rel="noreferrer noopener" target="_blank">click</a>', bad);
  }
  // the classic: a scheme broken up by control characters a browser ignores
  assert.equal(safeUrl('java\tscript:alert(1)'), '');
  assert.equal(safeUrl('java\nscript:alert(1)'), '');
  assert.equal(safeUrl('\x00javascript:alert(1)'), '');
  assert.equal(safeUrl(' https://ok.test/a '), 'https://ok.test/a');
});

test('an http(s) link survives, and always leaves safely', () => {
  const out = clean('<a href="https://example.test/a?b=1&c=2" title="t">x</a>');
  assert.equal(out, '<a href="https://example.test/a?b=1&amp;c=2" title="t"'
    + ' rel="noreferrer noopener" target="_blank">x</a>',
    'the bare & is escaped on the way out; a real entity would have been left alone');
});

test('images keep an absolute source and nothing else', () => {
  assert.equal(clean('<img src="https://i.test/a.png" alt="a" onerror="alert(1)" srcset="x 2x">'),
    '<img src="https://i.test/a.png" alt="a">');
  assert.equal(clean('<img src="javascript:alert(1)">'), '', 'no source, no image');
  assert.equal(clean('<img src="https://i.test/a.png">', { allowImages: false }), '');
});

test('a stray < is text, not the start of a tag', () => {
  assert.equal(clean('<p>5 < 6 and 7 > 6</p>'), '<p>5 &lt; 6 and 7 &gt; 6</p>');
  assert.equal(clean('<p>a &amp; b &lt; c &#39;</p>'), '<p>a &amp; b &lt; c &#39;</p>',
    'entities already in the source are left alone rather than double-escaped');
  assert.equal(clean('<p>Tom & Jerry</p>'), '<p>Tom &amp; Jerry</p>');
});

test('comments are dropped, including the conditional kind', () => {
  assert.equal(clean('<p>a</p><!-- <script>alert(1)</script> --><p>b</p>'), '<p>a</p><p>b</p>');
  assert.equal(clean('<!--[if IE]><script>x</script><![endif]--><p>b</p>'), '<p>b</p>');
  assert.equal(clean('<!doctype html><p>b</p>'), '<p>b</p>');
});

// --- the things that must come through ---------------------------------
test('the article structure survives intact', () => {
  const src = '<h2>Head</h2><p>Some <em>emphasis</em> and <strong>weight</strong>.</p>'
    + '<ul><li>one</li><li>two</li></ul><blockquote>quoted</blockquote>'
    + '<pre><code>code()</code></pre><figure><img src="https://i.test/x.png" alt="f">'
    + '<figcaption>cap</figcaption></figure>'
    + '<table><tr><th scope="col">h</th><td colspan="2">d</td></tr></table>';
  assert.equal(clean(src), src.replace('<img src="https://i.test/x.png" alt="f">',
    '<img src="https://i.test/x.png" alt="f">'));
});

test('an unknown element is unwrapped, keeping its words', () => {
  assert.equal(clean('<marquee>hello</marquee>'), 'hello');
  assert.equal(clean('<my-widget><p>real text</p></my-widget>'), '<p>real text</p>');
  assert.equal(clean('<nav><a href="https://x.test/">skip</a></nav>'),
    '<a href="https://x.test/" rel="noreferrer noopener" target="_blank">skip</a>');
});

test('malformed markup still yields a balanced fragment', () => {
  // an unclosed <em> is closed for us at the end
  assert.equal(clean('<p>a <em>b</p>'), '<p>a <em>b</em></p>');
  // a close tag with no open is ignored rather than corrupting the stack
  assert.equal(clean('</div><p>a</p>'), '<p>a</p>');
  assert.equal(clean('<div><p>a</div></p>'), '<div><p>a</p></div>');
});

test('quoted > inside an attribute does not end the tag early', () => {
  assert.equal(clean('<a href="https://x.test/?a=>b" title="a > b">t</a>'),
    '<a href="https://x.test/?a=&gt;b" title="a &gt; b" rel="noreferrer noopener" target="_blank">t</a>');
});

test('an oversized snapshot is refused rather than truncated into nonsense', () => {
  const big = '<p>' + 'x'.repeat(5000) + '</p>';
  const r = sanitizeArticle(big.repeat(3), { max: 6000 });
  assert.equal(r.tooBig, true);
  assert.ok(SNAPSHOT_MAX > 1e6, 'the real bound is generous — this is a guard, not a diet');
  assert.equal(sanitizeArticle(big, { max: 6000 }).tooBig, false);
});

test('what was removed is counted, so a gutted snapshot is noticeable', () => {
  const r = sanitizeArticle('<p>a</p><script>x</script><style>y</style><marquee>z</marquee>');
  assert.equal(r.dropped, 3);
});

console.log(`\nsanitize: ${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
