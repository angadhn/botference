// The dictation mic in the drawer's composers: tap to record, tap again to
// stop, the clip goes to the companion (onTranscribe) and the words land at
// the caret of THAT composer's box. happy-dom stands in for the browser, with
// a fake MediaRecorder and getUserMedia; the companion is two stubbed
// callbacks. The pure parts (mime choice, base64, caret splice) are checked
// on their own first.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const { GlobalWindow } = await import(path.join(here, '..', '..', '..', 'tests', 'node_modules', 'happy-dom', 'lib', 'index.js'));
const w = new GlobalWindow({ url: 'https://example.com/article' });
for (const k of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'DocumentFragment', 'navigator', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'MutationObserver', 'Event', 'KeyboardEvent', 'MouseEvent', 'Blob', 'FileReader', 'EventTarget', 'getSelection']) {
  if (!(k in globalThis) || k === 'window' || k === 'document' || k === 'navigator' || k === 'Blob' || k === 'FileReader') {
    // (Blob and FileReader must be the SAME realm's: node has a Blob of its own)
    try { globalThis[k] = w[k] ?? w; } catch (_) { Object.defineProperty(globalThis, k, { configurable: true, value: w[k] }); }
  }
}
const require = createRequire(import.meta.url);
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

let pass = 0, fail = 0; const failures = [];
const ok = (name, cond, detail) => { if (cond) pass++; else { fail++; failures.push(name + (detail ? '\n      ' + detail : '')); } };
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) return false; await tick(5); } return true; };

// ---- the pure parts -------------------------------------------------------
const MRof = supported => ({ isTypeSupported: m => supported.includes(m) });
ok('mime: webm/opus first when there is one', D.pickAudioMime(MRof(['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'])) === 'audio/webm;codecs=opus');
ok('mime: Safari gets mp4', D.pickAudioMime(MRof(['audio/mp4'])) === 'audio/mp4');
ok('mime: nothing known lets the browser choose', D.pickAudioMime(MRof([])) === '');
ok('mime: no MediaRecorder at all', D.pickAudioMime(undefined) === '');
ok('data URL payload', D.dataUrlPayload('data:audio/webm;codecs=opus;base64,QUJD') === 'QUJD');
const b64 = await D.blobToBase64(new w.Blob(['fake-audio'], { type: 'audio/mp4' }));
ok('blob to base64', Buffer.from(b64, 'base64').toString() === 'fake-audio', b64);
const sp = (v, a, b, t) => D.spliceDictation(v, a, b, t);
ok('splice: into an empty box', sp('', 0, 0, ' hello ').value === 'hello');
ok('splice: a space before when it would run on', JSON.stringify(sp('see', 3, 3, 'this')) === JSON.stringify({ value: 'see this', caret: 8 }));
ok('splice: spaces both sides mid-text', sp('beforeafter', 6, 6, 'mid').value === 'before mid after');
ok('splice: no doubled spaces', sp('before after', 7, 7, 'mid').value === 'before mid after');
ok('splice: replaces a selection', sp('keep DROP keep', 5, 9, 'new').value === 'keep new keep');
ok('splice: no caret means the end', sp('text', null, null, 'more').value === 'text more');
ok('refusal wording', D.micErrorText({ name: 'NotAllowedError' }) === 'microphone permission was refused');

// ---- the drawer, end to end ----------------------------------------------
const rec = { gum: 0, stopped: 0, mimes: [], started: 0 };
Object.defineProperty(w.navigator, 'mediaDevices', {
  configurable: true,
  value: { getUserMedia: async c => { rec.gum++; if (!c || c.audio !== true) throw new Error('bad constraints'); return { getTracks: () => [{ stop() { rec.stopped++; } }] }; } },
});
class FakeRecorder extends w.EventTarget {
  static isTypeSupported(m) { return m === 'audio/mp4'; }            // like iPhone Safari
  constructor(stream, o) { super(); this.mimeType = (o && o.mimeType) || ''; rec.mimes.push(this.mimeType); }
  start() { rec.started++; }
  stop() {
    const ev = new w.Event('dataavailable'); ev.data = new w.Blob(['fake-audio'], { type: 'audio/mp4' });
    this.dispatchEvent(ev);
    this.dispatchEvent(new w.Event('stop'));
  }
}
globalThis.MediaRecorder = w.MediaRecorder = FakeRecorder;

