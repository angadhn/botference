// The PDF hotkeys' half that lives in the drawer: beginNew(anchor, opts).
// `dictate` turns the microphone on for the new composer as soon as it is
// drawn, `route: 'all'` sets the pill row to the agents before the card is
// rendered, and Enter while the microphone records STOPS it rather than
// sending the box without its words. happy-dom, a fake MediaRecorder, two
// stubbed companion callbacks — the same stand-ins as mic.test.mjs.
//
//   node frontends/plugin/test/hotkeys.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/paper.pdf' });
// every one of these comes from happy-dom's realm, Event included: the drawer
// dispatches `new Event('input')` into happy-dom's textarea, which refuses a
// Node-realm Event ("parameter 1 is not of type 'Event'")
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection']) {
  try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await tick(5); } return true; };

const rec = { gum: 0, stopped: 0, started: 0 };
Object.defineProperty(w.navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async () => { rec.gum++; return { getTracks: () => [{ stop() { rec.stopped++; } }] }; } },
});
class FakeRecorder extends w.EventTarget {
  static isTypeSupported(m) { return m === 'audio/mp4'; }
  constructor(stream, o) { super(); this.mimeType = (o && o.mimeType) || ''; }
  start() { rec.started++; }
  stop() {
    const ev = new w.Event('dataavailable'); ev.data = new w.Blob(['fake-audio'], { type: 'audio/mp4' });
    this.dispatchEvent(ev);
    this.dispatchEvent(new w.Event('stop'));
  }
}
globalThis.MediaRecorder = w.MediaRecorder = FakeRecorder;

const calls = { transcribe: 0, saved: [], tidy: [] };
// what whisper "hears" next, and what the tidy bot answers
let heard = 'spoken words';
let tidied = { ok: true, text: 'Terse.' };
const drawer = D.create({
  cssText: '.panel{}',
  capabilities: { highlights: true, strike: true },
  onTranscribeStatus: async () => ({ ok: true, model: 'm' }),
  onTranscribe: async () => { calls.transcribe++; return { ok: true, text: heard }; },
  onTidy: async b => { calls.tidy.push(b); return tidied; },
  onSave: async t => { calls.saved.push(t); return { ok: true, id: 't' + calls.saved.length }; },
});
drawer.setConn(true);
drawer.setPage({ url: 'https://example.com/paper.pdf', title: 'Paper', threads: [], page_chat: [] });
await tick(20);
// the drawer mounts on its first beginNew, so the shadow root is read late
const root = () => drawer.shadow || (drawer.host && drawer.host.shadowRoot) || null;
const anchor = { quote: 'a passage of the paper', prefix: '', suffix: '' };
const card = () => root() && root().querySelector('.card.pending');
const mic = () => card() && card().querySelector('button.mic');
const box = () => card() && card().querySelector('textarea');
const routeOn = () => { const b = card() && card().querySelector('[data-act="route"].on, [data-act="route"][aria-pressed="true"], [data-act="route"].active'); return b ? b.dataset.route : ''; };

// ---- C: a note, dictated ---------------------------------------------------
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
ok('C: the pending card is drawn', await until(() => !!card()));
ok('C: the microphone is on without a tap', await until(() => mic() && mic().classList.contains('recording')));
ok('C: it asked for the microphone once', rec.gum === 1);
ok('C: a note, not a bot', routeOn() !== 'all', routeOn());

// Enter while recording: finishes — the words land and are sent, no second Enter
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('Enter stops the recording', await until(() => !mic().classList.contains('recording')));
ok('…and the clip goes off', await until(() => calls.transcribe === 1));
ok('…and the words are sent', await until(() => calls.saved.length === 1));
ok('…as a highlight with the words', calls.saved[0] && calls.saved[0].text === 'spoken words' && calls.saved[0].mark === 'highlight', JSON.stringify(calls.saved[0]));
await tick(20);
ok('…and the card is gone', !card());

// ---- A: the same, routed to the agents ------------------------------------
await tick(20);
drawer.beginNew({ ...anchor, mark: 'highlight' }, { route: 'all', dictate: true });
ok('A: the card is drawn', await until(() => !!card()));
ok('A: recording', await until(() => mic() && mic().classList.contains('recording')));
mic().click();
ok('A: words arrive', await until(() => box() && box().value === 'spoken words'));
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('A: sent', await until(() => calls.saved.length === 2));
ok('A: routed to all', calls.saved[1] && /^all$|^@all$/.test(String(calls.saved[1].route || '')), JSON.stringify(calls.saved[1]));

// ---- S: a strike, dictated; an empty send still files it -----------------
await tick(20);
drawer.beginNew({ ...anchor, mark: 'strike' }, { dictate: true });
ok('S: the card is a strike', await until(() => card() && card().classList.contains('struck')));
ok('S: recording', await until(() => mic() && mic().classList.contains('recording')));
ok('S: not routed to the bots', routeOn() !== 'all', routeOn());
// Esc throws the clip away; the box is empty; Enter files the bare strike
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
ok('S: Esc stops it', await until(() => !mic().classList.contains('recording')));
await tick(20);
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('S: an empty Enter files the strike', await until(() => calls.saved.length === 3));
ok('S: as a strike with no note', calls.saved[2] && calls.saved[2].mark === 'strike' && !calls.saved[2].text, JSON.stringify(calls.saved[2]));

