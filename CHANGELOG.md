# CHANGELOG

## 2026-08-08

- **Web annotator: the drawer can no longer be left behind.** Live
  updates reach a page through the extension's service worker, and
  Chrome retires those whenever it likes — the replacement reconnected
  the socket but had never heard of your tab, so replies landed in the
  record while the drawer sat there saying "queued…" until you reloaded.
  Now every message re-registers the tab, a port per tab makes the
  worker's death visible to the page (it reconnects and refetches), a
  socket that comes back tells every drawer to catch up, a send that
  hears nothing checks the record after a few seconds, and a page that
  is visibly waiting looks it up on its own. A turn whose ending was
  lost stops spinning after 45s, a refetch that finds the answer takes
  the stale wait down with it, and one malformed event can no longer
  freeze the stream.

- **Web annotator: a wait says what it is waiting for.** The companion
  now reports WHY nothing has started — the bridge is being woken, or
  another chat has the floor — and the drawer says "waking the agents…"
  or "queued behind another chat…" instead of a flat "queued…", with the
  same spinner every other live state uses. Waiting should look alive.

- **Web annotator: @ completes itself.** Typing `@` in any composer
  offers the agents that can be summoned (whichever ones the companion
  reports, plus `@all`), each with its logomark: keep typing to filter,
  ↑/↓ to choose, Enter, Tab or a click to complete to "@codex ". Esc or
  a handle nobody has closes it and leaves your text alone, and an "@"
  inside a word — an email address — never opens it at all.

- **Web annotator: the Pages list reads properly.** The row for the page
  you are on now outreads the rest by a visible margin (the other rows
  step back and come back on hover), and the button that opens the list
  wears the braid instead of a glyph that looked like a copy icon.

- **Web annotator: threads fold sooner.** A thread now folds past three
  drawn units instead of six, keeping its root and the last two — so a
  four-message exchange already tucks its middle behind "Show 1 earlier
  reply" (singular, and the count still ignores tool rows).

- **Web annotator: maths renders, and long threads fold.** Messages now
  typeset LaTeX — `$…$` and `\(…\)` inline, `$$…$$` and `\[…\]` display —
  for every author, in comment threads and page chat alike, using KaTeX
  0.18.2 vendored into the extension (`extension/vendor/katex`, woff2
  only): no CDN, no network call, nothing to install. Maths is cut out of
  the source before the markdown parser sees it, so `x_1`, `a*b` and `\\`
  come through as TeX rather than as mangled emphasis; dollar amounts
  stay prose ("costs $5 and $10"), `$` inside code stays literal, an
  unclosed delimiter is left as typed, and a formula KaTeX chokes on
  degrades to its own source instead of blanking the message. Obsidian
  export is deliberately untouched — the vault gets the raw `$…$`, which
  Obsidian typesets itself. Separately, a thread past six exchanges now
  keeps its opening message and the last few replies and folds the middle
  behind a one-line "Show N earlier replies"; a bot turn's "Explored"
  row can never be stranded above an answer that was hidden, and
  pending sends, streaming replies and the working chip always stay
  below the fold.

- **Web annotator: honest status lines, safe message addressing, and the
  braid.** The "queued…" indicator no longer outlives its turn — it is
  written only when the turn genuinely hasn't started yet and is removed
  the moment a reply lands (the turn often starts before the send
  response returns, which is why it used to stick). Editing/ticking/
  deleting now addresses messages by author and kind as well as
  timestamp, so two messages stamped in the same millisecond (a bot's
  "Explored" summary and its answer) can never receive each other's
  edits — server and drawer both fixed, with `ambiguous:true` surfaced
  when a tie is unbreakable. New visual identity: "The Braid" — three
  strands (you, claude, codex) converging into one plan — as the site
  share card, a full-bleed rope mark redrawn per size for the extension
  icons (crisp at 16px), and the favicon. Also: Google Search Console
  verification + GA4 analytics on botference.com, and a stray NUL byte
  in server.mjs that made grep treat the file as binary is gone.

- **Web annotator round 5 — instant sends and human collaborators.**
  Sending is now optimistic: your message appears in the thread the
  moment you hit Send (pending spinner, "reaching botference…"),
  reconciling when the server confirms — a failed send waits with a
  retry instead of vanishing, and double-clicks can no longer produce
  duplicates (structural fix + a 10s server dedupe). New collaboration
  layer: `botference plugin --share` puts the companion behind a
  password gate and a cloudflared tunnel; guests sign in with a name,
  comment under their own handle (stable per-handle colors), and can
  summon bots only within grants you set in
  `.botference/plugin/grants.json` (daily caps, re-read live).
  Extension-less guests — phones and iPads included — get a
  server-rendered reading room at `/pages`. Remote collaborators with
  the extension point it at your tunnel via its new options page (URL,
  password, display name). Also: sticky workspace (`botference plugin`
  works from any directory after the first run; `--here` overrides),
  clearer step-by-step offline instructions in the drawer, plugin mode
  in the zsh/bash completions, and owner-only enforcement on export,
  deletion, model/effort/verbosity, relay, and interrupt.

