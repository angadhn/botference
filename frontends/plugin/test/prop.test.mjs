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

// ---- 9. plainOf: source markup, read the way the page shows it --------------
{
  const P = A.plainOf;
  const eq = (name, got, want) => ok('plainOf: ' + name, got === want, JSON.stringify(got));
  eq('a link keeps its text', P('see [the Earth](earth.md) here'), 'see the Earth here');
  eq('a picture has no text on the page, so it is nothing to locate', P('![a plot](fig.png) below'), 'below');
  eq('…but the proposal\'s form keeps it whole', P('see ![a plot](fig.png) below', { keepImages: true }),
    'see ![a plot](fig.png) below');
  eq('a MyST figure is its caption to locate',
    P('Fig:\n```{figure} figs/orbit.png\n:name: orbit\nThe orbit.\n```\nafter'), 'Fig: The orbit. after');
  eq('…and whole, line breaks and all, kept',
    P('```{figure} figs/orbit.png\n:name: orbit\nThe **orbit**.\n```', { keepImages: true }),
    '```{figure} figs/orbit.png\n:name: orbit\nThe **orbit**.\n```');
  eq('inline math is left exactly as written', P('so $x_1 + a*b*c$ is **it**'), 'so $x_1 + a*b*c$ is it');
  eq('display math keeps its own lines', P('then\n$$\n\\int_0^1 f_x\\,dx\n$$\ndone'),
    'then $$\n\\int_0^1 f_x\\,dx\n$$ done');
  eq('\\( \\) and \\[ \\] too', P('a \\(x_i\\) b \\[y_*z_*\\]'), 'a \\(x_i\\) b \\[y_*z_*\\]');
  eq('money is not math', P('costs $5 and _then_ $10'), 'costs $5 and then $10');
  eq('a reference link keeps its text', P('[the Moon][moon] too'), 'the Moon too');
  eq('strong', P('it **must** hold'), 'it must hold');
  eq('strong, underscores', P('it __must__ hold'), 'it must hold');
  eq('emphasis', P('it *may* hold'), 'it may hold');
  eq('emphasis, underscores', P('it _may_ hold'), 'it may hold');
  eq('snake_case is not emphasis', P('call my_var_name now'), 'call my_var_name now');
  eq('a MyST role keeps its content', P('see {ref}`gravity` and {term}`mass`'), 'see gravity and mass');
  eq('a role with a target keeps its text', P('see {ref}`the force <grav-force>`'), 'see the force');
  eq('inline code loses its backticks', P('run `make all` first'), 'run make all first');
  eq('list numbers and bullets go', P('topics:\n1. one\n2. two\n- three'), 'topics: one two three');
  eq('heading hashes and quote bars go', P('## Orbits\n> said so'), 'Orbits said so');
  eq('whitespace folds', P('a   b\n\n  c'), 'a b c');
  eq('an empty-text link is nothing (its words live elsewhere)',
    P('1. [](content.Gravitational-Force)\n2. [Orbits](o.md)'), 'Orbits');
  eq('plain prose is unchanged', P('The quick brown fox.'), 'The quick brown fox.');
  eq('null is empty', P(null), '');
}

// ---- 9b. imageRefs: the pictures a passage refers to -------------------------
{
  const R = A.imageRefs;
  const one = R('a ![The orbit](/assets/o.png "t") b');
  ok('imageRefs: a markdown image', one.length === 1 && one[0].src === '/assets/o.png' && one[0].alt === 'The orbit'
    && one[0].kind === 'md' && one[0].raw === '![The orbit](/assets/o.png "t")', JSON.stringify(one));
  const fig = R('x\n```{figure} figs/orbit.png\n:alt: an ellipse\n:width: 80%\nThe orbit, drawn.\n```\ny');
  ok('imageRefs: a MyST figure, alt from :alt:, caption kept', fig.length === 1 && fig[0].kind === 'myst'
    && fig[0].src === 'figs/orbit.png' && fig[0].alt === 'an ellipse' && fig[0].caption === 'The orbit, drawn.',
    JSON.stringify(fig));
  const img = R(':::{image} pic.svg\n:::');
  ok('imageRefs: a colon-fenced {image}, alt empty', img.length === 1 && img[0].src === 'pic.svg' && img[0].alt === '');
  const capOnly = R('```{figure} a.png\nCaption only.\n```');
  ok('imageRefs: no :alt:, so the caption is the alt', capOnly[0] && capOnly[0].alt === 'Caption only.');
  const inside = R('```{figure} a.png\nSee ![inner](b.png).\n```');
  ok('imageRefs: an image inside a figure caption is the figure', inside.length === 1 && inside[0].kind === 'myst');
  ok('imageRefs: a link is not a picture', R('[text](a.png)').length === 0);
  ok('imageRefs: an unclosed fence is not a figure', R('```{figure} a.png\nno close').length === 0);
  ok('imageRefs: in order', R('![b](2.png) then ![a](1.png)').map(r => r.src).join() === '2.png,1.png');
}

