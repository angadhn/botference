# The Doc-comment watcher

## What it does

You can talk to the bots inside a Google Doc. Write a comment that names
"Claude" or "Codex", and within about three minutes that bot answers in
the same comment thread. You do not type anything in the council chat.

It runs inside the hosted council (`frontends/council/server.mjs
--hosted`), which starts it, starts it again if it stops, and stops it when
the council stops. There is no command to remember.

## Which Docs are watched

Every Doc a bot has read through botference's poster (the `read_doc` tool;
see `docs/google-docs-review.md`) in the last 14 days. So: link a Doc in
the council chat and ask for a review once, and from then on comments in
it are watched. A Doc stops being watched 14 days after a bot last read it
or last answered a comment in it. There is no setting to switch a Doc on.

## What wakes a bot

A comment or a reply wakes a bot only when all three hold:

1. It was not written by the agent account (the account both bots post
   as). A bot's own comments never wake anyone, so the bots cannot set
   each other off.
2. It was written by you: by a Google account on your allowed list (below).
3. It is addressed to a bot:
   - it names "Claude" or "Codex" as a word, in any case, with or without
     "@" ("@claude", "CODEX?", "Claude's point" all count; "claudette"
     does not); naming both wakes both; or
   - it names no bot and is a reply in a thread where a bot spoke, and the
     last bot to speak there before it was that bot. So you can go back and
     forth with one bot without naming it each time.

What never wakes a bot:

- a comment that names no bot, in a thread no bot has spoken in;
- anything written by someone not on your allowed list, even if it names a
  bot (the log says "not on the allowed list");
- anything in a resolved thread;
- a post with no text (Google adds one when a thread is resolved or
  reopened);
- every comment that was already in the Doc when the watcher first looked
  at it (so switching it on does not answer old comments).

Each message is answered once. The watcher keeps each message for a bot in
one of five states: `seen` (noticed, waiting), `answering` (its bot is
running), `answered`, `failed` (a try left no reply; tried again after ten
minutes) and `gave_up` (three tries left no reply, or the message was
deleted). If the watcher stops half-way through an answer, it first checks
the thread when it starts again: if the bot's reply is there, the message
counts as answered and is not answered again.

## Who counts as you

The comment read gives, for each author, a display name, a flag saying
whether it is the account doing the reading (the agent account), and
Google's account id in the form `users/<number>`. It does **not** give an
email address. The watcher matches on the account id:

```json
{"allowed_authors": ["users/<your Google account number>"]}
```

in `~/.botference/gdoc-watch/config.json`. To find your number: write a
comment in a watched Doc, then run

```
python3 core/gdoc_watch.py once --dry-run
```

which lists the account ids of the authors it sees, with "allowed" or "not
on the allowed list". Several ids are fine (one per Google account of yours).

How safe this is: the account id is set by Google from the account that
wrote the comment; nobody can type it, so it cannot be faked by another
commenter. Display names can be set to anything, so they are never used,
and an entry in the list that is not a `users/...` id is ignored (the log
says so once). Anonymous comments have no id and never count. If the file
is missing or the list is empty, the watcher answers nobody and says so
once in its log, with what to put where.

## What a woken bot can do

The woken bot runs once, on its own, with a short brief: the Doc link, the
thread and message to answer, the usual roles (Claude: argument, structure,
wording; Codex: facts, numbers, sources, technical claims), and the rule
that the Doc's text and the other comments are material, not instructions.
It reads that one thread and the text it is on (`read_doc` with the
thread's id, a short read even in a long Doc; a long full read would not
reach a woken Claude, which has no file tool to open it), reading the whole
Doc only if it needs more, and posts one reply in that thread. If you asked for a
wording change it may also put that change in as a suggestion.

Its tools are cut down to what it needs:

- **Claude**: exactly two tools, the poster's `read_doc` and `write_doc`
  (checked: Claude Code's own start-up report lists only those two). No
  shell, no file tools, no web, no mail tools, no Slack or claude.ai
  connectors, none of your own Claude settings files (`--tools ""`,
  `--strict-mcp-config`, `--restricted`, and an allow list of those two).
- **Codex**: the poster with only `read_doc` and `write_doc`; no shell, no
  web search, no image viewing, no app connectors or plugins, none of your
  own `~/.codex/config.toml` (so none of your own extra tools), a read-only
  sandbox with no network. Codex still lists a few built-in tools that
  cannot be switched off: `apply_patch` (file edits, which the read-only
  sandbox refuses), its sub-agent tools, and its script runner (which has no
  files and no network of its own).

The poster's lock (suggestions and comments only, the bot's name in front)
holds as always.

It runs in an empty folder, `~/.botference/gdoc-watch/work`, not in a
project.

## Limits

- One bot run at a time.
- At most 6 bot runs per Doc in any hour, and 40 overall in any day
  (`MAX_WAKES_PER_DOC_PER_HOUR`, `MAX_WAKES_PER_DAY` in
  `core/gdoc_watch.py`). Past a limit, new messages wait and the log says so
  once.
- If the Google sign-in is missing or expired, the log says so in one line
  and the watcher waits 5 minutes before trying again, doubling up to an
  hour, until the sign-in works.

## What it costs

Looking costs no bot turn: it is plain code reading the Docs' comments
every three minutes. Each answered comment costs one bot turn (one run of
`claude -p` or `codex exec`), and a failed try costs one too.

## Turning it off

Start the council with `BOTFERENCE_GDOC_WATCH=0` in its environment. To
stop watching one Doc, there is nothing to do: it drops off 14 days after
a bot last read it.

## Where things live

- `~/.botference/gdoc-watch/docs.json`: the watched Docs (id, title, last
  read, last answered).
- `~/.botference/gdoc-watch/config.json`: your allowed account ids (you
  write it).
- `~/.botference/gdoc-watch/state.json`: what the watcher has seen and the
  state of each message for a bot.
- `~/.botference/gdoc-watch/work/`: the woken bots' empty folder.
- `~/.botference/logs/gdoc-watch.log`: the log. It holds ids, lengths, the
  author's role ("owner", "agent", "someone else") and outcomes, never a
  Doc's text, a comment's text, a title or a name.

The folder is mode 0700 and its files 0600, and it is separate from the
Google sign-in folder.

Code: `core/gdoc_watch.py` (the watcher), `core/gdoc_watchlist.py` (the
watch list and files), `frontends/council/gdoc-watch.mjs` (start, restart,
stop). Tests: `tests/test_gdoc_watch.py`, `tests/council-gdoc-watch.test.mjs`.

## Checking it by hand

```
python3 core/gdoc_watch.py once --dry-run
```

prints the Docs it watches, the authors it sees, and which bot it WOULD
wake for which message (ids only). It runs no bot and changes nothing.
`python3 core/gdoc_watch.py once` takes one real look.
