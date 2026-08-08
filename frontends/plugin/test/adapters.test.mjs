// adapters.test.mjs — unit tests for the pure surface of
// frontends/plugin/extension/adapters.js: url matching, export-url
// construction, title cleanup, export-body cleaning, and the Google Docs
// adapter driven through an injected fetch. No framework, no DOM.
//
//   node frontends/plugin/test/adapters.test.mjs
//
// Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const A = require(path.join(here, '..', 'extension', 'adapters.js'));

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
}
function eq(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  ok(name, g === w, 'got  ' + g + '\n      want ' + w);
}

const ID = '1aBcD_efGH-2026QuietMachine';

// ---- 1. document id extraction ---------------------------------------------
{
  const variants = {
    'plain /edit': `https://docs.google.com/document/d/${ID}/edit`,
    'tab param': `https://docs.google.com/document/d/${ID}/edit?tab=t.0`,
    'heading fragment': `https://docs.google.com/document/d/${ID}/edit#heading=h.9k2xz1`,
    'both': `https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.9k2xz1`,
    'no /edit at all': `https://docs.google.com/document/d/${ID}`,
    'trailing slash': `https://docs.google.com/document/d/${ID}/`,
    'preview': `https://docs.google.com/document/d/${ID}/preview`,
    'query straight after the id': `https://docs.google.com/document/d/${ID}?usp=sharing`,
    'account-scoped': `https://docs.google.com/document/u/1/d/${ID}/edit`,
    'http': `http://docs.google.com/document/d/${ID}/edit`,
    'surrounding whitespace': `  https://docs.google.com/document/d/${ID}/edit  `,
  };
  for (const [name, url] of Object.entries(variants)) {
    eq('id: ' + name, A.gdocsId(url), ID);
  }
}

// ---- 2. everything else falls through ---------------------------------------
{
  const others = {
    'a spreadsheet': `https://docs.google.com/spreadsheets/d/${ID}/edit`,
    'a slide deck': `https://docs.google.com/presentation/d/${ID}/edit`,
    'a drive folder': `https://drive.google.com/drive/folders/${ID}`,
    'the docs home': 'https://docs.google.com/document/',
    'a plain article': 'https://example.com/sport/the-quiet-machine',
    'a lookalike host': `https://docs.google.com.evil.example/document/d/${ID}/edit`,
    'a subdomain lookalike': `https://notdocs.google.com/document/d/${ID}/edit`,
    'empty': '',
    'null': null,
    'undefined': undefined,
  };
  for (const [name, url] of Object.entries(others)) {
    eq('fallthrough: ' + name, A.gdocsId(url), null);
    ok('fallthrough: ' + name + ' gets no adapter', A.pick(url) === null);
  }
}

// ---- 3. export url ----------------------------------------------------------
{
  eq('export url', A.gdocsExportUrl(ID),
    `https://docs.google.com/document/d/${ID}/export?format=txt`);
  ok('export url is same-origin on docs.google.com',
    A.gdocsExportUrl(ID).startsWith('https://docs.google.com/'));
  eq('export url escapes anything odd in the id', A.gdocsExportUrl('a/b?c'),
    'https://docs.google.com/document/d/a%2Fb%3Fc/export?format=txt');
  ok('export url carries no redundant &id= rider',
    !/[?&]id=/.test(A.gdocsExportUrl(ID)));
}