- **Web annotator round 4 — living documents, working checklists, and a
  leash.** Page/doc text now re-ships with any mention when it actually
  changed since last sent (hash-gated), and Google Docs margin comments
  ride along as a digest (docx export parsed with a zlib-only zip
  reader — still zero dependencies). Bot replies that propose actions
  arrive as markdown checklists rendered as real clickable checkboxes —
  tick/untick persists into the message. The gear popover gains
  per-agent effort pickers and a short·long verbosity toggle (short =
  2-3 crisp chat-register sentences, the default; long ≤ 4-5),
  enforced per turn. Bots can no longer write files from web/doc
  content: every write permission is denied instantly with a visible
  notice. The Pages list shows which pages have bot chats and can
  hard-delete a page together with its council session.

- **Web annotator: Docs context and session binding actually hold.**
  Two live-caught bugs. (1) Google answers a wrong-account export with
  200 + an account chooser: the export URL now echoes the page's own
  `/u/<n>/` account scope (both URL spellings), HTML responses are
  detected as failures, a failed read shows a dismissible warning in
  Page chat instead of silently sending Docs menu chrome to the bots,
  and a failure no longer burns the once-only context — the next
  mention retries. (2) New pages could inherit the bridge's previous
  session (new chats are invisible in panel snapshots until their
  first turn, and `/rename` emits none): session capture now waits for
  a snapshot proving a *different* active session after the first turn,
  fails loudly ("its next comment starts a fresh chat") rather than
  binding wrong, refuses a sid another page owns, and `/resume` is
  confirmed before anything is sent into a chat.

- **Web annotator: Google Docs support (Page chat).** New site-adapter
  layer in the extension; the Docs adapter fetches the document's
  plain-text export with your own session (private docs included, no
  sharing changes) and hands it to the bots as first-turn context, with
  the doc's real title on the chat. Docs paints text to a canvas, so
  highlighting is deliberately off there: the drawer opens straight to
  Page chat and the Comments tab is disabled with an explanation. The
  adapter registry is the slot for Notion/Office-style sites later.

- **Web annotator: a Pages view — browse your annotation history inside
  the plugin.** A stacked-pages button in the drawer header lists every
  annotated page (title, site, thread count, last activity, newest
  first, current page marked); clicking a row opens or focuses that
  page in a tab with the drawer already open, and each row carries its
  own export-to-Obsidian crystal. The council's "Plugin pages" project
  keeps persisting underneath, but the plugin is now the front door to
  its own chats.

- **Web annotator: the ⚙ popover is now a small agents panel.** Per
  agent: logomark, model picker, a council-style context gauge (whole
  percents, compact tokens, a tick at the 50% auto-relay threshold) and
  "memory reset Nm ago" relay provenance, plus relay / relay-both
  buttons (`POST /relay` → `/relay @…` control turns; an idle bridge
  refuses with "agents are idle — nothing to relay" instead of
  spawning). Agent status rides on `GET /models` and the `models`
  broadcast, pushed only on meaningful change. The sleeping state is
  explicit — dimmed rows, "agents are asleep — they wake on the first
  @mention" — instead of an empty-looking popover.
- **Web annotator: tool activity reads like Claude Code.** Bridge tool
  summaries (`stream_id` suffix `:tools`) persist as `kind:"tools"`
  msgs, render as one collapsed "Explored · N steps" row always hoisted
  above the answer, and stay out of Obsidian exports. Turn events carry
  the engaged `agents`, and the working chip is now logomark
  avatar-rings whose spinner follows the floor on `@all` turns.
- **Web annotator fixes from live use**: deleting a thread's last
  message deletes the thread (stale empty threads heal on read, so
  orphaned highlights unpaint); composers clear only on successful
  send; bot replies render safe markdown; the drawer pushes the page
  aside and is drag-resizable; comment-thread replies are terser by
  prompt; export button wears the Obsidian crystal.

- **`botference plugin --install-autostart` — the companion, always
  there (macOS).** Installs a login LaunchAgent
  (`com.botference.plugin-web`) for the workspace you run it from, with
  KeepAlive, a PATH that can still find `node`/`python3`/the agent CLIs,
  any `--port`/`--no-agents` baked in, and output appended to
  `.botference/logs/plugin-autostart.log`; it loads immediately
  (`launchctl bootstrap gui/$UID`). A hand-run companion still wins —
  it holds the workspace lock and the launchd copy takes over ~10s
  after you Ctrl-C it. `--uninstall-autostart` boots it out and deletes
  the plist (idempotent). Neither combines with `--service`.

## 2026-08-07

- **`botference plugin` — the web annotator.** The review-doc experience
  on any static article page: a Chromium/Brave extension
  (`frontends/plugin/extension`, load unpacked once) plus a local
  companion server (port 4189). Highlight text → comment; an
  `@claude`/`@codex`/`@all` mention in any message — including a later
  reply — summons the bots, whose answers stream inline into a
  right-side drawer (Comments tab: threads anchored to highlights;
  Page chat tab: one conversation about the whole page; last-used tab
  remembered per site). Anchors are quote+context and degrade to an
  "orphaned" badge on changed pages, never losing a comment. Every page
  exports to one Obsidian note (blockquoted highlight + thread per
  entry, page chat appended); bot conversations persist as council
  chats under the **Plugin pages** project, titled by the article's own
  headline — archive/delete them from the council as usual.
  `--service` runs the companion detached (`plugin-web`);
  `--no-agents` serves annotations-only. Docs: README "Web Annotator",
  man page, `botference plugin --help`.

