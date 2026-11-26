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
  write what Discuss wrote before (with `"agent_style": "inline"` for agents'
  replies; TK marks are the one exception, below).

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
written as code spans. A pair of TK marks you type in a message of your own
is a gap (below); to write the letters `[TK]` yourself, put them in code
formatting.

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

### TK gaps: an agent writes a passage of your message

While you write a comment, a reply or a page-chat message, you can leave a
gap for an agent to write, as in Blygger Studio. The gap is filled when you
send the message, and the agent's passage is shown in place, in your own
message, as a small block marked as the agent's.

How to write one:

- `/tk an instruction` on a line of its own: the agent writes a paragraph
  (or more) there.
- `/tk(an instruction)` inside a sentence: the agent writes a few words
  there, as part of the sentence. Parentheses inside the instruction are
  fine as long as they are balanced, and it stays on one line. The `/tk` must
  start the line or follow a space or an opening bracket: `a/tk(x)` is not a
  gap.
- `[TK] an instruction [/TK]`, Blygger Studio's own marks, works the same
  way.

Not a gap: anything in code (a code span or a code block), `\/tk` (written
as the letters `/tk`), and `/tk` with nothing after it. At most 8 gaps per
message and 500 characters per instruction; an instruction longer than that
is not sent and its block says why. `/tk` is in the composer's autocomplete
and in `/help`.

**The agent block.** Each gap is drawn where you typed it, inside your
message: a robot mark, the word "agent" and the agent's name, what it wrote,
and your instruction underneath in small grey type. While it is being
written the block says so. If it could not be written, the block says why
(the agent took too long, wrote nothing, could not start) and offers to try
again. A filled block has four actions:

- **fill again**: ask the agent to write it again.
- **edit**: change the words by hand. They stay marked as the agent's draft
  ("Claude draft, edited by you"), because the agent wrote them first.
- **mine**: this is now your text. The block becomes ordinary words of your
  message, and the export writes them as yours, with no mark at all. A
  passage you have made yours is not filled again.
- **remove**: take the passage out. Nothing is written where it was.

Editing the message keeps every filled passage whose instruction you did not
change; only a gap that is new or whose instruction changed is sent again.

**Which agent.** `gap_agent` in the companion's `config.json`, `claude` by
default. Only Claude can fill gaps: the companion asks it through a one-time
command with no tools at all (below). Codex has no such form here, so with
`"gap_agent": "codex"` every gap's block says "codex cannot fill gaps (no
tool-less one-shot form for it)" and nothing is sent.

**What the agent is given, and what it can do.** Only gaps in a message you
typed yourself in the drawer, as the owner, are ever sent. The companion
marks a message as yours when it saves it, from the connection it came on,
never from anything in the message. Nothing else is read for gaps: not a
guest's message over a tunnel, not a page's text or a quoted passage, not an
agent's reply, not PDF annotations or review comments that were imported,
and not a message saved before this feature (until you edit and save it
again). Each gap is one separate run of `claude -p` that the companion
starts itself. It is not your page's agent session, so it has not seen the
conversation, the page snapshot or anyone else's messages. It is given no
tools (`--tools ""`), no MCP servers (`--strict-mcp-config`), none of your
user, project or local settings files (`--restricted`), and settings that
deny every tool. It runs in a new empty folder that is deleted afterwards,
and it is stopped after 90 seconds. Your instruction is the instruction. Your
surrounding words, the highlighted passage, the page's title and address and
the post's identity are given as one block of JSON data between two marker
lines made fresh for each run, and it is told to treat that block as data,
not instructions. This keeps a page from steering it, but it is not a
sandbox: it is the `claude` program running as you, with your Claude login.
Text it writes is shown as text. HTML, Liquid and wikilink brackets in it are
written so that they cannot run or link. At most 30 gaps are sent per page
per hour.

**The export.** It writes what is stored: it makes no agent calls, so
exporting twice writes the same note. `gap_export` decides whether "My notes
only" includes the agents' passages: `include` (the default) writes them,
marked as the agent's; `omit` leaves them out and writes a "not filled" mark
instead. "My notes and the agents' replies" always includes them.

How a gap is written in the note is one setting, `gap_style`:

- `callout` (the default): the text in a callout under an HTML comment that
  keeps your instruction (you see it, readers do not). A gap with no text
  (still being written, failed, or left out) is a `[!warning] Not filled`
  callout with the reason. No TK marks reach the note, so any markdown site
  can publish it.
- `studio`: Blygger Studio's own draft grammar, exactly as Studio writes it
  after its Generate button: `[TK] instruction [=]the text[/TK]`. A gap you
  typed on its own line is a paragraph of its own (and may hold several); a
  gap inside a sentence stays one paragraph. A gap with no text stays
  `[TK] instruction [/TK]`, which Studio shows as ungenerated and refuses to
  publish. A Blygger-aware publisher keeps your instruction out of the post
  and publishes the text disclosed as generated; the note's front matter
  lists each agent-written gap, in order, under `blyg_generated:` (the model
  when the companion knows it, and the time it was written). Inside a scope,
  any `[` that would begin a TK token or a bracket directive, and every
  backtick, is written as a character reference (`&#91;`, `&#96;`): they
  render as the same characters and can never end the scope early or hide
  its end in code; a bracket directive in your instruction is therefore
  never Studio's TK-transclude source reference. Choose this only for a site
  that is Blygger-aware: any other site would publish the TK marks and your
  instruction as text.

A passage you made yours ("mine") is written as your own words in both
styles, with no mark; a removed one is not written at all.

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
| `gap_agent` | `claude`, `codex` (Codex cannot fill gaps; see above) |
| `gap_export` | `include`, `omit` |
| `blyg_checks` | `on`, `off` |