const calls = { status: 0, transcribe: [] };
let statusOk = true;
const drawer = D.create({
  cssText: '.panel{}',
  onTranscribeStatus: async () => { calls.status++; return statusOk ? { ok: true, model: 'm' } : { ok: false, reason: 'no model' }; },
  onTranscribe: async body => { calls.transcribe.push(body); return { ok: true, text: 'dictated words' }; },
});
drawer.open('chat');
drawer.setConn(true);
drawer.setPage({ url: 'https://example.com/article', title: 'Article', threads: [], page_chat: [] });
await tick(20);
const shadow = () => drawer.shadow || (drawer.host && drawer.host.shadowRoot) || w.document.querySelector('div').shadowRoot;
const root = shadow();
ok('the drawer mounted', !!root);
const composer = root && root.querySelector('.composer');
ok("a composer is drawn", !!composer, root && root.innerHTML.slice(0, 3000)); if (!composer) { console.log(failures.join("\n")); process.exit(1); }
const mic = () => composer && root.querySelector(`.composer[data-target="${composer.getAttribute('data-target')}"] button.mic`);
const box = () => root.querySelector(`.composer[data-target="${composer.getAttribute('data-target')}"] textarea`);
ok('status asked on open', calls.status >= 1);
ok('mic shows when the companion can transcribe', mic() && !mic().hidden);
ok('it sits before Send', mic() && mic().nextElementSibling && mic().nextElementSibling.classList.contains('send'));

box().value = 'before after';
box().setSelectionRange(6, 6);
mic().click();
ok('recording', await until(() => mic().classList.contains('recording')));
ok('getUserMedia once, with audio', rec.gum === 1);
ok('the recorder asked for the first supported type', rec.mimes.join() === 'audio/mp4', rec.mimes.join());
ok('hint says so', /recording… tap to stop/.test(composer.isConnected ? composer.textContent : root.textContent));
mic().click();
ok('clip sent', await until(() => calls.transcribe.length === 1));
const body = calls.transcribe[0] || {};
ok('as base64 with its mime', body.mime === 'audio/mp4' && Buffer.from(body.audio_b64 || '', 'base64').toString() === 'fake-audio', JSON.stringify(body));
ok('back to idle', await until(() => !mic().classList.contains('transcribing') && !mic().classList.contains('recording')));
ok('words at the caret', box().value === 'before dictated words after', box().value);
ok('microphone released', rec.stopped === 1);

// Esc while recording discards the clip
mic().click();
await until(() => mic().classList.contains('recording'));
box().dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
await tick(20);
ok('Esc stops the recording', !mic().classList.contains('recording'));
ok('and sends nothing', calls.transcribe.length === 1);
ok('the drawer stays open', drawer.isOpen());

// a refused microphone says so, in that composer's note line
w.navigator.mediaDevices.getUserMedia = async () => { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; };
mic().click();
ok('refusal is said', await until(() => /microphone permission was refused/.test(root.textContent)));

// a companion that cannot transcribe: no mic at the next opening
statusOk = false;
drawer.close();
await tick(2100);         // past the de-duplication window
drawer.open('chat');
ok('mic hidden when the companion cannot transcribe', await until(() => mic() && mic().hidden));

console.log(`mic: ${pass} passed, ${fail} failed`);
await w.happyDOM.close();
if (fail) { console.log('failures:\n  ' + failures.join('\n  ')); process.exit(1); }
process.exit(0);