// ---- the pill's own click path is unchanged ------------------------------
await tick(20);
drawer.beginNew({ ...anchor, mark: 'highlight' });
ok('pill: the card is drawn', await until(() => !!card()));
await tick(30);
ok('pill: the microphone stays off', !(mic() && mic().classList.contains('recording')));
ok('pill: no extra microphone request', rec.gum === 3, String(rec.gum));
ok('every stream was released', rec.stopped === 3, String(rec.stopped));
ok('short dictations were never sent to be tidied', calls.tidy.length === 0, String(calls.tidy.length));
drawer.cancelNew();

// ---- the letter again FINISHES: the words land, made terse, and are sent --
const RAMBLE = 'so um what I want to say here is that the claim about the trains running full is '
  + 'not really supported there is no source for the load factor and also maybe we should cite '
  + 'the 2024 Eurostat figures and yeah that is basically my point I think';
heard = RAMBLE;
tidied = { ok: true, text: 'The full-trains claim has no source for the load factor; cite the 2024 Eurostat figures.' };
await tick(20);
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
ok('finish: recording', await until(() => mic() && mic().classList.contains('recording')));
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', bubbles: true, composed: true }));
ok('finish: C in the box stops the recording', await until(() => !mic().classList.contains('recording')));
ok('finish: the bot is asked, with the words', await until(() => calls.tidy.length === 1) && calls.tidy[0].text === RAMBLE && calls.tidy[0].target === '__new__', JSON.stringify(calls.tidy[0]));
ok('finish: the terse version is sent, no Enter needed', await until(() => calls.saved.length === 4) && calls.saved[3].text === tidied.text, JSON.stringify(calls.saved[3]));
await tick(20);
ok('finish: the card is gone', !card());

// ---- the mic tap KEEPS: the words land, the raw ones are one click away --
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
ok('keep: recording', await until(() => mic() && mic().classList.contains('recording')));
mic().click();
ok('keep: the terse version lands', await until(() => box() && box().value === tidied.text), box() && box().value);
const swap = () => card() && card().querySelector('.dictswap');
ok('keep: a swap pill offers the words as spoken', await until(() => swap() && /as spoken/.test(swap().textContent)),
  card() && card().querySelector('.crow') && card().querySelector('.crow').innerHTML.slice(0, 400));
if (swap()) swap().click();
ok('swap: the raw words are back', await until(() => box() && box().value === RAMBLE), box() && box().value);
ok('swap: …and the pill now offers the terse one', swap() && /terse/.test(swap().textContent));
if (swap()) swap().click();
ok('swap: and back again', await until(() => box() && box().value === tidied.text));
ok('keep: nothing was sent on its own', calls.saved.length === 4);
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('keep: Enter sends as shown', await until(() => calls.saved.length === 5) && calls.saved[4].text === tidied.text);
await tick(20);
ok('keep: the pill is gone with the send', !swap());

// a bot that fails leaves the raw words, with a quiet note
tidied = { ok: false, error: 'the agent took too long' };
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
mic().click();
ok('tidy failed: the raw words land anyway', await until(() => box() && box().value === RAMBLE), box() && box().value);
ok('tidy failed: no swap pill', !swap());
ok('tidy failed: the note says so', /kept your words as spoken/.test(root().textContent));
drawer.cancelNew();

// the page's own finish (content.js, focus elsewhere): short words, sent
heard = 'spoken words'; tidied = { ok: true, text: 'Terse.' };
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
ok('a cancelled comment\'s words do not come back in the next one', box() && box().value === '', box() && box().value);
ok('stopDictation finishes a recording', drawer.stopDictation() === true);
ok('…and the words are sent', await until(() => calls.saved.length === 6) && calls.saved[5].text === 'spoken words', JSON.stringify(calls.saved[5]));
ok('…and says so when there is none', drawer.stopDictation() === false);

// ---- nothing said: a finish adds nothing -----------------------------------
heard = '';
drawer.beginNew({ ...anchor, mark: 'strike' }, { dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 's', bubbles: true, composed: true }));
ok('S, nothing said, S: the strike is filed bare', await until(() => calls.saved.length === 7) && calls.saved[6].mark === 'strike' && !calls.saved[6].text, JSON.stringify(calls.saved[6]));
await tick(20);
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'c', bubbles: true, composed: true }));
ok('C, nothing said, C: the highlight is let go', await until(() => !card()));
ok('…and nothing was filed', calls.saved.length === 7);
drawer.beginNew({ ...anchor, mark: 'highlight' }, { route: 'all', dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
ok('A, nothing said, A on the page: let go', drawer.stopDictation() === true && await until(() => !card()));
ok('…and no agent was called', calls.saved.length === 7);
// …while the mic tap with nothing said keeps the box and says why
drawer.beginNew({ ...anchor, mark: 'highlight' }, { dictate: true });
await until(() => mic() && mic().classList.contains('recording'));
mic().click();
ok('tap, nothing said: the box stays, with the note', await until(() => /no speech was heard/.test(root().textContent)) && !!card());
drawer.cancelNew();

console.log(`hotkeys: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map(f => '  ✗ ' + f).join('\n')); process.exit(1); }
process.exit(0);   // happy-dom keeps timers alive; the verdict is in
