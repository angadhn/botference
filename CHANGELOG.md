# CHANGELOG

## 2026-07-20

- **Council + review web: model switcher with credit-exhaustion
  warnings.** Both UIs gain a compact per-agent model picker (Claude,
  Codex) showing each agent's current model and a native `<select>` of
  its available models, sourced from the bridge's `completion_context`
  scoped lists (`/model @claude …`, `/model @codex …`) with a static
  fallback. Selecting a model sends `/model @<agent> <model>` through
  the existing input path — council via `/input`, review via a new
  owner-only `/model` control endpoint that queues a raw control turn
  on the bridge. Council places it in the sidebar plus a current-model
  chip near the status strip; review places it in the sidebar with
  presence/theme (shown only in a live `--chat` session). The `status`
  event now carries `claude_model`/`codex_model` so the current model
  is authoritative. When an agent's turn output signals it is out of
  credits — Claude's "monthly spend limit" / `/usage-credits` /
  "out of credits" strings, or the OpenAI/Codex quota variants
  (best-guess, to refine) — that agent is flagged: its avatar dims and
  gains a ⚠ badge, an inline notice appears at the point of use (with a
  one-tap model switch and a "retry with @other" action), and composing
  a mention to a flagged agent warns before sending, with the switch
  control right there. The flag clears automatically on the agent's
  next normal turn, and optimistically when you switch its model.

## 2026-07-19

- **Council web: image upload from phone or computer.** Attach button in
  the composer (`accept="image/*"`, no `capture` attr — iOS Safari
  offers camera AND library), clipboard paste, and drag-drop onto the
  input. Thumbnails with ✕ above the input before sending; sent
  messages show inline thumbnails (served via the auth-gated
  `/uploads/` route, so shared links stay password-protected).
  Transport: `POST /upload` (raw bytes, ~10MB cap, max 4 per message),
  images validated by magic-byte sniffing — never by extension — and
  stored 0600 under the workspace's gitignored
  `.botference/uploads/<yyyy-mm>/`. `/input` refuses attachment paths
  outside that tree, and forwards them to the bridge in the exact
  attachment schema the Ink TUI uses (`{id, path, type:"image"}`), so
  the existing adapter staging pipeline handles them unchanged.