// ---- 3b. the account the page is scoped to ----------------------------------
// The live failure: a doc opened in a SECOND signed-in profile
// (docs.google.com/u/1/…) exported from the bare url, which the DEFAULT
// account answers 200 with an account chooser. The scope has to survive.
{
  eq('scope: an unscoped url has none', A.gdocsScope(`https://docs.google.com/document/d/${ID}/edit`), null);
  eq('scope: the Docs app’s own form', A.gdocsScope(`https://docs.google.com/document/u/1/d/${ID}/edit`),
    { n: '1', where: 'post' });
  eq('scope: the form Drive links out with', A.gdocsScope(`https://docs.google.com/u/1/document/d/${ID}/edit`),
    { n: '1', where: 'pre' });
  eq('scope: the default account is still a scope, not an absence',
    A.gdocsScope(`https://docs.google.com/document/u/0/d/${ID}/edit`), { n: '0', where: 'post' });
  eq('scope: a two-digit account', A.gdocsScope(`https://docs.google.com/document/u/12/d/${ID}/edit`),
    { n: '12', where: 'post' });
  eq('scope: not a doc at all', A.gdocsScope('https://example.com/x'), null);

  const url = n => `https://docs.google.com/document/u/${n}/d/${ID}/edit?tab=t.0`;
  eq('export url: u/0 is preserved, not dropped',
    A.gdocsExportUrl(ID, A.gdocsScope(url(0))),
    `https://docs.google.com/document/u/0/d/${ID}/export?format=txt`);
  eq('export url: u/1 keeps the second account',
    A.gdocsExportUrl(ID, A.gdocsScope(url(1))),
    `https://docs.google.com/document/u/1/d/${ID}/export?format=txt`);
  eq('export url: a /u/1/ that came BEFORE /document/ stays where it was',
    A.gdocsExportUrl(ID, A.gdocsScope(`https://docs.google.com/u/1/document/d/${ID}/edit`)),
    `https://docs.google.com/u/1/document/d/${ID}/export?format=txt`);
  eq('export url: no scope, no prefix',
    A.gdocsExportUrl(ID, A.gdocsScope(`https://docs.google.com/document/d/${ID}/edit`)),
    `https://docs.google.com/document/d/${ID}/export?format=txt`);
  eq('export url: a junk scope is ignored rather than pasted in',
    A.gdocsExportUrl(ID, { n: '1/../..', where: 'post' }),
    `https://docs.google.com/document/d/${ID}/export?format=txt`);
  for (const [name, u] of Object.entries({
    'unscoped': `https://docs.google.com/document/d/${ID}/edit`,
    'u/1 post': url(1),
    'u/1 pre': `https://docs.google.com/u/1/document/d/${ID}/edit`,
  })) {
    ok('export url stays on docs.google.com (' + name + ')',
      A.gdocsExportUrl(ID, A.gdocsScope(u)).startsWith('https://docs.google.com/'));
  }
}

// ---- 3c. an export that is a web page, not a document ------------------------
// This is the whole silent failure: status 200, and a login form or account
// chooser in the body. Anything that opens as markup is a failure.
{
  const html = [
    '<!doctype html><html lang="en"><head><title>Choose an account</title>',
    '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN">',
    '<html><body>Sign in</body></html>',
    '\n\n  <html>',
    '﻿<!doctype html>',
    '<?xml version="1.0"?><Error/>',
    '<meta http-equiv="refresh" content="0;url=https://accounts.google.com/">',
    '\n<!-- google --><html>',
  ];
  for (const s of html) ok('html sniff: ' + JSON.stringify(s.slice(0, 34)), A.looksHtml(s));

  const text = [
    'The Quiet Machine\n\nDraft seven.',
    '﻿The Quiet Machine',
    // a doc is allowed to talk about markup — the sniff only reads the opening
    'A draft about the web\n\n' + 'x'.repeat(5000) + '\n<html> is not a document',
    '', null, undefined,
  ];
  for (const s of text) ok('not html: ' + JSON.stringify(String(s).slice(0, 34)), !A.looksHtml(s));
}

// ---- 4. title cleanup --------------------------------------------------------
{
  eq('title: hyphen suffix', A.stripDocsSuffix('Q3 narrative - Google Docs'), 'Q3 narrative');
  eq('title: en dash suffix', A.stripDocsSuffix('Q3 narrative – Google Docs'), 'Q3 narrative');
  eq('title: em dash suffix', A.stripDocsSuffix('Q3 narrative — Google Docs'), 'Q3 narrative');
  eq('title: odd spacing', A.stripDocsSuffix('  Q3 narrative  -  Google  Docs  '), 'Q3 narrative');
  eq('title: no suffix is left alone', A.stripDocsSuffix('Q3 narrative'), 'Q3 narrative');
  eq('title: the phrase mid-title survives',
    A.stripDocsSuffix('Google Docs is not the point - Google Docs'), 'Google Docs is not the point');
  eq('title: a doc named after the suffix keeps its own dashes',
    A.stripDocsSuffix('Notes — part 2 - Google Docs'), 'Notes — part 2');
  eq('title: empty', A.stripDocsSuffix(''), '');
  eq('title: null', A.stripDocsSuffix(null), '');
}

