# Discuss plugin tour — storyboard (v5: the same wheel, told at walking pace)

TARGET ~95s, HARD CAP 105s. 1920×1080@30. Music realigns from edit.json.
ONE page, ONE focus thread, one story — the v4 story, retold so a
first-time viewer can follow it. The v4 note back was exact: 40 seconds
moved too fast, and on a phone the text could not be read. Both fixes are
structural, not cosmetic, and they are rules 1 and 2 below.

## Rule 1 — Mobile-first legibility
The film must work on a phone. That is enforced three ways:
- The take is shot at 1280×720 CSS with deviceScaleFactor 1.5, so every
  frame is still 1920×1080 but every pixel of UI is 1.5× larger than v4.
  Combined with the camera (≤1.55×) the drawer's type reaches ~2.3× v4.
- Labels are set at 40px (v4: 27px) and kept short.
- VERIFIED, not assumed: every beat's still is checked at full size AND
  downscaled to ~400px wide; the focal text of the beat (the question
  being typed, the numbers in Claude's answer, the Run button, the ✓,
  every label, botference.com) must be readable at phone scale.

## Rule 2 — The zoom rhythm
Deliberate zoom-in / zoom-out, never a static wide frame and never a
tight crop a viewer can't place. Each beat breathes the same way:
ESTABLISH (wide enough to see where you are on the page) → PUSH IN hard
on the one thing happening → HOLD long enough to actually read it →
RELEASE (pull back or hard cut to a wider re-establishing frame before
the next thing happens). Two dedicated wide "breather" shots re-anchor
the viewer mid-film: after Claude's answer, and after the plot.

## The page — the real thing
The user's OWN blog post: https://angadh.com/whereVonBraunWheel —
mirrored byte-for-byte by capture/mirror-site.mjs (verified by
npm run compare). The film loads the actual post and scrolls to the
passage; the scroll is part of the film's honesty.

## Agent-to-agent communication (new in v5)
The product truth, checked against the shipped code:
- bridge-system-prompt.md rule 6 forbids a bot @-tagging its counterpart
  to summon it, and server.mjs only ever summons on a message a PERSON
  posted. A film of Codex being summoned BY Claude would be a film of
  something the product refuses to do. The reader keeps the routing.
- But the shipped drawer DOES render a bot handing off: drawer.js lifts
  the room-protocol footer {"status","summary","next"} out of a reply
  and draws it as a quiet chip — status dot, summary, "over to @codex"
  (drawer.js envRow / ENV_NEXT). That is real UI, filmed as-is.
So the v5 beat is: Claude's reply ends with its own footer naming
@codex as next → the drawer renders the handoff chip → the camera lands
on it (label: "Claude hands this to Codex.") → the reader ratifies the
handoff by tagging @codex → Codex picks it up. Agents communicating,
human routing — which is exactly the shipped behaviour.

## On-screen text
MINIMAL, placed WHERE THE ACTION IS — never top-of-frame, never covering
the element it names (v3's note, kept). A label is a short flash of 40px
type next to the action, ~2s, then gone; fallback position is the
bottom-right corner. Beats that read on their own get none. The must-have
labels: the highlight beat, the handoff chip, the Run beat, "Export to
Obsidian".

## Page state throughout
EXACTLY TWO comments: one pre-existing RESOLVED thread (sage-green
highlight, never opened) two sentences above; the focus thread created on
camera. Page chat empty.

## Beats (targets; exact cuts live in edit.json, cued off measured marks)
1. Hook card (0:00–0:04) — dark serif card: "Google-Docs comments on any
   blog — with agents in the thread." Hard cut out.
2. The page (0:04–0:09) — post loads at the top, real title and byline;
   a reader's eased scroll down to the passage. Wide; the scroll is the
   motion.
3. Highlight (0:09–0:15) — push in ON the drag; the pill; label. The
   sage-green resolved mark is in the same shot on purpose.
4. Compose (0:15–0:24) — drawer arrives (brief wide to establish page +
   drawer together), then push into the composer as "@claude 3 rpm on a
   75 m wheel — is that really lunar gravity?" is typed at reading speed.
5. Claude thinks (0:24–0:27) — tight on the working chip, claude's ring.
6. Claude answers (0:27–0:34) — the two bullets (0.38 g = Mars, not the
   Moon), held long enough to read at phone scale.
7. The handoff (0:34–0:38) — Claude's own footer chip: "answered ·
   3 rpm is Mars, not the Moon · over to @codex". Label names it.
8. Breather (0:38–0:41) — pull wide: the page, the highlight, the open
   drawer. Re-establish before the second half.
9. The reader routes (0:41–0:46) — "@codex plot gravity vs radius at 2,
   3 and 5 rpm?" typed into the same composer.
10. Codex thinks (0:46–0:49) — same chip, other agent, same framing.
11. The code cell (0:49–0:54) — Codex's reply with the runnable python
    block, framed low on the card.
12. Run (0:54–1:00) — tightest framing in the film; push BEFORE the
    click; "✓ ran · 214 ms"; the figure paints. Label: "Code cells run."
13. The plot (1:00–1:05) — lightbox, full size; the axes are the label.
14. Resolve (1:05–1:10) — ✓, the card files, Resolved (2).
15. Digest (1:10–1:17) — archive open, the written summary lands over
    the placeholder; long enough to read four lines.
16. Green (1:17–1:21) — both passages sage green, two sentences apart;
    drawer fully out of frame.
17. Export (1:21–1:32) — the note in a faithful Obsidian frame (dark
    reading view, ribbon, file tree with the note + attachment, tab
    strip; body is export.mjs renderNote() verbatim). Two held framings,
    hard cut between head and foot. Label: "Export to Obsidian."
18. Close (1:32–1:39) — braid fuses to "the plan"; "botference Discuss ·
    botference.com" + QR (≥240px symbol, quiet zone, ≥3s still,
    decode-verified from a rendered frame).

## Rules that survive from v4
- Real drawer UI (shipped extension via the harness rig); the page is
  the mirrored live site, compared against the live one.
- Labels hang off MEASURED boxes (capture marks), never top-of-frame.
- Exactly-two-comments page state; faithful Obsidian frame on export.
- QR ≥240px, decode-verified. Cursor calm; dials get their own shots.
- Cuts carry pace — but v5 pace comes from the PERFORMANCE (typing at
  ~30cps, real holds), not from cutting harder.
- Every beat verifiable from stills: entry, action, payoff — at desktop
  AND phone scale.
- Site loop: recut from the new take, 10–14s, muted, ≤3MB each, seamless.