## 2026-08-06

- **`/relay @both` — reset both agents at once, token-efficiently.** The
  agent with the most context headroom authors **one** shared handoff;
  both fresh sessions bootstrap from it (author's copy is tier `self`,
  the peer's `cross`) and the restarts run in parallel. One generation
  instead of two; falls back to the free mechanical handoff when even
  the healthiest agent is ≥ the cross-tier ceiling. Aliases: `@all`,
  `/relay-both`. With only one live session it degrades to a normal
  single relay.
- **Council web: agents panel.** A per-agent condition dashboard — right
  rail on wide desktop; on phones/narrow windows it slides in from the
  right via its own header toggle, keeping the left drawer purely
  projects and chats (context usage finally readable on mobile).
  Each card: context gauge with whole percents and compact tokens
  (`43% · 86k / 200k`) and the 50% auto-relay threshold ticked, live
  activity (current tool + target), model picker, a relay button, and
  relay provenance ("memory reset 12m ago · self handoff") fed by new
  additive status fields (`*_last_relay_at`/`*_last_relay_tier`,
  persisted with the session). Panel footer: **relay both**, the
  auto-relay toggle (moved from the sidebar), and session facts
  (project/mode/lead/route) — the top status strip slims down to
  connection state plus a rounded `C 43% · X 62%` glance instead of
  full-precision floats.
- **Council web: markdown tables render as tables.** A sign-off sheet
  from a bot now arrives as a real table (alignment, inline formatting
  in cells, escaped markup, horizontally scrollable on phones), not a
  wall of pipes. Bare piped prose without a `|---|` delimiter row stays
  prose.
- **Council web: the sidebar's recent chats are live and honest.** Three
  fixes. (1) The projects snapshot is now treated as *workspace* state on
  the server: the freshest snapshot from any chat's bridge fans out to
  every tab (re-marked so each tab keeps its own chat flagged active) and
  is replayed on attach — previously each tab replayed its own bridge's
  stale listing, so the sidebar time-traveled backwards on chat switches
  and never heard about other chats' activity. (2) Recency now means *last
  message*: `updated_at` bumps only when the transcript (or title)
  actually changed, and the panel sorts by it — merely opening a chat
  re-saved its file and let opened-but-idle chats outrank
  recently-messaged ones. (3) The phantom "chat not found" toast is gone:
  the client no longer pre-judges deep links against the truncated
  8-per-project panel listing (and it now scans Inbox rows for the active
  flag) — the server, which checks the session files on disk, is the
  authority, and only a genuine `route_error` toasts.

## 2026-08-05

- **`botference see` renders local files.** A target that is an existing
  file (HTML, SVG, …) renders via `file://` — the way agents verify
  charts, reports, and mockups they just wrote, with no server and no
  hand-rolled ImageMagick/qlmanage lanes (whose SVG engines have
  artifacts Chrome does not). Works through the see-broker too: file
  targets are absolutized client-side, requests made from a
  subdirectory spool to the nearest enclosing workspace, and the broker
  now also watches `projects/*/` spools of registered workspaces, so
  ledger-less project dirs are covered.

## 2026-08-01

- **`/allow-host <domain>` — grant the bots a website when you say so.** The
  bots' shell sandbox restricts network access to an allowlist (by design:
  they execute commands autonomously while reading untrusted web content).
  Granting a new site used to mean editing code and restarting. Now it's a
  chat command: the grant persists per workspace
  (`.botference/allowed-hosts.json`) and the Claude adapter re-reads it at
  every spawn, so it applies from the bots' very next turn with no restart.
  Bare `/allow-host` lists grants; the bots' prompt tells them to ask you
  for it rather than work around a blocked fetch. (`ai-2040.com` also joined
  the default allowlist for the active review project.)

## 2026-07-29

- **Review hub: the portal runs the estate, not a config file you hand-edit.**
  Set `"workspace"` in `~/.botference/review-hub.json` and every directory
  under `<workspace>/projects/` becomes a review candidate — *scaffolded*
  once it has `review/review.config.json`, *not set up yet* otherwise. The
  owner portal lists all of them (running, stopped, never set up) merged
  with the explicit `papers` entries, an explicit entry winning any slug or
  directory collision.
- **Review hub: on/off toggles.** Turning a paper on scaffolds it if it was
  never set up, picks a free port from `"portRange"`, runs `cloudflared
  tunnel route dns review <slug>.<domain>`, and starts it hosted as a
  managed service with a generated guest password and the hub's owner
  password in its env. A failed DNS route is surfaced with the exact command
  to run and never stops the paper coming up. Turning it off stops that
  paper's service by its ledger entry, from the paper's own directory —
  never a pattern kill. Papers published by hand under the older
  `review-share` name are still found, because the lookup is scoped to that
  paper's own ledger.
- **Review hub: wake-on-request.** Asking for a paper whose server is down
  now starts it — if you are the owner — behind a self-refreshing
  "starting…" page. Guests keep getting the friendly "work from the git
  repo" page: starting a paper is never a guest's decision.
