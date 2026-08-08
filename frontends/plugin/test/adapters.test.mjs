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

// ---- 3d. the authuser cascade ------------------------------------------------
// The other multi-account failure: NO /u/<n>/ anywhere in the url, because the
// account is picked by cookie. `authuser=N` overrides that cookie, so the
// candidate list is "what the url says" followed by every account worth trying.
{
  const bare = `https://docs.google.com/document/d/${ID}/export?format=txt`;
  const au = n => bare + '&authuser=' + n;

  const plain = A.gdocsExportUrls(ID, null, null);
  eq('cascade: the url the page implies comes first', plain[0], bare);
  eq('cascade: then authuser 0..4', plain.slice(1), [au(0), au(1), au(2), au(3), au(4)]);
  eq('cascade: and stops there', plain.length, A.EXPORT_URL_MAX);
  eq('cascade: the cap is the primary plus 0..4', A.EXPORT_URL_MAX, 2 + A.AUTHUSER_MAX);

  const scoped = A.gdocsExportUrls(ID, A.gdocsScope(`https://docs.google.com/document/u/3/d/${ID}/edit`), null);
  eq('cascade: a scoped page still tries its own account first',
    scoped[0], `https://docs.google.com/document/u/3/d/${ID}/export?format=txt`);
  ok('cascade: …and falls back through the same authuser ladder',
    scoped.slice(1).join('|') === [au(0), au(1), au(2), au(3), au(4)].join('|'));

  const hinted = A.gdocsExportUrls(ID, null, '2');
  eq('cascade: a hinted account is tried straight after the plain url', hinted[1], au(2));
  eq('cascade: …and is not repeated later in the ladder',
    hinted.filter(u => u === au(2)).length, 1);
  eq('cascade: …so the list is still capped', hinted.length, A.EXPORT_URL_MAX);
  eq('cascade: a junk hint is ignored', A.gdocsExportUrls(ID, null, '../evil'), plain);
  eq('cascade: every candidate is on docs.google.com',
    plain.filter(u => u.startsWith('https://docs.google.com/document/')).length, plain.length);
}

