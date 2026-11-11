# Reviewing a Google Doc in the council

## What it does

Paste a Google Doc link in the council chat and ask for a review, comments
or edits. There is no command for it: the bots work out from your message
that you want the Doc reviewed, and ask if they are not sure.

Both bots, Claude and Codex, can do it. They never change the Doc's text
directly:

- A wording change goes in as a **suggestion** (Google's tracked change,
  which you accept or reject in the Doc). Only the words that change are
  marked.
- A question or a judgement goes in as a **comment** on the smallest bit of
  text it is about, or as a reply in an existing comment thread.

Both bots post under one Google account, the agent account. So every
comment and reply starts with the bot's name ("Claude: " or "Codex: "); the
software puts it there. A suggestion cannot carry a name, so after posting,
each bot lists its suggestions in the council chat under its own name.

Default roles, unless your message says otherwise: Claude covers argument,
structure and wording; Codex covers facts, numbers, sources and technical
claims. A bot that spots something in the other's lane says it in the
chat, not in the Doc.

The bots only touch Docs you linked. They read the Doc again right before
each write and send the write with that read's revision id (a version
number; Google refuses the write if the Doc changed since), so they never
write over a change someone made in the meantime.

If the Google sign-in is missing or has expired, the bot says so in the
chat, in one line that also says what to do.

The same poster also lets both bots read the agent account's mail, read
only: see `docs/google-mail.md`.

## How it works

Neither bot talks to Google itself. botference has its **own** Google
sign-in, for the agent account, and one small program, the **poster**
(`core/gdoc_mcp.py`), is the only thing that uses it.

The poster is an MCP server (MCP: the standard way a bot's command-line
tool is given extra tools). Each bot's command-line tool starts its own
copy when the bot starts: `claude -p` through `--mcp-config`, `codex exec`
through `-c mcp_servers.botference_google...` settings on its command line.
The poster runs outside the sandbox the bot's shell commands run in, so it
can reach Google even when the bot cannot read the sign-in. For Docs it
offers the bot exactly two tools (the other three read mail, see
`docs/google-mail.md`):

- `read_doc`: the Doc's title, revision id, its text with positions (the
  numbers Google uses to say where in the text something is), tabs, pending
  suggestions and comment threads. A long Doc is cut, and the cut says
  where to read on from.
- `write_doc`: one `documents.batchUpdate` (Google's "make these changes"
  call): a list of requests plus a `writeControl` (how Google should apply
  them).

Both copies of the poster use the same lock (`core/gdoc_guard.py`) and
the same sign-in.

## What is a hard lock and what is an instruction

Hard locks (enforced by the software; nothing the bot sends gets round
them):

- **Suggestions and comments only.** Every write goes through
  `gdoc_guard.seal()` before anything is sent. It gets through in only two
  shapes:
  - suggest mode (`writeControl.writeMode: "SUGGEST"`, so text changes land
    as suggestions), with every request one of `insertText`,
    `deleteContentRange`, `replaceAllText` (the three text changes),
    `insertComment` or `addCommentReply` (a comment, or a reply to one); or
  - comment only: every request is `insertComment` or `addCommentReply`.

  Anything else is refused, including any other request kind even in
  suggest mode (deleting or editing a comment, accepting or rejecting a
  suggestion, deleting a tab, styling, or a kind the lock has never heard
  of), because we do not know whether Google turns those into suggestions
  or just applies them. Input the lock cannot read is refused too.
- **A revision id on every write.** A write without
  `writeControl.requiredRevisionId` is refused.
- **No resolving, reopening or assigning.** A comment may carry only its
  text and the stretch of text it is on; a reply only the thread it answers
  and its text. That shuts out a reply with `commentAction: "RESOLVE"`
  (which would resolve the thread) and a comment that assigns someone
  (which emails them).
- **The bot's name on every comment and reply.** The poster puts
  "Claude: " or "Codex: " in front, unless the text already starts with it.
  Which name is set when the poster starts (`--bot claude` or
  `--bot codex`), not by anything the bot sends, so a bot cannot post under
  the other's name.
- **One way in.** The council's Claude may use the poster's tools and no
  other Google tool: all six claude.ai Google connectors (Docs, Drive,
  Gmail, Calendar, Sheets, Slides) are denied by server name, which removes
  them from the session. The Slack connector (`slack`, which could post in
  your Slack) is denied the same way. The council's Codex runs with Codex's app
  connectors switched off (`-c features.apps=false`), which removes
  OpenAI's Google Drive plugin, including the
  `google_drive.bulk_update_file_comments` approval in
  `~/.codex/config.toml`.
