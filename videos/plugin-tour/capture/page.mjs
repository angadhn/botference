// The page the film is shot on.
//
// A reading tool has to be filmed on something worth reading, and the harness's
// own fixture is a made-up football report. So the camera sees a recreation of
// the Slate Star Codex reading experience for "Meditations on Moloch": the
// masthead, the night-sky banner, the nav rail, the warm paper and the serif
// column, close enough that anyone who has read the blog recognises the room.
//
// WHAT IS OURS AND WHAT IS NOT
//   - Every sentence of the body is written here, in this file. It is a
//     paraphrase of the essay's argument — the fish farms, the multipolar trap,
//     the naming of the pattern — and not one paragraph of the post's own text.
//   - Exactly one direct quotation appears, eight words long, marked as a
//     quotation on screen: "The opposite of a trap is a garden."
//   - Nothing quoted inside the essay (the Ginsberg lines it is built around)
//     appears anywhere.
//   - There is NO author byline. The date line stands where the blog's byline
//     stands, and stops at the date, because these sentences are not the
//     author's and a recreation must not put words in a real person's mouth.
//   - `url:` on the record (and therefore in the exported note) points at the
//     real essay, so a reader who follows it lands on the original.
//
// Both quotes below are also imported by capture.mjs and note.mjs, so the
// sentence the camera drags across, the anchor stored in the record, and the
// blockquote in the exported note cannot drift apart.

/** The sentence the reader highlights on camera. */
export const FOCUS_QUOTE =
  'Each competitor gains by defecting, and every one of them ends up worse off than if none of them had';

/** The sentence the page's one pre-existing (resolved, sage-green) thread owns. */
export const GREEN_QUOTE =
  'Every owner can do this arithmetic, and every owner knows the others can do it too.';

// A handful of stars, placed by hand so the banner renders identically on every
// machine — a random field would make two takes impossible to intercut.
const STARS = [
  [6, 22, 1.6, 0.85], [13, 61, 1.1, 0.55], [19, 34, 1.9, 0.9], [24, 74, 1.2, 0.6],
  [31, 18, 1.4, 0.75], [37, 52, 2.1, 0.95], [42, 81, 1.1, 0.5], [48, 29, 1.5, 0.8],
  [54, 66, 1.2, 0.6], [59, 41, 1.8, 0.85], [64, 15, 1.3, 0.7], [69, 71, 1.6, 0.8],
  [74, 37, 1.1, 0.5], [78, 58, 2.0, 0.9], [83, 24, 1.4, 0.75], [88, 68, 1.2, 0.6],
  [92, 44, 1.7, 0.85], [96, 19, 1.2, 0.55], [9, 47, 1.3, 0.65], [28, 88, 1.5, 0.7],
  [45, 12, 1.2, 0.6], [61, 86, 1.4, 0.7], [80, 90, 1.1, 0.5], [34, 66, 1.0, 0.45],
  [51, 44, 1.2, 0.55], [71, 52, 1.0, 0.45], [16, 79, 1.3, 0.6], [86, 47, 1.1, 0.5],
];

const starCss = STARS
  .map(([x, y, r, a]) =>
    `radial-gradient(${r}px ${r}px at ${x}% ${y}%, rgba(255,255,255,${a}) 0%, rgba(255,255,255,0) 100%)`)
  .join(',\n      ');