// ---- 3e. asking the page which account it is signed in as --------------------
// Docs writes its own account into its own chrome. Cheaper and more accurate
// than the cascade, which stays as the fallback.
{
  eq('hint: an authuser rider on a widget url',
    A.accountFromUrls(['https://ogs.google.com/widget/app?authuser=2&origin=x']), '2');
  eq('hint: the Docs home button’s own path',
    A.accountFromUrls(['/document/u/1/']), '1');
  eq('hint: an absolute docs url',
    A.accountFromUrls([`https://docs.google.com/u/4/document/d/${ID}/edit`]), '4');
  eq('hint: the first one wins',
    A.accountFromUrls(['/nothing/here', '/document/u/3/', '?authuser=1']), '3');
  eq('hint: account 0 is a hint like any other', A.accountFromUrls(['?authuser=0']), '0');
  eq('hint: nothing to go on', A.accountFromUrls(['/edit', 'https://example.com/u/x/']), null);
  eq('hint: no links at all', A.accountFromUrls([]), null);
  eq('hint: not a list', A.accountFromUrls(null), null);
  eq('hint: a lookalike host is not a source',
    A.accountFromUrls(['https://evil.example/u/9/']), null);
  eq('hint: an avatar url that merely contains /u/ deeper in is not one',
    A.accountFromUrls(['https://lh3.googleusercontent.com/a/AAcHT/u/7/photo.jpg']), null);
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
  // NOT 'include'. /export 302s to googleusercontent with ACAO:* , which is
  // illegal for a credentialed request — 'include' made the fetch throw
  // "Failed to fetch" on every private doc. 'same-origin' still sends cookies
  // on the docs.google.com hop, which is the hop that mints the tokened url.
  eq('adapter: …with same-origin credentials, not include',
    f.calls[0].init.credentials, 'same-origin');
  eq('adapter: the credentials mode is stated once, in the module', A.PAGE_CREDENTIALS, 'same-origin');
  eq('adapter: a success leaves no error behind', ad.lastError, '');
  eq('adapter: …and records which url answered', ad.usedUrl, A.gdocsExportUrl(ID));
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
    ok('failure: …with the status it really came back with',
      /HTTP 200 but the body is HTML/.test(picker.lastError), picker.lastError);
    ok('failure: …and a peek at the body', /Choose an account/.test(picker.lastError), picker.lastError);
    ok('failure: …and which transport tried it', /^page /.test(picker.lastError), picker.lastError);
    ok('failure: …once per attempt, all of them',
      picker.lastError.split(' · ').length === A.EXPORT_URL_MAX, picker.lastError);
    ok('failure: the url in the reason is readable, not 40 chars of id',
      !picker.lastError.includes(ID) && /\/d\/…\//.test(picker.lastError), picker.lastError);

    const notFound = mk(stubFetch(res('nope', { ok: false, status: 404 })));
    await notFound.articleText();
    ok('failure: a 404 is reported as its status', /HTTP 404/.test(notFound.lastError), notFound.lastError);

    const threw = mk(stubFetch(() => { throw new Error('Failed to fetch'); }));
    await threw.articleText();
    ok('failure: a network throw carries the message', /Failed to fetch/.test(threw.lastError), threw.lastError);

    const empty = mk(stubFetch(res('   ')));
    await empty.articleText();
    ok('failure: an empty body says so', /empty/.test(empty.lastError), empty.lastError);

    // the retry the extension now performs (a failed export never sets the
    // sent-once flag): a whole cascade fails, the NEXT call succeeds and
    // clears the reason
    let n = 0;
    const flaky = mk(stubFetch(() => (++n <= A.EXPORT_URL_MAX ? res(PICKER) : res('Real text.'))));
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

// ---- 7b. the transport ladder --------------------------------------------------
// The live failure: credentials:'include' made the page fetch throw on the
// googleusercontent redirect. That is fixed by the credentials mode above; the
// background worker stays as the fallback for a page whose CSP blocks the
// request outright, and must NOT be used when the page can do it itself.
{
  const url = `https://docs.google.com/document/d/${ID}/edit`;
  const PICKER = '<!doctype html><html>Choose an account</html>';
  const bgOk = text => {
    const sent = [];
    const send = (msg, cb) => { sent.push(msg); cb({ ok: true, status: 200, contentType: 'text/plain', text }); };
    send.sent = sent;
    return send;
  };

  {
    // the page can do it: the worker is never even asked
    const f = stubFetch(res('Straight from the page.'));
    const send = bgOk('from the worker');
    const ad = A.pick(url, { fetch: f, send, documentTitle: () => '' });
    eq('ladder: the page transport answers', await ad.articleText(), 'Straight from the page.');
    eq('ladder: …and the worker was never bothered', send.sent.length, 0);
    eq('ladder: …which is recorded', ad.usedVia, 'page');
  }

  {
    // CSP (or the old CORS bug): the page fetch throws, the worker saves it
    const f = stubFetch(() => { throw new TypeError('Failed to fetch'); });
    const send = bgOk('Rescued by the worker.');
    const ad = A.pick(url, { fetch: f, send, documentTitle: () => '' });
    eq('ladder: a page fetch that throws falls back to the worker',
      await ad.articleText(), 'Rescued by the worker.');
    eq('ladder: …by the documented message', send.sent[0].t, 'gdocs-export');
    eq('ladder: …carrying the export url', send.sent[0].url, A.gdocsExportUrl(ID));
    eq('ladder: …and only after the page lane gave up', f.calls.length, 1);
    eq('ladder: the working transport is recorded', ad.usedVia, 'background');
  }

  {
    // an install whose worker predates this message: not a refusal, just absent
    const f = stubFetch(() => { throw new TypeError('Failed to fetch'); });
    const send = (msg, cb) => cb({ ok: false, error: 'unknown message "gdocs-export"' });
    const ad = A.pick(url, { fetch: f, send, documentTitle: () => '' });
    eq('ladder: an older worker is treated as no worker', await ad.articleText(), '');
    ok('ladder: …and the page failure is what gets reported',
      /Failed to fetch/.test(ad.lastError), ad.lastError);
  }

  {
    // the worker refuses the url outright — a real answer, reported as one
    const f = stubFetch(() => { throw new TypeError('Failed to fetch'); });
    const send = (msg, cb) => cb({ ok: false, error: 'gdocs-export: refused — this is not a Google Docs export url' });
    const ad = A.pick(url, { fetch: f, send, documentTitle: () => '' });
    eq('ladder: a worker refusal is not retried as a fetch', await ad.articleText(), '');
    ok('ladder: …and says so', /refused/.test(ad.lastError), ad.lastError);
  }

  {
    // the chooser: cascade every account on the page lane, THEN the worker
    let n = 0;
    const f = stubFetch(() => (++n <= A.EXPORT_URL_MAX ? res(PICKER) : res('never')));
    const send = bgOk('The document, from the worker.');
    const ad = A.pick(url, { fetch: f, send, documentTitle: () => '' });
    eq('ladder: a chooser cascades the whole ladder before giving up on the page',
      await ad.articleText(), 'The document, from the worker.');
    eq('ladder: …which is every candidate url, once', f.calls.length, A.EXPORT_URL_MAX);
    eq('ladder: …in the documented order',
      f.calls.map(c => c.url), A.gdocsExportUrls(ID, null, null));
  }

  {
    // the cascade stops when the account is not the question
    const f = stubFetch(res('boom', { ok: false, status: 500 }));
    const ad = A.pick(url, { fetch: f, documentTitle: () => '' });
    eq('ladder: a 500 is not retried against five other accounts',
      await ad.articleText(), '');
    eq('ladder: …one attempt, not six', f.calls.length, 1);
  }

  {
    // the second account is the right one: stop the moment a document arrives
    const want = `https://docs.google.com/document/d/${ID}/export?format=txt&authuser=1`;
    const f = stubFetch(u => (u === want ? res('The second account’s copy.') : res(PICKER)));
    const ad = A.pick(url, { fetch: f, documentTitle: () => '' });
    eq('ladder: the cascade stops at the account that works',
      await ad.articleText(), 'The second account’s copy.');
    eq('ladder: …without trying the rest', f.calls.length, 3);   // plain, authuser=0, authuser=1
    eq('ladder: …and remembers which url it was', ad.usedUrl, want);
  }

  {
    // the page's own links name the account, so the cascade is not needed
    const want = `https://docs.google.com/document/d/${ID}/export?format=txt&authuser=3`;
    const f = stubFetch(u => (u === want ? res('The third account’s copy.') : res(PICKER)));
    const ad = A.pick(url, {
      fetch: f, documentTitle: () => '',
      accountUrls: () => ['https://ogs.google.com/widget?authuser=3'],
    });
    eq('ladder: a hint from the page short-circuits the cascade',
      await ad.articleText(), 'The third account’s copy.');
    eq('ladder: …to two requests, not four', f.calls.length, 2);
    eq('ladder: the hint is recorded', ad.hintedAccount, '3');
  }

  {
    // a page that says nothing, and a DOM walk that throws, are both survivable
    const f = stubFetch(res('Fine.'));
    const ad = A.pick(url, {
      fetch: f, documentTitle: () => '',
      accountUrls: () => { throw new Error('detached'); },
    });
    eq('ladder: a broken account hint does not take the export down',
      await ad.articleText(), 'Fine.');
  }
}

// ---- 8. the registry is a registry, not a special case ------------------------
{
  ok('registry: is a list', Array.isArray(A.REGISTRY) && A.REGISTRY.length >= 1);
  ok('registry: every entry has match + create',
    A.REGISTRY.every(a => typeof a.match === 'function' && typeof a.create === 'function' && a.name));
  ok('registry: a matcher that throws does not take the page down',
    A.pick({ toString() { throw new Error('boom'); } }) === null);
}

// ---- 9. the .docx export: the document's own comment threads -------------------
// A txt export is prose only — every comment in the doc is dropped. The zip of
// the same document carries them, so a mention on a Doc sends both. Everything
// below is the same ladder asking for different bytes, and every failure is
// silent: this is an attachment to a message the user already sent.
{
  const url = `https://docs.google.com/document/d/${ID}/edit`;

  // ---- urls ----
  eq('docx: export url', A.gdocsExportUrl(ID, null, 'docx'),
    `https://docs.google.com/document/d/${ID}/export?format=docx`);
  eq('docx: …account-scoped the way the page url spells it',
    A.gdocsExportUrl(ID, { n: '1', where: 'pre' }, 'docx'),
    `https://docs.google.com/u/1/document/d/${ID}/export?format=docx`);
  eq('docx: …and the other spelling', A.gdocsExportUrl(ID, { n: '2', where: 'post' }, 'docx'),
    `https://docs.google.com/document/u/2/d/${ID}/export?format=docx`);
  eq('docx: an unknown format is never put on the wire',
    A.gdocsExportUrl(ID, null, 'pdf'), A.gdocsExportUrl(ID));
  eq('docx: no format at all is still txt', A.gdocsExportUrl(ID, null), A.gdocsExportUrl(ID, null, 'txt'));

  const ladder = A.gdocsExportUrls(ID, null, null, 'docx');
  ok('docx: the ladder is the same ladder', ladder.length === A.EXPORT_URL_MAX);
  ok('docx: …all of it asking for the zip', ladder.every(u => /format=docx/.test(u)));
  ok('docx: …starting with the url the page url implies', ladder[0] === A.gdocsExportUrl(ID, null, 'docx'));
  ok('docx: …then the authuser cascade',
    ladder[1] === A.gdocsExportUrl(ID, null, 'docx') + '&authuser=0');

  // ---- the zip signature ----
  const zip = n => {
    const b = new Uint8Array(n || 64);
    b[0] = 0x50; b[1] = 0x4b; b[2] = 0x03; b[3] = 0x04;
    return b;
  };
  ok('docx: PK\\x03\\x04 is a zip', A.looksZip(zip()));
  ok('docx: …and so is an empty archive', A.looksZip(new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0])));
  ok('docx: a chooser page is not', A.looksZip(new TextEncoder().encode('<!DOCTYPE html><html>')) === false);
  ok('docx: nor is a truncated body', A.looksZip(new Uint8Array([0x50, 0x4b])) === false);
  ok('docx: nor is nothing at all', A.looksZip(null) === false && A.looksZip(new Uint8Array(0)) === false);

  // ---- base64, which is how bytes cross sendMessage ----
  eq('docx: base64 of the zip signature', A.bytesToBase64(new Uint8Array([0x50, 0x4b, 0x03, 0x04])), 'UEsDBA==');
  const big = zip(200000);
  eq('docx: a large body encodes without blowing the argument limit',
    A.bytesToBase64(big), Buffer.from(big).toString('base64'));
  eq('docx: an ArrayBuffer works too',
    A.bytesToBase64(new Uint8Array([1, 2, 3]).buffer), Buffer.from([1, 2, 3]).toString('base64'));
  eq('docx: size is read off the encoding, without decoding it', A.b64Size('UEsDBA=='), 4);
  eq('docx: …with one pad char', A.b64Size(Buffer.from(zip(5)).toString('base64')), 5);
  eq('docx: …and with none', A.b64Size(Buffer.from(zip(6)).toString('base64')), 6);
  eq('docx: nothing is zero bytes', A.b64Size(''), 0);
  eq('docx: the cap is 6MB', A.DOCX_MAX, 6 * 1024 * 1024);

  // ---- the ladder, driven ----
  const bytesLane = reply => {
    const calls = [];
    const fn = async u => { calls.push(u); return typeof reply === 'function' ? reply(u) : reply; };
    fn.calls = calls;
    return fn;
  };
  const okBytes = (bytes, extra) => Object.assign(
    { ok: true, status: 200, contentType: A.DOCX_MAX ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : '',
      bytes, size: bytes.length }, extra || {});
  const mkd = (rb, env) => A.pick(url, Object.assign({
    request: async () => ({ ok: false, error: 'text lane unused here' }),
    requestBytes: rb, documentTitle: () => '',
  }, env || {}));

  {
    const lane = bytesLane(okBytes(zip(128)));
    const ad = mkd(lane);
    const b64 = await ad.docx();
    eq('docx: a real zip comes back base64-encoded', b64, A.bytesToBase64(zip(128)));
    eq('docx: …after exactly one request', lane.calls.length, 1);
    eq('docx: …at the docx export url', lane.calls[0], A.gdocsExportUrl(ID, null, 'docx'));
    eq('docx: a success leaves no complaint behind', ad.docxError, '');
    eq('docx: …and records which url answered', ad.docxUrl, A.gdocsExportUrl(ID, null, 'docx'));
  }

  {
    // the background lane's shape: already encoded, because a Uint8Array does
    // not survive sendMessage
    const b64 = A.bytesToBase64(zip(96));
    const ad = mkd(bytesLane({ ok: true, status: 200, contentType: '', b64, size: A.b64Size(b64) }));
    eq('docx: an already-encoded answer is taken as it is', await ad.docx(), b64);
  }

  {
    const chooser = new TextEncoder().encode(
      '<!DOCTYPE html><html><body><h1>Choose an account</h1></body></html>');
    const lane = bytesLane(okBytes(chooser, { contentType: 'text/html' }));
    const ad = mkd(lane);
    eq('docx: an account chooser served 200 is not a document', await ad.docx(), '');
    ok('docx: …and says so', /not a \.docx zip/.test(ad.docxError), ad.docxError);
    eq('docx: …after trying every account, like the text ladder does',
      lane.calls.length, A.EXPORT_URL_MAX);
  }

  {
    const lane = bytesLane(u => (/authuser=2/.test(u)
      ? okBytes(zip(64))
      : { ok: false, status: 404, error: 'HTTP 404' }));
    const ad = mkd(lane);
    eq('docx: the cascade finds the account that can read the doc',
      await ad.docx(), A.bytesToBase64(zip(64)));
    ok('docx: …and stops there', /authuser=2$/.test(ad.docxUrl), ad.docxUrl);
  }

  {
    const lane = bytesLane({ ok: true, status: 200, contentType: '',
      bytes: new Uint8Array(0), size: A.DOCX_MAX + 1 });
    const ad = mkd(lane);
    eq('docx: a document past the cap is dropped, not sent', await ad.docx(), '');
    ok('docx: …saying it was too big', /over the 6MB cap/.test(ad.docxError), ad.docxError);
    eq('docx: …without cascading — it is the right account, just a big file',
      lane.calls.length, 1);
  }

  {
    const ad = mkd(bytesLane({ ok: false, status: 500, error: 'HTTP 500' }));
    eq('docx: a server error is silent too', await ad.docx(), '');
    ok('docx: …and reported', /HTTP 500/.test(ad.docxError), ad.docxError);
  }

  {
    // a world with no binary transport at all (a `request` override and
    // nothing else): the attachment is simply absent
    const ad = A.pick(url, { request: async () => ({ ok: false }), documentTitle: () => '' });
    eq('docx: no binary transport means no attachment, never a throw', await ad.docx(), '');
    ok('docx: …and it says why', /no binary transport/.test(ad.docxError), ad.docxError);
  }

  {
    // the text ladder must not have moved: it still asks for txt
    const f = stubFetch(res('The document.'));
    const ad = A.pick(url, { fetch: f, documentTitle: () => '' });
    await ad.articleText();
    ok('docx: the prose export still asks for txt', /format=txt/.test(f.calls[0].url), f.calls[0].url);
  }
}

// ---- report -------------------------------------------------------------------
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' adapters.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
