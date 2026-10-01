// prop.test.mjs — proposals on the page (SPEC, "Amendment (2026-10-01):
// proposals on the page"). An OPEN suggestion card is previewed in the body:
// its `current` struck where it stands (mark.bfp-prop), its `proposed`
// inserted right after (ins.bfp-prop-ins), display only. happy-dom stands in
// for the browser; anchor.js is loaded after the DOM globals exist.
//
//   node frontends/plugin/test/prop.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// happy-dom lives in the repo's tests/node_modules (cd tests && npm install)
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'http://localhost/' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'getComputedStyle']) {
  if (!(k in globalThis) || k === 'window' || k === 'document') globalThis[k] = w[k] ?? w;
}
const require = createRequire(import.meta.url);
const A = require(path.join(here, '..', 'extension', 'anchor.js'));
const doc = w.document;

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };

const HTML = '<article>'
  + '<p>The quick <em>brown fox</em> jumps over the lazy dog.</p>'
  + '<p>A later passage here, about cats and their habits.</p>'
  + '<p>It is twice said and twice said.</p>'
  + '</article>';
const reset = () => { doc.body.innerHTML = HTML; };
const props = () => [...doc.querySelectorAll('mark.bfp-prop')];
const inses = () => [...doc.querySelectorAll('ins.bfp-prop-ins')];
const card = (o) => ({ id: 'sg1', state: 'open', current: 'quick brown fox', proposed: 'quick red fox', ...o });

// ---- 1. a proposal paints: strike marks, and the <ins> after the last one ---
{
  reset();
  const index = A.buildTextIndex(doc.body);
  const r = A.paintProposal(index, card());
  ok('paint: returns the marks', r && r.marks.length === 2, r && String(r.marks.length));
  ok('paint: every mark is a proposal mark for this card',
    props().length === 2 && props().every(m => m.getAttribute('data-bfp-prop') === 'sg1'));
  ok('paint: the marks are not thread highlights', !doc.querySelector('mark.bfp-hl'));
  ok('paint: the struck words are exactly `current`',
    props().map(m => m.textContent).join('') === 'quick brown fox', props().map(m => m.textContent).join('|'));
  ok('paint: one <ins>, holding exactly `proposed`', inses().length === 1 && inses()[0].textContent === 'quick red fox');
  const last = props()[props().length - 1];
  ok('paint: the <ins> sits immediately after the last mark', last.nextSibling === inses()[0]);
  ok('paint: the <ins> carries the card id', inses()[0].getAttribute('data-bfp-prop') === 'sg1');
  ok('paint: the <ins> is hidden from assistive tech', inses()[0].getAttribute('aria-hidden') === 'true');
  ok('paint: the strike is a background line, with no tint of its own',
    /linear-gradient/.test(last.style.getPropertyValue('background-image'))
    && last.style.getPropertyValue('background-color') === 'transparent');
  ok('paint: the <ins> wears the landed-rewrite underline',
    inses()[0].style.getPropertyValue('text-decoration-color') === 'rgba(45, 145, 85, .95)'
    || /45,\s*145,\s*85/.test(inses()[0].style.getPropertyValue('text-decoration-color')));
  ok('paint: proposalIds sees it', JSON.stringify(A.proposalIds()) === '["sg1"]');
  ok('paint: a second paint of the same card is a no-op', A.paintProposal(index, card()) === null && props().length === 2);
}

// ---- 2. the index stays true after a paint ----------------------------------
{
  reset();
  const index = A.buildTextIndex(doc.body);
  const rawBefore = index.raw;
  A.paintProposal(index, card());
  ok('index: raw unchanged by the paint', index.raw === rawBefore);
  const fresh = A.buildTextIndex(doc.body);
  ok('index: a fresh walk reads the same text (the <ins> is not in it)', fresh.raw === rawBefore);
  // the mended segs still cover the raw contiguously and point at live nodes
  let contiguous = true, at = 0;
  for (const s of index.segs) {
    if (s.from !== at) contiguous = false;
    at = s.to;
    if (s.node && s.node.data !== index.raw.slice(s.from, s.to)) contiguous = false;
  }
  ok('index: segs mended in place and still true', contiguous && at === index.raw.length);
  // …so a later passage is still found, and painted, at the right offsets
  const r = A.locate(index.raw, { quote: 'about cats' });
  ok('index: a later locate still finds its passage', r.ok && index.raw.slice(r.start, r.end) === 'about cats');
  const marks = A.paintOffsets(index, r.start, r.end, 't-1', false);
  ok('index: and paints exactly those words', marks.map(m => m.textContent).join('') === 'about cats');
  // and a locate INSIDE the struck passage still resolves to the page's words
  const r2 = A.locate(index.raw, { quote: 'brown fox jumps' });
  ok('index: a locate across the struck passage resolves', r2.ok && index.raw.slice(r2.start, r2.end) === 'brown fox jumps');
}

// ---- 3. the <ins> is excluded from every text extraction ---------------------
{
  reset();
  A.paintProposal(A.buildTextIndex(doc.body), card({ proposed: 'a wholly novel phrase' }));
  const idx = A.buildTextIndex(doc.body);
  ok('extract: the proposed wording is not in the text index', !/wholly novel/.test(idx.raw));
  ok('extract: so nothing can locate onto it', !A.locate(idx.raw, { quote: 'a wholly novel phrase' }).ok);
  ok('extract: the current wording still is', /quick brown fox/.test(idx.raw));
}

