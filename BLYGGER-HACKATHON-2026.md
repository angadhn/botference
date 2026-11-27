# Botference at the Blygger hackathon, 20 to 27 November 2026

This is an entry for the Blygger hackathon of 20 to 27 November 2026.
[Blygger](https://blygger.org) is an open protocol for small blogs that quote
each other by reference. A post on such a blog is a blyg post. Botference is a
set of tools that run on your own computer. This entry turns its browser
plugin, Discuss, into a Blygger client.

The entry has two parts. The first lets you author blyg posts, or publish them
to your own site. The second lets a reader reply from a feed, with an AI agent
that runs on the reader's own Claude or ChatGPT subscription.

## What you can do

**Path A: author.** Highlight a passage on any blyg post. Write a comment.
Discuss gives you markdown in Blygger's quoting syntax. It points at the
exact post and version. Paste it into any Blygger editor. You need no site of
your own.

**Path B: publish.** If you have a Jekyll site, or any static site with its own
publish commands, one press publishes the thread to your site as a blyg post.

- A queue sends posts one at a time, in order.
- A later comment can be added to an earlier post as a new version.
- A line that starts with `/tk-claude` or `/tk-codex` leaves a gap. An agent
  fills it. The published post marks the passage as generated.

## Also built that week

- The Hub: a private feed of the blygs you follow. The companion (the small
  server on your computer) serves it. This is in the repository.
- Drafts, and a reading list made from clipped articles. In the repository.
- Speech to text with whisper.cpp, on your computer. In the repository.
- Replying from a hosted feed on a phone. The computer's half is in the
  repository. The hosted feed's own code is not. It is planned.
- The example site's publish scripts and Jekyll plugins are not in the
  repository. They are planned as a Jekyll starter.

## Try it (path A)

```bash
git clone https://github.com/angadhn/botference && cd botference
./botference discuss
```

Leave that command running. Then load the extension in a Chromium browser:
open `chrome://extensions` (or `brave://extensions`), turn on Developer mode,
press Load unpacked, and choose `frontends/plugin/extension`.

Open a post on a blyg. Highlight a passage and comment. Open the export
chooser (the crystal at the top of the drawer) and choose Copy for Blygger
Studio. Details: [docs/blygger.md](docs/blygger.md).

## Replying from a feed, with your own subscription

A web page cannot use your Claude or ChatGPT subscription. The command-line
program of the subscription runs on your own computer. This pattern lets a
feed reach that computer.

1. On your computer, run `botference hub-link pair --hub https://<feed origin>`.
   This makes a key and prints two lines for the feed's environment:
   `BLYG_HUB_STUDIO_URL` and `BLYG_HUB_STUDIO_KEY`. Add `--companion
   https://<name>` to set the first line. Add `--publish drafts-only` (the
   default) or `--publish one-click`.
2. The companion must be reachable. A tunnel does this. The README describes
   one.
3. The feed's server signs each request. The signature is HMAC-SHA256 over
   `v1`, the method, the path, the time, a random nonce and the SHA-256 of the
   body, with the key's secret. It sends the request to
   `/hub-link/<route>` on the companion. The routes are ping, reply, status,
   publish, cancel and redo. Others serve speech, clippings and earlier posts.
4. The companion checks the signature. It refuses a time off by more than 120
   seconds, and a nonce it saw in the last 10 minutes.
5. It reads the post's item document. It checks that the quoted passage is in
   the post. It trusts nothing that the feed says about the post.
6. It files the reply as a thread. For each `/tk-claude` line it runs the
   `claude` program once, with no tools, on your subscription. `/tk-codex`
   uses a locked-down `codex exec`. The passage is marked as generated.
7. With `drafts-only`, the reply stays a draft. With `one-click`, the
   publish queue runs your site's commands.
8. The feed asks for the state of each reply. The states are refused, saved,
   filling, queued, awaiting look, publishing, published, failed and
   cancelled.
9. Each reply has an id, the `rid`. A repeated request with the same `rid`
   does nothing new.

**Reusable today:** the computer's half. That is the hub-link routes, the
pairing command, the agent one-shots and the publish queue. The wire format is
in [SPEC.md](frontends/plugin/SPEC.md), section "The hub link". **Not here
yet:** the feed's page and its server function.

**Limits:** 30 signed requests a minute, 20 replies an hour and 10 publishes a
day. At most 30 agent passages per page per hour. A leaked key can file
replies, spend those agent calls, publish up to 10 posts a day under your name
(with `one-click`) and read the clippings you listed. Run
`botference hub-link rotate` to replace the key, or `botference hub-link off`
to end the link. In this set-up the agent runs for the
owner of the subscription only, on that person's own computer. Check your
subscription's terms. To run agents for other people, use API keys.

## Adapting it to your site

The companion runs your own site's commands. It does not hold a hosting
password. You describe them with `botference blyg-home example`, `check` and
`set`. The commands are plan, apply and publish. The example is one Jekyll
site. If your site is different, give an AI coding agent this repository and
[docs/blygger.md](docs/blygger.md). Ask it to write the plan, apply and push
commands for your site. The commands must meet the contract in
[docs/blygger-setup.md](docs/blygger-setup.md) and in SPEC.md, section "Owner
setup for Publish as blyg". The repository does not show a finished example.

## State

Experimental. It was built in one week and one person uses it daily. AI agents
built it. A separate agent reviewed each part. The
[laws for publishing](docs/laws.md) are proposed, not adopted. More:
[docs/blygger-setup.md](docs/blygger-setup.md) and
[botference.com/blygger.html](https://botference.com/blygger.html).
