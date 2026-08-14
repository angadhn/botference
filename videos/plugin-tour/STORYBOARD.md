# Discuss plugin tour — storyboard (v6: same wheel, now with a pulse)

TARGET ~94s, HARD CAP 105s. 1920×1080@30. Music realigns from edit.json.
ONE page, ONE focus thread, one story. v6 answers the three notes on the
v5 cut, and each is now a standing rule (rules 3, 4 and 5 below). The v5
wins — phone legibility, long readable holds, the honest handoff — are
rules 1, 2 and 6 and MUST NOT regress.

## Rule 1 — Mobile-first legibility (v5, kept)
The film must work on a phone. That is enforced three ways:
- The take is shot at 1280×720 CSS with deviceScaleFactor 1.5, so every
  frame is still 1920×1080 but every pixel of UI is 1.5× larger than v4.
- Labels are 40px and short; the hook's kicker is 46px; the url line 38px.
- VERIFIED, not assumed: every beat's still is checked at full size AND
  downscaled to ~400px wide; the focal text of the beat (the question
  being typed, the numbers in Claude's answer, the Run button, the ✓,
  the export chooser, every label, botference.com) must be readable at
  phone scale.

## Rule 2 — Long readable holds (v5, kept)
Pace comes from the PERFORMANCE — typing at 30cps, real holds on every
payoff — not from cutting harder. Claude's bullets, the plot, the digest
and the green pair each hold long enough to actually read at phone scale.

## Rule 3 — The motivated camera (v6, from note 2)
**The camera only moves when something on screen moves it.** A move must
be aimed at a measured action mark in footage/shots.json — something
appearing, being clicked, or being typed — and the file says which mark.
If no action justifies a move, the camera HOLDS, locked. v5's slow creeps
(1.48→1.52 across a spinner, 1.02→1.08 across a held plot) are exactly
the moves this rule deletes. v6 has six motivated moves in the whole
film: the push onto the drag, the push into the composer, the release
that reveals Claude's bullets, the push-before-the-click + release-on-
the-figure at Run, the push riding the cursor to the ✓, the release when
the digest lands, and the push when the export chooser opens. Everything
else is a locked frame. The re-anchor between halves is a hard CUT to a
wide, not a zoom out.
Corollary: a locked camera on a still screen is dead air, so the footage
carries the life first — capture.mjs restHold() lets the resting hand
drift a few px each second, the way a real hand does. Where a LONG
reading hold still trips freezedetect (a resting hand and a fading label
both sit under its per-frame threshold), the hold carries a
sub-perceptual pan of ~4px/s — the hook card's own anti-freeze trick, an
order of magnitude below the zooms note 2 was about — declared in
edit.json as exactly that. Never a move a viewer can perceive.

## Rule 4 — Cuts on the beat (v6, from note 3)
The score runs at 100 BPM: a quarter-note is EXACTLY 18 frames at 30fps,
and every scene duration in edit.json is a multiple of 18. So every cut
lands ON a beat, and (since a movement's chords are anchored to its first
cut) chords land ON cuts. The lock is arithmetic — change a duration to a
non-multiple of 18 and you have broken this rule.

## Rule 5 — The voice (v6, from note 3: "go crazy")
The film has a narrator, and the narrator has a case to close. The story
is a tiny detective plot, honestly earned — the post really does state a
wrong number, Claude really proves it, Codex really brings the plot:
  hook kicker  "The commenters check your math."
  highlight    "This number smells wrong."      ← the case opens
  handoff      "Claude tags in Codex."
  run          "Yes, it actually runs."
  plot         "Receipts."
  resolve      "Case closed."
  digest       "It writes the minutes, too."
  exported     "Off to your vault."
  note         "The case file, in Obsidian."    ← the case files itself
Labels stay 40px, ~2s, NEXT TO the action (never top-of-frame — v3's
rule, kept). Two payoffs get a musical wink, declared in edit.json and
read by compose.mjs: 'tada' (two rising bells) as the plot lands full
screen, 'done' (a falling fifth on the marimba) on the ✓. The score
itself carries the swagger: felt piano and marimba as before, but with a
walking bass, a backbeat tick, swung offbeats and a shaker that arrives
with the Run movement — the film's "drop" is the code cell running.
Energy lives in cuts, copy and music. NEVER in camera motion (rule 3).

## Rule 6 — The honest handoff (v5, kept)
bridge-system-prompt.md rule 6 forbids a bot summoning its counterpart;
server.mjs only summons on a person's message. The shipped drawer DOES
render Claude's own room-protocol footer as a chip — "answered · 3 rpm is
Mars, not the Moon · over to @codex" (drawer.js envRow/ENV_NEXT). So the
film shows the chip, names it, and the READER ratifies the handoff by
typing @codex. Agents communicating, human routing — the shipped truth.