- **Council web: transcript lands pinned at the bottom after every
  replay.** Root cause of the "opens somewhere in the middle" anchor:
  the per-event "respect a scrolled-up reader" heuristic ran DURING
  history replay — any layout/viewport shift between replay bursts
  (iOS URL bar, fonts, code blocks settling) parked the scroll >90px
  off the bottom, after which every following event refused to
  auto-scroll. Now the server marks the end of its history batch with
  an additive `replay_done` event, the client suppresses the heuristic
  for the whole replay (including `/resume` restores, which end at the
  bridge's live `ready`), pins on the boundary, re-asserts after late
  layout via double-rAF + a ResizeObserver, and sets
  `overflow-anchor: none` so browser scroll anchoring can't fight the
  explicit pin. Live streaming keeps the old respect-the-reader
  behavior.
- **Council web: chat switches render instantly from a bounded cache.**
  One bridge = one live chat (a sidebar switch IS a `/resume` round
  trip), so true parallel caching is impossible — instead the outgoing
  transcript+scroll is snapshotted (LRU, last 5), the cached transcript
  paints immediately on switch-back, and the authoritative replay
  builds offscreen and swaps in at `ready` — never a blank flash, a
  small "syncing…" pill while reconciling. Tapping the already-active
  chat is now a no-op instead of a redundant resume.
- **Council web: links clickable, text selectable, passwords
  one-tap-copyable.** URLs in any message autolink (escape-safe, on the
  raw text, never inside code spans; `target=_blank rel=noopener`);
  `password: <token>` lines (tunnel share lines) render the token as a
  tap-to-copy chip, and inline-code spans copy on tap with a "copied ✓"
  toast (graceful no-op without the clipboard API); the transcript
  explicitly opts into text selection for iOS long-press. No more
  screenshotting tunnel passwords off a phone.

## 2026-07-18

- **`botference service` — managed long-lived processes that survive
  the shell (and an agent's turn).** New `lib/service.sh` + launcher
  dispatch. Motivation: bots inside botference sessions could not stand
  up a review/council share on request — anything they backgrounded
  died with their turn's process-group teardown (and launchctl is
  sandbox-denied). The fix is a sanctioned, auditable lifecycle, not
  loosened cleanup. `service start <name> -- <command…>` (name
  `[a-z0-9-]{1,32}`) forks the command into its own session and process
  group (python3 fork + setsid, stdin `</dev/null`, stdout+stderr →
  `.botference/logs/service-<name>.log` with ~5MB rotation), so no
  parent death, SIGHUP, or process-group SIGKILL reaches it; records
  `{name, pid, pgid, command, started, cwd, log}` in the per-workspace
  ledger `.botference/services.json` (atomic tmp+rename writes, pgid
  match as a pid-reuse guard); refuses duplicate running names; reaps
  stale dead entries on every invocation. `service list` (name, pid,
  uptime, alive/dead, command, log), `service logs <name> [-n N]`,
  `service stop <name>|--all` (TERM the process group, KILL after 5s,
  drop the entry). Convenience wiring — what agents should use:
  `botference review --share --service` and `botference plan --share
  --service` run the whole share (server + tunnel) under the service
  lifecycle (`review-share` / `council-share`), print the canonical
  `share this: <url>   password: <pw>` line (parsed from the service
  log with a bounded 90s wait), then return control; re-running while
  up reprints the last share line (idempotent for agents). Verified end
  to end: a real `review --share --service` on a throwaway repo printed
  its tunnel URL and returned; the group held launcher + node server +
  cloudflared; `service stop` took down all three and freed the port.
  Tests (`tests/service.test.mjs`, 9 cases): the agent-death simulation
  (service started inside a child bash whose entire process group is
  then SIGKILLed — service must survive, then die on `service stop`),
  duplicate refusal, stale reaping + name reuse, logs tail, `stop
  --all`, TERM→KILL escalation, input validation, instant-death
  detection, share-line parsing/idempotency. `review`'s gitignore block
  now also ignores `.botference/` in document repos. Docs: README
  ("Long-Running Services"), launcher help, man page, completions
  (bash + zsh, incl. service-name completion from the ledger), and the
  paper-review skill now instructs bots to use `botference service` —
  never bare background processes — for anything that must outlive
  their turn.

## 2026-07-17

- **Fixed live events never arriving through `--share` tunnels (council
  AND review).** Field bug: through a cloudflared quick tunnel,
  `GET /events` returned 200 with correct headers but zero body bytes —
  the phone saw "loading…" forever. Root cause, isolated with a minimal
  SSE origin: cloudflared (observed on 2026.1.1, QUIC and http2
  transports alike) buffers a streamed response body until the response
  *ends* — a 2KB first-chunk pad, `flushHeaders()`, `X-Accel-Buffering:
  no`, and `setNoDelay` (all now in place anyway, they matter for other
  proxies) cannot help. Fix: a dependency-free WebSocket transport
  (`frontends/review/ws.mjs`, RFC 6455 server side, shared by both
  frontends and shipped with review engine copies — `--upgrade` picks it
  up) — cloudflared proxies WS upgrades unbuffered. Both browser clients
  now connect WS-first (`/ws`, same auth gate, same hello/replay as
  `/events`) and fall back to SSE when WS never opens (old servers,
  WS-hostile middleboxes). SSE itself hardened: padded flushed first
  chunk + 15s comment heartbeats on both servers (`SSE_HEARTBEAT_MS`
  overridable). Verified through real quick tunnels: council WS
  delivered hello + full history replay in 222ms and live turn events in
  340ms; review WS delivered hello in 191ms and a live `state` fan-out
  in 546ms — where SSE through the same tunnels delivered zero bytes in
  20s. Tests: WS handshake/replay/live-events/auth + SSE transport
  hygiene in both suites, with a raw WS test client fixture
  (`tests/fixtures/ws-client.mjs`).

- **`botference plan --web` / `--share`: the planning council in the
  browser (and on your phone).** A new web frontend
  (`frontends/council/`) serves PLAN mode as a claude.ai-shaped chat
  app: left sidebar with projects and their chats (click = the
  equivalent slash command: `/resume <id>`, `/project open <id>`,
  `/new`), a streaming transcript (author-styled messages, the room
  footer JSON hidden), a slash-command autocomplete popover driven by
  the bridge's `completion_context` (global + scoped completions, so
  `/model @claude …` offers models), inline choice/permission cards
  with the review frontend's default-deny/dismiss 120s timers, per-agent
  busy avatars, a status strip (project · route · context %), and a
  segmented light/system/dark theme control. Mobile-first: sidebar as a
  slide-over behind a hamburger, 16px inputs, safe-area padding.
  `--web` serves locally; `--share` adds an in-page password gate
  (HMAC cookie + per-IP rate limiting, the review machinery) plus a
  cloudflared tunnel and prints `share this: <url>   password: <pw>`
  (`COUNCIL_PASSWORD` respected, generated otherwise). `--share
  --no-auth` explicitly skips the gate for an open URL, with a
  prominent warning at launch and a dismissible banner in the page —
  never the default. The server spawns its own bridge (JSONL protocol
  unchanged), replays coalesced event history to reconnecting browsers,
  and refuses a second web frontend per workspace via
  `.botference/council-web.lock`; the Ink TUI remains the default
  `botference plan`. Tests: `tests/council-web.test.mjs` (server boot,
  SSE replay, verbatim slash input delivery against a stubbed JSONL
  bridge, the gate, `--no-auth`, the lock, and a happy-dom UI smoke).