- **Review hub: passwordless owner devices.** A new browser can ask to be
  trusted; the hub fires a macOS notification and dialog on the machine, and
  Approve hands that browser a one-year HMAC-signed cookie scoped to the
  parent domain, so it is the owner on the paper subdomains too (which is
  what makes wake-on-request work from a phone). Pending requests expire
  after five minutes, denied and expired devices are told plainly, and the
  portal on the machine itself can approve when no dialog appears.
  `REVIEW_HUB_PASSWORD` still works; deleting
  `~/.botference/.review-hub-device-secret` revokes every device at once.
- **Review hub: private by default.** A newly enabled paper gets a generated
  guest password and an *empty* `collaborators` list, so it is invisible and
  unreachable to everyone but the owner until the owner declares who may see
  it. Existing declared collaborators are unaffected. Passwords live in
  `~/.botference/review-paper-secrets.json` (mode 0600), never in the config.
- **Review hub: every project's files, at the portal, with zero setup.** Not
  everything a project produces is a scaffolded review — plots, HTML
  reports, notes. Each discovered project is now browsable at
  `/p/<slug>/files/`, served by the hub process itself: no review
  scaffolding, no paper server, no DNS record. Owner-only, always (a
  declared collaborator on a paper still gets 403). Dot-segment path
  components — `.git`, `.botference`, any dotfile — and traversal are
  refused, symlinks are resolved and re-checked so they are not a way out,
  and a project's own HTML is served under `Content-Security-Policy:
  sandbox` with an opaque origin, so a report's scripts run but can never
  act as the owner against the hub.
- **`botference review --setup`** scaffolds and builds, then exits without
  serving; **`--hosted --service`** (with optional `--service-name`) runs one
  hosted server under the managed service lifecycle, pinned to the paper's
  own ledger. These are the two primitives the hub's toggles drive.
- **Deliverables get a permanent home and a permanent link.** The bots'
  standing instructions now say: anything the user will open again (plots,
  HTML pages, reports) is saved into the chat's project folder
  (`projects/<id>/artifacts/`, or `work/artifacts/` for Inbox chats) and
  linked in chat as `/files/<relpath>` — never served from ad-hoc HTTP
  servers or throwaway tunnels. The council server gains the matching
  auth-gated `GET /files/` route over the workspace (dot-segments like
  `.botference` refused, traversal blocked), so those links work on every
  device for as long as the file exists.
- **Council transcript: the reply is the last thing in a turn, not the tool
  calls.** The "Explored …" tool-run entry is emitted at turn end — after the
  agent's text already streamed in — so it used to land *below* the reply,
  making every turn look unfinished. The web client now renders it as a
  visually distinct collapsed card ("claude explored · N steps", expandable
  to the full step list) and slots it *above* the agent's message, so the
  final reply always closes the turn.
- **Council sidebar: a flat "Recent" list.** The panel now ships the Inbox's
  recent chats too (`inbox_sessions` on the projects event, same newest-first
  shortlist every project already got), and the web sidebar opens with a
  Recent section — the latest chats across Inbox and every active project in
  one ordered list, each row tagged with a small project chip. Finding a chat
  no longer requires remembering which project it lives in.
- **Council sidebar: the new-project form has a Create button.** Typing a
  title and tapping anywhere else used to discard it silently — the project
  was never created and nothing said so. There is now a visible Create
  button beside the field (Enter still works), and dismissing the form with
  text in it shows a "project name discarded" toast.
- **`/file` actually files the chat now.** Filing the chat you are sitting
  in (`/file <project>`, `/add-to-project`, `/project assign <project>`, or
  the no-args picker) used to write only `projects/session-index.json` and
  print success — then the very next turn's save silently put the chat back.
  Membership is resolved payload-first everywhere (project panel, `/resume`,
  restore), and `_persist_session()` re-stamps both the payload and the
  index from the room's active project after every turn, so an
  index-only write never had a chance. **A chat's project is the project its
  room is in at save time**, so filing the current chat now moves the active
  context with it — exactly what the `/project open <target>` workaround was
  doing by hand. The confirmation says so ("…is now the active project",
  plus where plan writes land). Every "file the current chat" path (`/file`
  with and without args, `/project assign`, the "Where should this chat
  live?" card after `/new`, `/project create`) funnels through one helper.
- **`/project assign <session-id-prefix> <project>` moves the other chat on
  disk.** It now rewrites that session's `project_id` in its saved JSON
  (atomic write + the locked single-row metadata-index sync) as well as
  associating it in the index, so a chat whose payload already named a
  project actually moves and reopens in its new project. Best effort by
  design: if that chat is open in another bridge process, that process
  re-stamps its own active project on its next save. Filing someone else's
  chat still leaves your room where it was.
- **`/project clear` no longer leaves the chat listed under the project it
  just left.** Clearing writes an empty payload `project_id`, which falls
  back to the session index — so the stale association is now dropped too.

- **Browse any project's chats without "activating" it.** The web sidebar
  now expands every project — active, inactive, or archived — to its 8 most
  recent chats, and tapping a chat just opens it. The `→ make active
  project` row is gone: opening a chat IS how you enter a project, and
  filing a new chat is already covered by the "Where should this chat live?"
  card after `/new`. Every project header is a chevron toggle (the active
  one included); the project you land in auto-expands, but a manual collapse
  sticks until the active project changes again. The per-chat **⋯**
  Archive/Delete menu, **⊘ archive project**, the **Archived** section and
  the split **＋ New** control are unchanged.
  - Controller: `project_panel_snapshot()` builds the recent-chat shortlist
    for **every** project out of the same single sweep that already computed
    the counts (cached metadata index → title/updated_at, plus the tiny
    project-local `sessions/` dirs). No extra file reads per turn; only
    `(mtime, id, title, updated_at)` tuples are accumulated, and the
    shortlist stays capped at 8 per project. Counts keep their
    dedupe-by-session-id semantics, and a chat reachable from both the
    global store and a project-local dir is still listed exactly once.
  - `/resume <id|title>` now reaches a chat filed under *any* project — it
    falls back to an all-projects lookup when the active project has no
    match (fallback only, so the hot path is untouched). Restoring a chat
    makes that chat's project active, including legacy chats whose project
    is only recorded in `projects/session-index.json`.
  - The Ink TUI still expands only the active project; the extra payload is
    ignored there (covered by a regression test).

- **Archive, don't delete — for chats and for projects.** Two new
  controller commands put a chat away without destroying it:
  `/archive [<id-prefix>|list]` *moves* `work/sessions/<id>.json` to
  `archive/sessions/` (`BOTFERENCE_ARCHIVE_DIR`) and `/unarchive
  [<id-prefix>]` moves it back. A move is one atomic rename, so nothing
  is rewritten, every listing (which globs `work/sessions/`) simply
  stops showing it, and there is no payload flag for a second bridge
  process to race on. Archiving is reversible, so it asks for no
  confirmation; archiving the chat you're in saves it first and then
  rolls into a fresh `/new`. `/unarchive` refuses to overwrite a live
  chat with the same id — the archived copy is left untouched rather
  than clobbering newer state. Both tolerate a file another process
  already moved or deleted. Projects get the same treatment via
  `/project archive <id>` / `/project unarchive <id>`, which flips only
  the `status` field in `projects/portfolio.json` — the folder, its
  PROJECT.md, and every chat filed under it stay exactly where they are;
  archiving the active project drops the room back to Inbox.

- **Council web sidebar: per-chat actions, archived projects, and a
  split New control.** Every chat row now has a **⋯** menu with
  **Archive** and **Delete…**; both send the plain slash command through
  the normal input path, so `/delete`'s confirmation is the controller's
  own choice card in the transcript (asked once, not twice). Each
  project block offers **⊘ archive project**, and non-active projects
  collapse into an **Archived** section at the bottom of the sidebar —
  closed by default, with **↩ unarchive project** inside — so a long
  history of finished work stops crowding the list. The old "New chat"
  button became a split control: `＋ New` with `chat` / `project`
  stacked beside it, where `project` opens an inline title field and
  sends `/project create <title>` (no modal, no `prompt()`, thumb-sized
  on a phone). `/project ` also gained scoped autocomplete for its
  subcommands. Tests: three new happy-dom sidebar cases in
  `tests/council-web.test.mjs`, plus `TestChatArchive` /
  `TestProjectArchive` in `tests/test_botference.py`.

- **Fixed chats showing up under the wrong project (and vanishing from
  the one they were filed in).** Now that a workspace is driven by
  several processes at once — the Ink TUI plus one web-council bridge
  per open chat — every `SessionStore`/`ProjectStore` was
  read-modify-writing the same shared index files with no coordination,
  so the last writer silently overwrote the others. Three concrete
  faults, all fixed:
  - `work/sessions/.metadata-index.json` was rewritten WHOLESALE from
    each process's private in-memory cache. That deleted rows for chats
    the writer had never seen and republished its stale `project_id` for
    chats another process had since moved. Writers now merge into the
    file they re-read under a lock and publish only the rows they
    actually verified this pass, freshest mtime winning per row.
  - A row's mtime was read by stat-ing the session file AFTER the atomic
    rename, so a writer that lost a race pinned its own stale data to the
    winner's timestamp. Nothing ever re-parsed that chat again, and the
    wrong project stuck permanently — the "rockets chat under Health &
    Fitness" report. The mtime now comes from the inode we wrote, so a
    row that lost a race simply loses the merge and self-heals.
  - `projects/session-index.json` was a non-atomic, unlocked
    read-modify-write. Concurrent writers dropped each other's
    associations wholesale (a stress run with three writers lost 119 of
    121 filed chats, including one filed via `/project assign` and never
    touched again), and readers that hit a half-written file saw NO
    memberships at all — every chat blinking into Inbox. Writes are now
    atomic and locked, and a chat already filed where it belongs is no
    longer rewritten on every persisted turn.
  Also: the project panel now counts and lists each chat ONCE when it is
  reachable from both the global store and a project-local `sessions/`
  dir (the duplicate-rows report), `prune_empty` drops pruned rows from
  the shared index instead of leaving corpses for other processes, and
  the panel scan no longer mutates the metadata cache the controller's
  save path is writing. On-disk formats are unchanged — existing
  sessions, indexes and associations load as-is.

## 2026-07-28

- **Council web: true multi-tab chats — one bridge per open chat.**
  The server previously drove a single bridge with one global "active
  chat", so the `#/chat/<id>` URL was cosmetic: a second browser tab's
  message landed in whichever chat was last resumed anywhere. Now the
  server keeps a bridge POOL: a tab connecting with `?chat=<sid>`
  (derived from its `#/chat/<sid>` hash) attaches to the bridge driving
  that chat, spawned on demand with an automatic `/resume`; every POST
  names its bridge. Tabs on different chats are fully concurrent
  sessions behind the same tunnel; tabs on the same chat share one
  bridge and see the same live stream. Sidebar/hash chat switching
  re-attaches the tab's event stream (offscreen replay reconcile, cached
  optimistic paint — never a blank flash) instead of sending `/resume`
  through a shared bridge; a typed `/resume` of a chat already open in
  another tab is intercepted server-side and re-attaches instead of
  forking the session into two processes. Unknown chat ids fall back to
  the primary bridge with a toast. `COUNCIL_MAX_CHATS` caps the pool
  (default 4); idle, unwatched bridges are parked at the cap. `/quit`
  now closes its own chat's bridge; the server exits with the last one.
  Docs: README, man page. Tests: pool routing/isolation over live WS,
  route_error fallback, reworked switch/hash-routing DOM tests.

