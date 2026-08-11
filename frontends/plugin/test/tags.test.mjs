// tags.test.mjs — a tag's color is its name.
//
//   node frontends/plugin/test/tags.test.mjs
//
// tagHue(name) is FNV-1a over the lowercased, trimmed name → a hue 0..359.
// There is no picker and no persistence: the name IS the color, so the whole
// feature rests on three facts asserted here —
//
//   1. the function is deterministic and normalizes the way tags themselves
//      are normalized (case-insensitively, whitespace-trimmed);
//   2. the drawer's copy and the phone's copy agree byte for byte (the
//      extension/server boundary means duplication, exactly as normUrl);
//   3. EVERY hue clears WCAG AA contrast under the theme constants both
//      stylesheets use, in light and in dark — a color scheme that is only
//      legible for lucky tag names is not a color scheme.
//
// Exit code is the number of failures.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// views.mjs imports store.mjs, which resolves its workspace at import time —
// a throwaway keeps even an accidental write out of the live .botference
process.env.BOTFERENCE_PROJECT_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bfp-tags-'));

const Drawer = createRequire(import.meta.url)(path.join(here, '..', 'extension', 'drawer.js'));
const views = await import(path.join(here, '..', 'views.mjs'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; return; }
  fail++;
  failures.push(name + (detail ? '\n      ' + detail : ''));
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want),
  'got  ' + JSON.stringify(got) + '\n      want ' + JSON.stringify(want));

const hue = Drawer.tagHue;

// ---- 1. the function ---------------------------------------------------------
eq('deterministic', hue('fluids'), hue('fluids'));
ok('a hue at all', Number.isInteger(hue('fluids')) && hue('fluids') >= 0 && hue('fluids') < 360);
eq('case never changes the color (tags dedupe case-insensitively)',
  hue('Fluids'), hue('fluids'));
eq('…nor does surrounding whitespace', hue('  fluids '), hue('fluids'));
ok('different names are (almost always) different colors',
  new Set(['fluids', 'turbulence', 'rail', 'drafts', 'chapter 3', 'control']
    .map(hue)).size >= 5);
eq('the empty name still answers a number, not NaN', typeof hue(''), 'number');
eq('…and so does a non-string', typeof hue(null), 'number');
ok('a multi-word tag hashes its words, spaces and all',
  hue('chapter 3') !== hue('chapter3'));

// ---- 2. the two copies agree --------------------------------------------------
{
  const names = ['fluids', 'Fluids', 'chapter 3', 'rail', 'δx', 'ενέργεια', '日本語',
    'a'.repeat(40), '#weird', 'x,y', ' spaced out ', ''];
  for (const n of names) {
    eq('drawer and phone agree on ' + JSON.stringify(n), views.tagHue(n), hue(n));
  }
}

// ---- 3. every hue is legible, in both themes ----------------------------------
// The stylesheets write text hsl(h 45% var(--tag-fg-l)) on hsl(h 55% --tag-bg-l):
// light = 30% on 93%, dark = 80% on 20% (drawer.css and views.mjs carry the
// same four constants). WCAG AA for the chips' small text is 4.5:1 — checked
// for ALL 360 hues, because a palette that fails only on certain names would
// fail silently in production.
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}
function luminance([r, g, b]) {
  const lin = c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(fg, bg) {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}
{
  const themes = [
    ['light', 30, 93],   // --tag-fg-l / --tag-bg-l
    ['dark', 80, 20],
  ];
  for (const [name, fgL, bgL] of themes) {
    let worst = Infinity, at = -1;
    for (let h = 0; h < 360; h++) {
      const c = contrast(hslToRgb(h, 45, fgL), hslToRgb(h, 55, bgL));
      if (c < worst) { worst = c; at = h; }
    }
    ok(`every hue clears WCAG AA in ${name} (worst ${worst.toFixed(2)}:1 at h=${at})`,
      worst >= 4.5, `worst ${worst} at hue ${at}`);
  }
}

// ---- 4. the phone actually wears it -------------------------------------------
{
  const index = {
    aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: {
      url: 'https://x.test/one', title: 'One', threads: 1, kind: 'article',
      tags: ['fluids', 'rail'], updated_at: '2026-08-10T00:00:00Z',
    },
  };
  const html = views.pagesView({ index, me: { owner: true, handle: 'angadh' }, snapshots: new Set() });
  ok('the tag rail carries each tag\'s own hue',
    html.includes(`style="--th:${hue('fluids')}"`) && html.includes(`style="--th:${hue('rail')}"`), html);
  const railAt = html.indexOf('rail tags');
  ok('…and the row chips carry the SAME hue as the rail (one tag, one color)',
    html.indexOf(`--th:${hue('fluids')}`, railAt) !== -1 &&
    html.lastIndexOf(`--th:${hue('fluids')}`) > html.indexOf(`--th:${hue('fluids')}`));
  const page = {
    url: 'https://x.test/one', title: 'One', site: 'x.test', tags: ['fluids'],
    threads: [], page_chat: [],
  };
  const pv = views.pageView({ page, key: 'a'.repeat(40), me: { owner: true, handle: 'angadh' }, notice: '', snapshot: false });
  ok('the conversation view\'s tag rail wears it too', pv.includes(`--th:${hue('fluids')}`), pv.slice(0, 400));
}

// ---- report -------------------------------------------------------------------
fs.rmSync(process.env.BOTFERENCE_PROJECT_ROOT, { recursive: true, force: true });
if (fail) {
  console.error('\nFAILED (' + fail + '):');
  for (const f of failures) console.error('  ✗ ' + f);
}
console.log((fail ? '✗' : '✓') + ' tags.test.mjs — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
