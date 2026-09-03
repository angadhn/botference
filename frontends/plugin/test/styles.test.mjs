// styles.test.mjs — the rule that the drawer may never paint without its
// styles, in frontends/plugin/extension/drawer.js.
//
//   node frontends/plugin/test/styles.test.mjs
//
// The bug this suite is the fence around: the drawer's markup goes into a
// shadow root, a shadow root's <link> DOES NOT block paint, and on a heavy
// single-page app (council.botference.com) the gap between "markup inserted"
// and "drawer.css arrived" was long enough to see — the whole drawer, every
// pane at once, drawn as raw text down the left of somebody's page. When the
// extension had been reloaded under the tab it never closed at all: getURL
// answered nothing, the old fallback href was a relative 'drawer.css', and an
// SPA answers its own index.html to that.
//
// Both halves of the fix are pure so they can be driven here with no DOM:
//   cssPlan       — where the styling comes from, decided before anything is
//                   put in the shadow root ('none' = do not mount at all)
//   makeStyleGate — nothing is visible until something confirms the styles
//
// No framework. Exit code is the number of failures.

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const D = require(path.join(here, '..', 'extension', 'drawer.js'));

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

// ---- cssPlan: where the styling is coming from ---------------------------

eq('text in hand is the plan — no link, no race',
  D.cssPlan({ cssText: 'body{}', cssUrl: 'chrome-extension://x/drawer.css' }), { mode: 'inline' });

eq('no text, a url: the link, and its href is the url',
  D.cssPlan({ cssUrl: 'chrome-extension://x/drawer.css' }),
  { mode: 'link', href: 'chrome-extension://x/drawer.css' });

eq('the harness’s relative url is a url like any other',
  D.cssPlan({ cssUrl: '../extension/drawer.css' }),
  { mode: 'link', href: '../extension/drawer.css' });

// This is the orphaned content script: getURL answered '' because there is no
// extension any more. The old code fell back to a relative 'drawer.css' here.
eq('nothing at all is a REFUSAL, not a fallback', D.cssPlan({ cssUrl: '' }), { mode: 'none' });
eq('…and so is no cssUrl key at all', D.cssPlan({}), { mode: 'none' });
eq('…and so is a call with no options', D.cssPlan(), { mode: 'none' });
eq('whitespace is not a stylesheet', D.cssPlan({ cssText: '   ', cssUrl: '  ' }), { mode: 'none' });
eq('…nor is a url object somebody passed by accident',
  D.cssPlan({ cssUrl: { href: 'x' } }), { mode: 'none' });
eq('an empty cssText falls through to the link',
  D.cssPlan({ cssText: '', cssUrl: 'u' }), { mode: 'link', href: 'u' });

// ---- makeStyleGate: nothing is seen until the styles are confirmed --------

function gate(withAsk) {
  const log = [];
  const g = D.makeStyleGate(
    () => log.push('show'), () => log.push('hide'),
    withAsk === false ? null : () => log.push('ask'));
  return { g, log };
}

{
  const { g, log } = gate();
  eq('the host is hidden before anything else happens', log, ['hide']);
  ok('…and the gate says so', g.ready === false && g.asked === false);
  ok('ok() opens it, once', g.ok() === true && g.ok() === false);
  eq('…and the host is shown exactly once', log, ['hide', 'show']);
}

{
  const { g, log } = gate();
  ok('fail() goes and asks for the text instead', g.fail() === true);
  eq('…and shows nothing while it does', log, ['hide', 'ask']);
  ok('…asking at most once', g.fail() === false);
  eq('…still nothing shown', log, ['hide', 'ask']);
  ok('…and the text arriving is what opens it', g.ok() === true && g.ready === true);
  eq('…now it is shown', log, ['hide', 'ask', 'show']);
}

{
  // the ordinary path: the link won, so the late text must not re-ask
  const { g, log } = gate();
  g.ok();
  ok('a gate already open never asks for a repair', g.fail() === false && g.asked === false);
  eq('…and nothing else happens to the host', log, ['hide', 'show']);
}

{
  // a page with no host to hide (the drawer refused to mount) must not throw
  const g = D.makeStyleGate(() => { throw new Error('no host'); },
    () => { throw new Error('no host'); }, null);
  ok('a host that will not be hidden is not a reason to paint', g.ready === false);
  ok('…and showing into nothing does not throw either', g.ok() === true);
}

{
  // fail() with nowhere to ask is still a refusal to show
  const { g, log } = gate(false);
  ok('fail() with no repair available is still not a reveal', g.fail() === true);
  eq('…and the host stays hidden', log, ['hide']);
}

ok('the wait before a silent link is chased up is a real number',
  typeof D.CSS_WAIT_MS === 'number' && D.CSS_WAIT_MS > 0 && D.CSS_WAIT_MS <= 5000);

// ---- and the stylesheet itself still says the thing the probe reads ------
// mount()'s last-resort check is "is .panel position:fixed?" — that is only
// true because drawer.css says so, and nothing else does.
{
  const fs = require('node:fs');
  const css = fs.readFileSync(path.join(here, '..', 'extension', 'drawer.css'), 'utf8');
  ok('drawer.css is what makes .panel fixed — the probe mount() falls back on',
    /\.panel\s*\{[^}]*position:\s*fixed/.test(css));
}

// ---- content.js keeps no relative fallback -------------------------------
// The exact line that made the failure permanent. A grep, because the option
// is passed into a DOM-shaped call this suite has no DOM for.
{
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(here, '..', 'extension', 'content.js'), 'utf8');
  ok('content.js never falls back to a relative drawer.css',
    !/cssUrl:[^\n]*\|\|\s*'drawer\.css'/.test(src));
  ok('…nor to a relative katex stylesheet',
    !/katexCssUrl:[^\n]*\|\|\s*'vendor/.test(src));
  ok('…and it hands the drawer a way to get the stylesheet as text',
    /onCssFail:\s*\(\)\s*=>\s*ensureCss\(\)/.test(src));
}

for (const f of failures) console.log('  ✗ ' + f);
console.log(`✓ styles.test.mjs — ${pass} passed, ${fail} failed`);
process.exit(fail);