- **Stable share URLs via named cloudflared tunnels** for BOTH
  `plan --share` and `review --share`: set
  `BOTFERENCE_TUNNEL=<your-tunnel-name>` (created once with
  `cloudflared tunnel login/create/route dns`) and `--share` runs the
  named tunnel instead of a random quick one;
  `BOTFERENCE_TUNNEL_URL` is printed as the share URL when set. Tunnel
  mechanics extracted into `lib/tunnel.sh`, shared by both frontends.

- **Fixed the botched panel borders the flicker fix introduced.** Ink's
  experimental `incrementalRendering` (enabled yesterday) corrupts its
  cursor bookkeeping whenever the frame's line count shifts (input area
  growing, projects panel toggling): the whole frame lands one row low,
  leaving an orphaned border line floating above the panel tops and the
  busy line overstruck into the divider. Reproduced deterministically
  with a virtual-terminal probe and disabled — the standard writer
  repaints the frame as one atomic write bracketed in DEC 2026
  synchronized-update markers, which keeps the flicker win: still zero
  full-screen `clearTerminal` repaints, still an O(1) busy tick
  (~34 KB/s while busy vs the broken 67 KB/s + 14 screen-clears/s; the
  incremental writer's 1 KB/s was not worth corrupted frames). A new
  screen-consistency test interprets Ink's actual ANSI output into a
  virtual screen and asserts it stays byte-identical to a fresh render
  across line-count churn (`ink-ui/src/renderScreen.test.tsx`).

## 2026-07-16

- **Hosted review: in-page password gate instead of the browser
  basic-auth popup.** Unauthenticated document requests get a minimal,
  theme-consistent gate page (paper title, one password field, both
  color schemes); the correct password sets an HMAC-signed
  `review_auth` cookie (HttpOnly, SameSite=Lax, Secure behind the
  https tunnel, 7-day lifetime, secret persisted in gitignored
  `state/.auth-secret`) and redirects to the requested page — wrong
  passwords re-render the gate with a calm error and share the
  existing per-IP POST rate limit. JSON/SSE/asset requests get plain
  401 JSON (no `WWW-Authenticate` header anywhere, so no popup), and
  `Authorization: Basic` with any username still works for curl/tools
  (documented in SCHEMA.md).

- **`botference review`: agents on by default, detected — plus
  `--share`.** The launcher now decides the bot bridge from actual
  capability (python3 + a `claude`/`codex` CLI on PATH) instead of an
  always-on `--chat`: capable machines serve with agents and print
  `agents: on (claude, codex detected)`; machines without the CLIs serve
  read-and-comment with a friendly explanation (comments sync via git;
  agents reply elsewhere). `--no-agents` opts out, `--agents` forces on
  with a clear error when impossible (`--chat`/`--no-chat` remain as
  silent deprecated aliases). New `botference review --share`: hosted
  mode behind a cloudflared quick tunnel — respects `REVIEW_PASSWORD` or
  generates one, prints `share this: <url>   password: <pw>`, Ctrl-C
  tears down server + tunnel together; missing cloudflared degrades to a
  local serve with an install hint. Hosted honesty/awareness fixes: a
  guest's queued mention chip now reads "queued — waiting for
  <owner-handle> to approve" (server exposes `owner_handle` in `/data`);
  when the server disappears, guests get a prominent-but-calm banner
  (comments are safe in the browser, will sync if the URL returns, can
  be exported) while the owner keeps the quiet presence strip; and a
  guest summons entering the pending queue fires a macOS desktop
  notification to the owner (osascript, best-effort). Docs, man page,
  completions, and the paper-review skill updated to the new command
  story.

- **Review engine: TikZ figures render.** Pandoc drops `tikzpicture`
  environments, so papers whose figures are drawn in LaTeX showed no
  figures at all (seen live: three TikZ diagrams). The builder now
  extracts each `tikzpicture` (figure-wrapped or bare), compiles it as a
  `documentclass[tikz]{standalone}` document reusing the paper's
  preamble (minus geometry/fancyhdr/hyperref and header/footer commands,
  so `\usetikzlibrary`/`\definecolor`/`\newcommand` all work) with
  `pdflatex` + `pdftocairo -svg` (fallback `dvisvgm --pdf`), caches the
  SVG by content hash under `site/tikz/`, and swaps it in as a synthetic
  `\includegraphics` so the wrapping figure/caption/label survive pandoc
  — global figure numbering and cross-page refs included. Compile
  failures or a missing toolchain degrade to the fig-placeholder pattern
  with a one-line build warning; the build never breaks. Build summary
  prints `tikz: N/M compiled to SVG`.
- **Review engine: whitespace/smart-quote-tolerant span matching.** Live
  field failure: suggestion cards carry single-spaced ASCII `current_text`
  while rendered paragraphs wrap lines and use pandoc's typographic
  quotes, so exact `indexOf` matching silently skipped inline tracked
  changes — and would have wrongly flagged applies as
  `needs_manual_resolution`. New shared `assets/span-match.js` (browser
  global + CJS): matching collapses `\s+` runs to one space and folds
  curly quotes to ASCII on both sides — uniqueness counting included —
  with an index map back to true raw offsets so the in-page `<del>/<ins>`
  wrap (review.js) and the source replacement (apply.mjs) always operate
  on the original text. Verified against the live Acta data: both
  `rw-abstract-modeling-step*` cards go from 0 matches to exactly 1 on
  the built abstract page.
- **Review engine: masthead title fallback.** Papers without `\title{}`
  (seen live) left the masthead empty with no recourse: config gains an
  optional `title` key that wins over the `\title{}` parse, and detect
  emits `"title": ""` plus a summary note telling the user to fill it in
  (never guessed from headers).
- **Review engine: single-file LaTeX papers.** A configured section file
  containing two or more `\section` commands (typically the master of a
  paper that is not split into `\input` files) is now split at build time
  into virtual sections — one rendered page per `\section`, plus an
  Abstract/Front Matter page for content before the first section — with
  the same slugs, TOC, global equation/figure/table numbering, and
  cross-page ref resolution as multi-file papers. Each chunk is re-wrapped
  with the paper's preamble so `\newcommand` macros keep expanding; the
  split is recomputed from the source every build (nothing stored in
  config; `"split": false` on a section entry opts out). Multi-line
  `\title{...\\ \large ...}` values are cleaned for the masthead/TOC.
- **Review engine: figures.** Config gains `figures_dirs` (array),
  detected from every `\graphicspath` entry *and* the directories that
  `\includegraphics` arguments actually resolve to; the server serves all
  of them (each path-guarded) and the builder rewrites `<img>` srcs
  against any of them, probing png/jpg/jpeg/svg/gif/webp/pdf for
  extensionless refs. PDF-only and missing figures render as labeled
  placeholders instead of broken images; jpeg/svg/gif/webp/pdf MIME types
  added. The legacy `figures_dir` (string) key keeps working verbatim —
  existing configs need no edits (Acta site output verified
  byte-identical).
- **Review detection summary** (`scripts/review-detect.mjs`) now reports
  the single-file split ("N \section commands — the build splits it…"),
  the figure dirs found, referenced/resolved figure counts, and warns
  loudly when zero referenced figures resolve on disk.
- **Review engine tests**: `node --test tests/review-engine.test.mjs`
  runs detect + build + a live server against generated single-file and
  multi-file fixture papers (split pages, TOC, cross-page refs, global
  numbering, figure serving over HTTP, traversal guard, legacy-config
  regression). Never binds port 4177.
- **Shell completions** for the launcher (`completions/_botference` zsh,
  `completions/botference.bash`) covering all modes incl. `review`.
- **New: `botference review` subcommand** — one command to set up and
  serve the document-review interface from any document repo:
  `botference review [dir] [--hosted] [--port N] [--no-chat]
  [--upgrade]`. First run copies the engine into `<dir>/review/`,
  auto-detects `review.config.json` (master file, sections, bib,
  abbreviations, todo macros, figures dir, free port — summary echoed
  for eyeballing; `scripts/review-detect.mjs`), appends the review
  gitignore block idempotently, and builds the site; every run rebuilds
  when sources changed and execs `node review/server.mjs --chat`
  (Ctrl-C stops it). `--upgrade` refreshes only engine files, never
  config/state/suggestions/site. Requires `pandoc` (friendly error if
  missing). Launcher-side: `lib/review.sh`.
- **New: document-review frontend (`frontends/review/`) + `paper-review`
  skill.** Google-Docs-style review of rendered LaTeX/Markdown: margin
  comments, @-mention bot turns via the bridge, threaded replies,
  agent-colored suggestion cards, deterministic apply with separate
  Apply/Commit/Revert, per-user git-synced comments, and a hosted mode
  (password + tunnel) for collaborators without botference. Built and
  verified against a live Acta Astronautica paper.
- **Fixed the TUI flickering during bot turns.** Two compounding causes:
  the app rendered at exactly the terminal height, which pushes Ink onto
  its fullscreen fallback — a `clearTerminal` (full screen + scrollback
  erase) and complete repaint on *every* render — and the busy-spinner
  animation ticked app-level state every 70ms, re-rendering the entire
  tree (~130 components) and triggering that full repaint ~14×/s all
  through a streaming turn (measured: 29 full-screen clears and ~67 KB/s
  of terminal writes per 2s). Now the frame stays one row under the
  terminal height, Ink's incremental renderer diffs per line and rewrites
  only lines that changed, the spinner is an isolated `<BusyLine>`
  component that owns its animation frame (nothing else re-renders, and
  it ticks at a calmer 150ms), and transcript rows are memoized against
  the per-entry flat-line cache so a stream flush re-renders only the
  changed row. After: zero full-screen repaints, zero row re-renders per
  spinner tick, ~1 KB/s written while busy (~60× less). Render-path
  regression tests pin all of this down (`ink-ui/src/panes.test.tsx`).

## 2026-07-15

- **Fixed the TUI's 4GB out-of-memory crashes.** Root cause: the Ink UI
  loaded React's *development* reconciler (NODE_ENV was never set), which
  records a `performance.measure()` — with a props-diff payload — for
  every component render; Node retains every user-timing entry for the
  life of the process, so long busy/streaming sessions leaked ~1MB/s
  until the ~4GB heap ceiling (three OOM aborts on 2026-07-15).
  `dist/bin.js` is now a loader that pins `NODE_ENV=production` before
  React is imported, the launcher sets it too, and a periodic user-timing
  purge keeps even deliberate dev-mode runs bounded. Also: the launcher
  gives node `--max-old-space-size=8192` headroom, the syntax-highlight
  cache is capped (it minted a new entry per stream flush while code
  blocks streamed), the transcript pane no longer re-flattens the whole
  transcript on the urgent render path (the flatten now happens once, on
  the deferred path — less flicker while streaming), and after an
  abnormal TUI exit the launcher drains buffered mouse escape sequences
  so they can't replay into the shell as garbage.

## 2026-07-12

- **GPT-5.6 Sol is the default Codex participant.** OpenAI's new GPT-5.6
  family (Sol flagship / Terra cheaper / Luna fastest, all 1.05M context,
  GA July 9) is wired in: `gpt-5.6-sol` is the default everywhere
  (launcher, bridge, adapter), all three appear in `/model @codex`
  completions with correct context windows, the new `max` reasoning
  effort joins `/effort @codex`, and `gpt-5-latest` now probes Sol first
  (falling back to gpt-5.5). Requires codex-cli ≥ 0.144 — older CLIs get
  a server error telling you to upgrade (`brew upgrade --cask codex`).

## 2026-07-09

- **Image attachments actually work now.** Pastes with backslash-escaped
  spaces (every macOS screenshot name), quoted paths, `file://` URLs, and
  several paths on one line (multi-file drag-drop, Finder Cmd+C → Cmd+V)
  all parse into attachments; nonexistent paths stay visible as text
  instead of becoming dead `[image N]` placeholders, and attachments
  missing at send time are reported in the room instead of silently
  dropped (both failure modes found in a real transcript). New: **Ctrl+V**
  attaches a raw image from the macOS clipboard (screenshot Cmd+C,
  browser "Copy Image") — terminals can't deliver image data through
  normal paste. `~` paths expand on the Python side too.
- **Flight recorder + run ledger.** The launcher logs every run's start
  and real exit code to `.botference/run-ledger.jsonl` (hard kills show
  as starts without ends; abnormal runs are counted in the next launch's
  crash notice). The UI writes heartbeat breadcrumbs to
  `.botference/flight.jsonl` — memory usage with >85% heap-pressure
  flagging, last bridge activity — and a dying Python bridge is now
  recorded to ink-crash.log with its exit code.

## 2026-07-08

- **Crash tracking.** UI (Node) exceptions now persist to
  `.botference/ink-crash.log` with stack traces; the launcher runs node
  with `--report-on-fatalerror` so even V8 out-of-memory aborts — which
  no in-process handler can catch — leave a report in
  `.botference/crash-reports/`; Python exceptions already landed in
  `<sessions>/crash.log`. The next launch surfaces fresh crash evidence
  in the room ("A previous run appears to have crashed"), once. Also
  fixed: the launcher captured `rm`'s exit code instead of the TUI's, so
  crashes reported as clean exits.
- **Terminal restore backstop in the launcher.** A hard crash (OOM
  abort, SIGKILL) can never run in-process cleanup — the launcher now
  unconditionally disables mouse reporting / bracketed paste / alt
  screen and runs `stty sane` after the TUI exits, so no crash leaves
  the shell spraying mouse escapes.
- **Nested-store regression fixed at the launcher layer.** Launching
  from inside a state dir (e.g. `cd botference && botference plan`)
  re-split the session store: `lib/config.sh` exported a
  `BOTFERENCE_WORK_DIR` pointing at the legacy `work/` leftover, which
  overrides the core/paths.py guard. The shell now applies the same
  project.json rule. (A chat stranded in the nested store by this bug
  was migrated back to the canonical `sessions/`.)
- **`/agents` — user-gated subagents for Claude.** The Claude
  participant has no Task (subagent) tool by default and is instructed
  to *suggest* subagents and wait; `/agents on` grants the tool from its
  next turn (enforced at the CLI tool-list level, not by prompt),
  `/agents off` revokes, the grant persists with the chat across
  `/resume`, and `/new` resets it. Codex has no subagent facility.

## 2026-07-06

- **Clean terminal on every exit.** Ctrl+C (and any other exit) used to
  leave mouse tracking enabled — Ink's unmount re-enabled it *after* the
  restore ran — so mouse movement sprayed escape garbage into the shell;
  Ctrl+Z had no handler at all (and under raw mode never even reached the
  app). Now: the final restore wins the unmount race and a backstop exit
  hook re-issues the disables last; Ctrl+Z synchronously restores the
  terminal, suspends the whole process group, and `fg` re-enters all
  modes and repaints; SIGHUP restores too. Verified byte-for-byte in tmux.
- **Long-chat reliability.** Session saves are ~4x faster (compact JSON;
  ~70ms at 10K entries, was ~300ms blocking the loop on every message);
  resuming a huge chat replays only the last 2000 entries (full history
  stays in the session file); the UI display log is capped (~2400
  entries) with trim-stable render caching; `stream-events.jsonl` and
  `crash.log` rotate instead of growing forever. Crash guards: a
  malformed bridge event, non-object JSON line, deeply-nested markdown
  bomb, or giant pasted message can no longer kill the TUI or the bridge
  (renders degrade gracefully; huge messages skip the typing reveal).
- **Claude can reach Wikimedia now.** Two blocks fixed: the Claude
  participant's Bash sandbox only allowed GitHub hosts (curl to
  wikipedia.org failed outright — Codex has full network, hence the
  asymmetry), and Claude Code's WebFetch refuses some wikimedia domains.
  wikipedia/wikimedia hosts joined the sandbox allowlist and Claude's
  initial prompt now carries a short fallback: on a WebFetch 403 /
  anti-bot / domain-verification failure, curl the URL via Bash instead.
  Verified end-to-end against commons.wikimedia.org and
  upload.wikimedia.org.