// ---- 5. export body cleaning -------------------------------------------------
{
  eq('clean: BOM and surrounding whitespace go',
    A.cleanExport('﻿\n  Heading\n\nBody.\n\n  '), 'Heading\n\nBody.');
  eq('clean: CRLF normalised', A.cleanExport('a\r\nb'), 'a\nb');
  eq('clean: long blank runs collapse to one blank line',
    A.cleanExport('a\n\n\n\n\nb'), 'a\n\nb');
  eq('clean: paragraph spacing is kept', A.cleanExport('a\n\nb'), 'a\n\nb');
  eq('clean: capped', A.cleanExport('x'.repeat(30000)).length, A.TEXT_LIMIT);
  {
    // the cut can land on a paragraph break: trim the dangle, keep the rest
    const s = A.cleanExport('ab\n\n'.repeat(9000));
    ok('clean: a cut on whitespace leaves no dangle', s === s.trimEnd(), JSON.stringify(s.slice(-6)));
    ok('clean: …and loses no more than the whitespace it cut',
      s.length <= A.TEXT_LIMIT && s.length > A.TEXT_LIMIT - 4, String(s.length));
  }
  eq('clean: the cap is the 12000 the companion then trims to 6000', A.TEXT_LIMIT, 12000);
  eq('clean: nothing at all', A.cleanExport(null), '');
}

// ---- 6. the adapter itself, through an injected fetch -------------------------
function stubFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    if (typeof reply === 'function') return reply(url, init);
    return reply;
  };
  fn.calls = calls;
  return fn;
}
const res = (body, extra) => Object.assign({
  ok: true, status: 200,
  headers: { get: () => 'text/plain; charset=UTF-8' },
  text: async () => body,
}, extra || {});

{
  const url = `https://docs.google.com/document/d/${ID}/edit?tab=t.0#heading=h.9`;
  const f = stubFetch(res('﻿The Quiet Machine\n\nDraft seven.\n\n'));
  const ad = A.pick(url, { fetch: f, documentTitle: () => 'The Quiet Machine - Google Docs' });

  ok('adapter: a doc url gets one', !!ad);
  eq('adapter: names itself', ad.name, 'gdocs');
  eq('adapter: carries the id', ad.id, ID);
  eq('adapter: highlights are off', ad.capabilities.highlights, false);
  eq('adapter: title comes from the tab, suffix stripped', ad.title(), 'The Quiet Machine');

  const text = await ad.articleText();
  eq('adapter: text is the cleaned export', text, 'The Quiet Machine\n\nDraft seven.');
  eq('adapter: fetched the export url exactly once', f.calls.length, 1);
  eq('adapter: …at the export url', f.calls[0].url, A.gdocsExportUrl(ID));
  eq('adapter: …with the user’s session', f.calls[0].init.credentials, 'include');
  eq('adapter: a success leaves no error behind', ad.lastError, '');
}

// ---- 6b. the account-scoped tab fetches the account-scoped export ------------
{
  const cases = {
    'the Docs app’s own url': [`https://docs.google.com/document/u/1/d/${ID}/edit?tab=t.0`,
      `https://docs.google.com/document/u/1/d/${ID}/export?format=txt`],
    'a Drive-style url': [`https://docs.google.com/u/2/document/d/${ID}/edit`,
      `https://docs.google.com/u/2/document/d/${ID}/export?format=txt`],
    'the default account, spelled out': [`https://docs.google.com/document/u/0/d/${ID}/edit`,
      `https://docs.google.com/document/u/0/d/${ID}/export?format=txt`],
    'no account in the url at all': [`https://docs.google.com/document/d/${ID}/edit`,
      `https://docs.google.com/document/d/${ID}/export?format=txt`],
  };
  for (const [name, [url, want]] of Object.entries(cases)) {
    const f = stubFetch(res('Body.'));
    const ad = A.pick(url, { fetch: f, documentTitle: () => 'x - Google Docs' });
    eq('scoped fetch: ' + name + ' — id survives', ad.id, ID);
    eq('scoped fetch: ' + name + ' — export url', ad.exportUrl, want);
    await ad.articleText();
    eq('scoped fetch: ' + name + ' — that is the url fetched', f.calls[0].url, want);
  }
}