## 2026-07-24

- **`botference see` — eyes for agents.** Renders any page in headless
  system Chrome (no Playwright, no install) and writes one PNG per
  viewport (defaults 390x844 + 1440x900), printing paths for the agent
  to read back. Targets: a URL, a bare `:port`, or a running
  `botference service` NAME — the listening port is discovered from the
  live process via the ledgers, so agents never need to know ports.
  Rationale: layout/design failures produce no errors or logs, so a
  code+logs loop ships pages that "work" but look broken (the fitlog
  chart sat squashed for days). `--viewport WxH` (repeatable),
  `--basic-auth`, `--out`; virtual-time budget lets client-drawn charts
  finish before the shot. Tests: `tests/see.test.mjs`.
  **Sandboxed agents included, via the see-broker:** seatbelt kills
  Chrome inside agent sandboxes ("Abort trap 6"), so when a local
  render fails wholesale the SAME command hands its argv to the
  `see-broker` service (`botference see --serve`, started once via the
  service ledger) through `.botference/see/` request files; the broker
  renders outside the sandbox in the requesting workspace and answers
  with identical `wrote:` output. Deterministic filesystem protocol,
  no sandbox loosened, `set -e`-safe throughout.

- **Claude Opus 5 (`claude-opus-5`, released today) added and made the
  suggested Opus everywhere.** Registered in both context-window tables
  (1M); now the default in `resolve_cli_model`/`resolve_context_window`,
  the monitor, and `botference_agent.py`; the Fable credit-exhaustion
  hint suggests Opus 5 (same $5/$25 pricing as 4.8, strictly better);
  first Opus offered in the review and council model switchers and the
  TUI `/model @claude` completions. Opus 4.8 stays selectable — existing
  sessions keep working — it's just no longer what anything suggests.