- **Steering: typing during a Claude turn now reaches Claude mid-turn**,
  matching native Claude Code behavior — the message is injected into the
  running session (stdin on the programmatic transport via
  `--input-format stream-json`; a pane paste under `--claude-interactive`)
  and read after the current tool call. Steered messages display as
  `(↪@claude)` and enter the shared transcript so Codex sees them next
  turn. Slash commands, other-target @mentions, attachments, and Codex
  turns keep the existing queue (`codex exec` accepts no mid-run input).
- **Desktop notifications when the bots finish.** After a turn or
  bot-to-bot thread lasting ≥5s, and whenever a bot blocks on a
  write-permission prompt, botference emits a terminal notification
  escape (OSC 777 on Ghostty/WezTerm/foot, OSC 9 elsewhere,
  tmux-passthrough aware) and your terminal posts the native desktop
  notification — typically only while the window is unfocused. On by
  default; `/notify off` disables it, persisted per-user in
  `~/.botference/settings.json`. Esc-interrupting a turn suppresses the
  ping.
- **Man page + doc sync.** New `docs/man/botference.1` (launcher modes,
  options, in-session command highlights, files, environment); README's
  stale "typing pauses the thread" bullet updated for steering; `/help`
  screenshot re-captured. Also fixed: a full pytest run used to litter
  hundreds of session files into the repo's own `work/sessions` store —
  a conftest guard now redirects default path resolution into each
  test's tmp dir.
