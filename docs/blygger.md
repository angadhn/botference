# Discuss and Blygger

This page is for people who know [Blygger](https://blygger.org) (spec
[0.4](https://blygger.org/spec/0.4/)) and want to know what Botference's
browser extension, Discuss, does when the page you are reading is a blyg
post.

Discuss lets you highlight passages on any web page, comment on them, strike
them, and chat about the page with your own AI models. It exports a page's
highlights, comments and chat as one markdown note. On a Blygger post it does
four more things:

1. It recognises the post, and records which post and which version you were
   reading with every highlight and page-chat message.
2. It checks each highlight against the post's text with the spec's own
   quoting rule (§10.2), and tells you when a highlight is not word for word.
3. It exports your highlights as quotes by reference, in Blygger's own
   syntax, so every quote names the exact post it came from.
4. It tells the models which post and version they are discussing.

On a page that is not a Blygger post, nothing changes except the export's
quote shape, which is a setting (below).

## Recognising a post

The Discuss companion (a small server on your own computer) asks the page's
site when you first open Discuss on a page, before the first highlight or
page-chat message on it, and before an export, unless it already holds an
answer (see "What is fetched, and when" for how long one is kept):

1. **Find the manifest**, in the spec's discovery order (§12.1, without the
   feed steps): `blyg.json` at the page's own path; the page's
   `<link rel="blyg">` (a manifest, or a base URL to append `blyg.json` to);
   then `/blyg/blyg.json` and `/blyg.json` at the host root. The identity
   origin is the folder the manifest was actually fetched from (§12.2).
2. **Find the post.** The page's
   `<link rel="alternate" type="application/json">` names the item document
   (§5.8). Without one, an id in the page's own path (`t/{id}/`, `f/{id}/`) is
   tried.
3. **Verify.** The item document is always read from where the origin's
   manifest says it lives (the `item` template, or `items/{id}.json`), never
   only from where the page pointed. Its `id` and `origin` must match byte for
   byte, and its `content_hash` must be the SHA-256 of its `content_md`
   (§5.1). Its `page` and the template addresses must be http or https.
4. **The page must be the post's own page.** The document's `page` field
   (or, without one, the reference client's `t/{id}/` / `f/{id}/`) must name
   the page you are on, apart from query, fragment and a trailing slash; or
   you are on that page's `v{n}/` for a pinned version. A link proves nothing
   about the page that carries it: any page can link a blyg's manifest or a
   post's document. A page that links a post but is not its page is "part of
   a blyg" when it is on the blyg's own host (a front page, a collection), and
   "not a blyg" anywhere else, so a copy elsewhere is never credited to the
   post's author and its words are never exported as the post's.
5. **Pinned versions.** On a pinned version's own page (`{page}v{n}/`, §8.4),
   the version you are reading is that one, read from its pin document. The
   post's current version, and which versions are pinned, come from its
   changelog.

The answer is one of: a post (with its origin, id, kind, version, whether that
version is pinned, its page, the blyg's title and the author); part of a blyg
but not one post (a front page, a collection); not a blyg; or could not check
(offline, refused, too slow, too large, malformed, or did not verify). A page
that could not be checked is asked again later; it is never guessed. PDFs,
local files, and pages on this computer or its private network are never
checked and cost no request.

Once a page is known to be a post, a later check that fails (you are offline,
the site is slow) does not undo it: the page stays a post until a check that
succeeds says otherwise.

When the page is a post, the drawer's header gains one grey line beside the
site name: `blyg · v2 · Author` (or `v2 pinned`). Nothing else in the drawer
changes.

### What is recorded

- **On the page record:** the last answer (`page.blyg`), without the post's
  words.
- **On each highlight, comment, strike and page-chat message of yours:** the
  post's origin, id and version when it was made, and for a highlight whether
  its words pass the quoting rule. An old highlight keeps the version it
  quoted after the post changes.
- The first record on a page waits a few seconds for the answer. If the answer
  is not in by then, the record says "checking" and is filled in once, when it
  arrives.
- Records made before Discuss knew about Blygger are labelled the first time
  the page is checked (on opening or on export), with the version current at
  that check. The export says that this is the version at the time of the
  check, not at the time of the highlight.
- A record without these fields is not a blyg record. Nothing needs
  migrating.

## The export

The note is **the Blygger directive syntax plus two optional front-matter
keys**. The body is plain spec syntax (§10.1), which any Blygger editor
accepts. The two keys are for a site whose build reads them. Anyone else can
delete them.

### The body

- **Your words and the quote.** For each highlight, the comment you wrote
  when you made it (the thread's first message, if it is yours and has words)
  comes first, as prose; then the quote; then the rest of the thread (your
  later replies, the bots' replies) as before. Blygger readers take position
  to mean something: words above a quote make a quote post, words below it a
  reply. A highlight with no comment of yours at its start (none at all, a
  thread a bot began, a bare strike) starts with the quote. A strike's note is
  its reason, so it goes above too. Blank lines always separate your words
  from the quote; words that end in a list get an empty `<!-- -->` line after
  them, so the directive can never be read as part of the list. To keep the
  old order, quote first and the whole thread under it, set
  `"comment_order": "quote-first"` (the default is `"comment-first"`; any
  other value is refused and the drawer says so).
- **A highlight on a post whose words pass the check** is a partial
  transclusion: the directive `![[<id> | <label>]]` on a line of its own, and
  directly under it, with no blank line, the passage as a `> ` blockquote. A
  passage of several paragraphs has an empty `>` line between them. The
  passage is your highlight's own words, written as plain text: `* _ ` [ < \ ~`,
  an `&` that would start an entity, and line-start characters that would
  make a heading, list, quote or rule are escaped with a backslash, so the
  publisher reads the same text the check was run on. The label is the
  page's title as Discuss shows it (your own name for the page if you renamed
  it). It is your label, not a claim about the post (§10.1).
- **A highlight that is not word for word** (it ran into a caption, a
  footnote marker, a button), or whose words are no longer in the post's
  current version, is never written as a directive, because the publisher's
  build would reject it. It is written as an ordinary quote, with an italic
  line saying why. When Discuss found the longest exact run of your
  highlight's words in the post, the line gives it so that you can quote that
  instead. The drawer shows the same line under the highlight while you read.
- **The whole post** is the bare directive line `![[<id> | <label>]]`. It is
  written at the top of the body when the note quotes no passage of the post
  by reference (for example a note that is only a page chat), so every note
  about a post references it. A response that quotes a passage by reference
  starts with your words instead: its quote is its reference. (With
  `comment_order: "quote-first"`, a response starts with the whole-post line,
  as before.)
- **A page that is not a Blygger post** is quoted as an ordinary blockquote.
- A note may mix both kinds. Each highlight is written in its own form.
- The page chat, when the export includes it, follows the same rules: your
  words as prose, each agent's reply in a callout (see below).

### The front matter

```yaml
blyg_sources:
  - https://example.org/blyg/t/<id>/
blyg_stub_of:
  origin: https://example.org/blyg/
  id: <id>
  version: 2
```

- `blyg_sources` lists the page of every Blygger post the note references,
  once each. It is written only when the note references one.
- `blyg_stub_of` is written only when the note is a response (the export
  chooser's "a response to this post/page" row; on a post's own page it is
  ticked to begin with). It names exactly one
  target. On a Blygger post it is the post at the version you read (`origin`,
  `id`, `version`), and the body starts with the whole-post line, as a
  Blygger stub does (§10.6). On any other page it is `url:` and the page's
  address, the spec's plain-web shape.
- Delete either key if your site does not use it. Nothing in the body depends
  on them.

### Quotes from ordinary pages: `quote_style`

One setting in the companion's `config.json`, with two named styles. It
applies to quotes from http and https pages that are not Blygger posts. A PDF
on your computer, a local file or the library always gets the plain shape,
so no local path or internal address ever goes into a note's body:

- `url-card` (the default) closes each quote with an empty `>` line and the
  page's bare URL as its last paragraph. A heading or page line stays above
  the URL. Sites that turn a trailing bare URL into a link card want this. In
  any other renderer it reads as a quote with its source under it.
- `plain` writes the quote alone, as Discuss always did. The page's URL is in
  the note's front matter only. To switch back, set `"quote_style": "plain"`,
  and for the old order too, `"comment_order": "quote-first"`: the two together
  write exactly what Discuss wrote before.

Any other value is refused: the note is written with `plain`, and the drawer
says why.

A directive's label is the page's title. Blygger's grammar has no escape, so a
title that contains `]]` or ends in `]` cannot be written as a label that
reads back the same; such a label is left out and the directive names the post
bare.

### TK marks in a quoted passage

A passage that contains Blygger Studio's TK marks (`[TK]`, `[/TK]`, in any
case) has them written as code spans: `` `[TK]` ``. A Blygger conformance
checker refuses a published post whose source holds TK marks outside code,
and it reads the raw text, so a backslash would not help; the §10.2 text
rule ignores inline formatting, so the passage still matches the post word
for word. Bracket-directive text in a passage (`![[id]]`, `[[id]]`) keeps a
backslash instead, because a receiving site's wikilink pass reads inside
code spans. No part of a note (comments, replies, the page chat, a title, an
ordinary page's quoted words) carries bare TK marks: outside code they are
written as code spans. To write the letters `[TK]` yourself, put them in
code formatting.

### The agents' words

The export chooser offers "My notes and the agents' replies" and "My notes
only". In the first, an agent's reply is written in an Obsidian callout of
its own, headed with the agent's name:

```markdown
> [!note] Claude
> The agent's words.
```

so your words and an agent's are never confused, and the box is easy to
delete. Your own words are never in one. A callout never touches a quote or
a Blygger passage: an empty `<!-- -->` line keeps them apart, so a
directive's passage is still exactly the lines under it. Two settings in the
companion's `config.json`: `callout_type` (default `note`, which Obsidian and
the common static-site callout plugins draw) and `agent_style` (`callout`,
the default, or `inline` for the old `**claude:** …` lines).

### TK gaps in your own notes

In a comment, reply or page-chat message of your own, `[TK] an instruction
[/TK]` marks a gap for an agent to fill, as in Blygger Studio. When you export
with the agents' replies, one agent (`gap_agent`: `claude` by default, or
`codex`) is asked to write it; the answer goes where the gap was. Only your
own words are read for gaps, never a page's text, a quoted passage or an
agent's reply. The agent is given your instruction as an instruction, and the
page's title and address, the post's identity, the highlighted passage and
your surrounding words only as quoted data, which it is told not to obey.
What it writes is kept with the page, so exporting again does not ask again
and writes the same note. At most 8 gaps and three minutes per export; a gap
that cannot be filled never stops the export, and the footbar says how many
were filled and how many not. "My notes only" fills and shows no gap.

How a gap is written is one setting, `gap_style`:

- `callout` (the default): the text in a callout under an HTML comment that
  keeps your instruction (you see it, readers do not). An unfilled gap is a
  `[!warning] Not filled` callout with the reason. No TK marks reach the note,
  so any markdown site can publish it.
- `studio`: Blygger Studio's own draft grammar, exactly as Studio writes it
  after its Generate button: `[TK] instruction [=]the text[/TK]` (a gap inside
  a sentence stays one paragraph; one in a paragraph of its own may hold
  several). An unfilled gap stays `[TK] instruction [/TK]`, which Studio shows
  as ungenerated and refuses to publish. A Blygger-aware publisher keeps your
  instruction out of the post and publishes the text disclosed as generated;
  the note's front matter lists each filled gap, in order, under
  `blyg_generated:` (the model when the companion knows it, and the time it
  was written). Inside a scope, any `[` that would begin a TK token or a
  bracket directive, and every backtick, is written as a character reference
  (`&#91;`, `&#96;`): they render as the same characters and can never end the
  scope early or hide its end in code; a bracket directive in your
  instruction is therefore never Studio's TK-transclude source reference.
  Choose this only for a site that is Blygger-aware: any other site would
  publish the TK marks and your instruction as text.

### The response default

On a Blygger post's own page, the export chooser's "a response to this post"
starts ticked: a note made from one post is nearly always a reply to it. On
any other page it starts unticked. Once you change it on a page, your choice
is what counts there.

### Settings, and the old shape

All in the companion's `config.json` (`.botference/plugin/config.json`), each
refused with a footbar warning when its value is unknown:

| Setting | Values (default first) |
|---|---|
| `quote_style` | `url-card`, `plain` |
| `comment_order` | `comment-first`, `quote-first` |
| `agent_style` | `callout`, `inline` |
| `callout_type` | `note`, or any callout name |
| `gap_style` | `callout`, `studio` |
| `gap_agent` | `claude`, `codex` |
| `blyg_checks` | `on`, `off` |

`quote_style: "plain"` with `comment_order: "quote-first"` and
`agent_style: "inline"` writes an ordinary page's note exactly as Discuss
did before any of this.

### A worked example

The public post <https://venkateshrao.com/blyg/t/3vzq82afn6rmyvk6vsq8abnkqh/>
("Starter checklist", version 2, pinned), read by GET. One highlight of a
line that contains TK marks, with an opening comment holding a TK gap, a
later question and an agent's reply. Rendered by the export code with the
default settings; the comments, the gap's filled text and the agent's reply
are made up.

```markdown
---
url: https://venkateshrao.com/blyg/t/3vzq82afn6rmyvk6vsq8abnkqh
site: venkateshrao.com
saved: 2026-11-21
tags: [botference-discuss]
blyg_sources:
  - https://venkateshrao.com/blyg/t/3vzq82afn6rmyvk6vsq8abnkqh/
blyg_stub_of:
  origin: https://venkateshrao.com/blyg/
  id: 3vzq82afn6rmyvk6vsq8abnkqh
  version: 2
---

# Starter checklist

The checklist treats a model as one more tool to set up.

<!-- TK: say in one sentence what a TK scope is, for a reader new to Blygger -->
> [!note] Claude
> A TK scope is a gap the author marks for a model to fill; the published post shows only the text, disclosed as generated.

![[3vzq82afn6rmyvk6vsq8abnkqh | Starter checklist]]
> Add an AI for `[TK]` prompt `[/TK]` generation and Changelog generation (recommended: Sonnet and Haiku or equivalent)

@claude which of the two would you start with?

> [!note] Claude
> Haiku for changelog notes, since they are short and frequent; Sonnet for prompts that write prose.
```

The same note with `gap_style: "studio"`, from the front matter to the quote:

```markdown
blyg_sources:
  - https://venkateshrao.com/blyg/t/3vzq82afn6rmyvk6vsq8abnkqh/
blyg_stub_of:
  origin: https://venkateshrao.com/blyg/
  id: 3vzq82afn6rmyvk6vsq8abnkqh
  version: 2
blyg_generated:
  - at: 2026-11-21T10:02:00Z
---

# Starter checklist

The checklist treats a model as one more tool to set up.

[TK] say in one sentence what a TK scope is, for a reader new to Blygger [=]A TK scope is a gap the author marks for a model to fill; the published post shows only the text, disclosed as generated.[/TK]

![[3vzq82afn6rmyvk6vsq8abnkqh | Starter checklist]]
> Add an AI for `[TK]` prompt `[/TK]` generation and Changelog generation (recommended: Sonnet and Haiku or equivalent)
```

(No model name is listed under `blyg_generated` here: the companion writes one
only when the reader has set which model the agent runs as.)

### Blog drafts

The `/draft-blog` command writes a first draft into a registered Jekyll site,
built from the site's post template. On a Blygger post the template's front
matter gains the same two keys. They replace the same keys if the template
already has them, and every other template line is kept, in its order. On any
other page the template is written exactly as before. The bot does not
retype your highlights. It writes a placeholder line where a quote belongs,
and the companion puts the highlight there in the same syntax and order as
the export: the comment you made with it, then the quote (the thread's later
replies are left to the bot's prose).
A blockquote the bot wrote that is a near copy of one of your highlights is
replaced by your highlight's exact words. Jekyll runs Liquid over a post,
and a page title or passage is somebody else's text: a quote containing
`{{`, `}}`, `{%` or `%}` is wrapped in `{% raw %}` … `{% endraw %}` lines, so
it is printed and never run. The draft's `source_url` is written only as a
web address. The draft stays an unpublished draft. Nothing here publishes
anything.

## What is fetched, and when

All fetching is done by the Discuss companion on your own computer, never by
the web page and never by the extension's content script. A content script's
request is made for the page's origin, so it is subject to CORS and, on some
browsers, to the page's own security policy. The companion is subject to
neither.

- **Who:** only you. When the companion is shared over a tunnel, a guest's
  pages, highlights and messages never start a check (their records are simply
  not stamped).
- **When:** the first time Discuss is opened on a page, before the first
  highlight or page-chat message on a page, and before an export, unless an
  answer is held. An answer is kept for ten minutes. A site that could not be
  checked is not asked again for a while: one minute after the first failure,
  doubling with each further failure up to six hours, and forgotten as soon
  as it answers. Until then every page on that site answers "could not check"
  at once, so nothing waits on it. Two askers at the same moment share one
  check.
- **What:** at most eight GET requests per check: the manifest probes above,
  the item document, and a pinned version's document when you are on its
  page. A page's `<link rel="blyg">` and `<link rel="alternate"
  type="application/json">` cause GETs to whatever host they name (that is
  what discovery is), always under the limits below. The extension sends the
  companion those two addresses. The companion fetches the page itself (one
  more GET) only when it has no addresses from the extension: an export from
  the pages list, or an older extension.
- **Limits:** http and https only. Never an address on this computer, its
  private network, or any other special-purpose range (loopback, private,
  shared carrier space such as 100.64.0.0/10, link-local and cloud metadata,
  multicast, reserved, documentation; IPv6 forms that carry such an IPv4
  address), and never the companion's own port. A page on such an address is
  not checked at all. Each name is resolved once (within 3 seconds); every
  address it answers is checked, a name with any such address among its
  answers is refused, and the connection is made to exactly the address that
  was checked, with no proxy, so a name cannot answer one address to the check
  and another to the connection. Each redirect is checked the same way (at
  most five). There is a time limit of 8 seconds per request and 20 seconds
  per check. Size limits are 256 KB for a manifest, 4 MB for an item document
  and 2 MB for a page, enforced while reading.
- **Turning it off:** set `"blyg_checks": "off"` in the companion's
  `config.json` (`.botference/plugin/config.json`). No page is asked about
  then, nothing is stamped, and quotes are written as ordinary quotes.
- **What is believed:** only JSON that parses as an object, from the origin
  the manifest was fetched from, whose id, origin and hash check out. Every
  string kept from it is clipped, stripped of control characters, and escaped
  wherever it is drawn. Nothing fetched is ever run, and nothing in it is
  followed as an instruction. The models see the post's id, version, origin,
  title and author as quoted data.

## What is never sent anywhere

- Nothing is posted to a blyg: no Webmention, no POST, no registration.
  Discuss only reads.
- Your highlights, comments and chat stay in the companion's store and in the
  notes it writes to your own disk. The checks send a blyg nothing but
  ordinary GET requests for its public files. Their user agent names the
  software, not you:
  `Mozilla/5.0 (compatible; botference-discuss/1.0; +https://botference.com)`.
- The export writes a file. Publishing it, and sending any mention the spec
  asks a publisher to send, is up to you and your own site.
- Filling a TK gap sends the gap's instruction, your surrounding words, the
  highlighted passage and the page's title and address to the agent you
  already use for Discuss (gap_agent), on this machine's own agent session,
  as any question to it would. Nothing is sent for a gap in "My notes only",
  and nothing again for a gap already filled.

## Known limits

- The check is §10.2 as the reference client reads it for block boundaries
  (which elements end a block follow blygger-studio). Character references
  are decoded as HTML decodes them (every numeric reference, and HTML 4's
  named ones), which is more than the reference client decodes; on a post
  whose HTML spells characters as references, that client's own check may
  disagree. A publisher that reads the rule differently may disagree on an
  edge case.
- A blyg's front page or collection page is "part of a blyg". Highlights made
  there are ordinary quotes, because Discuss cannot tell which post on the
  page a passage belongs to.
- In the authoring-workspace mode, where the models edit a site's files
  directly, quotes are not checked. Only a `/draft-blog` block that the
  companion saves is.
