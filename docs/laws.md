# Laws for publishing a blyg (proposed)

Status: **15 laws proposed on 2026-11-26. None adopted.** The owner adopts, edits or rejects each law. An AI may
propose a law; it may not adopt or change one. The readable copy is on the website, `site/laws.html`
(https://botference.com/laws.html). Keep the two the same.

Background: the Blygger project's post
[“How Blygger Studio is tested now, and why there is more test code than product code”](https://blyg.blygger.org/t/2fhnkb3zbh4jpxxbd7yv11tr4d/)
(the oracle framework is Kyle Mathews's work, as the post credits). A law is one sentence that starts “For every…”
and cites where its promise comes from.

How to read each law:

- **Authority**: where the promise comes from: a section of `frontends/plugin/SPEC.md` with its date, the
  CHANGELOG, the Blygger protocol, or the owner's site's note format.
- **Status**: Proposed, for all of them.
- **Checked today**: test files that exist now. They test chosen examples. None uses an independent model,
  generated sequences of actions, or planted bugs. “In the owner's site” means a test in the owner's own Jekyll
  site, not in this repository. Plugin test files are under `frontends/plugin/test/`.

## The laws

1. **For every thread the owner presses to publish, the post goes out with the text of the owner's latest press of
   that thread, never an older press and never text the owner did not press.**
   - Authority: SPEC, “the publish queue”: “What goes out: the text at the press” and the review fix “No entry
     publishes an older text of a thread” (2026-11-25).
   - Status: Proposed.
   - Checked today: `blyg-queue.test.mjs`, “THE WRONG TEXT NEVER GOES LIVE” and its mirror.

2. **For every new version published from the plugin, the post keeps its id, its address and its creation date, and
   its version number goes up by exactly one.**
   - Authority: SPEC, “Publishing again: a new VERSION of the same post” (2026-11-24).
   - Status: Proposed.
   - Checked today: `blyg-run.test.mjs`, “PUBLISHING AGAIN” and “ADD TO THE EARLIER POST”.

3. **For every one-click publish, the site's plan changes only that post's note and the files the site keeps for
   what the note itself quotes or links; a plan that would change anything else stops the run before the site is
   built or pushed.**
   - Authority: SPEC, “Publish as blyg”, “One click” (2026-11-23), and “Owner setup for Publish as blyg”
     (`plan_guard`, `--only-note`).
   - Status: Proposed.
   - Checked today: `blyg-run.test.mjs` (the guard flags go on every plan, apply and publish; a refused plan stops
     the run before apply; the note is never written outside the notes folder). In the owner's site:
     `tests/blyg_draft_test.rb` and `tests/blyg_publish_test.rb` (the `--only-note` refusals).

4. **For every passage that an agent wrote, or that the owner pasted from an agent, the published post shows it
   inside the marked agent box, even after the owner edits or accepts it, and the instruction behind it never
   appears on the post's page.**
   - Authority: SPEC, “Agent text on a published post” (2026-11-24) and “The box: marked, never named, always a
     block” (review round 5, 2026-11-24).
   - Status: Proposed.
   - Checked today: `blyg-note.test.mjs` (the generated-passage form); `blyg-run.test.mjs` (“THE LOOK POLICY”: the
     box in the preview); `blyg-liquid-build.test.mjs` (a real Jekyll build; runs only when `BLYG_BLOG_TREE` names
     a checkout of the site, skipped otherwise). In the owner's site: `tests/blygger_tk_test.rb` (the instruction is
     not on the page).

5. **For every agent passage, its text is published as text: it never becomes an HTML element, an HTML attribute,
   a script, a kramdown attribute list, or a link whose scheme is not http, https, mailto or a relative address.**
   - Authority: SPEC, “Text that goes into the note” (2026-11-23) and “Agent text on a published post”
     (2026-11-24); the owner's site's note format, “Agent passages in a draft”.
   - Status: Proposed.
   - Checked today: `blyg-note.test.mjs` (“inside a generated passage nothing can end the scope…”, “an agent's text
     in a scope can set no attribute…”, “short posts are text”); `blyg-liquid-build.test.mjs` when it runs. In the
     owner's site: `tests/blygger_tk_test.rb` (hostile output, hidden schemes) and `tests/blygger_build_test.rb`.

6. **For every post published with one click, the plugin stops for the owner's look for two reasons only: a comment
   that was in the post would be left out, or a note changed outside the plugin would be replaced.**
   - Authority: SPEC, “The look policy (the owner, 2026-11-25)”; CHANGELOG 2026-11-25.
   - Status: Proposed.
   - Checked today: `blyg-run.test.mjs` (“THE LOOK POLICY”); `blyg-queue.test.mjs` (“A FORCED LOOK”, “OUTSIDE”).

7. **For every post when the setting is `confirm: always`, nothing is published until the owner has seen the note
   and pressed Publish, and a press made under that setting keeps its look even if the setting changes before its
   turn.**
   - Authority: SPEC, “One click” (2026-11-23) and “the publish queue”: “`confirm: always`” and the review fix
     “Where the owner is, one value” (2026-11-25).
   - Status: Proposed.
   - Checked today: `blyg-run.test.mjs` (“confirm always: … the run waits at planned for the click”);
     `blyg-queue.test.mjs` (“CONFIRM ALWAYS”, “A LOOK PROMISED AT THE PRESS is kept”).

8. **For every press the companion accepts, the post ends published, failed with a stated reason, cancelled by the
   owner, or waiting for the owner with a stated reason; it is never dropped without a word.**
   - Authority: SPEC, “the publish queue”, review fixes “Nothing is swallowed” and “An unreadable queue file is
     kept” (2026-11-25).
   - Status: Proposed.
   - Checked today: `blyg-queue.test.mjs`, by examples (a malformed entry, an exception while starting, an
     unreadable queue file, a restart, giving up after a restart). No test checks every sequence of presses.

9. **For every run that fails after the site may have published, the queue pauses on that run and nothing is tried
   again until the owner acts.**
   - Authority: SPEC, “the publish queue”, “When a run fails” (2026-11-25); “The run” (“nothing is retried by
     itself”, 2026-11-23).
   - Status: Proposed.
   - Checked today: `blyg-queue.test.mjs` (“A FAILURE AFTER PUSH PAUSES the queue”, “A RESTART while paused”);
     `blyg-run.test.mjs` (each failing step “retries nothing by itself”).

10. **For every request to publish, queue, cancel, resume, retry or give up a post, the companion acts only for the
    owner through the pinned extension, and refuses a guest, an anonymous caller and a script on the companion's
    own page.**
    - Authority: SPEC, “Publish as blyg”: “Which requests may reach the routes” and “Routes and events”
      (2026-11-23); the queue's routes (2026-11-25).
    - Status: Proposed.
    - Checked today: `blyg-publish-server.test.mjs` (“hosted: every route is refused to an anonymous caller (401),
      a wrong password (401) and a guest (403)”; “a guest cannot … start a run, or act on one”; “the companion's
      own page cannot start, advance or read a publish”).

11. **For every post, the post answers at most one target; a post that links to two or more blyg posts answers
    none of them, and a new version never gains a target that the post was first published without.**
    - Authority: SPEC, “A lone link to a blyg post makes the post a response to it” (2026-11-24); Blygger
      protocol, `blyg_stub_of`.
    - Status: Proposed.
    - Checked today: `blyg-run.test.mjs` (“A LONE LINK”, “A LONE LINK, kept”); `blyg-note.test.mjs` (“a post's one
      target”).

12. **For every highlight made on a blyg's home feed, the companion files it under a post only after it fetches
    that post and finds the passage in the post's text; otherwise the highlight stays a quote of the feed page.**
    - Authority: SPEC, “A highlight on a blyg's home feed belongs to the post it sits in” and its review fixes
      (2026-11-24); Blygger protocol 0.4, §10.2 (the quoting rule).
    - Status: Proposed.
    - Checked today: `feedbind-server.test.mjs` (verified, unverified, a copying site, too short, several
      candidates); `feedbind.test.mjs`.

13. **For every guest of a hosted companion, the guest never receives an agent's instruction, an agent's passage,
    or agent text that the owner pasted; each one shows as “[an agent's passage]”.**
    - Authority: SPEC, “Publish as blyg, review round 5”: “Guests never receive a gap” (2026-11-24).
    - Status: Proposed.
    - Checked today: `blyg-server.test.mjs` (“a hosted GUEST never receives a gap: not its fill, its instruction,
      or pasted words (/page, an answer, SSE)”).

14. **For every draft note without `agents: on`, no agent is asked, and its `/tk` lines are built and published
    exactly as typed.**
    - Authority: the owner's site's note format, “Agent passages in a draft” (“Only opted-in notes”).
    - Status: Proposed.
    - Checked today: in the owner's site, `tests/blyg_fill_test.rb` (“a note without the key is never sent”),
      `tests/blygger_build_test.rb` (“… a note without the key is untouched”), `tests/blyg_publish_test.rb`
      (“without the key, tk lines are text”).

15. **For every run of `scripts/blyg-fill`, the note file stays exactly as the owner left it; the answers go only to
    the note's separate fills file.**
    - Authority: the owner's site's note format, “Agent passages in a draft” (“The note itself is never written”).
    - Status: Proposed.
    - Checked today: not checked by a test yet. The tests read the fills file; none compares the note before and
      after a run.

## How a law is adopted

- The owner reads each law, then adopts it, edits it, or rejects it. An AI does none of these.
- An adopted law then gets an independent check. The check is written from the law, not from the code.
- A law that changes later changes the same way: the owner decides, and the date is recorded.