- **Built-in `review-doc` skill.** Both bots now discover a skill for
  rendering review documents (implementation plans, proposals) as
  self-contained HTML with Google-Docs-style margin commenting and
  feedback export — highlight, comment, export, hand the feedback file
  back to the council. Vendored under `.claude/skills/` and
  `.agents/skills/` like `grill-me`.

## 2026-07-05

- **Chat lifecycle commands.** `/new [title]` starts a fresh chat in place
  (previous chat stays saved and resumable; project context is kept).
  `/file` opens a project picker to file the current chat (alias
  `/add-to-project`; `/file <project-id>` for direct hits). `/delete`
  opens a picker of recent chats — always with a confirm step — cleans the
  project index, and deleting the current chat rolls into a fresh one.
  `/help` is regrouped around the lifecycle.
- **No more empty-session litter.** Sessions are created lazily: a chat
  only hits disk on its first message (or `/rename`, or opening a
  project). On launch, day-old zero-transcript session files are swept
  automatically. Also fixed: launching botference from *inside* a state
  directory (e.g. `cd botference && botference plan`) used to silently
  start a second session store at `<state>/work/sessions` — a path guard
  now keeps a state dir from nesting another store.
- **`/adopt` works under `--claude-interactive`.** The tmux pane now
  launches as `claude --resume <adopted chat>`, so botference steers a
  real, attachable Claude Code session resumed from your past chat —
  watch it live with `tmux attach`. (The programmatic transport remains
  the more robust path; the interactive mirror is still experimental.)