`quote_style: "plain"` with `comment_order: "quote-first"` and
`agent_style: "inline"` writes an ordinary page's note exactly as Discuss
did before any of this, with one exception: TK marks (`[TK]`, `[/TK]`) in any
text are written as code, and a `/tk` or `[TK] … [/TK]` you type in a new
message of your own is a gap. A note whose words contain them is therefore not
byte for byte what it was. Blygger's grammar has no escape for a bare TK mark
that a checker would accept, so this one cannot be switched back.

### A worked example

The public post <https://venkateshrao.com/blyg/t/3vzq82afn6rmyvk6vsq8abnkqh/>
("Starter checklist", version 2, pinned), read by GET. One highlight of a
line that contains TK marks, then a later question and an agent's reply. The
comment made with the highlight was typed as:

```text
The checklist treats a model as one more tool to set up.
/tk say in one sentence what a TK scope is, for a reader new to Blygger
```

and the agent's passage was filled when it was sent. Rendered by the export
code with the default settings; the comments, the agent's passage and the
agent's reply are made up.

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
  - at: 2026-11-21T10:00:20Z
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

## Pasting into Blygger Studio

The export above writes a note for one particular site's vault. If you write in
[Blygger Studio](https://github.com/blygger/blygger-studio) instead, use
**Copy for Blygger Studio**, which puts Studio's own markdown on the clipboard.

**For a Studio user** (nothing here needs a token, and Discuss never contacts your Studio):

1. Install the Discuss extension (the repository README, "Load unpacked" → `frontends/plugin/extension`) and start its companion with `./botference discuss`.
2. In Studio, subscribe to the blyg whose post you will quote, and let it import. Studio
   can only quote a post it holds.
3. Open the post in your browser, highlight passages, and write your comments in Discuss.
4. Open the export chooser (the crystal at the top of the drawer), and choose
   **Copy for Blygger Studio**. The footbar says how much was copied.
5. In Studio, press **stub** on the post under *reading* if your note is a response (its
   first line names the post), then paste over the draft's text. For a quote post without a
   stub, paste into a new thread draft (quotes work in threads, not fragments).
6. Read the preview, then publish. Lines in `/* … */` are notes to yourself: Studio takes
   them out.

**What paste cannot carry.** Whether the post is a *stub* (Studio sets that from its stub
button, never from text), the version a quote is of (Studio quotes the version current at
publish), the page chat, a note's tags and title, and an agent's name or model. It also
cannot make Studio hold a post it has not imported. For an ordinary web page, a response
is only a link in the text, not a declared response.

### What Studio's compose screen accepts

Read from the public source of [blygger-studio](https://github.com/blygger/blygger-studio)
at commit `27b5924` (main as of 2026-11-22 04:23 UTC) and the
[0.4 spec](https://blygger.org/spec/0.4/). Paths are in that repository.

| What | What Studio accepts | Where |
|---|---|---|
| A partial quote of another origin's item | An own-line `![[id]]` or `![[id \| label]]` with the passage as `> ` lines directly under it (a bare `>` between paragraphs). **No version is written.** The quote is taken at the version current when you publish. | `src/grammar.ts` (`DIRECTIVE_LINE`); `src/directives.ts` (`attachedQuote`); `src/ui/syntax.tsx`: "Always takes the target's current version at publish time" |
| The passage is checked as text | The quote's markdown is rendered and its plain text compared with the item, so markdown characters in a passage must be backslash-escaped (Discuss does), and `$…$` would become a formula (Discuss writes `\$`). | `src/transclusion.ts` (`selectionFromQuote`, `locateSelection`) |
| A pinned version | `![[id@vN]]` is "reserved syntax, not implemented": it fails publish. Discuss never writes it. | `src/grammar.ts` (`RESERVED_LINE`); `src/ui/syntax.tsx` |
| A whole-item quote | The bare `![[id]]` line. | same |
| A link | `[[id]]` or `[[id \| text]]`, inline anywhere. An id Studio cannot resolve fails the whole publish. | `src/grammar.ts` (`LINK_INLINE`) |
| Declaring a stub | **Not markup, not a field in the editor, not a URL.** The only ways are the **stub** button on a reading entry (or a hopper member) and the API's `createItem {mode: "response", source: {subscriptionId, remoteId}}`; both need the target to be imported through a subscription. The editor can only *clear* a stub. | `src/item-create.ts` (`createResponseDraft`); `src/ui/reading.tsx` (`stub`); `src/ui/catalog.tsx`; `src/ui/authoring.tsx` ("clear stub"); `docs/api.md`. The router has no compose or stub deep link: `src/ui/app.tsx` lists `/`, `/reading`, `/reading/$sub/$id`, `/peek`, `/edit/$id`, `/fork` and others, none of which takes a quote or stub parameter. |
| A stub of a web page | Only for a plain-RSS entry, whose stub button writes a `[label](url)` line and a `{url}` citation. Nothing in the editor sets one for a page you read in a browser. | `src/item-create.ts`; `src/stub.ts` (`parseStubOf`) |
| TK gaps | `[TK]instruction[/TK]` ungenerated; Studio's Generate button writes `[=]output` itself. A gap needs no spaces, Discuss writes `[TK] instruction [/TK]`. Not inside code. | `src/tk.ts` (`parseScopes`) |
| Generated text, marked | `[TK]impyrt=text[/TK]` or `[TK]impyrt <model>=text[/TK]` is "text generated somewhere else", published as written and disclosed as machine-generated. A filled `[TK] i [=]text[/TK]` pasted from elsewhere has no provenance record behind it, so Studio treats it as hand-written and does **not** disclose it. | `src/tk.ts` (`IMPYRT_INLINE`); `src/model.ts` (comment above the publish step: "no provenance (hand-authored output) are plain text, no disclosure") |
| Notes to yourself | `/* … */`, from a line start or after a space, removed before publish; a stray `/*` or `*/` blocks publish. | `src/comments.ts` |
| New items | `![[+` at a line start and `[[+ idea]]` make new items at publish; Discuss never writes them and makes them inert in your words. | `src/ui/syntax.tsx` |
| HTML | Studio renders markdown with HTML off, so an HTML comment such as `<!-- -->` would publish as visible text. The vault note uses them; the Studio paste never does. | `src/directives.ts`, `src/code-ranges.ts`, `src/markdown.ts` (`html: false`) |

### What the Studio copy writes

- No front matter, title or page chat. The reader's comments and quotes follow
  `comment_order` (comment above the quote by default), and "my notes only" leaves agents out.
- A highlight on a post that passes Discuss's word-for-word check: `![[id | label]]` and the
  passage under it. One that does not pass, or any highlight on another page: a plain
  blockquote ending with `— [title](address)`. A PDF on your disk gets no address.
- An agent's reply: `[TK]impyrt=…[/TK]`, as its own paragraph, with no model named (Discuss
  does not store one for chat replies; Studio's own rule is not to invent one). Gaps an agent
  filled for you carry their model. Gaps not filled stay `[TK] instruction [/TK]`, which
  Studio can generate and will not publish until it has. There are no callouts.
- If the note is a response, its first line is a `/* STUB THIS POST: … */` note with the
  post's address, id and the version you read. On a post Discuss adds the whole-post line
  where the Obsidian note does. On a page it is a link line instead.
- What Discuss has to tell you (the version it checked, a quote that is not word for word)
  is in `/* */` notes, never in text that publishes.
- Words made safe: TK marks in your words are code, `/*` and `*/` are backslash-escaped,
  `[[+` is defused, a fence you left open is closed, and a guest's or a web page's `[[` and
  `![[` are defused. A directive you type on a line of your own, and a `[[id | text]]` link
  with a real id, stay live. The exact characters are `&#91;` for a bracket, which Studio
  renders as `[`.

**Nothing is sent.** The companion renders the text from the page record it already holds
(it does not ask the post's site, as the vault export does), and the drawer copies it. No
Studio, no token, no network.

### Verified, and assumed

*Read in Studio's source:* every row of the table above. Discuss's test suite holds each
output to a small restatement of those scanners (`test/studio-paste.test.mjs`).

*Assumed, because nothing here runs a Studio:* that pasting into the editor's text area
keeps the text as it is (no auto-formatting on paste); that your Studio holds the same
version of the post that you read, or at least still contains the passage (it checks at
publish, and refuses a mismatch with the list); that Studio's preview shows an `impyrt`
scope highlighted as generated; that `&#91;` renders as `[` in the preview; and that a
`/* */` line directly above a `![[id]]` line leaves the directive working. A person with a
Studio should try these, in this order:

1. Paste a note with one passage from a post you subscribe to into a **new thread**, open the
   preview, and publish to a test blyg. The quote should render as a blockquote naming the
   post, with no "unresolvable" or "not in the version we hold" error.
2. Press **stub** on that post, paste over the draft, and check the draft header says
   "stub of …" and that the stub note's first line was removed on publish.
3. Paste a note with an agent reply and an unfilled gap. The reply should show as generated
   text; the gap should offer Generate.
4. Put `*/` and `[[+ x]]` in a comment in Discuss, copy, paste, and confirm Studio shows them as
   written and does not make a new item or complain of a stray comment.

## The Hub: a private reading feed

The Hub is one console for what you read and what answers you. It is kept by
the companion on your own computer. Open `http://127.0.0.1:4189/hub` (the
drawer's feed icon, or the link on the extension's options page; `/following`
opens the same page). It has four views, side by side:

- **Feed**: the posts of the blygs you follow that you have not read, newest first; at its foot, **Older posts** pages back.
- **Mentions**: responses to your own posts, from your own site's inbox.
- **Background**: what should not interrupt reading.
- **Archive**: the posts you ticked as read (see "The Archive and the unread target" below).

**No unread counters.** The Hub shows no number of posts anywhere: not on the tabs, the filters, a blyg's row, the last
refresh line or the pages. Reading is not an inbox to clear. The one number is the mentions you have not marked seen, in
brackets on the Mentions tab ("Mentions (3)"); a mention drops out of it when you mark it seen. (The limits below still
count unread posts behind the scenes; the page never shows those counts.)

Below them is **Following**, the list of blygs you follow, where you add one,
import a blogroll and change the settings. The Hub is the reading half of a
Blygger client; nothing here publishes, mentions or writes anything.

**Following a blyg.** Paste any address on it (a post, its front page) into
"Follow a blyg". Discuss finds the blyg's manifest the way the spec's
resolution does (§12.1) and follows the blyg at its identity origin. To follow
many at once, use "Import a blogroll": give the address of an OPML file, or
paste it, or give (or paste) a blygger.com directory (`blygs.json`: a list, or
an object holding one, of entries with `origin`, `title` and `feed`). Discuss
shows what would be added and what it could not resolve; nothing is followed
until you tick it and confirm.

**The Feed.** Every 30 minutes (and on **Refresh now**) the companion asks each
followed blyg for its manifest and its `items/index.json`, compares the index
with what it holds (§13.2: the index is the reconciliation surface), and fetches
only the posts that are new or whose version went up. One entry per post, at its
newest version, with "N versions" when it has more than one. A post gone from the
index is dropped. A lower version than the one held is not adopted (§13.3). An
index that disagrees with the documents about a post's version is not chased on
every run: the document wins, and the post is asked about again only when the
index's entry changes. Newest first, filtered by All, New, Threads, Fragments or
Responses to me. "Responses to me" lists posts whose `stub_of`, or whose
transclusions, point at a blyg listed in the setting `my_origins` (one origin per
line, in the Hub's Following section; empty by default, and a post of one of your own
blygs is never a response to you); it is worked out from the blygs you follow,
whereas Mentions is the authoritative list from your inbox. Each entry shows the
blyg, author, date, kind, version, what it is "in response to", its first heading
or an excerpt, and Open. Only an excerpt is kept and shown: the page never
renders a post in full. A post dated in the future cannot sit on top: ordering
and the date shown use at most the time Discuss fetched it (§13.7).

**Versions and pins.** Each entry reads "v5 · 5 versions", with a small history
(date, the changelog note, a "pinned" mark) and, when any version is pinned
(§8), a "pinned: v1, v4" line. It is read from the post's own changelog, which
Discuss already fetches; pinned documents are never fetched in the background. A
pinned mark opens that version's page only when the page can be worked out from
what is held (the post's page, then `v<n>/`, §8.4); otherwise it is shown without
a link. Open always opens the current version. The stamp on a highlight says
which kind of version was read: `current-unpinned`, `current-pinned` or
`older-pinned` (a pinned version's own page).

**Background.** One function decides, for every post and mention, which view it
belongs to, and the entry says why. In Background: *withdrawn* posts (§13.4;
yours too, when `my_origins` names your blyg, as "withdrawn (your own)"), the
members of a folded burst ("part of a burst": a thread, and the posts of the same
blyg its transclusions name that were created within ten minutes of the thread's
`created` or `updated`, which approximates "the same publish", §13.7), versions
with "no new words" (the same `content_hash`: a maintenance version, §13.2),
versions that are "barely changed", posts of a paused blyg, and notices from your
inbox ("linked from", "reposted by"). A maintenance or barely-changed version of a
post you have not read yet stays in the Feed, because it is still new to you. A
post comes back to the Feed when it gets a version with real new words (one you
had seen or opened is new again; one you have answered stays answered). "Barely
changed" is the reader-local threshold of §13.2, the setting
`following_barely_changed_percent` (default 2; 0 means only an identical
`content_hash` counts). It can only be measured honestly from what Discuss keeps,
so it is measured when the whole text of both versions is held (a post whose text
was clipped is never called barely changed), the headings are equal, and the one
stretch between the versions' common beginning and ending is no more than that
percent of the longer text. The threshold is never sent anywhere.

**Mentions.** If your own site runs a private inbox of responses to your posts,
set `inbox_api_url` (https only) and `inbox_token_file` (an absolute path to a
local file whose first line is the token: visible ASCII, 8 to 512 characters, no
quote or backslash; one that is longer is refused, never cut). The token is never a setting: it is
read from that file when the companion is about to ask, sent as
`Authorization: Bearer …` to the inbox's own address only (not to anywhere it
redirects), and never stored in `config.json` or `following.json`, shown in the
page, put in a note or written to a log. The file may not be inside the
repository or the companion's data folders, and the Hub warns (it does not refuse)
when other users of the computer can read it: keep it to yourself with
`chmod 600`. The token is scrubbed out of everything the inbox sends before any of
it is read, so an inbox that echoes it back cannot put it on the page. The inbox is asked on the same timer
and on **Refresh now**, and has a state of its own: *off* (no address set),
*pending* (not asked yet), *paused* (an inbox is set but Blygger checks are off),
*ok*, *unauthorised* (the inbox refused, or there is no usable token file),
*unreachable* (it could not be asked, answered with an error, or answered from
another origin than the one set) or *unreadable* (it answered something that is not
a JSON document this code can read). The inbox has its own small request budget, so
the blygs cannot starve it. The Mentions view lists responses newest
first, grouped by your post, each with the responder, the blyg, what they did,
the passage, a link to the source (Open, below) and, when the source is a post of
a blyg you follow, a link to its entry in the Feed. The tab shows how many are
unseen, in brackets: "Mentions (3)" (and just "Mentions" when none is). Following the spec (§15.5), a response is a mention with words of its own
(a reply, a quote, a fork); a notice (a bare link, or a repost with no words of
its own) never appears there and goes to Background as "linked from" or
"reposted by"; a plain mention, whose source is not a blyg post and was checked
only by its link (§15.6), is held apart under its own heading as a lower class;
and a mention that does not say which it is is shown in Mentions labelled "class
unknown", not guessed. "Accepted, never verified" entries, and whether some were
blocked, are noted at the foot. Each mention has a "details" toggle with what the
inbox sent, as escaped JSON.
**The real shape of the inbox's mentions is unverified**: Discuss reads what a
command-line listing showed (who, their blyg's title, what they did, the version
of your post, a time, the quoted passage, the source, your post's title and
address) and shows whatever of it is present. The mapping from the inbox's field
names to these is one table, `MENTION_FIELDS` in
`frontends/plugin/following-inbox.mjs`, with what each action means in
`ACTION_CLASSES`; correct them there if your inbox spells them differently.

**Opening a post.** Open (a button that asks the companion, which answers with the
original address) opens the post's own page in a new tab and marks it opened (a
mention, seen). A post's `page` may be on another host (§5.8); then the button
says where it opens. The list's knowledge of a post is used to identify a page
only when the page itself agrees: Discuss then skips the manifest check and
stamps highlights with the list's blyg, id and version. The page agrees when it
carries a `<link rel="blyg">` whose target resolves to the same origin and a JSON
alternate for the item, inside that origin, whose id matches. A page with no such
links, or only one, goes through the normal check; a page whose links name a
different blyg or post goes through the normal check too, and the entry says it
disagreed. A highlight made on a followed post is not checked against the post's
words (§10.2) unless the export, which always asks the post's own site, does it.
Exporting a note for a followed post marks it answered.

**What the states mean.** A followed blyg is *active* (refreshed), *paused* (your
choice; never asked until you resume it), *unreachable* (it could not be asked:
asked again after 10 minutes, then 20, doubling up to 6 hours, and **Retry**
forces it) or *gone* (it answered three times in a row without a manifest or
index; not asked again until you resume it). A post is *new*, *opened* (you opened
it), *responded* (you exported a note for it), *edited* (you had ticked it, and a real
edit brought it back: "edited since you read it"), *older* (unread, but it stepped aside
when newer posts came in at a limit: see "Limits"; listed under **Older posts**, without
its text), *archived* (you ticked it as read) or
*archived_changed* (still in the Archive, but a newer wording exists that you have not
read: the Archive line says "edited again"). The first four are in the Feed; opening a
post never archives it, only your own tick does. (Older versions also had *seen*; a post
stored that way is loaded as *new*.)

**Limits.** At most 500 blygs; 200 unread posts held per blyg and 2000 in all (archived posts do not count); per
refresh at most 200 requests and 60 seconds, and 50 post documents per blyg. The unread limits are the right way round: a
**new post always comes in**. When a blyg then holds more unread posts than its limit, its *oldest* unread posts step
aside (state *older*), and when all blygs together hold more than theirs, the oldest of all step aside first. A post that
steps aside is never deleted and never marked read: a small record of it stays (its blyg, kind, title or first words,
dates and page address, about a third of a kilobyte, at most 1,000 per blyg; past that the oldest leave the list and are
read back again in their turn), and only its stored text is let go, so what is kept stays bounded. A starred post, one you
answered (*responded*) and one that came back *edited* never step aside. The Feed's **Older posts** pages back through the
posts it holds and then through these; **Read it here** on one fetches its text again from its blyg (one request, through
the same guard as every other) and the page says so if that fails. As you read and there is room again, the reading back
brings the newest of them back into the Feed, with their text, before it reads any further back. Nothing is held back in
silence: if a refresh leaves new posts of a blyg waiting (it ran out of time or requests, or that blyg's share of them, or
its new posts are failing and wait for a back-off), or a blyg changed many posts you had read, the Feed says so in one
plain line for that blyg.
A blyg's index and every post document must come from inside the blyg's own
origin (same scheme, host and port, under its path), also after redirects: a
manifest that points elsewhere is refused and the reason is shown beside the
blyg. A host that fails three times in a row is not asked for 15 minutes. One
refresh runs at a time; a second is refused, not queued. These are settings on
the Hub's Following section (in `config.json`: `following_refresh_minutes`,
`following_max_items_per_blyg`, `following_max_items_total`, `following_unread_target`,
`following_run_seconds`, `following_run_requests`,
`following_barely_changed_percent`, `following_feed_clip_words`, `my_origins`, `inbox_api_url`,
`inbox_token_file`); a value outside its range is refused and the default is
used. With no blyg followed and no inbox there is no timer, and with
`"blyg_checks": "off"` the Hub asks no site anything, its timer disarms, and
Refresh now says so.

**What is stored, and what is not published.** In the companion's data folder
(`.botference/plugin/following.json`, per profile): the blygs you follow with
their states, per post its origin, id, kind, version, dates, title or excerpt,
the post it answers (`stub_of`), counts of transclusions and links, a clipped
plain-text copy for the list (never the HTML), your read state, and the
mentions the inbox last listed with what it sent for each (never the token).
Nothing about what you follow or read is sent anywhere: the requests are the
same plain GETs for public files that the page check makes (see "What is
fetched, and when" below, whose limits apply to every one of them: the same
guard, the same address rules, no other way out), and they carry no cookie, no
account and no mention of you; the one exception is the request to your own
inbox, which carries your token. The page is the owner's alone: over a tunnel a
guest, or a request with no password, is refused on every Hub route, and
so is a request a browser says came from another site. The page is never framed
and runs one script and one style under a Content-Security-Policy.

**The Archive and the unread target.** Press **✓ Read** in the row under a post (beside "Open original") and the post moves to the Archive: it
leaves the Feed, its text is deleted from the companion, and a small record stays (its blyg, kind, title or first words
up to 120 characters, version read, dates and its whole page address, about half a kilobyte). The Archive tab lists those
records, newest ticked first, 50 lines at a time (**Older posts** pages back, up to 1000), each starting with an **Unread** button
and with "Open original"; its search box filters the records by title and blyg. **Unread** puts the post back in the Feed as *new*, fetching its
text again (one request), so it needs the blyg to be reachable and not paused; if it cannot be fetched the post stays
archived. On a thread with folded parts the button says "✓ Read (and its parts)" and archives the parts the Feed showed
with it; a post the thread only links to stays where it is. **Mark all read** archives exactly the posts the Feed is showing,
with their parts, after a confirmation (the page sends them 100 at a time). At most 500 archive records are kept per blyg
(never a starred one); past that the oldest ticked are dropped from the list. Dropping a record never makes the post unread again: each blyg also keeps a small list of
the posts you read (up to 5,000 by id; past that the oldest 500 go into a compact filter that knows them by id alone, 60 KB
however many, with about one false match in a hundred at 50,000 ids: a false match hides one post), and the Hub never
fetches a post on that list, or in that filter, as a new one, whatever date the blyg gives it. A blyg is never stopped for this. A blyg whose posts have all been fetched or ticked is
*caught up*; when every blyg you follow (other than paused ones) is and the Feed is empty, the Feed says "You have read
everything from the blygs you follow."

**Edits of posts you have read.** When a post you ticked gets a new version whose content differs (its `content_hash`), it
comes back to the Feed as *edited*, badged "edited since you read it" (nothing of its text was kept, so a small change
cannot be told from a large one, so the record keeps a 30-byte fingerprint of the words you read instead: an edit that
changes less than `following_barely_changed_percent` of a post of at least 100/percent words is recorded and the post stays
read); a version with identical content is maintenance and changes nothing. Edits are wanted,
but not often, so a post comes back at most once in 7 days, at most 3 posts of one blyg in one refresh and 10 in a day
(a blyg at its unread limit is no reason to hold one back: its oldest unread post steps aside, as for a new post); otherwise
it stays in the Archive as *archived_changed*,
whose line says "edited again", with **Mark read** (keep it read, at the newer version), "Open original" and **Unread**,
and it comes back at a later refresh once those limits allow. At most 3 edited posts of one blyg are in the Feed at once (the
next come back as you tick them), and when more than 5 posts of one blyg you had read change within a day none comes back:
the Archive says so in one line for that blyg and the posts wait there, "edited again". At most 5 documents of read posts are fetched per blyg per
refresh. A post whose record was dropped from the Archive's list is known only by its id: an edit of it leaves it read.

**Bursts.** A thread and the fragments published with it (§13.7) arrive together: the thread is fetched before any fragment
created within ten minutes of it, the fragments fold under it (in Background), and they do not count toward the target. A
fragment fetched while its thread could not be is in Background, "waiting for its thread", for at most a day, then stands on
its own. A fold covers the versions published in the burst: a part edited later is shown as its own update.

**Reading back.** A refresh keeps the Feed stocked: while it holds fewer unread posts than `following_unread_target`
(default 50, 1 to 500) it also reads further back in each blyg's index, going round the blygs one post at a time (the one
read back longest ago first) and within a blyg from its newest post that is not yet fetched to its oldest, so each blyg is
read backwards in time; a blyg's posts that stepped aside (*older*) are read back first, newest first. It stops at the
target, at the refresh's request and time limits, or at a blyg's unread limit (reading back never makes a post step aside), and
carries on at the next refresh: running out of budget is not an error and counts against nobody. Withdrawn posts are never
fetched. A post published since the last refresh (dated after the newest post the Hub has itself fetched from that blyg,
and not in the future) is always fetched, target or not, within that blyg's fair share of the refresh (its requests divided by
the blygs due, at least 5); dates an index gives only order a blyg's own reading back. A blyg whose new posts cannot be
fetched (three failures in a refresh) is not asked for them again until a back-off that doubles each time has passed. When a
tick leaves the Feed below the target, the page asks for a *top-up*: the next posts the last refresh lined up (20 per blyg),
with no index read, at most 10 requests and at most once in 30 seconds. A host that answers 429, 5xx or not at all is asked
again later (its breaker opens after three failures); a post a host does not serve (404, 410, 403) is asked again after a
back-off. Only a document that was served and cannot be used is noted against the blyg (for 7 days, or until its index names
a new version); if one blyg serves 100 of them (or all together 2,000), reading back pauses for that blyg, its line says
*reading back is paused: this blyg served documents that could not be used. New posts are still fetched.*, and **Retry**
clears the list. **Unfollow** asks which you mean: "Stop following" keeps the list of posts you read there (for up to 50
blygs, a year), so following it again does not bring them back as unread; "Stop following and forget what I have read
there" deletes it.

**The star.** **☆ Star** (after ✓ Read) marks a post to come back to, on any device: pressed, it says **★ Starred**, and
the **Starred** tab lists the starred posts, newest starred first, each a light line (kind, blyg, first words, dates, when
starred, and where the post is now: unread in the Feed, under Older posts, read in the Archive) with "Open original" and "Remove star". A star
is yours alone and nothing about it is sent to any blyg. It is independent of reading: starring never marks a post read,
and marking it read (or Unread) never removes its star; an edit of a starred post you read follows the edit rule. At most
500 posts are starred (the next star is refused, saying so). "Stop following" keeps a blyg's starred lines; "Stop following
and forget what I have read there" removes them too.

**Where it is kept, and several invocations at once.** Everything goes through one asynchronous storage interface
(`following-store.mjs`) whose writes are conditional (a write names the version it read, and is refused if another
writer got there first), so the same engine runs in this companion over files and on a serverless host over a blob store,
where several short invocations may overlap. On disk: `following.json` holds only the follow list (no post);
`following-run.json` the run lease, the top-up gap and the hosts' breakers; per blyg `following-feed/` (its unread posts and
a summary of its numbers, which the page reads), `following-archive/` (its archive records) and `following-ledgers/` (the
posts read, its queue and counters); `following-inbox.json`, `following-stars.json`; and each post's text in
`following-bodies/`. Every operation reads what it needs, changes copies, and writes the documents it changed in a fixed
order; if another writer changed one meanwhile it is run again on what is stored now, so your tick, Unread, star, pause or
unfollow is never lost to a refresh. A refresh fetches first and only then applies what it fetched, per blyg. Only one
refresh or top-up runs at a time (a lease kept in the store, which lapses if its holder dies). A post's text nothing names
is deleted only once it is an hour old. A `following.json` of the older layout (every post inside it) is converted on first
read; it is copied to `following-pre-shard.json` until the conversion is done, and a conversion that is cut short is
simply done again. The layout is numbered in `following.json` (`layout`): 4 since the limits were turned round (a feed may
hold *older* records). A store of layout 3 is moved to 4 on its first read by one write of `following.json` and nothing
else; an engine of an older layout then refuses to write to it ("the Hub is being updated") instead of reading an older
record as a new post with no text. To go back to older code, set `layout` back to 3 by hand first (its *older* posts then
show as new, without text, until a refresh or a tick). A post keeps its last 10 versions in its history.

