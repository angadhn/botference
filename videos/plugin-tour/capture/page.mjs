// The page the film is shot on.
//
// v1–v3 were shot on a RECREATION of somebody else's blog, and every line of
// prose in it had to be written here so the film never put words in a stranger's
// mouth. v4 is shot on the author's OWN post — https://angadh.com/whereVonBraunWheel
// — so the constraint inverts: nothing should be written here at all.
//
// capture/mirror-site.mjs loads the live page in the same browser engine the
// shoot uses and saves the site's own bytes into capture/site/ under the site's
// own paths: the 84KB stylesheet, the ET Book and Aniron faces, every figure,
// and the post-JavaScript DOM of the nav and the article. capture/serve.mjs
// serves that directory as the page's docroot. So the article under the drawer
// is not "close to" the real one — it is the real markup, the real stylesheet,
// the real drop cap, the real margin captions and the real link favicons.
//
// The three things this file adds are the three the shoot needs and a browsing
// reader would never notice:
//   1. a forced light scheme and an explicitly declared ::selection colour,
//      because Chromium takes its default selection colour from the HOST
//      MACHINE's accent — on the machine this was shot on, a lurid pink — and
//      the first action in the film is a reader dragging across a sentence;
//   2. the scroll-progress rail, which the site draws with its own script and
//      the film's scroll beat moves (mirror-site.mjs strips every script, so
//      the one that is part of the picture is handed back here);
//   3. nothing else.
//
// The two quotes below are imported by capture.mjs, serve.mjs and note.mjs, so
// the sentence the camera drags across, the anchor stored in the record and the
// blockquote in the exported note cannot drift apart. Both are lifted verbatim
// from the mirrored markup and asserted against it at import.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = path.join(HERE, 'site');

/**
 * The sentence the reader highlights on camera.
 *
 * It is the one place in a 3,400-word essay where the post states a number a
 * reader can check: a 75 m wheel, 3 rpm for lunar gravity, 5 rpm for Earth-like.
 * Artificial gravity is w^2 r, the arithmetic is one line, and the answer is
 * interesting — which is exactly the shape of question a margin comment with an
 * agent in it exists for.
 */
export const FOCUS_QUOTE =
  'For example, one of von Braun’s designs called for a massive 75 metre diameter wheel '
  + 'that generated lunar gravity if spun at 3 rpm and Earth-like gravity at 5 rpm';

/** The sentence the page's one pre-existing (resolved, sage-green) thread owns.
 *  Two sentences earlier, in the same paragraph: close enough that the film can
 *  hold both marks in one frame at the end, far enough that they never touch. */
export const GREEN_QUOTE =
  'Much like a ferris wheel, the wheel’s rotation could disorient astronauts if spun too fast.';

// ---------------------------------------------------------------------------
// The mirrored page
// ---------------------------------------------------------------------------
const ARTICLE_FILE = path.join(SITE_DIR, 'article.html');
if (!fs.existsSync(ARTICLE_FILE)) {
  throw new Error('capture/site/ is empty — run `node capture/mirror-site.mjs` first');
}

export const ARTICLE_HTML = fs.readFileSync(ARTICLE_FILE, 'utf8');

for (const q of [FOCUS_QUOTE, GREEN_QUOTE]) {
  if (!ARTICLE_HTML.includes(q)) {
    throw new Error(`the mirrored page no longer contains:\n  ${q}\n(re-run capture/mirror-site.mjs — the post was revised)`);
  }
}

export const MIRROR = JSON.parse(fs.readFileSync(path.join(SITE_DIR, 'mirror.json'), 'utf8'));

/** The page's own identity, as the record and the exported note will carry it. */
export const PAGE_URL = MIRROR.url;
export const PAGE_TITLE = 'Where is my von Braun wheel?';
export const PAGE_SITE = 'angadh.com';

/** The stylesheets the harness gets, in the order the live page loads them.
 *  The second is Font Awesome: the post's own CSS draws the little mark after
 *  every outbound link (a Wikipedia W, a red PDF page) as an FA glyph, and
 *  without it the article renders a row of tidy squares instead. */
export const SITE_STYLESHEETS = [
  '/styles.css',
  '/cdn/ajax/libs/font-awesome/6.5.1/css/all.min.css',
];

/** The one script from the site the film keeps: the progress rail the scroll moves. */
export const SITE_SCRIPTS = ['/assets/js/scroll-progress.js'];

/**
 * The colour the page is on. The live post paints nothing and sits on the
 * browser's white canvas; src/SiteLoop.tsx dips through this at the loop's
 * seam, so the join lands on the page's own ground rather than on a colour
 * chosen to look like it.
 */
export const PAPER = '#ffffff';

export const ARTICLE_CSS = `
  /* ---- the shoot's own three lines (capture/page.mjs) --------------------- */

  /* The post is a light page. Without this the harness's own "color-scheme:
     light dark" leaves Chrome free to pick the dark scheme's ::selection
     colour for the drag that opens the film. */
  html.forcelight, :root { color-scheme: light; }

  /* The live post paints no background at all — body and html are transparent
     and what you see is the browser's own white canvas. The harness paints its
     fixture paper (#fdfcfa) onto <body>, which is three points off and shows up
     as a seam against the drawer. Handing the canvas back is one line. */
  html { background: ${PAPER}; }
  body { background: transparent; }

  /* Chromium takes its default selection colour from the HOST MACHINE's accent
     — a strong pink on the machine this was shot on — so the first action in
     the film, a reader dragging across a sentence, painted it a colour a viewer
     would read as an error, and a different colour on the next person's laptop.
     A page may state its own selection colour and plenty do; this one states a
     neutral blue, so the drag looks like a drag on every machine and the yellow
     that follows it is unmistakably the extension's doing. */
  ::selection { background: rgba(122, 156, 196, .34); }

  /* The harness's own fixture styling, which would otherwise fight the site's
     stylesheet for the same elements. */
  article .dek { display: none; }
  .bar { display: none !important; }

  /* The site sets its own scrollbar nowhere, and the default macOS overlay bar
     flickers on and off through a scripted scroll. */
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: rgba(0,0,0,.16); border-radius: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
`;