- **`/adopt` — bring an existing Claude Code chat into the council.** Lists
  recent native `claude` sessions for the current folder in the arrow-key
  picker (or `/adopt <id-prefix>` directly). The chosen chat becomes the
  room's Claude session with its full native context; Claude receives the
  room protocol and writes a handoff summary into the shared transcript, so
  Codex late-joins already briefed. Failed adoptions roll back cleanly.

## 2026-07-04

- **Steadier Codex context meter.** The status line previously showed
  Codex's raw last-turn input delta, which spiked on tool-heavy turns
  (each internal API call re-sends the full context) and dropped on short
  ones — hence the oscillation. `codex exec --json` exposes no native
  occupancy event, so the adapter now estimates occupancy: a tool-free
  turn's delta is the exact full prompt (verified against codex-cli
  0.142) and overwrites the estimate — including downward, so
  auto-compaction shows honestly — while tool turns contribute
  `delta / (tool_calls + 1)` as an approximate sample. The first Codex
  turn now shows a reading instead of "unavailable", and yield-pressure
  warnings use the same, more faithful number.

- **Free-form is now the only planning mode.** The `--free-form` flag is gone
  from the launcher, `lib/config.sh`, the Ink UI, and the bridge; the room
  footer/handoff protocol is always active. Turn-based behavior survives as
  the degenerate case: a reply with no footer handoff and no @mention simply
  returns the floor to you. Budgets, preemption, and the conciseness nudge
  are unchanged.