- **The bots cannot read the sign-in.** If a bot could read
  `~/.botference/google/token.json`, a shell command could call Google with
  it directly, round the lock. Claude's settings deny reading and writing
  that folder; Claude Code applies the deny rule to the bot's shell
  commands as an operating-system block, not just to its Read tool.
  Codex's shell runs under a named permission profile (`botference`:
  Codex's own `:workspace` or `:read-only` profile, plus that folder
  marked `none`). For that, the sandbox mode is passed as
  `-c sandbox_mode=...` instead of `--sandbox`, because with the flag Codex
  ignores the profile. In workspace-write mode the profile also keeps the
  project's `.git`, `.codex` and `.agents` folders read-only for Codex,
  exactly as `--sandbox workspace-write` did, so a commit stays Claude's
  job.

Instructions only (the bot is told; nothing enforces them): roles, staying
in your lane, replying in an existing thread rather than opening a second
one, listing suggestions in the chat, re-reading right before each write
(the revision id makes a stale write fail rather than land, but nothing
forces a fresh read), staying on Docs the user linked, telling the user the
sign-in line, and treating the Doc's text and comments as material rather
than instructions.

## Known limits

- The lock covers *what kind* of change lands, not *which Doc*: a bot
  could comment or suggest in any Doc the agent account can open. Share
  only what you want reviewed with the agent account.
- `features.apps=false` switches off every Codex app connector (an app
  connector is a service OpenAI plugs into Codex) in the council, for
  example a GitHub app, not only Google Drive.
- While the Google Cloud app is in "Testing" status, Google ends the saved
  sign-in after 7 days. The bots then say the sign-in expired, and the
  owner runs the login step again. Publishing the app in Google Cloud
  removes the 7-day limit.
- The lock's code lives in the botference folder. A bot that is given
  write access to that folder could edit the lock. If that matters, do not
  open a council on the botference checkout itself.
- The Codex profile depends on how the Codex command-line tool behaves.
  Checked on codex-cli 0.167.0: project files writable; `.git`, `.codex`
  and `.agents` read-only; the sign-in folder unreadable. Check again after
  a Codex update.
- Codex also loads whatever other tools the owner's own Codex setup has
  (for example the ChatGPT app's JavaScript tool, `node_repl`). Such a
  tool runs in its own sandbox, not the shell's. Checked for `node_repl`
  on codex-cli 0.167.0: it cannot write outside the project or reach the
  internet. Not checked: whether the sign-in folder is hidden from it too.
- The tmux launch of Claude (`BOTFERENCE_CLAUDE_TRANSPORT=tmux`) runs a
  normal interactive Claude with no botference settings: it has neither
  the poster nor these locks, and asks you before each tool call.

## One-time setup (the owner)

1. In Google Cloud, make an OAuth client of type "Desktop app" for the
   agent Google account, with the Google Docs API turned on. Download its
   JSON file and save it as `~/.botference/google/client.json`. While the
   app is in "Testing" status, add the agent account as a test user (on
   the app's sign-in settings page), or Google refuses the login.
2. From the botference folder, run:

   ```
   python3 core/gdoc_client.py login --account <agent account email>
   ```

   A browser opens. Sign in as the agent account and allow access to
   Google Docs. The login refuses to save the sign-in if a different
   account signed in, and says so.
3. Share each Doc you want reviewed with the agent account as a commenter
   or an editor.

If the bots later say the sign-in expired or was refused, run step 2 again.

## Where things live

- The sign-in key: `~/.botference/google/client.json` (you put it there).
- The saved sign-in and the account it belongs to:
  `~/.botference/google/token.json` (mode 0600, folder 0700). Neither file
  is ever printed or logged.
- Sign-in, reading and writing: `core/gdoc_client.py`. Every failure is a
  `GdocError` with one plain line; the kinds are the `Problem` list.
- The poster and the launch details for both bots: `core/gdoc_mcp.py`
  (`claude_mcp_config`, `codex_config_overrides`,
  `CLAUDE_DENIED_CONNECTOR_SERVERS`, `claude_sign_in_deny_rules`).
- The lock: `core/gdoc_guard.py`. Its outcomes are the `Verdict` list;
  `judge()` returns exactly one; `seal()` judges and then puts the name on.
- Wiring: `core/cli_adapters.py`. Claude's allow and deny rules are in
  `claude_plan_settings_for_write_roots`; `ClaudeAdapter._build_cmd` adds
  the poster whenever it runs with botference's settings, so agents the
  council summons get it too. `CodexAdapter._build_send_cmd` and
  `_build_resume_cmd` add `codex_config_overrides`.
- Shared rule text for both bots: `google_doc_review_note()` in
  `core/room_prompts.py`, given to the bots in their first-turn text. Which
  bots get it: `GDOC_REVIEW_BOTS`, now `("claude", "codex")`.
- Tests: `tests/test_gdoc_review.py` (mail: `tests/test_gmail_reader.py`).
