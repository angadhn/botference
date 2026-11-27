# A Blygger set-up: read on a phone, publish from home

This page describes one complete set-up built with botference during the
Blygger hackathon (20–27 November 2026). It is written for someone who wants
to copy it, or to build the same thing another way.

The short version: you read other people's blygs in a private feed, select a
passage, write or speak a reply, and it is published to your own static site
as a Blygger response that quotes the exact passage. The phone does the
reading and writing. A computer at home does the publishing.

## The parts

| Part | Where it runs | What it does |
|---|---|---|
| Your site | A static host (Jekyll on Netlify in the example) | Publishes your posts and the Blygger files (`blyg.json`, items, feed) |
| The companion | Your own computer (`botference discuss`) | Files replies, runs agents, runs your site's publish commands, queues the work |
| Discuss | A browser extension on a laptop | Highlights and comments on any page; publishes a thread as a blyg post |
| The Hub | The companion (`/hub`), or hosted on your site | A private feed of the blygs you follow |
| The hub link | Between a hosted Hub and the companion | Carries replies from the Hub to your computer |

Publishing always runs your site's own commands on your own computer. The
companion never holds a hosting password; it runs the commands you configure
with `botference blyg-home`. One optional command, `link_targets`, prints the
list of your published posts, so a `/tk` passage can link to one when you ask
for a backlink (`botference blyg-home links` shows what it gives).

## What you can do with it

**From a laptop, with Discuss**

- Highlight a passage on a blyg post and comment. One press publishes your
  words and the passage as a post on your site. The quote points at the post's
  id and version.
- On an ordinary web page the same press makes a post that responds to that
  page, with a quote and a link.
- A thread of several comments becomes one post. A later comment can be added
  to an earlier post as a new version.
- A line that starts with `/tk-claude` or `/tk-codex` leaves a gap that an
  agent fills. The passage is marked as generated in the Blygger item, and it
  is shown in a box on the page. Formatting (lists, tables, code) is rendered
  from an allow-list. A link written by an agent never notifies anyone.
- A line with only `/quote` puts the quoted passage at that point in the post.

**From a phone, with a hosted Hub**

- Read the blygs you follow. Select text in a post and press Reply.
- Type, or press the microphone button. The recording goes to your computer, which turns it
  into text with whisper.cpp and returns it to the reply box.
- Publish now, or Save as draft. A draft shows the agent's passage before you
  publish.
- Reply again to a post you have already answered, and choose to add to your
  earlier reply (a new version of the same post) or to make a new post.
- Write a post that answers nobody as a stand-alone post.
- Read articles you clipped into a folder of your notes (an allow-list on the
  computer says which), and reply to their passages. The post responds to the
  original page.

**On your site**

- In the drawer, an agent passage's card can show the prompt you wrote. That is
  a choice per post, and it is off unless you turn it on. The prompt is never
  put in the Blygger item: the protocol forbids instruction text there. The
  Hub's reply does not pass this choice yet.

## How a reply travels from the phone

1. The Hub page sends your reply to the Hub's own server function.
2. The function signs a request with a key that only it and your computer
   hold, and sends it to the companion through a tunnel.
3. The companion checks the signature, checks that the quoted passage is in
   the post (it reads the post's item document), and files the reply as a
   thread.
4. Agents fill any `/tk` lines. They run as one-shot commands with no tools.
5. The publish queue runs your site's commands: plan, build and test, push.
6. Mentions go to the authors your post answers or quotes.
7. The Hub asks the companion for the state of the reply.

Pairing is one command on the computer, `botference hub-link pair`, and two
environment variables on the Hub's host. `--publish drafts-only` makes the
link save drafts only; you then publish from the computer.

## What a leaked link key can do

The key lets its holder file replies and new posts, spend agent calls within
hourly limits, publish up to ten posts a day under your name, read back the
replies it filed itself, and read the clippings you allow-listed. It cannot
read your other notes, pages or settings. `botference hub-link rotate` ends
it. The full list is in [SPEC.md](../frontends/plugin/SPEC.md), "The hub
link".

## What is in this repository, and what is not

In this repository:

- The companion, Discuss, the publish queue and the agent passages.
- The Hub's engine and the Hub page served by the companion.
- The companion's half of the hub link, including speech and clippings.

Not in this repository:

- The hosted Hub: the server function, its sign-in checks and its storage on
  the site's host. In the example it lives with the site's own code.
- The site's publish commands. They belong to each site. The example is one
  Jekyll site; the commands the companion expects are described in
  [docs/blygger.md](blygger.md).

## What you need to copy it

- A static site that publishes Blygger files, with commands to plan, build
  and push a post.
- A computer that stays on, with `botference discuss` running, and a tunnel
  so a hosted Hub can reach it.
- A Claude or ChatGPT subscription, or an API key, for the agent passages.
- For speech: whisper.cpp and ffmpeg installed with Homebrew.

## State

Experimental. It was built in a week and is used daily by one person. Every
part was built by AI agents and reviewed by a separate agent before it went
live; the reviews found real faults each time. The
[laws for publishing](laws.md) are proposed, not adopted.