- **Projects panel polish.** Session rows show a compact relative age
  (`5m`, `3h`, `2d`) and are strictly sorted newest-first; the currently
  open chat is marked `▸ … · open` in bold. With the panel focused, typing
  filters projects and chats by title (shown in the panel header; Esc or
  Backspace edits it, `/` still starts a slash command, and the filter
  clears when you Tab away or open a row).
- **/draft now runs through the free-form room flow.** Draft, review, revise,
  finalize, and checkpoint turns stream live in the council like any other
  turn. The reviewer ends each review with the room footer: `converged`
  skips the revision (sign-off), `blocked` / `next: "@user"` saves the
  comments and pauses the draft for your input, and typing mid-draft pauses
  at the next round boundary. The deterministic file writes are unchanged —
  `implementation-plan.md`, per-round reviewer comments, and `/finalize`'s
  `checkpoint.md` — and any stray footer a model appends is stripped before
  the file is written.
- **The caucus is retired.** `/caucus`, the caucus pane, prompts, and
  `RoomMode.CAUCUS` are removed — the bots debate in the open council via
  free-form handoffs instead, and the council pane is now full-width next to
  the Projects panel. The caucus writer vote lives on in the room footer: an
  optional `writer: "@claude"|"@codex"` field; when both bots vote for the
  same writer the lead is set automatically (manual `/lead` always wins,
  votes persist across resume). Old sessions restore fine — their
  `caucus_history` display log is dropped, transcript summaries are kept,
  and legacy caucus footers are still stripped from the display.