## Reading in the Hub

Each post in the Feed is shown in place: a meta line (an unread dot, THREAD or FRAGMENT, the blyg's name, or "you" for
a blyg in `my_origins`, the date in your own style, and a reading time at 220 words a minute), up to its three most
recent versions as lines ("V4 Nov 20, 2026: the changelog note", with "and N earlier, in history" for the rest), its
title, its text, its address (shortened; the whole of it on hover) and the actions **Respond**, **Read here**, **Open
original**, a "..." menu (Mark new, for a post you opened) and, at the start of the line, a checkbox, "Read: move to Archive". A post of at most `following_feed_clip_words` words (default 300) is
shown whole, a fragment always, and a longer one is cut at a paragraph, quote or list boundary, with "more" opening the
rest in place. The search box above the list ("search every word") filters what is loaded on the page by substring,
ignoring case, over the text, title, author and blyg; it asks nothing of anyone. The Feed carries at most 100 entries
at a time, with "show more".

**Read here** keeps the post's text as an annotatable page in the same store as every other page you annotate, under the
post's own address, so a highlight made there and a highlight made later on the original site with the extension are one
record and one list of threads. Highlights, comments, page chat, TK gaps and export all work as on any article, in a plain
browser too (on a phone, for one). Respond opens the same page with the page chat ready. The post's origin, id and version
on the record come from the post's own item document, which is where the text came from (the stamp's source is
`item-document`), so they are authoritative. The text is sanitised by the article view's own sanitiser, an allow-list:
no scripts, styles, frames, forms, SVG or MathML, no event handlers or `style` attributes, links only to http(s) and
`mailto:` (opened with `rel="noopener noreferrer"`), images only over https, loaded lazily with no referrer. Reading here
marks the post opened; exporting a note marks it answered. If the Hub later sees a newer version, the page says so and
offers to load it; loading it keeps each highlight whose quote still matches and marks the others as no longer on the
page, and nothing is swapped under your highlights before you ask. A page you had already captured with the extension, with
highlights on it, is kept as it is until you load the post's version.