// ---- 10. fallback 1: a marked-up current places by its rendered words -------
{
  reset();
  const index = A.buildTextIndex(doc.body);
  const r = A.paintProposal(index, card({ current: 'quick **brown [fox](fox.md)**',
    proposed: 'quick *red* [fox](fox.md)' }));
  ok('plain: placed', r && !r.approx, r && String(r.approx));
  ok('plain: the struck words are the rendered ones',
    props().map(m => m.textContent).join('') === 'quick brown fox', props().map(m => m.textContent).join('|'));
  ok('plain: the proposal is shown without its markup', inses().length === 1 && inses()[0].textContent === 'quick red fox',
    inses()[0] && inses()[0].textContent);
  ok('plain: not marked approximate', !doc.querySelector('[data-bfp-prop-approx]') && !A.approxProposalIds().length);
  reset();
  ok('plain: still held to exactly-once',
    A.paintProposal(A.buildTextIndex(doc.body), card({ current: '**twice said**' })) === null && !props().length);
}

// ---- 11. fallback 2: the thread's passage, marked approximate ---------------
{
  reset();
  const original = doc.body.innerHTML;
  const index = A.buildTextIndex(doc.body);
  const t = A.locate(index.raw, { quote: 'A later passage here' });
  A.paintOffsets(index, t.start, t.end, 't-11', 'ready');
  const near = { start: t.start, end: t.end };
  const myst = 'In this lecture: 1. [](content.Some-Label) 2. [](content.Other)';
  ok('approx: without a passage to stand on, nothing', A.paintProposal(index, card({ current: myst })) === null);
  const r = A.paintProposal(index, card({ current: myst, proposed: 'See **the list** below.' }), near);
  ok('approx: placed, and says so', r && r.approx === true);
  ok('approx: the strike is over the thread passage',
    props().map(m => m.textContent).join('') === 'A later passage here');
  ok('approx: every mark carries the flag and the approximate title',
    props().every(m => m.getAttribute('data-bfp-prop-approx') === '1' && /approximate/.test(m.getAttribute('title'))));
  ok('approx: the <ins> follows, flagged, without markup',
    inses().length === 1 && inses()[0].getAttribute('data-bfp-prop-approx') === '1'
    && inses()[0].textContent === 'See the list below.' && props()[props().length - 1].nextSibling === inses()[0]);
  ok('approx: approxProposalIds and proposalIds see it',
    A.approxProposalIds().join() === 'sg1' && A.proposalIds().join() === 'sg1');
  ok('approx: the <ins> is not in the text index', A.buildTextIndex(doc.body).raw === index.raw);
  ok('approx: nested inside the thread mark', props()[0].parentNode.closest('mark.bfp-hl[data-bfp="t-11"]'));
  A.unpaintProposal('sg1');
  ok('approx: unpaint takes it all down', !A.proposalIds().length && !A.approxProposalIds().length && !inses().length);
  A.unpaint('t-11');
  ok('approx: the DOM is as it was found', doc.body.innerHTML === original, doc.body.innerHTML);
  // an exact hit wins over `near`
  reset();
  const i2 = A.buildTextIndex(doc.body);
  const r2 = A.paintProposal(i2, card(), near);
  ok('approx: an exact match ignores near', r2 && !r2.approx && props().map(m => m.textContent).join('') === 'quick brown fox');
  // a bogus near is refused
  reset();
  const i3 = A.buildTextIndex(doc.body);
  ok('approx: a near outside the index paints nothing',
    A.paintProposal(i3, card({ current: myst }), { start: 5, end: i3.raw.length + 10 }) === null && !props().length);
}

// ---- 12. one approximate preview per passage; sync with nearFor -------------
{
  reset();
  const original = doc.body.innerHTML;
  const index = A.buildTextIndex(doc.body);
  const t = A.locate(index.raw, { quote: 'about cats and their habits' });
  const near = { sgA: { start: t.start, end: t.end }, sgB: { start: t.start, end: t.end } };
  const cards = [card({ id: 'sgA', current: '[](x.Y)' }), card({ id: 'sgB', current: '[](x.Z)', proposed: 'z' })];
  const painted = A.paintProposals(index, cards, near);
  ok('stack: only the first approximate card on a passage is shown', painted.join() === 'sgA', painted.join());
  A.unpaintProposal(null);
  ok('stack: unpaint(null) restores the DOM', doc.body.innerHTML === original);
  const got = A.syncProposals(cards, true, doc.body, idx => {
    const r = A.locate(idx.raw, { quote: 'about cats and their habits' });
    return { sgB: { start: r.start, end: r.end } };
  });
  ok('sync: nearFor is asked against the fresh index', got.join() === 'sgB' && A.approxProposalIds().join() === 'sgB');
  A.syncProposals(cards, false, doc.body, () => ({}));
  ok('sync: off takes the approximate preview down too', !A.proposalIds().length && doc.body.innerHTML === original);
}

console.log(`prop: ${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