// ---- 7. every failure resolves to '' (content.js then extracts generically) ----
{
  const url = `https://docs.google.com/document/d/${ID}/edit`;
  const mk = f => A.pick(url, { fetch: f, documentTitle: () => 'x - Google Docs' });

  eq('failure: 404', await mk(stubFetch(res('nope', { ok: false, status: 404 }))).articleText(), '');
  eq('failure: 500', await mk(stubFetch(res('', { ok: false, status: 500 }))).articleText(), '');
  eq('failure: network throw',
    await mk(stubFetch(() => { throw new Error('Failed to fetch'); })).articleText(), '');
  eq('failure: rejected promise',
    await mk(stubFetch(() => Promise.reject(new Error('offline')))).articleText(), '');
  eq('failure: a 200 sign-in page by content type',
    await mk(stubFetch(res('<!doctype html><html>sign in</html>',
      { headers: { get: () => 'text/html; charset=UTF-8' } }))).articleText(), '');
  eq('failure: a 200 sign-in page by body sniff',
    await mk(stubFetch(res('<!DOCTYPE html>\n<html lang="en">sign in'))).articleText(), '');
  eq('failure: no answer at all', await mk(stubFetch(null)).articleText(), '');
  eq('failure: no fetch in this world',
    await A.pick(url, { fetch: null, documentTitle: () => '' }).articleText(), '');

  // the live one: the wrong account answers 200 with a chooser, and says
  // text/html only sometimes — the body has to be enough on its own
  const PICKER = '<!DOCTYPE html><html lang="en"><head><title>Choose an account</title></head>' +
    '<body><h1>Choose an account</h1><p>to continue to Google Docs</p></body></html>';
  eq('failure: a 200 account chooser, content-type and all',
    await mk(stubFetch(res(PICKER, { headers: { get: () => 'text/html; charset=UTF-8' } }))).articleText(), '');
  eq('failure: …and the same chooser mislabelled text/plain',
    await mk(stubFetch(res(PICKER))).articleText(), '');
  eq('failure: an html body with no doctype and a 200 text/plain',
    await mk(stubFetch(res('<html><body>Sign in</body></html>'))).articleText(), '');
  eq('failure: a meta-refresh to accounts.google.com',
    await mk(stubFetch(res('<meta http-equiv="refresh" content="0;url=https://accounts.google.com/">'))).articleText(), '');
  eq('failure: a 200 with nothing in it', await mk(stubFetch(res('   \n  '))).articleText(), '');

  // …and every one of them says WHY, because content.js logs it and the user
  // is told the bots will not see the page
  {
    const picker = mk(stubFetch(res(PICKER)));
    await picker.articleText();
    ok('failure: an html body is reported as html', /HTML/.test(picker.lastError), picker.lastError);
    ok('failure: …with the status it really came back with', /^HTTP 200\b/.test(picker.lastError), picker.lastError);
    ok('failure: …and a peek at the body, capped', /Choose an account/.test(picker.lastError) &&
      picker.lastError.length < 200, picker.lastError);

    const notFound = mk(stubFetch(res('nope', { ok: false, status: 404 })));
    await notFound.articleText();
    eq('failure: a 404 is reported as its status', notFound.lastError, 'HTTP 404');

    const threw = mk(stubFetch(() => { throw new Error('Failed to fetch'); }));
    await threw.articleText();
    ok('failure: a network throw carries the message', /Failed to fetch/.test(threw.lastError), threw.lastError);

    const empty = mk(stubFetch(res('   ')));
    await empty.articleText();
    ok('failure: an empty body says so', /empty/.test(empty.lastError), empty.lastError);

    // the retry the extension now performs (a failed export never sets the
    // sent-once flag): the second attempt succeeds and clears the reason
    let n = 0;
    const flaky = mk(stubFetch(() => (++n === 1 ? res(PICKER) : res('Real text.'))));
    const first = await flaky.articleText();
    const why = flaky.lastError;
    const second = await flaky.articleText();
    ok('failure: a later attempt that works clears the reason',
      first === '' && !!why && second === 'Real text.' && flaky.lastError === '',
      JSON.stringify([first, why, second, flaky.lastError]));
  }

  // a very long doc is truncated here, not at the companion's 6000 — the
  // server does the real capping and this is only a transport ceiling
  const long = 'A'.repeat(40000);
  const t = await mk(stubFetch(res(long))).articleText();
  eq('long doc: trimmed to the transport ceiling', t.length, A.TEXT_LIMIT);
}

// ---- 8. the registry is a registry, not a special case ------------------------
{
  ok('registry: is a list', Array.isArray(A.REGISTRY) && A.REGISTRY.length >= 1);
  ok('registry: every entry has match + create',
    A.REGISTRY.every(a => typeof a.match === 'function' && typeof a.create === 'function' && a.name));
  ok('registry: a matcher that throws does not take the page down',
    A.pick({ toString() { throw new Error('boom'); } }) === null);
}

// ---- report -------------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' adapters.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