- **Review hub: one stable front door for every hosted paper review**
  (`frontends/review/hub.mjs`). Run it behind a single named cloudflared
  tunnel: the hub hostname serves a gated portal that lists each visitor
  only the papers their login opens (checked against each paper's own
  `/auth` — the hub stores no passwords) or that declare them in a
  `collaborators` list; each paper's hostname is transparently proxied
  (headers, cookies, SSE, rate limits untouched) to its local
  `--hosted` server, and a paper whose server is down gets a friendly
  "work from the git repo" page instead of a 502. Localhost is the
  owner: no login, every paper listed with direct links; set
  `REVIEW_HUB_PASSWORD` and that password opens the same full owner
  view from any device (the phone case). Config
  `~/.botference/review-hub.json` (env `REVIEW_HUB_CONFIG`), re-read
  per request — adding a paper is a config entry + one `cloudflared
  tunnel route dns`, no restarts. Tests: `tests/review-hub.test.mjs`.

- **Review server: `REVIEW_OWNER_PASSWORD` — the owner from any
  device.** With this second password set, the hosted gate signs its
  bearer in AS the owner regardless of the name typed: the auth cookie
  carries the owner's real handle and the redirect carries
  `?owner=<token>`, which the client already banks — so a phone gets
  full owner standing (accept/apply/commit, releasing agent summons)
  with no token copy-paste. The guest password and every existing rule
  (owner handle refused at the guest gate, token never guessable) are
  unchanged; without the env var nothing differs.

- **Fixed "No thread to resume — call send() first" after interrupting a
  starting codex turn.** Task cancellation is a `BaseException`, so the
  `except Exception` cleanup in `_start_model_session` never ran: the
  model stayed marked initialized with no thread, and every later turn
  tried `resume()` and died. Interrupts now unmark the model (and stash
  the relay handoff, when there is one), and a start that "succeeds"
  without ever yielding a codex thread id is likewise treated as
  uninitialized — the next turn re-sends instead of resuming a ghost.
  Recovery on old bridges: switch to another chat and back (restore
  already applied the same invariant).

