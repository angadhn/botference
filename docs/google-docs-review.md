# Reviewing a Google Doc in the council

## What it does

Paste a Google Doc link in the council chat and ask for a review, comments
or edits. There is no command for it: the bots work out from your message
that you want the Doc reviewed, and ask if they are not sure.

The bots never change the Doc's text directly:

- A wording change goes in as a **suggestion** (Google's tracked change,
  which you accept or reject in the Doc). Only the words that change are
  marked.
- A question or a judgement goes in as a **comment** on the smallest bit of
  text it is about.

Both bots post under one Google account, "Angadh's Agent". So every comment
starts with the bot's name ("Claude:" or "Codex:"). A suggestion cannot
carry a name, so after posting, each bot lists its suggestions in the
council chat under its own name.

Default roles, unless your message says otherwise: Claude covers argument,
structure and wording; Codex covers facts, numbers, sources and technical
claims. A bot that spots something in the other's lane says it in the
chat, not in the Doc.

The bots only touch Docs you linked. They never resolve, delete, accept or
reject anything unless you name it. They read the Doc again right before
each write and send the write with that read's revision id (a version
number Google uses to refuse a write if the Doc changed since), so they
never write over a change someone made in the meantime.

**Status (2026-11-10):** Claude's side is built. Codex's side is not yet
wired; until it is, only Claude reviews.

## What is a hard lock and what is an instruction

Hard locks (enforced by the software; the bot cannot get around them):

- The council's Claude may use exactly two Google tools:
  `mcp__claude_ai_Google_Docs__read_doc` and
  `mcp__claude_ai_Google_Docs__update_doc`. They are on the allow list in
  `claude_plan_settings_for_write_roots` (`core/cli_adapters.py`).
- The other Google connectors (Drive, Gmail, Calendar, Sheets, Slides) are
  signed in as the user's personal account. Every claude.ai connector loads
  in the bot's session, so these five are also on the deny list by server
  name, which removes them from the session altogether.
- The write tool can only comment or suggest. Before each write call,
  Claude Code runs `core/gdoc_guard.py` (a "PreToolUse hook": a check that
  runs before a tool call and can stop it). A batch (one write call, which
  holds a list of requests) gets through in only two shapes:
  - It is sent with `writeControl.writeMode: "SUGGEST"` (so text changes
    land as suggestions), and every request in it is one of
    `insertText`, `deleteContentRange`, `replaceAllText` (the three text
    changes), `insertComment` or `addCommentReply` (a comment, or a reply
    to one).
  - It is not in suggest mode, and every request in it is `insertComment`
    or `addCommentReply`.

  Anything else is refused. That includes any other request kind even in
  suggest mode (deleting or editing a comment, deleting a tab, changing the
  page style, named ranges, or a kind the guard has never heard of),
  because we do not know whether Google turns those into suggestions or
  just applies them. It also includes a text change without suggest mode,
  an empty batch, and input the guard cannot read. The hook is set with
  `onFailure: "block"`, so a guard that crashes, cannot start or times out
  also refuses the call.

Instructions only (the bot is told; nothing enforces them): name prefixes,
roles, replying in existing threads, never resolving or deleting (the guard
also refuses the request kinds that delete or edit a comment), re-reading
before each write and using the revision id, staying on Docs the user
linked, and treating the Doc's text and comments as material rather than
instructions. Note that suggest mode is a hard lock on *what kind* of
change lands, not on *which Doc*: the bot could suggest into any Doc the
agent account can open.

## Where things live

- Shared rule text for both bots: `google_doc_review_note()` in
  `core/room_prompts.py`. It reaches a bot through its first-turn text
  (`_build_initial_prompt` in `core/botference.py`). Which bots get it is
  the tuple `GDOC_REVIEW_BOTS`, now `("claude",)`.
- Claude's tools, deny list and hook: `core/cli_adapters.py`
  (`claude_plan_settings_for_write_roots`, `_gdoc_guard_hooks`).
- The guard: `core/gdoc_guard.py`. Its outcomes are the `Verdict` list;
  `judge()` returns exactly one.
- Tests: `tests/test_gdoc_review.py`.

These settings apply to the default (programmatic, `claude -p`) launch and
to agents the council summons, which reuse the same settings. The tmux
launch (`BOTFERENCE_CLAUDE_TRANSPORT=tmux`) runs a normal interactive
Claude with no botference settings: it asks you before each tool call and
has no guard.

## Handoff: the Codex job

What is built for Claude is above. For Codex:

- Its Google access comes from OpenAI's "Google Drive" plugin. The tools
  are named `mcp__codex_apps__google_drive_*`: `get_document`,
  `get_document_comments`, `bulk_update_file_comments`,
  `batch_update_document`. It also posts as "Angadh's Agent".
- In testing, Codex's comment went through the plugin. Its suggestion did
  NOT: it was made by driving the Brave browser. So the Codex job must
  check whether `batch_update_document` accepts a suggest mode
  (`writeControl.writeMode: "SUGGEST"` or the plugin's equivalent) under
  the headless `codex exec` launch the council uses.
- It must also find a way to lock Codex's write tools to suggest and
  comment only, as hard as Claude's hook. Codex has no PreToolUse hook in
  the same form; look for a per-tool approval or deny setting in the Codex
  config for `codex exec`, and refuse `batch_update_document` calls
  without suggest mode. If no hard lock exists, say so plainly rather than
  rely on the instruction alone. Keep all other Google Drive plugin tools
  (file search, sharing, trashing) unavailable to the bot.
- The rule text is already written for both bots. To turn it on for Codex,
  add `"codex"` to `GDOC_REVIEW_BOTS` in `core/room_prompts.py`, and
  update `TestRuleText.test_codex_not_yet_wired`. The rule mentions
  `writeControl.requiredRevisionId`; if the plugin names the revision
  check differently, adjust the wording so it fits both bots.