## Rule 7 — The export is shown (v6, from note 1)
The film may not teleport the note into Obsidian. The take performs the
shipped affordance end to end: the drawer header's Obsidian crystal
(drawer.js shell(), data-act="export") → the two-row chooser
(paintExportPick: "Comments only" / "Everything") → the click on
Everything → the footbar printing the vault path the companion answered
with ("exported → /Users/angadh/Vault/Web Clippings/…"). Only THEN the
Obsidian frame. After this a viewer can say: "I click the crystal and
it's in my vault."

## The page — the real thing
The user's OWN blog post: https://angadh.com/whereVonBraunWheel —
mirrored byte-for-byte by capture/mirror-site.mjs (verified by
npm run compare). The film loads the actual post and scrolls to the
passage; the scroll is part of the film's honesty. The wine-glass video
mid-page is the post's real embed — keep.

## Page state throughout
EXACTLY TWO comments: one pre-existing RESOLVED thread (sage-green
highlight, never opened) two sentences above; the focus thread created on
camera. Page chat empty.

## Beats (targets; exact cuts live in edit.json, cued off measured marks)
1.  Hook (0:00–0:04) — dark serif card: "Google-Docs comments, on any
    blog." + kicker in the accent colour: "The commenters check your
    math." Hard cut out on the downbeat that brings the bass in.
2.  The page (0:04–0:10) — post loads at the top, real title and byline;
    a reader's eased scroll down. Camera locked at 1.0; the scroll is
    the motion.
3.  Highlight (0:10–0:15) — push in ON the drag; the pill; the case-
    opening label. The sage-green resolved mark is in the same shot.
4.  Compose (0:15–0:22) — drawer arrives (beat wide), push into the
    composer, then locked while "@claude 3 rpm on a 75 m wheel — is that
    really lunar gravity?" is typed at reading speed.
5.  Claude thinks (0:22–0:24) — locked tight on the working chip.
6.  Claude answers (0:24–0:30) — tight on the arriving words, release
    as the reply lands, locked on the two bullets (0.38 g = Mars).
7.  The handoff (0:30–0:33) — Claude's own footer chip; label names it.
8.  Breather (0:33–0:35) — hard CUT to a locked wide. Re-anchor.
9.  The reader routes (0:35–0:39) — "@codex plot gravity vs radius at 2,
    3 and 5 rpm?" typed into the same composer. Locked.
10. Codex thinks (0:39–0:41) — same chip, other agent, same framing.
11. The code cell (0:41–0:44) — the runnable python block scrolls to
    centre inside a locked frame.
12. Run (0:44–0:48) — push BEFORE the click; "✓ ran · 214 ms"; release
    cued to the figure painting. Label: "Yes, it actually runs."
13. The plot (0:48–0:52) — lightbox, full size, locked at 1.0; 'tada'
    sting on the cut; "Receipts." in the corner.
14. Resolve (0:52–0:56) — push rides the cursor to the ✓; 'done' sting
    on the click; "Case closed."; the card files, Resolved (2).
15. Digest (0:56–1:02) — archive open, the written summary lands over
    the placeholder; release cued to the landing; corner label.
16. Green (1:02–1:06) — both passages sage green, two sentences apart;
    locked left-flush at 1.52; drawer fully out of frame.
17. Export (1:06–1:11) — the cursor climbs to the Obsidian crystal; the
    chooser opens (push cued to the click); "Everything" is picked.
18. Exported (1:11–1:14) — locked on the drawer's foot: "exported →
    /Users/angadh/Vault/Web Clippings/Where is my von Braun wheel?.md".
    Label: "Off to your vault."
19. The vault (1:14–1:26) — the note in the faithful Obsidian frame
    (dark reading view, ribbon, file tree with the note + attachment;
    body is export.mjs renderNote() verbatim). Two held framings, hard
    cut between head and foot. Label closes the arc.
20. Close (1:26–1:34) — braid fuses to "the plan"; "botference Discuss ·
    botference.com" + one tag line of brand voice + QR (≥240px symbol,
    quiet zone, ≥3s still, decode-verified from a rendered frame).

## Rules that survive from earlier cuts
- Real drawer UI (shipped extension via the harness rig); the page is
  the mirrored live site, compared against the live one (2 known diffs:
  the white-canvas patch in page.mjs, docHeight wobble from the embed).
- Labels hang off MEASURED boxes (capture marks), never top-of-frame.
- Exactly-two-comments page state; faithful Obsidian frame on export.
- QR ≥240px, decode-verified. Cursor calm; dials get their own shots.
- Every beat verifiable from stills: entry, action, payoff — at desktop
  AND phone scale.
- Site loop: recut from the take, 10–14s, muted, ≤3MB each, seamless.
