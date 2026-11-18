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
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
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

const calls = { transcribe: 0, saved: [] };
const drawer = D.create({
  cssText: '.panel{}',
  capabilities: { highlights: true, strike: true },
  onTranscribeStatus: async () => ({ ok: true, model: 'm' }),
  onTranscribe: async () => { calls.transcribe++; return { ok: true, text: 'spoken words' }; },
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

// Enter while recording: stops, does not send
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('Enter stops the recording', await until(() => !mic().classList.contains('recording')));
ok('…and the clip goes off', await until(() => calls.transcribe === 1));
ok('…and nothing was sent', calls.saved.length === 0);
ok('the words land in the box', await until(() => box() && box().value === 'spoken words'), box() && box().value);
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, composed: true }));
ok('Enter again sends them', await until(() => calls.saved.length === 1));
ok('…as a highlight with the words', calls.saved[0] && calls.saved[0].text === 'spoken words' && calls.saved[0].mark === 'highlight', JSON.stringify(calls.saved[0]));

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

console.log(`hotkeys: ${pass} passed, ${fail} failed`);
if (fail) { console.log(failures.map(f => '  ✗ ' + f).join('\n')); process.exit(1); }
process.exit(0);   // happy-dom keeps timers alive; the verdict is in
