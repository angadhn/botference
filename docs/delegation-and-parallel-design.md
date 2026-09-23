# Builds go to an Opus 5.5 agent, replies can nest, and `/parallel`

*Design for review, 2026-09-23. ==highlighted== = changed in this revision.*

==**Status: built.** Everything below is implemented and tested, nothing is
committed yet. You said "make it work the way it works here", so I took the
recommended answer to each decision; they are listed under "Decisions taken"
and each is one line to change.==

## Short answer to your questions

Yes, it all makes sense, and all of it is doable. Two things in your
picture differ from how the code actually works, and both make the job
easier rather than harder:

1. **Gemini is not one of the bots you chat with.** It is a one-shot
   call that runs whenever a YouTube link appears in your prompt. It runs
   *before* either bot sees the prompt, and its report is pasted into
   the text both bots receive. So "video goes to Gemini first, then the
   others" is already how every turn works, serial or parallel. Nothing
   to add there. (Local video files are not handled today; only YouTube
   links. Say if you want that.)
2. **Codex cannot summon a Claude agent by itself.** The Codex CLI has
   no tool that starts Claude. Claude *can* start sub-agents (its Task
   tool), but if only Claude could delegate, the two bots would behave
   differently and the interface could not show Codex's summons. So the
   summoning has to be done by botference itself, on behalf of whichever
   bot asks. That is the design below, and it is the same mechanism the
   bots already use to ask Gemini to watch a video (a `watch:` line in
   the reply that botference acts on).

## 1. Builds are delegated to a named agent

### What the reader sees

When a bot decides something needs building, its reply ends with a
short brief instead of the build itself:

> I'll have the site built. `summon: build the landing page from the
> outline above, one HTML file, dark theme, save under projects/acta/…`

Botference reads that line, starts a fresh Claude Code run
(`claude-opus-5-5`, effort `high`, see decision 3) in the project's
folder with the brief plus the room's recent history, and while it runs
you see, **indented under the bot's message**:

```
┃ codex   I'll have the site built. summon: build the landing page …
┃
┃   ↳ agent · Claude Opus 5.5 (high) · summoned by codex · working…  ⏱ 0:42
```

When it finishes the card fills in:

```
┃   ↳ agent · Claude Opus 5.5 (high) · summoned by codex · done in 3:10
┃     Built projects/acta/site/index.html (one file, 14 KB). Dark theme,
┃     four sections from the outline, no external scripts.
┃     artifact: projects/acta/site/index.html
┃     ▸ full output (tool calls, 23 lines)
```

Then the summoning bot is woken once with the agent's summary (the way
it is woken after Gemini reports), so it can tell you what to look at.
The other bot sees the agent's summary in its history like any other
message, attributed to the agent, not to the summoner.

Rules of the picture:

- The agent card always sits directly under the message that summoned
  it, even if other messages arrive while it works. Several summons from
  one message stack in order under it, like replies on Reddit.
- The header always names the model and effort actually used and who
  summoned it. No agent card ever appears without a parent.
- The summary shown is the agent's own final message. The full output
  (its tool calls) is folded away, one click to open.
- The same card appears in the council page, the browser plugin's
  comment threads and page chat, and the terminal (indented, with a
  `↳` prefix).

### How the bots are made to do this

Three layers, weakest to strongest:

1. **The instructions.** The first-turn text both bots get already says
   how to hand over deliverables. It changes to: *you never build a
   deliverable yourself; write a `summon:` brief and stop.* The plugin's
   make-artifact turn, which today tells Claude to use its own Agent
   tool with model `opus`, changes to the same `summon:` line.
2. **A stamp when they disobey.** Botference already inspects each
   reply's tool calls to see whether it wrote HTML or plots (that is how
   the "you built this but never looked at it" warning works). A reply
   that wrote a deliverable file itself gets a visible `⚠ built in-chat,
   not delegated` stamp, in the same style as the quote-check stamp. The
   file still exists; nothing is deleted. You see it happened.
3. **Optional hard stop** (decision 2): refuse the bots' own writes to
   `projects/*/artifacts/` and `*.html` paths, so only the agent can
   write there. This is a permission rule per bot, and it means a bot
   that wants to hand-fix one line in a built page also has to summon.

I recommend 1 + 2 now, and adding 3 only if the stamp shows up often.

### What the agent gets and does not get

- Gets: the brief, the room's last few turns (so "the outline above"
  resolves), the project folder as its working directory, the same
  deliverables rule the bots have (save under `projects/<id>/…`, end
  with an `artifact:` line).
- Does not get: the bots' running sessions, the ability to summon
  further agents, or the ability to reply to you directly. It reports
  to its summoner; the summoner talks to you.
- Its `artifact:` line is picked up exactly as a bot's is today, so the
  review hand-off ("never reviewed by the bot that wrote it") keeps
  working. The recorded author is the agent, and the reviewer rule
  treats the *summoner* as the writer, so Codex-summoned builds are
  reviewed by Claude and vice versa.

### Budget

One summon per bot per user turn by default, same as the Gemini budget,
so a bot cannot loop. A `summon:` line beyond the budget is shown to you
with a note and not run. The agent's run has no time cap by default (`timeout_s` under `builder`
sets one); it runs until it is done, and you can always press stop.

## 2. `/parallel`

### What it does

`/parallel` anywhere in a prompt (start or end) is lifted out, and the
rest of the prompt goes to both bots **at the same time**. Each bot gets
the full chat history up to and including your prompt, and *not* the
other bot's reply to it. Both replies stream side by side in the
council page (two live cards) and in the terminal's two panes.

After both finish, both replies are in the shared history in the order
they finished, so the next ordinary turn, and each bot, sees both.

What does not change:

- YouTube links are still watched by Gemini first, and its report is in
  the text both bots receive.
- Attachments, projects, the `/model` and `/effort` settings, and the
  sticky routing all behave as usual for the turns after.
- Esc / the interrupt button stops both.

What is different from an ordinary `@all` turn today: today Claude
answers first and Codex is shown Claude's reply before it writes its
own, which is why you see it reacting rather than answering.

### Two choices in the mechanics (decision 4)

- **The bot-to-bot follow-up.** After an ordinary round the bots may talk
  among themselves for up to six turns, and a verification turn runs
  when they converge. For a `/parallel` turn I recommend **skipping**
  that: the point is two independent takes, and you can always say
  "discuss" next. Alternative: run it as usual after both land.
- **Per-prompt only.** `/parallel` applies to that one prompt. If you
  find yourself typing it every time, a sticky `/parallel on|off` is a
  small follow-up.

## Decisions taken

==Taken from your reply ("talk for a bit, then dispatch an agent, like this
harness does") plus the recommendation in each case:==

1. ==**What must be delegated:** anything the reader opens as the deliverable
   (HTML, sites, plots, PDF/DOCX/slides, anything under
   `projects/<id>/artifacts/`). Code edits in a repo under discussion stay
   with the bots. The bots are told this in their first-turn text.==
2. ==**Enforcement:** instructions plus the visible `⚠ built in-chat, not
   delegated` stamp. No write-blocking yet.==
3. ==**Builder:** Claude Code, `claude-opus-5-5`, effort `high`, 15-minute
   cap, set under `builder` in `context-budgets.json`. A `for.codex` entry
   there can point Codex's summons at a Codex builder (say `gpt-6-sol` at
   `xhigh`) — you asked whether Codex should "call its own equivalent"; it
   can, with one line, and defaults to Opus 5.5 as you first asked.==
4. ==**After `/parallel`:** no bot-to-bot thread and no verification turn.==
5. ==**Codex default model:** still GPT-6 Astra. Sol and Luna are selectable.==

## Implementation plan

Order is chosen so each step is usable on its own.

- [x] **A. Summon primitive in the controller** (`core/botference.py`,
      new `core/summon.py`). Parse a `summon:` line from a bot reply
      (same place `watch:` is parsed). Start `claude -p --model
      claude-opus-5-5 --effort <builder effort>` in the project folder
      with brief + recent history. Stream its progress as a new room
      event kind `agent` carrying `parent` (the summoner's message id),
      `model`, `effort`, `summoned_by`, `status`, `summary`, and the
      folded tool log. Wake the summoner once with the summary. Budget
      and timeout as above. Session save/restore keeps agent cards.
- [x] **B. Prompts.** Rewrite the deliverables note and the plugin
      make-artifact turn to `summon:`. Add the stamp for in-chat builds
      next to the existing visual-artifact check.
- [x] **C. Council page.** Render `agent` events as nested cards under
      the parent message (insert into the parent's element, not the
      flat list), with header, live timer, summary, folded log. Restore
      on reload. CSS for the indent rail.
- [x] **D. Browser plugin.** Add `parent_ts` to stored messages; the
      drawer indents a message with a parent under it, in comment
      threads and in page chat. Same header. Review hand-off: record
      `drafted_by` as the summoner.
- [x] **E. Terminal UI.** Indented `↳ agent · model` lines in the
      pane of the summoning bot.
- [x] **F. `/parallel`.** New input kind; strip the token; in
      `_send_message` run both bots concurrently with history marked
      seen up to your prompt; skip (or run, per decision 4) the
      follow-up thread; interrupt cancels both. Autocomplete, `/help`,
      README, man page, CHANGELOG.
- [x] **G. Tests.** Controller tests for summon parsing, budget, wake,
      restore, and for `/parallel` ordering and isolation; plugin
      companion tests for nested rendering data; a `botference see`
      screenshot of the council page with a nested card.

==Test totals after the build: Python 914 passed (25 new); council page 87;
terminal UI 197; browser plugin all suites pass except one pre-existing
failure (the "python block runs" test) that fails identically on the
untouched tree. Both installed CLIs answered a one-line prompt on the new
models (`claude-opus-5-5`, `gpt-6-sol`). Not yet exercised: a real summon
end to end in a live chat — the next chat where a bot says `summon:` is
that test.==

## Already done today

- `claude-opus-5-5` (Opus 5.5) added; Claude effort ladder is now
  `low medium high xhigh max`.
- `gpt-6-sol` and `gpt-6-luna` added; Codex effort ladder is now
  `low medium high xhigh max ultra` (`ultra` exists on Sol and Astra
  only; `minimal` is gone because no current model accepts it).
- Autocomplete, `/help`, launcher help, README, man page, CHANGELOG and
  the plugin test fixtures agree. Python suite: 889 passed. Plugin
  suite: one failure in the python-block-run test that also fails on
  the untouched tree.
