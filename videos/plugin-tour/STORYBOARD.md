# Discuss plugin tour — storyboard (v4: the von Braun wheel cut)

HARD CAP 45s, target ~38s. 1920×1080@30. Music realigns from edit.json.
ONE page, ONE focus thread, one story.

## The page — the real thing this time
The user's OWN blog post: https://angadh.com/whereVonBraunWheel
Be faithful to the site: fetch the real page, reproduce its actual
styling/layout/typography exactly (it is the user's own content — real
title, real byline, real prose, no paraphrasing needed). The film may
LOAD the actual post and SCROLL to the passage being commented on —
the scroll is part of the film's honesty.

## On-screen text
MINIMAL, and placed WHERE THE ACTION IS — the user found top-of-screen
labels pulled their eyes away from the thing happening. Rules:
- A label is a small flash of text NEXT TO the action it names (near
  the highlight as it lands, near the Run button as it's clicked,
  near the ✓ as it files), appearing ~1.5s, then gone. Small, quiet,
  never covering the element it points at.
- If a beat reads clearly without a label, it gets NO label. The only
  must-have: "Export to Obsidian" on the export beat.
- Fallback position when near-action placement would cover something:
  BOTTOM-RIGHT corner, never top-center, never top-of-frame.
(Bot-to-bot summoning is deferred — the reader tags @codex; council
already has it, the plugin will follow.)

## Page state throughout
EXACTLY TWO comments: one pre-existing RESOLVED thread (sage-green
highlight, never opened) somewhere visible; the focus thread created
on camera at a passage where a question is natural.

## Beat 1 — Hook card (0:00–0:03)
Dark serif card: "Google-Docs comments on any blog — with agents in
the thread." Cut.

## Beat 2 — The thread (0:03–0:21)
Page loads (or is already up) → SCROLL to the chosen passage (a beat
of real reading motion, ~1.5s) → highlight → comment "@claude ..." (a
genuine question about that passage — e.g. about spin rate, artificial
gravity, or Coriolis comfort limits, whatever the actual text supports)
→ Claude's real thinking dial → Claude reply (substantive, on-topic,
grounded in the post's actual content) → reader tags "@codex plot
artificial gravity vs radius at a few rpm?" (adapt to what the passage
actually discusses) → Codex dial → Codex reply with runnable code cell
→ run → real matplotlib plot.

## Beat 3 — Resolve (0:21–0:28)
✓ → Resolved (2) → digest card, written on-topic summary → highlight
flips sage green.

## Beat 4 — The export (0:28–0:34)
The exported note shown INSIDE A FAITHFUL OBSIDIAN FRAME — the user
liked the first attempt's Obsidian facsimile and missed it in the
second cut. Recreate the Obsidian reading view properly: dark theme,
left sidebar with a small vault file tree (the note highlighted in
it), tab strip, the note title, Obsidian's typography. The note BODY
is the real export.mjs renderNote() output for this thread (quote,
exchange, plot image, resolved-by). Label: "Export to Obsidian".

## Beat 5 — Close (0:32–0:37)
Braid fuses to "the plan". "botference Discuss · botference.com" +
QR to https://botference.com (≥240px symbol, quiet zone, ≥2.5s,
decode-verified from a rendered frame).

## Rules
- Real drawer UI (shipped extension via the harness rig).
- The page recreation must match the live site: fetch it, mirror its
  CSS/fonts/images honestly; if the post has equations or figures,
  keep them — they make it credible.
- Cuts carry pace; cursor calm; type-on 2–3× v1 speed; dials ~1.5s.
- Every beat verifiable from stills: entry, action, payoff.
- Site loop: recut same content, 10–14s, muted, ≤3MB each, seamless.