**Respond from the Feed.** Select text inside a post in the Feed, press Comment, write, save: the comment goes to that post's
own page record (the one Read here and the original page use), made on the spot from the text the Hub holds, with no request,
and its identity (origin, id, version) is the item document's. A selection that runs across two posts is refused with a short
message. Highlights already on a post are drawn in its entry. This needs no extension, so it works on a phone. With the Discuss
extension on a desktop browser, the Hub page marks each post's text `data-blyg-page`, `data-blyg-origin`, `data-blyg-id` and
`data-blyg-version`, and the extension (not the Feed's own button, which then stands down) files a selection inside it under
that post's page, not under the Hub's address. The extension reads those attributes only on the companion's own Hub pages
(its configured address, path `/hub` or `/following`); on any other website they are ignored, so a page cannot claim to be
someone else's post.

**Images.** Images in a post are loaded from their own hosts when they are shown: over https only, lazily, and with no Referer. That
tells each of those hosts your address and the time you looked, which is what reading a post anywhere on the web tells its images'
hosts. Discuss does not proxy or copy images.

**Where the page record is kept.** A post's `page` may be anywhere (§5.8). The record Read here makes is kept under the post's own
page address only when that address lies inside the blyg's own origin; for a page outside it (a permalink beside the blyg's mount, or on
another host) the record is kept under the post's item document address, which is inside the origin, and `page` stays a link to open.
So a blyg cannot name the address of a page it does not own and have its text, title or identity put on a record of yours. An existing
record is attached to a post only if it already is that post (the Hub's own record, or a page whose identity is exactly that blyg and id),
and a copy you captured with the extension is never replaced unless you press "Use the post's own text".

**What the page is made of.** A post's text is written by the sanitiser as a balanced tree built by its own stack, applying HTML's
implied end tags itself, with no page-structure elements (`main`, `header`, `footer`, `section`, `article`, `aside`, `address`), and read
again to a fixed point; it travels inside an inert `<template>` and a nonced script puts it in place, so nothing in it can close or
move an element of the page around it. A real browser's parser is run over a corpus of hostile inputs to check this
(`test/sanitize-browser.test.mjs`; it is skipped, with a message, when no Chrome or Brave is found).

**Who sees it.** A page the Hub made is the owner's alone: a guest's page lists leave it out, its address answers as if there were nothing
there, and nothing may be written to it, whichever parameter names it (an address or a page key, in a query or a body); a request that
carries `url` twice is refused. Live events about it (the event streams a page keeps open) reach the owner's connections only. So is the
theme folder's address.

An error nothing caught is logged and the companion goes on serving; only a failure before it is listening, or to bind its port, is fatal.

**What is stored, and for whom.** The sanitised text of every followed post (at most 40 KB each, with "Read here for the
rest" when it was longer) is kept in a file of its own in the companion's data folder (`following-bodies/`), removed with
its post, and a post you read here becomes an ordinary page record. Images are not copied: your browser loads them from
their https addresses. Nothing is sent anywhere. At the default limits the bodies come to at most 2000 x 40 KB = 80 MB,
usually a small fraction of that. Like every page in the companion's store they are the owner's; a guest who has the
password of a shared companion can open any annotated page, these too.

## Using your own reader

The drawer's feed icon opens the Hub by default. If you already read blygs somewhere else (a Blygger Studio's reading page, say), you can
make the icon, and the options page's link, open that instead. For a person, or for their coding agent:

- **Where the setting lives.** The extension's options page, the field "Your own reader", saved with the Save button. In storage it is
  `chrome.storage.local` key `bfp:reader-url`, and the choice that was made is `bfp:reader-onboarding` (one of `unasked`, `hub`,
  `external`). Both are read and validated by `readerUrlOf`, `readerTarget` and `readerAction` in `frontends/plugin/extension/config.js`.
- **The two values.** Empty (the default): the companion's own Hub, `/hub` on the configured companion address. An address: that reader.
  It must be an absolute `https` address (an `http` one only for this computer: `localhost`, `127.0.0.1`, `[::1]`); anything else is
  refused and nothing is saved.
- **Example, a Blygger Studio reading page.** Set "Your own reader" to `https://their.site/blyg/studio/reading`. The feed icon then opens
  that address in a new tab.
- **First use.** With no reader set and nothing chosen, if the Hub follows no blyg yet, clicking the feed icon asks instead of opening an
  empty page: "Use the built-in Hub", or "I already read blygs somewhere" with a box for its address. The choice is remembered, and both
  can be changed later on the options page.
- **What still works.** When an external reader is used, Discuss still recognises Blygger posts on the pages you open from it (the usual
  detection, see "Recognising a post"), so highlights, comments and exports work there. The Hub-only features do not apply: Read here,
  respond from the Feed, Mentions and the Feed itself.

## Theming the Hub

Set `hub_theme_dir` (in the Hub's Following section, or `config.json`) to the absolute path of a folder of your own that
holds `hub.css` and, if you like, font files (`.woff2`, `.woff`, `.ttf`, `.otf`). The folder may not be inside the
companion's data folders. The companion serves only files directly in it, by name, with those extensions, as
`/hub/theme/<name>` behind the same sign-in as the Hub: no listing, no sub-folders, no `..`, a symlink only if it stays
inside the folder, at most 256 KB for a stylesheet and 2 MB for a font. The Hub, and the Hub's page for a post you read
here, link `/hub/theme/hub.css` after the built-in stylesheet. The theme's state is shown in Settings: *none*, *ok*, or
*unreadable* (the built-in look is then used, untouched).

The pages' Content-Security-Policy stays `default-src 'none'` with a nonce for the page's own script and style and https
images. With a working theme it gains exactly `style-src ... 'self'` and `font-src 'self'`: your stylesheet and fonts load
from the companion, and an `@import` of, or font from, anywhere else does not. Without one there is no `font-src` at all.

Hooks a theme may rely on (the markup keeps them stable):

| class | what it is |
|---|---|
| `hub` | the `<body>` of every Hub page, and of a post's page |
| `hub-main` | the reading column (`<main>`; on a post's page, its `<article>`) |
| `hub-tabs` | the Feed / Mentions / Background links |
| `hub-entry` | one post in the Feed |
| `hub-entry-meta` | its first line: dot, kind, blyg, date, reading time, version |
| `hub-entry-title` | its title |
| `hub-entry-body` | the post's text (also the post's page text) |
| `hub-quote` | a quoted post inside the text (a blockquote) |
| `hub-entry-actions` | Respond, Read here, Open original |
| `hub-settings` | the settings form |

A theme (the page is a left-aligned column with room on the right, about 24rem, for the Discuss side panel on wide
screens, full width under 900px):

```css
.hub-main { font-family: "Iowan Old Style", Georgia, serif; font-size: 1.1rem; line-height: 1.6;
  max-width: 34em; margin: 0 24rem 0 3rem; }
.hub-entry { background: none; border: 0; border-bottom: 1px solid #ddd; border-radius: 0; padding: 1.4rem 0; }
.hub-entry-meta { font: .8rem system-ui, sans-serif; letter-spacing: .02em; }
.hub-entry-title { font-size: 1.5rem; line-height: 1.25; }
.hub-entry-body p { margin: 0 0 1em; }
.hub-quote { border-left: 3px solid #c9b79c; margin: 1em 0; padding: .1em 1em; font-style: italic; }
.hub-entry-actions button { font: .8rem system-ui, sans-serif; }
.hub-tabs a { font-family: system-ui, sans-serif; }
@media (max-width: 900px) { .hub-main { margin: 0 auto; max-width: none; padding: 0 1rem; } }
```

## Which names the companion answers to

A web page can make a browser send requests to your own computer under the
page's name, after pointing that name at `127.0.0.1` ("DNS rebinding"). So the
companion refuses (HTTP 421) every request whose `Host` is not `127.0.0.1`,
`localhost` or `[::1]` on the port it listens on, or a public hostname you have
configured. Public names come from `PLUGIN_PUBLIC_HOSTNAMES` (a comma-separated
list) and the reading room's and memorizer's names (`PLUGIN_READING_HOSTNAME`,
`PLUGIN_MEMORY_HOSTNAME`): there are no built-in names, so a name that was not configured is a foreign one (`botference plugin`, the launcher,
passes the names it routes the tunnel to). A companion that signs people in with Cloudflare Access refuses to start with none, and then
refuses (421) any request through the tunnel that asks for another name. A companion started with `--hosted` also answers other
names (its tunnel carries its public name, or `localhost` when the tunnel rewrites
the Host line), but only to a request that passes the password. A request with no
`Host` at all is always refused.

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
  highlighted passage and the page's title and address to Claude, through a
  separate `claude -p` run with no tools, when you send the message (see "TK
  gaps" above). Nothing is sent again for a gap already filled unless you ask
  for it again or change its instruction, and nothing is sent at export.

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