## 2026-07-02

- **Free-form mode (`--free-form`)**: bots may hand each other the floor in
  the council via a JSON room footer (`next: "@claude"|"@codex"|"@user"`) or a
  prose @mention, recursively, until they hand back to the user. Bot-to-bot
  threads are budgeted (6 turns / ~8K output tokens, one automatic extension),
  the countdown is shown to the models each turn, oversized turns get a
  conciseness nudge, and typing mid-thread pauses it at the next turn
  boundary. Budget exhaustion pauses the thread and returns the floor — reply
  "continue" to resume. Turn-based behavior is unchanged without the flag.
- **Removed the Textual (Python) TUI and legacy Ink backend.** The Ink TUI is
  now the only frontend; `--textual`, `--ink-legacy`, and `--ink-v2` flags are
  gone. Shared UI dataclasses moved from `botference_ui.py` to
  `core/ui_types.py`. Ctrl+Y native terminal selection now works in the main
  Ink UI. The `textual` dependency was dropped from `requirements.txt`.
- **Project filing**: the first message of an Inbox chat now opens an
  arrow-key picker in the Ink UI (matched projects / new project from chat /
  stay in Inbox; Esc dismisses) via a new `choice_request`/`choice_response`
  bridge protocol; new `/project assign [<session-id-prefix>] <project-id>` files the
  current or any saved chat under a project via `session-index.json` without
  switching the active context. Resuming an old chat under `--free-form` now
  injects a one-time protocol note so pre-existing model sessions learn the
  footer handoff.
- **Smoother streaming**: the Ink bridge now coalesces streaming text deltas
  and flushes every ~70ms, cutting per-chunk re-renders by an order of
  magnitude while keeping typing visibly live.
