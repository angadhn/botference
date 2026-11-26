---
id: 55vwkj4n4kqrye8zsx8ee4ze60
v1: 2026-11-26T01:22:55Z
---
# Release note: Discuss reads and publishes blyg posts

During the Blygger hackathon, 20–27 November 2026, botference's browser extension, Discuss, learned to read blyg posts and to publish them. [Blygger](https://blygger.org) is an open protocol for small blogs that quote each other by reference. A post on such a blog is a blyg post. This note lists what changed. The [Blygger page](https://botference.com/blygger.html) describes it in more detail.

## Reading a blyg post

- **Quote by reference.** On a blyg post, the extension reads the post's own documents. Each highlight then records the post's id and version. The extension tells you when a highlight is not word for word in the post.
- **Responses.** On a blyg post, a thread that you publish is a response to that post by default. You can untick this.
- **Mentions.** A mention is the notice that tells another blog about your response. Discuss does not send it. Your site's own publisher sends it after the post is live. The Hub, a private feed of the blygs you follow, lists the mentions that your own site receives.

## Writing with an agent

- **Agent passages in a marked box.** Type `/tk-claude` or `/tk-codex` and an instruction in your own comment. The agent writes that passage, and the extension shows it in a box marked as an AI's text. The box stays when you publish. The instruction is not published.
- **Drafts with `fill-gap`.** The command `botference fill-gap` fills one gap in a draft that you write in Obsidian. A site's own scripts call it and keep the answer in a separate file. The draft itself is not changed.

## Publishing

- **The publish queue.** Every press of the publish button is accepted at once. Posts go out one at a time, in the order you pressed them, up to 20 waiting.
- **One-click publishing.** With `confirm: never`, the press is the publish. A post stops for your look only when publishing would lose something already published.
- **Copy for Blygger Studio.** If you write in [Blygger Studio](https://github.com/blygger/blygger-studio), copy the thread as Studio's own markdown and paste it there.

All of this is experimental. The only example set-up is one Jekyll site. Publishing runs your site's own commands, which check, build and push the post. The set-up is in [docs/blygger.md](https://github.com/angadhn/botference/blob/main/docs/blygger.md).