- **Council web: fixed `/new` (and the sidebar New chat button) being
  undone by the chat-id URL.** Since chat IDs landed in the URL hash,
  every session-list update re-ran the hash router, so a stale
  `#/chat/<old-id>` immediately resumed the old chat after any
  server-side switch — `/new` appeared to "continue an old chat", and
  a hash naming a deleted/pruned session raised a spurious "chat not
  found" toast. The hash now drives navigation only on initial page
  load (deep link / reload) and on real `hashchange` events; on later
  session-list updates the URL follows the active chat instead.

## 2026-07-23

- **`botference service list` is now global.** Ledgers stay
  per-directory, but every `service start` registers its ledger in a
  self-maintained index (`~/.botference/ledgers`) and `list` reads all
  of them — every running service is visible from any directory, with a
  DIR column showing where each lives. `stop` and `logs` remain scoped
  to the current directory's ledger (you can't fat-finger a kill across
  projects); run them from the DIR shown. Existing ledgers are picked
  up the first time `list` or `start` runs in their directory. Dead
  entries reap per-ledger; index lines whose ledgers vanish are pruned.

- **Review: humans can suggest text, not only ask a bot to.** The
  composer now has two modes on any highlight — **Comment** (unchanged)
  and **Suggest**. A human suggestion prefills `current_text` from the
  exact selection, offers an editable proposal, renders **inline in the
  body** as strikethrough + replacement in that human's own author
  colour (the same rendering path bot suggestions use), and flows
  through the identical accept → ⚡ Apply → ✓ Commit pipeline. File
  ownership is preserved absolutely: a human's suggestions live in
  their own `state/users/<handle>.json` as `user-suggestion` entries;
  `suggestions.json` stays bot-owned. `apply.mjs` merges both sources
  and is author-agnostic.
  **Unique anchoring is resolved at compose time, not apply time.** The
  composer reads the real source file (new read-only `GET /source`,
  restricted to configured files) and refuses to save a suggestion it
  cannot anchor uniquely: an ambiguous prose span is widened word by
  word with surrounding context until it matches exactly once, and the
  UI shows what it locked onto. Headings anchor on the **enclosing
  LaTeX macro** (`\section{Introduction}` → `\section{New Title}`),
  never the bare word. A paper-title suggestion targets `\title{}` in
  the master, or — for papers that have no `\title{}` and take their
  masthead from `review.config.json`'s `title` key — that JSON key,
  applied **JSON-aware** (parse → set → re-serialize, with a drift
  guard). A JSON file is never string-replaced.

- **Review: everything is commentable.** Section headings, list items,
  block quotes, figure captions and table cells were completely
  uncommentable — selection anchoring found nothing and the composer
  silently never opened. They now carry anchors, and the masthead title
  (which had a `data-cid` but sat outside `#paper`, so half the code
  skipped it) fully participates in block collection and tracked-change
  rendering. **No existing comment moved**: `blk-N` is a positional
  index over `#paper p, #paper figure` that every live paper's comments
  are anchored to, so that selector is frozen byte-for-byte and each
  new type got its own independent namespace (`-hd-N` for headings,
  `-misc-N` for the rest). A regression test asserts the `blk-N` list is
  unchanged and holds only paragraphs and figures.

- **Review: the handle field moved onto the hosted gate page.** In
  hosted mode the "who are you?" picker rendered into the desktop
  sidebar footer — which on a phone or tablet is a drawer, so a guest
  could authenticate and then never pick a handle, and *everything they
  wrote was silently dropped*. The password gate now asks for a name
  and the password together; the name comes back in a readable
  `review_handle` cookie (the auth cookie stays HttpOnly) and seeds the
  browser's handle slot. Auth is not weakened: the name is not a
  credential, the password still is, and claiming the owner's handle is
  refused at the gate exactly as it is in `who()`. The sidebar picker
  remains for changing your name later.

- **Review: presence shows people, not just bots.** The top-right
  cluster now lists humans (initials disc in that handle's hashed
  author colour — the same colour as their comments and chips) and
  agents (brand glyph + rotating working ring), separated by a hairline
  so the two are never confused. Activity is computed from **real
  interaction** rather than from holding a connection open: *active* =
  pointer/scroll/key/selection within 60s and the tab visible; *idle* =
  visible but untouched, or hidden (reacted to immediately); *offline* =
  no beat for ~45s. A small `POST /beat` every ~15s carries
  `{state, section, focused_id}` and the server fans a `presence` event
  out over the existing WebSocket/SSE stream. **Presence is in-memory
  only and is never written to disk — there is no attendance log.** It
  is symmetric (everyone sees everyone identically) and coarse (state
  and section, nothing else). Desktop only; phones send no beats and
  simply don't appear, keeping full read + comment.

