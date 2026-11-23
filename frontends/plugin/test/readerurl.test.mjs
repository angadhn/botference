// readerurl.test.mjs — which reader the drawer's feed icon opens (extension/config.js, background.js, drawer.js).
//
//   node frontends/plugin/test/readerurl.test.mjs
//
// `reader_url`: empty = the companion's own Hub; set = a reader the person already has. The icon's target is one of READER_MODES, what a
// click does is one of READER_ACTIONS (the chooser appears only when nothing is set, nothing was chosen and the Hub follows nothing), and
// what was chosen is a named onboarding state that is remembered. happy-dom stands in for the browser; storage is a stub area.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'CustomEvent', 'Blob', 'FileReader']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const C = require(path.join(here, '..', 'extension', 'config.js'));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));
const ext = f => fs.readFileSync(path.join(here, '..', 'extension', f), 'utf8');

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), 'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));
const throws = fn => { try { fn(); return false; } catch { return true; } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const BASE = 'http://127.0.0.1:4189';
const STUDIO = 'https://their.site/blyg/studio/reading';

// ---- validation ---------------------------------------------------------------
eq('reader_url: empty is allowed (the Hub)', C.readerUrlOf(''), { value: '', refused: false });
eq('reader_url: absent is empty', C.readerUrlOf(undefined), { value: '', refused: false });
eq('reader_url: an https address', C.readerUrlOf(STUDIO), { value: STUDIO, refused: false });
eq('reader_url: spaces around it are not part of it', C.readerUrlOf('  ' + STUDIO + '  ').value, STUDIO);
for (const ok_ of ['http://127.0.0.1:8080/reading', 'http://localhost:3000/', 'http://[::1]:9000/x']) eq('reader_url: http for this computer: ' + ok_, C.readerUrlOf(ok_).refused, false);
for (const bad of ['http://their.site/reading', 'ftp://their.site/x', 'javascript:alert(1)', 'file:///etc/passwd', 'their.site/reading', 'https://user:pw@their.site/x', 'not a url', 'data:text/html,x', 'http://127.0.0.1.evil.test/']) {
  eq('reader_url: refused: ' + bad, C.readerUrlOf(bad), { value: '', refused: true });
}

// ---- the icon's target, for each value ---------------------------------------------
eq('the modes, named', C.READER_MODES, ['companion-hub', 'external']);
eq('empty: the companion\'s own Hub', C.readerTarget({ base: BASE, reader_url: '' }), { mode: 'companion-hub', url: BASE + '/hub' });
eq('empty, on a remote companion: its Hub', C.readerTarget({ base: 'https://hub.example.com/plugin' }), { mode: 'companion-hub', url: 'https://hub.example.com/plugin/hub' });
eq('set: that reader', C.readerTarget({ base: BASE, reader_url: STUDIO }), { mode: 'external', url: STUDIO });
eq('a stored value that is not valid is the Hub (never opened)', C.readerTarget({ base: BASE, reader_url: 'javascript:alert(1)' }).mode, 'companion-hub');

// ---- what a click does; the chooser only in the stated condition -----------------------
eq('the actions, named', C.READER_ACTIONS, ['choose', 'open-hub', 'open-external']);
const cfg = o => ({ base: BASE, reader_url: '', reader_onboarding: 'unasked', ...o });
eq('nothing set, nothing chosen, nothing followed: CHOOSE', C.readerAction(cfg({}), 0), 'choose');
eq('…but one blyg followed: the Hub', C.readerAction(cfg({}), 1), 'open-hub');
eq('…or the Hub could not be asked: the Hub (never a question on a guess)', C.readerAction(cfg({}), null), 'open-hub');
eq('the Hub was chosen before: the Hub, even if it follows nothing yet', C.readerAction(cfg({ reader_onboarding: 'hub' }), 0), 'open-hub');
eq('a reader is set: it opens, whatever the Hub follows', C.readerAction(cfg({ reader_url: STUDIO, reader_onboarding: 'external' }), 0), 'open-external');
eq('…and with no choice remembered either', C.readerAction(cfg({ reader_url: STUDIO }), 0), 'open-external');
eq('…and with the Hub unreachable', C.readerAction(cfg({ reader_url: STUDIO }), null), 'open-external');
eq('external chosen but the address was cleared: the Hub', C.readerAction(cfg({ reader_onboarding: 'external' }), 5), 'open-hub');

// ---- the onboarding state: named, one function, and it persists -----------------------------
eq('the states, named', C.ONBOARDING, ['unasked', 'hub', 'external']);
eq('choose the Hub', C.onboardingMove('unasked', 'choose-hub'), 'hub');
eq('choose an external reader', C.onboardingMove('unasked', 'choose-external'), 'external');
eq('changeable later: Hub to external and back', [C.onboardingMove('hub', 'choose-external'), C.onboardingMove('external', 'choose-hub')], ['external', 'hub']);
eq('forget', C.onboardingMove('external', 'forget'), 'unasked');
ok('a move that does not exist is refused', throws(() => C.onboardingMove('unasked', 'wander')));
ok('a state that does not exist is refused', throws(() => C.onboardingMove('maybe', 'choose-hub')));
eq('a stored word that is not a state reads as unasked', C.onboardingOf('maybe'), 'unasked');
eq('what the options page saves: an address', C.readerChoiceFrom(STUDIO, 'unasked'), { ok: true, reader_url: STUDIO, reader_onboarding: 'external' });
eq('…an empty box is the Hub', C.readerChoiceFrom('', 'external'), { ok: true, reader_url: '', reader_onboarding: 'hub' });
eq('…an address that cannot be opened is refused and changes nothing', C.readerChoiceFrom('http://their.site/x', 'hub').ok, false);
{
  const mk = () => { const store = {}; return { store, get: (keys, cb) => { const out = {}; for (const k of keys) if (k in store) out[k] = store[k]; cb(out); }, set: (obj, cb) => { Object.assign(store, JSON.parse(JSON.stringify(obj))); cb && cb(); } }; };
  const area = mk();
  const first = await C.readConfig(area);
  eq('first run: no reader, nothing chosen', [first.reader_url, first.reader_onboarding], ['', 'unasked']);
  await C.writeConfig({ ...first, reader_url: STUDIO, reader_onboarding: C.onboardingMove('unasked', 'choose-external') }, area);
  const back = await C.readConfig(area);
  eq('the choice persists: the address and the state', [back.reader_url, back.reader_onboarding], [STUDIO, 'external']);
  await C.writeConfig({ ...back, reader_url: '', reader_onboarding: 'hub' }, area);
  eq('…and so does switching back', [(await C.readConfig(area)).reader_url, (await C.readConfig(area)).reader_onboarding], ['', 'hub']);
  // a hand-edited store never makes the icon open something that is not valid
  area.store[C.KEYS.readerUrl] = 'javascript:alert(1)';
  area.store[C.KEYS.onboarding] = 'maybe';
  eq('a bad stored value reads as empty, and the state as unasked', [(await C.readConfig(area)).reader_url, (await C.readConfig(area)).reader_onboarding], ['', 'unasked']);
  // a save that is about something else keeps the reader (writeConfig rewrites the whole block)
  await C.writeConfig({ ...back, reader_url: STUDIO, reader_onboarding: 'external' }, area);
  const other = await C.readConfig(area);
  await C.writeConfig({ ...other, handle: 'someone-else' }, area);
  eq('…a save of the handle keeps it', [(await C.readConfig(area)).reader_url, (await C.readConfig(area)).handle], [STUDIO, 'someone-else']);
}

// ---- the drawer's chooser -----------------------------------------------------------------------------
{
  const asked = [];
  const drawer = D.create({ cssText: '.panel{}', isTrusted: () => true, onModels: async () => ({ ok: true, current: {}, options: {} }),
    onReaderChoice: async c => { asked.push(c); return c.choice === 'external' && !/^https:/.test(c.url) ? { ok: false, error: 'That is not an address I can open' } : { ok: true }; } });
  drawer.setConn(true); drawer.setAuthor('reader');
  drawer.setPage({ url: 'https://example.com/a', title: 'T', threads: [], page_chat: [] });
  drawer.open('comments'); await tick(5);
  const pick = () => drawer.shadow.querySelector('.popover.readerpick');
  ok('the chooser is not there until asked for', pick().hidden && !drawer.readerChooserOpen());
  drawer.openReaderChooser();
  ok('asked: it is open, and says both things', !pick().hidden && drawer.readerChooserOpen() && /Use the built-in Hub/.test(pick().textContent) && /I already read blygs somewhere/.test(pick().textContent) && !!pick().querySelector('input.reader-input'));
  pick().querySelector('[data-act="reader-hub"]').click(); await tick(5);
  eq('"Use the built-in Hub" goes through the callback and closes the chooser', [asked.at(-1).choice, drawer.readerChooserOpen()], ['hub', false]);
  drawer.openReaderChooser();
  pick().querySelector('.reader-input').value = 'http://their.site/x';
  pick().querySelector('[data-act="reader-ext"]').click(); await tick(5);
  ok('an address that is refused stays open, with the reason', drawer.readerChooserOpen() && /not an address I can open/.test(pick().textContent));
  pick().querySelector('.reader-input').value = STUDIO;
  pick().querySelector('[data-act="reader-ext"]').click(); await tick(5);
  eq('a valid address is passed on, and the chooser closes', [asked.at(-1).choice, asked.at(-1).url, drawer.readerChooserOpen()], ['external', STUDIO, false]);
  eq('the pop-overs, named (the chooser is one of them)', D.POPOVERS.includes('reader'), true);
}

// ---- a page cannot choose for you ------------------------------------------------------------------------------
{
  // the drawer: a click a page made up (isTrusted false: every event a script dispatches) does not open a reader or change which one
  const asked = []; const opened = [];
  const drawer = D.create({ cssText: '.panel{}', onModels: async () => ({ ok: true, current: {}, options: {} }),
    onOpenFollowing: () => opened.push('icon'), onReaderChoice: async c => { asked.push(c); return { ok: true }; } });
  drawer.setConn(true); drawer.setAuthor('reader');
  drawer.setPage({ url: 'https://example.com/a', title: 'T', threads: [], page_chat: [] });
  drawer.open('comments'); await tick(5);
  drawer.openReaderChooser();
  const root = drawer.shadow;
  const click = sel => root.querySelector(sel).dispatchEvent(new w.Event('click', { bubbles: true, composed: true }));
  eq('the events a script dispatches are not trusted (the browser says so)', new w.Event('click').isTrusted === true, false);
  root.querySelector('.reader-input').value = STUDIO;
  click('[data-act="reader-ext"]'); click('[data-act="reader-hub"]'); click('[data-act="following"]'); await tick(5);
  eq('a made-up click on the chooser\'s buttons or the feed icon does nothing', [asked.length, opened.length, drawer.readerChooserOpen()], [0, 0, true]);
  const offers = C.createOffers(() => 1000);
  ok('background: no offer, refused', !offers.valid(7) && offers.spend(7) === false);
  offers.offer(7);
  ok('offered to a tab: valid for that tab only', offers.valid(7) && !offers.valid(8));
  ok('spent once: the second use is refused', offers.spend(7) === true && offers.spend(7) === false && !offers.valid(7));
  let t = 0; const timed = C.createOffers(() => t);
  timed.offer(3); t = C.OFFER_MS - 1; ok('valid until it lapses', timed.valid(3)); t = C.OFFER_MS + 1; ok('...and not after', !timed.valid(3) && timed.spend(3) === false);
  ok('a tab with no id gets no offer', (() => { const o = C.createOffers(() => 1); o.offer(null); o.offer(undefined); return !o.valid(null) && !o.valid(undefined); })());
  const bgs = ext('background.js');
  ok('background: a choice needs a valid offer for this tab, and spends it on success', /case 'reader-choice':[\s\S]*if \(!readerOffers\.valid\(tabId\)\) return \{ ok: false[\s\S]*readerOffers\.spend\(tabId\);[\s\S]*CFG\.writeConfig/.test(bgs));
  ok('background: the offer is made only when the answer is "choose"', /if \(action === 'choose'\) \{ readerOffers\.offer\(tabId\); return/.test(bgs));
}

// ---- the wiring ---------------------------------------------------------------------------------------------------
{
  const bg = ext('background.js'), content = ext('content.js'), options = ext('options.js'), html = ext('options.html');
  ok('background: the feed icon is decided by readerAction', /case 'open-reader':[\s\S]*CFG\.readerAction\(CONF, followed\)/.test(bg));
  ok('background: the chooser is offered only when the action says choose', /if \(action === 'choose'\) \{ readerOffers\.offer\(tabId\); return \{ ok: true, action, chooser: true \}; \}/.test(bg));
  ok('background: an external reader opens at readerTarget', /action === 'open-external' \? CFG\.readerTarget\(CONF\)\.url/.test(bg));
  ok('background: the answer is validated and remembered through the named moves', /case 'reader-choice':[\s\S]*CFG\.readerUrlOf\(msg\.url\)[\s\S]*CFG\.onboardingMove\(CONF\.reader_onboarding, 'choose-external'\)[\s\S]*CFG\.writeConfig/.test(bg));
  ok('content: the icon asks the background, and shows the chooser only when told to', /onOpenFollowing: async \(\) => \{ const r = await bg\(\{ t: 'open-reader' \}\); if \(r && r\.chooser\) drawer\.openReaderChooser\(\); \}/.test(content));
  ok('options: every save keeps the reader (writeConfig rewrites the whole block)', /reader_url: readerNow\.url,\s*\n\s*reader_onboarding: readerNow\.onboarding/.test(options));
  ok('options: the reader box, saved through the same validation, and the link follows it', /readerChoiceFrom\(rb\.value, readerNow\.onboarding\)/.test(options) && /CFG\.readerTarget\(cfg\)/.test(options) && /id="reader-url"/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { for (const f of failures) console.log('  \u00b7 ' + f); process.exit(1); }
process.exit(0);