// ---- 4. a deletion paints the strike and no <ins> ----------------------------
{
  reset();
  const r = A.paintProposal(A.buildTextIndex(doc.body), card({ current: 'over the lazy dog', proposed: '' }));
  ok('delete: marks painted', r && props().length === 1 && props()[0].textContent === 'over the lazy dog');
  ok('delete: no <ins>', inses().length === 0 && r.ins === null);
  reset();
  A.paintProposal(A.buildTextIndex(doc.body), card({ current: 'over the lazy dog', proposed: '   \n ' }));
  ok('delete: a whitespace-only proposal is a deletion too', props().length === 1 && inses().length === 0);
}

// ---- 5. a current that is not there exactly once paints nothing --------------
{
  reset();
  const index = A.buildTextIndex(doc.body);
  ok('ambiguous: twice on the page paints nothing',
    A.paintProposal(index, card({ current: 'twice said' })) === null && !props().length && !inses().length);
  ok('missing: absent from the page paints nothing',
    A.paintProposal(index, card({ current: 'not on this page at all' })) === null && !props().length);
  ok('missing: an empty current paints nothing',
    A.paintProposal(index, card({ current: '' })) === null && !props().length);
  ok('whitespace-tolerant: a re-wrapped current still places',
    !!A.paintProposal(index, card({ id: 'sg9', current: 'quick\n   brown   fox' })));
  ok('nothing written: the body text is unchanged', doc.body.textContent.indexOf('quick red fox') >= 0
    && A.buildTextIndex(doc.body).raw === index.raw);
}

// ---- 6. unpaint removes everything and normalises the text -------------------
{
  reset();
  const original = doc.body.innerHTML;
  A.paintProposal(A.buildTextIndex(doc.body), card());
  ok('unpaint: painted first', props().length === 2 && inses().length === 1);
  const n = A.unpaintProposal('sg1');
  ok('unpaint: reports what it removed', n === 3, String(n));
  ok('unpaint: no marks, no <ins>', !props().length && !inses().length && !A.proposalIds().length);
  ok('unpaint: the DOM is exactly as it was found', doc.body.innerHTML === original, doc.body.innerHTML);
  const p = doc.querySelector('p');
  ok('unpaint: split text nodes re-joined', p.childNodes.length === 3 && p.querySelector('em').childNodes.length === 1,
    String(p.childNodes.length));
  // unpaint(null) takes every card down
  const idx = A.buildTextIndex(doc.body);
  A.paintProposal(idx, card());
  A.paintProposal(idx, card({ id: 'sg2', current: 'about cats', proposed: 'about dogs' }));
  ok('unpaint all: two cards painted', A.proposalIds().length === 2);
  A.unpaintProposal(null);
  ok('unpaint all: none left', !A.proposalIds().length && doc.body.innerHTML === original);
}

// ---- 7. over a thread's highlight: nests, and leaves it alone ----------------
{
  reset();
  const idx = A.buildTextIndex(doc.body);
  const r = A.locate(idx.raw, { quote: 'jumps over the lazy dog' });
  A.paintOffsets(idx, r.start, r.end, 't-7', 'ready');
  const hlBg = doc.querySelector('mark.bfp-hl').style.getPropertyValue('background-color');
  A.paintProposal(idx, card({ current: 'the lazy dog', proposed: 'the sleepy dog' }));
  const pm = props()[0];
  ok('nest: the proposal mark sits inside the thread mark', pm && pm.parentNode.closest('mark.bfp-hl[data-bfp="t-7"]'));
  ok('nest: the thread mark keeps its tint', doc.querySelector('mark.bfp-hl').style.getPropertyValue('background-color') === hlBg);
  A.unpaintProposal('sg1');
  ok('nest: unpainting the proposal leaves the thread mark whole',
    A.marksFor('t-7').map(m => m.textContent).join('') === 'jumps over the lazy dog' && !inses().length);
}

// ---- 8. lifecycle: a card that leaves `open` comes down ----------------------
{
  for (const state of ['applied', 'rejected', 'needs-manual', 'unreadable']) {
    reset();
    const original = doc.body.innerHTML;
    const cards = [card(), card({ id: 'sg2', current: 'about cats', proposed: 'about dogs' })];
    A.syncProposals(cards, true, doc.body);
    ok(`lifecycle(${state}): both open cards painted`, A.proposalIds().sort().join() === 'sg1,sg2');
    cards[0].state = state;
    A.syncProposals(cards, true, doc.body);
    ok(`lifecycle(${state}): the answered card is unpainted`, A.proposalIds().join() === 'sg2'
      && !doc.querySelector('[data-bfp-prop="sg1"]'));
    cards[1].state = state;
    A.syncProposals(cards, true, doc.body);
    ok(`lifecycle(${state}): nothing left once both are answered`,
      !A.proposalIds().length && doc.body.innerHTML === original);
  }
  // a card that vanished from the record altogether is swept on the next sync
  reset();
  A.syncProposals([card()], true, doc.body);
  A.syncProposals([], true, doc.body);
  ok('lifecycle: a vanished card is swept', !A.proposalIds().length);
  // paintProposals skips anything not open
  reset();
  const painted = A.paintProposals(A.buildTextIndex(doc.body),
    [card({ state: 'applied' }), card({ id: 'sg3', current: 'about cats', proposed: 'x' })]);
  ok('lifecycle: paintProposals paints only open cards', painted.join() === 'sg3');
  // the track-changes switch: off unpaints, on paints again
  reset();
  A.syncProposals([card()], true, doc.body);
  A.syncProposals([card()], false, doc.body);
  ok('switch: off takes the preview down', !A.proposalIds().length);
  A.syncProposals([card()], true, doc.body);
  ok('switch: on puts it back', A.proposalIds().join() === 'sg1');
}

console.log(`prop: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