export const ARTICLE_CSS = `
  /* ---- the recreated reading experience (capture/page.mjs) ---------------- */
  /* A light blog says so. Without this the harness's own "color-scheme: light
     dark" leaves Chrome free to pick the dark scheme's ::selection colour, and
     the drag — the first action in the film — paints the sentence a lurid pink
     that no reader of this page in a real browser would ever see. */
  html.forcelight, :root {
    color-scheme: light;
    --pbg: #e9e2d2; --pfg: #262320; --pmuted: #7d7466; --pline: #ded5c2;
  }
  body {
    margin: 0;
    background: #e9e2d2;
    color: #262320;
    font: 19px/1.78 Georgia, "Iowan Old Style", Charter, ui-serif, serif;
  }
  /* Chromium takes its default selection colour from the HOST MACHINE's accent,
     which on the machine this was shot on is a strong pink — so the first
     action in the film, a reader dragging across a sentence, painted it a
     colour a viewer would read as an error, and a different colour on the next
     person's laptop. A page is allowed to state its own selection colour and
     plenty do; this one states a neutral blue, so the drag looks like a drag on
     every machine and the yellow that follows it is unmistakably the
     extension's doing rather than more of the same. */
  ::selection { background: rgba(122, 156, 196, .38); }
  /* Wide enough that the drawer pushing the page aside does not leave a
     hand's width of empty paper between the two — at 1004px the gutter was a
     third of every framing that had both of them in it. */
  .sscwrap { max-width: 1210px; margin: 0 auto; background: #fdfaf3;
    box-shadow: 0 0 0 1px rgba(0,0,0,.06), 0 2px 26px rgba(60,50,30,.10); }

  .ssc-mast { position: relative; height: 196px; overflow: hidden;
    background:
      ${starCss},
      linear-gradient(174deg, #0a1424 0%, #132339 42%, #24344c 78%, #3c4a60 100%);
    display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .ssc-mast h2 { margin: 0; font: 400 47px/1 Georgia, ui-serif, serif;
    letter-spacing: .13em; color: #f4f1e8; text-indent: .13em;
    text-shadow: 0 2px 18px rgba(0,0,0,.6); }
  .ssc-mast .tag { margin-top: 16px; font: 400 12.5px/1.5 Georgia, ui-serif, serif;
    letter-spacing: .19em; text-transform: uppercase; color: #b9c4d4; text-indent: .19em; }

  .ssc-nav { display: flex; justify-content: center; gap: 30px;
    border-bottom: 1px solid #e3dac6; padding: 13px 0 12px; background: #fdfaf3; }
  .ssc-nav span { font: 400 11.5px/1 Georgia, ui-serif, serif; letter-spacing: .15em;
    text-transform: uppercase; color: #8a7f6c; }
  .ssc-nav span.on { color: #3f5b7d; }

  article { max-width: 760px; margin: 0 auto; padding: 46px 22px 92px; }
  article h1 { font: 400 40px/1.18 Georgia, ui-serif, serif; color: #3f5b7d;
    margin: 0 0 14px; letter-spacing: -.005em; }
  article .posted { font: 400 12.5px/1.5 Georgia, ui-serif, serif; letter-spacing: .12em;
    text-transform: uppercase; color: #9a9081; margin: 0 0 34px;
    padding-bottom: 22px; border-bottom: 1px solid #ece3d0; }
  article .num { text-align: center; font: 400 21px/1 Georgia, ui-serif, serif;
    color: #6c6355; letter-spacing: .1em; margin: 40px 0 24px; }
  article p { margin: 0 0 1.24em; }
  article blockquote { margin: 1.5em 0; padding-left: 1.1rem;
    border-left: 3px solid #d9cfb8; color: #554e42; font-style: italic; }
  article .dek, article .byline { display: none; }
`;

const P = s => `  <p>${s}</p>`;

export const ARTICLE_HTML = `<div class="sscwrap">
  <header class="ssc-mast">
    <h2>SLATE STAR CODEX</h2>
    <div class="tag">In a mad world, all blogging is psychiatry blogging</div>
  </header>
  <nav class="ssc-nav">
    <span>Home</span><span>About</span><span>Archives</span><span class="on">Best Of</span>
    <span>Top Posts</span><span>Comments</span><span>Contact</span>
  </nav>
<article>
  <h1>Meditations on Moloch</h1>
  <p class="posted">Posted on 30 July 2014</p>

  <div class="num">I.</div>

${P('Start with the lake. Ten fish farms sit on it, and each one could install a filter that would keep its own waste out of the water. The filter is not cheap. A farm that installs one pays for water everybody else drinks; a farm that skips it, while the others pay, drinks the same clean water and keeps the money. Every owner can do this arithmetic, and every owner knows the others can do it too.')}

${P('So the filters do not go in, the lake goes bad, and not one person in the story ever wanted a bad lake. Each competitor gains by defecting, and every one of them ends up worse off than if none of them had.')}

  <div class="num">II.</div>

${P('The lake is not about fish. Once the shape is in your hand you find it wherever two parties are close enough to feel each other: advertising budgets that cancel out, hospitals tuned to the ranking rather than to the patient, laboratories publishing faster than they can check. The individually correct move is the collectively ruinous one, and everybody involved can see it perfectly well while they make it.')}

${P('That is what makes the trap worth a name of its own. It does not need a market, or a machine, or a villain. It needs competitors, an advantage that is scarce, and no way to make a promise stick.')}

  <div class="num">III.</div>

${P('So the essay gives the pattern a name and treats it as a thing with an appetite: not something anybody admires, only something everybody feeds, because the alternative is losing. Naming it is not mysticism. It is the difference between bad luck, which you endure, and a mechanism, which you can look at.')}

${P('Which is also why the answer is never an argument. You cannot talk a multipolar trap out of existence — everyone inside it already agrees with you and defects anyway. What breaks the shape has to come from outside it: a rule with teeth, a body that can coordinate, a technology that makes the promise enforceable.')}

  <blockquote>“The opposite of a trap is a garden.”</blockquote>

${P('Gardens are built, and then they are maintained, and that is the part nobody volunteers for.')}
</article>
</div>`;