- **Review: per-handle agent grants + a People panel.** Hosted mode was
  binary — owner, or guest whose every `@tag` queued for release. A
  third tier: owner-written `state/grants.json`
  (`{"<handle>": {"agents": true, "daily_cap": N}}`), toggled per person
  in a People panel expanded from the presence cluster. A granted handle
  within its cap goes straight to the bridge; over cap it returns to the
  queue with an honest "daily cap reached (N/N)" message. **The cap is
  visible to the granted guest in their own sidebar** ("4 of 5 agent
  calls left today") — a budget that teaches judicious use, not a silent
  throttle. Apply, Commit, Revert, model switching and permission/choice
  answers stay owner-only forever; a grant never confers them, and
  revocation takes effect on the next request.

- **Review: task console for document-level instructions.** A
  bottom-docked collapsible bar (owner-only, desktop-only) for
  instructions that have no anchor text: "apply all", "commit",
  "restructure section 3", "verify every citation resolves". This is
  *not* a chat about the paper — that remains rejected; anything about
  the text stays an anchored margin comment. Routing is as strict as
  everywhere else: nothing reaches an agent without an explicit
  `@claude`/`@codex`/`@all`, and console turns carry a DOCUMENT-LEVEL
  envelope so bots answer in the turn instead of writing a thread entry.
  The **Changes widget** (Apply / Commit / Revert / out-of-band commit)
  moved out of the sidebar and into it, because committing *is* a
  document-level task.

- **Review: settings panel (gear in the avatar cluster).** Owner-only,
  desktop-only slide-over showing live per-agent context occupancy
  (exact, from the bridge's own status events), this session's turns and
  prompt tokens per agent **and per handle** (the mention payload
  already carries the author, so each turn is attributed to whoever
  triggered it), a today/this-week rollup of *real billed* cost from
  botference's `logs/usage.jsonl` when present, and the model switcher —
  **relocated here** from the sidebar, where it held permanent space for
  a rarely-touched control, keeping its credit-exhaustion warnings. The
  session money figure is labeled an estimate with its basis stated: the
  CLI bridge reports prompt occupancy, but neither output tokens nor
  billed cost. There is deliberately **no subscription-quota meter** —
  no provider exposes Pro/Max or ChatGPT plan quota to anything but its
  interactive CLI, so the panel says exactly that and points at `/usage`
  in Claude Code rather than inventing a number.

- **Review: the 🚩 "Flag for agents" button is gone.** Agents engage
  only via an explicit `@tag`, so the flag was a redundant second
  mechanism that *looked* like it summoned someone while doing nothing
  but writing `state/summon.json`. The button, the `POST /summon`
  endpoint and the file are all removed.

- **Auto-relay at 50% context (on by default).** botference now watches
  each model's context occupancy and relays it automatically — same
  handoff machinery as `/relay` — once it crosses 50% of its context
  window, so long sessions roll over to a fresh, summarized session
  before they get expensive or overflow. The relay is always deferred to
  a safe boundary: it never fires mid-turn or inside a free-form
  bot-to-bot thread, landing before that model's next turn (or right
  after the current thread ends). A loop guard arms exactly one relay per
  crossing and re-arms only after occupancy drops back below the
  threshold. Toggle with `/autorelay [on|off]` (TUI, shown in `/status`)
  or the new Auto-relay toggle in the web council sidebar; the preference
  persists per-user (`~/.botference/settings.json`) and the pending flag
  is snapshotted with the session so it survives restarts. Threshold is a
  module constant (`AUTO_RELAY_THRESHOLD_PCT = 50`).

- **Council web: subagent progress lane.** When the Claude bot spawns
  Claude Code subagents (the `Task`/`Agent` tool), the browser now shows
  an inline card in the bot's in-progress turn — one row per subagent
  with a pulsing status dot, the agent label (from the Task description),
  a live-ticking elapsed clock, and the latest tool activity as
  `ToolName · target` (long paths middle-truncated). A finished agent
  collapses to a compact `label · duration · N tools` summary, and the
  card freezes into the transcript at turn end so past turns still show
  what their agents did. The stream events the bridge already forwards
  now carry `parent_tool_use_id` (attributing each tool event to its
  agent) and, on a `Task`/`Agent` tool_use, an `agent_label`; because
  those events live in the replayable history, the lane rebuilds on
  reload.

- **Council web: chat id in the URL.** Opening or switching a chat writes
  `#/chat/<session-id>` (via `history.replaceState`, so it stays out of
  the back-button history), so the address bar is now a shareable
  per-chat link. On load and on `hashchange`, the referenced chat is
  reopened if it exists; an unknown id falls back to the current chat
  with a brief, non-blocking notice.

## 2026-07-22

- **Council web: slash-command autocomplete no longer goes dark.** The
  bridge emits `completion_context` exactly once at startup, and the
  server kept it only in the replayable event history — which chat
  switches wipe (`clear_panes`) and long chats front-trim, so any page
  load after either replayed a history without it and `/` suggested
  nothing. The server now pins the latest `completion_context` outside
  history and replays it to every client on connect (SSE and WS), and
  the client seeds a built-in fallback command list (mirroring
  `get_completion_context()`) so completions work even against an
  older running server — a browser refresh is enough, no server or
  tunnel restart. Notably restores discoverability of `/agents on`,
  the per-chat grant that lets the web council's Claude spawn
  subagents (e.g. steering Opus workers) mid-session.

- **Review masthead titles are never blank.** `botference review` on a
  document without `\title{}` used to scaffold `"title": ""` and render
  no masthead ("never guessed" policy, retired). Detect now derives a
  title — markdown H1, else the humanized folder name — and says so in
  its summary; the builder applies the same fallback at build time, so
  existing deployments pick it up via `botference review --upgrade`
  without config edits. An explicit config `title` still wins, and
  `"title": false` opts out of the masthead entirely. The hosted-mode
  gate page uses the same fallback instead of "Document review".

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
