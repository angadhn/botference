# CHANGELOG

## 2026-08-29

- **The bots can now see what the whole review has already decided.** Editing a
  long draft, decisions pile up in different threads: you settle a phrasing on
  page 2, you agree a deletion on page 5. Until now a bot answering a comment on
  page 9 knew only that one conversation, so it could happily suggest wording
  that undid something you had settled an hour earlier — and you were the only
  one who would notice.

- **How it works, and why it is not just more text in every message.** Putting
  all fifty threads into every turn would bury the one comment the bot was
  actually asked about. So the companion keeps a short summary of the whole
  review in a file on your machine — one line per comment, newest decision
  first, saying what the passage was, what state it is in (still being
  discussed, a change proposed and waiting on you, struck through, filed,
  or the passage deleted) and what was decided — and each turn simply tells the
  bots where that file is. They read it when they need it. It costs no extra
  bot time to write: every line comes straight off the record.

- **And a bot that disagrees has to say so.** The instruction is not "go along
  with whatever is in there". If what a bot wants to propose genuinely
  contradicts something already decided, it is told to name that decision and
  say why it would decide differently — rather than quietly contradicting it,
  or quietly going along with something it thinks is wrong. Catching those
  clashes is the whole reason it has the file.

- **It stays current by itself.** The summary is rewritten whenever a decision
  changes — you file a thread, delete one, strike a passage through, correct a
  note, accept or turn down a suggestion — and again just before any bot turn
  goes out, so a comment you filed while the bots were busy still counts. It
  appears once a page has two comments on it (with one, there is nothing to be
  inconsistent with), it never goes into any export or annotated copy, and it is
  deleted along with the page.

- **One discussion can now end in several changes, not just one.** A bot
  answering a comment on a PDF may propose up to three separate deletions or
  replacements in a single reply — each with its own chip, each with its own
  Strike it button. Take one, take all three, take none. Until now a
  conversation that concluded "these three sentences all have to change" could
  only ever produce one red line, because a marking belonged to the passage you
  had highlighted and there was only one of those.

- **And the discussion says what it produced.** A thread that has struck
  something out carries a quiet line under its quote — "struck through here — 3
  changes" — with a number for each one that takes you straight to it. The
  strikeouts themselves already carried the link the other way ("from a
  discussion · view"); now both ends of it are drawn.

- **The bots can name the passage themselves when your highlight was short.**
  This fixes something that happened on a real manuscript: a highlight that
  missed the first letter of a word and stopped short of the words either side,
  and a bot that answered by telling the reader to go back and highlight it
  again properly. It can now say which words it means — the full phrase, copied
  from the page — and the chip shows you exactly what will be struck, with a
  line through it, before you press anything. The mark lands on the right words.
  You never re-highlight.

- **A named passage is checked before it can become a button.** It has to be on
  the page you are reading, found there exactly once, and it may not run
  half-across a marking that is already there. If any of that fails, no button
  appears, the chip says which of the four things went wrong, and the bot is
  told on its next turn — so it fixes the line instead of telling you a deletion
  was made.

- **A strikeout can change hands.** Editing a long draft turns up
  inconsistencies late: a conversation on page 9 concludes that the mark you
  made out of a conversation on page 3 now needs different wording. Confirming
  it there moves the mark to the new discussion — it drops out of the old one's
  list and appears in the new one's, and the trail of where it has been is kept
  on the record rather than overwritten.

- **Discuss your blog draft, and have the bots suggest changes to the draft.**
  Write a post in markdown, run your site locally (`jekyll serve`), open the page
  in the browser and comment on it the way you comment on anything else — and now,
  when you ask for a passage to be tightened, the bots go and read the MARKDOWN
  the page was built from and propose a change to it. Before this, a comment on
  your own draft could be answered and could not be acted on: everything the bots
  could see was the rendered page, which is a photocopy the next build throws
  away.

- **They propose; you decide; nothing happens to your post until you say so.**
  A suggested change arrives under the reply as a small card: the sentence as it
  stands, the sentence as it would read — struck through where words go, tinted
  where they arrive — and one line saying why. There is an Accept and a Reject
  on it and nothing else. Until you press Accept, your file has not been
  touched. When you do, the change is made, Jekyll rebuilds, the tab reloads and
  you are looking at the result.

- **A whole-page pass is a stack of small changes, each answered on its own.**
  Ask in the page chat — "spell-check the whole post" — and the answer comes
  back as a list of proposals rather than a paragraph describing them. Go
  through them one at a time, or press **Accept all** and take the lot: they are
  applied top to bottom, in the order they appear in the post.

- **When a change cannot be made safely, it is not made, and you are told.**
  The companion finds the passage by looking for it in your file, and it insists
  on finding it exactly once. If the sentence has since been edited, or if the
  same wording appears in three places, there is no way to know which one was
  meant — so nothing is changed, the card turns and says which of the two
  happened, and the change is yours to make by hand if you still want it. It
  never picks one and hopes. An Accept all stops there too: what has already
  been applied stays applied, and what is left is still yours to answer. (This
  is the same rule the paper-review side of botference has used on LaTeX
  manuscripts for months — the same code, imported rather than rewritten, down
  to being untroubled by line wrapping and by curly quotes.)

- **A proposal that could not be read still shows up.** If a bot writes a
  malformed suggestion, you get a quiet card saying so rather than silence —
  because silence is indistinguishable from a change that landed, and the bot's
  own "done!" would then be the only account of it you had. Bots are told, on
  their next turn, what you accepted and what you turned down.

- **You tell it once which folder your site comes from.** In the companion's
  `config.json`:

      "blog_sites": [{ "serve_origin": "http://localhost:4000",
                       "root": "/Users/you/sites/yourblog", "kind": "jekyll" }]

  The first time you open a page of that site, the drawer asks — once — "is this
  your site?", exactly as it asks about a council folder, and for the same
  reason: saying yes is what lets the bots edit files in there. Saying no is
  kept too, and it never asks again.

- **It works out which file the page came from by reading your repo, not by
  guessing.** Front-matter `permalink` first, then the permalink templates in
  your `_config.yml` (categories and all), then the usual filename conventions,
  and finally a match on the slug — which covers permalink styles nobody
  modelled. Posts, drafts, pages and collections all resolve. If two files share
  a slug it says so rather than picking one, and if it cannot work out which
  markdown renders at an address it tells you that in the drawer and leaves
  everything read-only. The drawer names the file it is about to edit, so you
  always know what is about to change.

- **Images too.** A bot can put a new picture in the right place — the file
  under `assets/`, referenced the way the rest of your post references images —
  and edit an existing one with whatever image tools are on the machine.

- **It will never publish your site, and that is on purpose.** Nothing in
  Discuss commits, pushes, branches or tags anything in your site's repository,
  there is no publish button and no way to ask for one, and the bots are told in
  so many words not to run git there (the CLI is configured to refuse it as
  well). You put your site live yourself, by your own route. This is a promise
  written into the code rather than a setting: it belongs to the KIND of folder,
  so a config restored onto a new computer brings the protection with it and
  there is no flag anywhere to switch it off. (The paper-review side of
  botference still commits and pushes as it always did — a paper under review is
  a shared working copy; your blog is your published name.)

- **Every file that moves is still counted and named.** On other kinds of
  document, a change nobody commented on turns into a comment thread of its own
  so it cannot land invisibly. On your blog there is nothing for that to catch —
  no change lands during a turn at all, and everything proposed is already a
  card in front of you — so it does not run there. What does run is the count:
  if anything in your site's folder moves, you are told what moved, and if it is
  this post, the tab reloads.

## 2026-08-28

- **A long PDF opens.** Marking up a book was, quietly, not possible: at a
  hundred pages with a hundred comments the tab sat frozen for over two minutes
  before a single highlight appeared, and every comment you filed froze it
  again. At the size you actually wanted — several hundred pages, a few hundred
  comments — it never finished at all. The same document now comes up in about a
  second, and a five-hundred-page book with three hundred comments in about
  three and a half.

- **Why it was slow, in one sentence.** Every time the extension went looking
  for where your comments belong on the page, it re-read the whole document from
  the beginning — and it did that once for every comment, and then re-read it
  again between painting each highlight. On an article you would never notice.
  On a textbook it was the whole afternoon. It reads the document once now, and
  keeps the reading.

- **Filing a comment no longer freezes the page behind it.** Your words always
  appeared in the thread straight away; what came next was the whole document
  being re-read, which is what made pressing Send feel like the app had stopped.
  That pass now takes a fraction of a second instead of a minute and a half.

- **Nothing about how comments attach to the page has changed.** Same rule for
  finding a passage, same handling of a passage that has moved or gone, same
  orphan badge when it cannot be found. This was only ever about how long it
  took to answer, never about the answer.

- **There is now a test that keeps it that way.** It builds a three-hundred-page
  book with two hundred and fifty comments on it, opens it in a real browser,
  and fails if opening it or filing a comment ever starts creeping back towards
  slow.

- **A question you filed can now be fixed instead of filed twice.** If you asked
  a bot to reword a question it had made, it had no way of saying "change that
  one" — so it wrote another, and you ended up with two questions about the same
  idea and no way to correct either. Now, in a discussion that has already made
  questions, a bot is shown which ones (with their ids) and can offer a
  corrected version of a particular card. The button under its reply says
  **Revise the card** rather than **File it**, and pressing it rewrites the
  question that is already there — one card, not two.

- **Revising a card does not cost you your progress with it.** The wording, the
  options, the right answer and the explanation are all replaced; how well you
  know it and when it comes back next are left exactly as they were. That is
  deliberate: your history with an idea took months to build and the wording
  took a moment, so correcting a question should never send it back to the start.
  A card you had flagged as wrong goes back into rotation the moment it is
  rewritten, which is what flagging was always waiting for.

- **A correction that cannot be applied says so, and never quietly makes a new
  card instead.** If a bot names a card that is not in your vault, or one from
  another page, you get a greyed note under its reply saying so — no button, and
  nothing filed. The bot is told the same on its next turn, so it cannot go on
  telling you a question was fixed when it was not.

- **"This looks like a duplicate."** Where two questions in your vault came out
  of the same discussion, or ask nearly the same thing about the same page, the
  quiz and the Memorize tab say so quietly beside the card and show you the other
  one. One tap discards whichever you do not want, or says they are different —
  in which case that pair is never mentioned again. It is a hint and only a hint:
  nothing is merged and nothing is ever removed on its own.

- **"Seems wrong" and "discard" are where you can find them.** In the Memorize
  tab they used to appear only after you had answered a card, so getting rid of a
  question meant answering it first. They now sit under the card the whole time,
  as quietly as before.

- **The bots can see the page now.** Highlight a figure caption in a PDF and ask
  what the plot shows, and the answer is no longer "I cannot see it": the viewer
  renders that page to an image, the companion keeps it beside the page's
  snapshot, and the turn hands the agent the file to open. Both bots really do
  look — claude with its Read tool, codex with `view_image` — so figures, plots,
  tables and equations are finally part of what a comment is about. A scanned
  page, which has no text at all, is readable to them for the first time.

- **…and when it cannot see, it says so.** A page that was never captured — the
  document is not open in a tab, or the comment came from the phone — makes the
  turn say exactly that, and tells the bot to admit it rather than answer from
  the caption. Silence there was how a model ended up describing a figure it had
  never seen.

- Capture is quiet and costs nothing you would notice: it happens when you
  comment on a page (about a tenth of a second), the same page is never sent
  twice, and a render that fails never delays or blocks your comment. Pictures
  live under `.botference/plugin/snapshots/` beside the page's text and are
  deleted with the page.

## 2026-08-27

- **Memorize: the question vault has a face, an address, and a way home.** The
  quiz you review your filed questions in is now its own product at
  **`memorizer.botference.com`** — on that address `/` *is* the quiz. Same
  companion, same tunnel, same sign-in (a phone you already approved for the
  review hub is the owner there with nothing typed), still owner-only and still
  scriptless. The reading room stays at `discuss.botference.com`; anything else
  on the vault's address goes home rather than serving the archive twice.
  `--install-tunnel` routes the new hostname alongside the other two.

- **…and it looks like something now.** Warm ivory ground, the question set in a
  serif with room around it, softly rounded cards, one accent (the plugin's own
  clay), and a dark scheme that is designed rather than inverted. On a wide
  screen the explanation, the passage the card was made from and who wrote it
  sit in a MARGIN beside the question — margin notes beside a manuscript, which
  is the thing this whole product is — and the question does not move when you
  answer. On a phone they stack in reading order under your answer, with `next`
  pinned to the bottom of the screen so it is under your thumb while you are
  still reading the explanation. Right is a calm green; wrong is warm, never the
  strikeout's red — being wrong in your own memory is not a correction to the
  document.

- **A question and its discussion now point at each other.** Filing a question
  marks nothing on the page (deliberately — a question is a note in your memory,
  not a property of the file), which left no trace of it anywhere. Every card in
  the quiz now carries a quiet *from a discussion · trace* that opens the source
  in a new window, resolved when the page is drawn: the discussion if that
  thread still exists, the page if only the page does, and nothing at all if the
  page is gone — never a dead link. In the other direction, a comment thread
  that has produced questions says *filed as a memory · view* (or *3 memories*),
  and stops saying it the moment you discard the card.

- **A Memorize tab in the drawer: revise the page you are on.** Beside Comments
  and Page chat, a third tab shows what this page (or a council project it is
  filed in — never "everything"; that is what the address is for) has put in the
  vault, and lets you answer it there and then. It goes through the same
  endpoints as the quiz page, so there is one schedule on disk and never a
  second one. Get one wrong and the card becomes a correction slip: what you
  pressed shrinks to a struck line, the wrong options disappear, the right
  answer is promoted to a slab of its own, and the explanation gets the whole
  width of the column.

- **Two ways a card leaves, and they mean different things.** *Seems wrong*
  parks a card — out of rotation, everything kept, waiting to be rewritten.
  *Discard* drops it for good: it was not worth remembering after all, and the
  row leaves the vault. Both are on the quiz page and in the drawer, both quiet
  and well away from the answer buttons, and neither is silent — the next page
  says which of the two happened.

- **A strikeout's note now says the whole thing, and you can change it.** When a
  bot suggests a passage should come out, the note it proposes is the note that
  goes onto the document — read weeks later by a co-author who has only the
  struck passage and that one line, because you delete the conversation
  afterwards. So a note that points back at the chat ("replace with the wording
  above", "as discussed") is **refused**: no button appears, nothing is marked
  up, the reply says so in plain words, and the bot is told why on its next turn
  so it writes the line again properly. Where the conclusion is replacement
  wording, the note now carries that wording in full — and nothing anywhere
  truncates it. A note used to be silently cut at 200 characters, mid-word, and
  then you were asked to paste the rest in by hand.

- **…and a strikeout you have already made can be corrected in one click.** Ask
  again in the discussion, take the better wording, and the note on the
  strikeout is rewritten in place — same red line, your name, the date it was
  made, and the exported PDF picks it up. A suggestion you passed over keeps a
  *Use this note* button for the same reason, the chip tells you which of the two
  things your click did, and you can still edit the note by hand like any comment
  of your own. Before this there was no way to change it at all.

- **A strikeout says where it came from.** While the discussion that produced it
  still exists, the strikeout's card carries a quiet *from a discussion · view* —
  the way back, and on the page the only way back, since the red line sits over
  the highlight you would otherwise have clicked. Delete the discussion and the
  link simply goes away; the strikeout stands alone, as it always has.

- **The annotated PDF carries only live marks.** A thread you have filed is a
  settled argument, and the copy you send is for somebody else to read — so
  resolved threads are no longer written into it. They are not counted as
  failures either: the *"N comments written · M could not be placed"* line stays
  a true sentence about anchoring, and a page where everything is filed says so
  in plain words (*"every comment here is resolved or already in the file"*)
  rather than opening a Save dialog for a copy identical to the original. The
  Obsidian note is unchanged and deliberately opposite: it keeps every filed
  thread, its *Resolved by…* line and its summary, because that note is your own
  complete archive rather than a copy for anyone.

- **Discuss remembers things for you now.** Everything you read and argue about
  with the bots is a record of having understood something once; nothing brought
  any of it back. Every comment thread now carries a small **?** beside its ✓,
  and the selection pill on any page carries one too: *this is interesting, make
  a question of it*. One click and that is the end of your part in it — a bot
  writes a short multiple-choice question about the idea (true/false and
  fill-in-the-blank where the material suits them), and it goes straight into a
  question vault. There is no card to approve, no format to choose and no
  settings anywhere: you decide what is worth remembering, and nothing else.

  The bots may **offer**, too — rarely, and only when a conversation has shown
  you have not got something. It arrives as a *File it / No* chip under the
  reply, in the same shape as the strike and filing suggestions. Nothing is
  filed until you press it.

- **…and asks you about them, on your phone.** A new **quiz** page in the
  reading room (`/quiz`, linked from the pages list and from a door in the
  drawer's header that says how many are due) shows one question at a time,
  biggest overdue first. Tap an answer: right and it comes back later, wrong and
  it comes back sooner — and, before it does, you get the explanation, the
  passage it was made from, and a link to the very conversation that produced
  it. Rescheduling is Anki's own SM-2 algorithm, so a question you keep getting
  right disappears for months and one you keep missing is asked again before you
  stand up.

  Every card links back to its source because a bot wrote it and bots are wrong
  sometimes; there is a *this card seems wrong* button on every one, which takes
  it out of the rotation. The whole page works with JavaScript off.

  One bank, not decks: cards remember the page, the council project it is filed
  under and its tags, and the quiz's chips let you narrow to a topic — and show
  which topics you have been getting wrong.

## 2026-08-26

- **A bot suggesting a change now knows what else is marked in the sentence —
  and that its highlight is a fence, not a starting point.** On a paper with
  three marks in one sentence (two already struck, one still under discussion),
  asking the bot in the third thread for a rewording and then saying "add it"
  came back rewriting the whole sentence: text the other two marks already
  covered, swallowed and rewritten a second time, and not even the change it had
  just proposed.

  It was not being wilful. Its turn showed it one quoted passage and nothing at
  all about any other mark on the page, so the only sentence it could see was
  the whole sentence. A comment turn on a PDF now also carries the other marks
  sitting on or beside its passage — what each one is (a strikeout is a decision
  already taken; a highlight is a conversation), whether it is open or filed, and
  its exact wording, nearest first.

  Alongside it, on **every** comment turn: your highlight is the whole of the
  remit. A suggested rewording or deletion must fit inside the passage you
  highlighted and change nothing outside it; where a change genuinely needs
  something outside it to move as well, the bot has to say so in a line of its
  own instead of quietly widening its wording. And "add it" means exactly what
  it already proposed in that thread, "add some of it" the part you named —
  neither is licence to grow the change.

- **A discussion can now END in a strikethrough.** You highlight a passage,
  argue about it with the bots, and between you decide the sentence should come
  out — and until now the thread stayed a yellow highlight, because which of the
  two tools you were using was decided when you selected the text and never
  again. The only way to the red line was to delete the thread and draw the
  strikeout over the passage a second time, losing the conversation that reached
  the decision.

  Any comment on a PDF now carries a small struck **S** beside its ✓, and one
  click turns it into a strikethrough — your name on it, the red line on the
  page, the whole conversation kept. The way back is the same control, drawn
  quieter. It works on comments made long before this existed; there is nothing
  to convert or migrate.

- **…and the bots can suggest one.** When the discussion in a thread has
  genuinely concluded that the passage should go, a bot may end its reply with a
  suggestion, and you get a chip: **Strike it / No**. Bots never mark up your
  document — the chip is an offer and nothing more.

  **Both of them may suggest, and you pick.** Ask claude, ask codex, compare:
  each suggestion is a chip on its own reply, in its own words, and taking one
  uses that wording. The one you turned down does not disappear — it goes quiet
  and says "not chosen", still showing what it had proposed.

  Saying yes does **not** turn the discussion into a strikeout. It creates a
  separate strikethrough of your own on the same passage, carrying the one-line
  reason and none of the conversation — so you can then delete the discussion
  and the person you send the annotated PDF to sees a clean red line with your
  name and one sentence in the popup, with no trace of the agents. Deleting the
  discussion leaves you looking at the strikeout it produced, not at nothing.

- **Bot replies are typed out, not dropped in.** A bridge hands over text in
  chunks whose size is an accident of the tokenizer and the network — a
  sentence, then eleven characters, then a paragraph — and painting each one as
  it landed made an answer arrive in lurches. Both the Discuss drawer (comment
  threads and page chat) and the council web chat now reveal a live answer at a
  readable pace instead.

  This is not slowness: nothing is ever held back that has not already arrived,
  and the pace is a fraction of the backlog, so a burst — or the end of an
  answer — catches up in a few frames. A finished reply is never waiting on an
  animation. Markdown is unaffected: the pacing happens to the text, before it
  is rendered, so nothing is ever half-parsed on screen.

  **The way back** is a two-position switch: `typed · instant`, in the drawer's
  gear popover under the reply-length switch, and in the council's sidebar
  footer beside the theme control. Each is remembered per surface. If your
  system asks for reduced motion you get `instant` regardless, the switch says
  so, and your own choice is kept underneath for when that changes.

- **The comment you just wrote in stays the one you are looking at.** On a long
  document, pressing Send used to lose you the card: it dropped back into page
  order, stopped looking current, and when the bot answered you had to go back
  to the document and click the right highlight to find your own conversation.
  A Send now holds that thread — spotlit, and scrolled back into view on every
  redraw — so the answer types itself where you are already looking.

  It holds **until you do something else**, and only that: scrolling the column
  yourself, opening another thread or highlight, or changing tab releases it.
  Content arriving never does.

- **Bots are told when a passage is struck through.** A strikeout on a PDF is a
  suggested deletion, and a bot summoned into that thread was answering as
  though the sentence were uncontested. The turn now says so — and says
  explicitly that it is background, not a request: answer what was actually
  asked, and do not carry out or argue for the deletion unless asked. Ordinary
  highlights are unchanged.

- **Fixed: maths lost its typeface on pages that hydrate.** The KaTeX font link
  lives in the page's own `<head>` (font declarations do not register inside a
  shadow root) and was only ever added once, so the same React hydration that
  deletes the drawer's host deleted the fonts with it — every formula in the
  drawer quietly fell back to the page's serif for the life of the tab. It is
  repaired the same way the host is now, including when only the head is
  re-rendered.

- **The test harness is a thing an agent can trust again.** Three poses were
  known-unreliable and all three were the harness's own bugs: the workspace
  pose died on a null click (two selectors that later work had made ambiguous),
  the commenters pose looked like it never started (it published its result
  where no runner could read it), and the hydration pose scored 8-9/11 headless
  (three assertions read a class set inside an animation frame). A missing
  control is now one named failure rather than the end of a run, and
  `?pdf=scan&selftest=1` has a small pose of its own instead of falling through
  to fifty assertions about a text layer it does not have.
- **A page can be filed in a council project, and then it knows what that
  project knows.** The case this is for: you are marking up the second draft
  of somebody's manuscript, and everything anyone said about the *first* draft
  is in a project — in chats Discuss could read and had never had any reason
  to open, because that PDF is a different page, made of different bytes, on a
  different day. The bots answering on draft two had no idea draft one had
  ever been discussed, and you were left retyping last round's objections into
  this round's margin.

  There is a folder button in the drawer header now. It lists your projects
  with a peek at each — their recent chat titles, the files in their folder —
  so two similarly-named ones can be told apart without opening either, and
  ticks the ones this page is already in. File the page, and every turn on it
  carries a digest of what those projects hold: the chat titles, `TASKS.md`,
  the file list, and **the actual words** of the two most recent
  conversations. Titles alone would tell the bots that a conversation
  happened; the point is what was decided in it.

  **Filing is a read, not a move.** The page stays exactly where it is, keeps
  its own chat and its own queue, and gains no permission to write anything
  anywhere — that is the difference between a page *filed in* a project and a
  page that *is* one of the project's own files. It can be filed in several at
  once (the three most recent talk, and the page says how many did not fit),
  and unfiling is one click that leaves nothing behind.

- **…and the bots may say where a page belongs — but they may not put it
  there.** On a page filed nowhere, the turn carries the names of your
  projects, and a bot that thinks this page clearly belongs with one of them
  ends its reply saying so. Discuss lifts that line out of the words and draws
  it under the reply as a chip: *"This looks like it belongs in Adriana's
  paper — the same manuscript, one draft on"*, with **File it** and **No**.
  Nothing is filed until you press it. A bot that invents a project name is
  ignored rather than given a button that files a page nowhere.

- **A project's contents, in the sidebar.** Every project block in the council
  web UI has a **contents** row now: its chats with dates, and a shallow
  listing of `projects/<id>/` with sizes — top level plus one level inside
  each folder, so a project holding a checked-out repo cannot turn the sidebar
  into a file browser. Read-only, and fetched when you open it rather than
  carried in the snapshot that goes out after every turn. `/project contents
  [<id>]` prints the same two lists at a terminal.

- **A project's folder can be pushed to a new private GitHub repo.** ⇪ publish
  to GitHub… in the sidebar, or `/project github [<id>] [<name>]`. It checks
  that `gh` is installed and logged in *before* asking anything, then names
  the repo it is about to create and waits for a yes — creating a repository
  under someone's account is not undoable from here, so it is never one click,
  and an interface that cannot ask is refused rather than guessed at. The name
  defaults to a slug of the project title. A folder that is already a git repo
  is not re-initialised, and one that already has an `origin` is **pushed to**
  rather than given a second repo it did not ask for. Your own `gh` login does
  the talking; Botference never handles a token. The resulting URL is
  remembered and shown under the contents panel.

- **Three different-sized ways to get a chat out of a project's list, and they
  are no longer one word.** The ⋯ menu on a chat row now offers **Remove from
  project** first — the chat, its transcript and its title are untouched, only
  the filing goes, so it lands back in Inbox and `/file` puts it where you
  meant. Then **Archive** (it leaves every listing; every byte survives), then
  **Delete…**. The commonest reason to want a chat out of a project is that it
  was filed in the wrong project, and losing the chat over that is a loss with
  no cause. Also `/project unfile [<session-id-prefix>]` at a terminal.

- **The 8-chat limit on the project panel is gone.** Eight was a UI number
  pretending to be a payload number: the sidebar looked tidy, and a project
  with a dozen chats simply could not show you the older ones — a chat that
  fell off the shortlist could not even be confirmed by `/resume` from the
  web, which is why the active chat had to be bolted back on. The real
  constraint is that the whole snapshot is recomputed after every turn and
  broadcast to every open tab, so it wants a bound set by bytes rather than by
  taste: it is 100 now (`BOTFERENCE_PANEL_SESSION_LIMIT`, and `0` means no
  limit at all), which for any personal workspace is no limit at all. The
  sidebar scrolls a long list instead of truncating it, and a project's own
  buttons sit below the scroller where a long list cannot push them away.

## 2026-08-25

- **Fixed: the annotated copy could not be written for a local PDF at all.**
  "Cannot perform Construct on a detached ArrayBuffer" — the file's bytes are
  read once at boot and handed to the renderer, which takes them for keeps, so
  the export was writing from a buffer that no longer existed. It reads the
  file again now. Only local PDFs were affected; one off a website was fine.

- **The annotated copy asks where to put itself, and says where it went.** The
  export used to hand the file to the browser's downloader and report in a grey
  line at the bottom of the drawer, so a click looked like nothing happening.
  It now opens a real Save dialog, and says in the pane itself what it is
  doing, where it landed, or why it could not — the failure staying up until it
  is read. Cancelling the dialog cancels the export; it does not download one
  anyway.

- **The PDF selection pill wears the signs its tools are known by**: a speech
  bubble for comment (the same 💬 the article pill has always shown, drawn) and
  an S with the red line through it for strike.

- **A second tool on a PDF: strike a passage through.** The selection pill on a
  PDF now has Adobe's pair — highlight-and-comment, and strike-through — and a
  struck passage is drawn the way Acrobat draws it: a thin red line through the
  middle of the words, not a coloured block over them. The words stay
  perfectly readable, because the point of striking them is that somebody has
  to be able to read what you want removed.

  A strikeout **needs no note**. The line through the sentence has already
  said "this should come out", so Send files it with the box empty; type
  something if you want to say why. Either way it is an ordinary thread from
  then on: reply into it, `@claude` it, resolve it, and it turns amber and then
  sage on the page exactly as a highlight does — the line keeps the colour, so
  a page read at arm's length still tells you which passages are waiting on
  you.

  It travels. A `/StrikeOut` already in the file arrives struck; **an annotated
  copy** writes your struck threads back out as real strikeout annotations, in
  red, that Acrobat and Preview draw — so the author you send the copy to sees
  the deletion you meant rather than a yellow highlight with a note under it.
  The reading room quotes a struck passage struck, and the Obsidian note wraps
  it in `~~` with *suggested deletion* beside the page number.

  PDFs only, deliberately: a strikeout is a suggested edit to a draft, and a
  news article is not a draft. The pill on an ordinary page is exactly what it
  has always been.

- **A PDF's own comments are comments now — in both directions.** Open a
  manuscript that has been round a supervisor and Discuss used to say "No
  comments yet" over a paper covered in Acrobat highlights and Preview sticky
  notes. It now reads them: the drawer says *"This PDF carries 7 comments"* and
  offers to import them, and pressing the button turns each one into an
  ordinary thread — quoted on the same words, on the same page, under the name
  of whoever wrote it, at the moment they wrote it, with Acrobat's own replies
  underneath. From there they are threads like any other: reply, resolve,
  `@claude`, send review, export to Obsidian. Nothing is imported without being
  asked for, nothing is imported twice however often you reopen the file, and a
  comment you edit in Acrobat comes back as a new one rather than overwriting
  the thread your bots have already answered in.

  And back out: the export chooser on a PDF now offers **an annotated copy**.
  Every thread on the page — your comments and the bots' replies — is written
  into a copy of the file as a standard highlight with the whole conversation
  in its popup, and downloaded. Send that to somebody who has only Acrobat and
  they can read the discussion. The original file is never touched, never
  uploaded and never copied anywhere: the annotated version is built in the
  browser and lands in your Downloads folder as `<name> (discussed).pdf`.

  The annotated copy is still **the same document** to Discuss — same page,
  same chat, same highlights — because a PDF is identified here by its words,
  and annotations are not words.

- **Fixed: the drawer went missing on Medium (and any site that renders its
  whole page from a framework).** Select a passage and no comment button
  appeared; click the toolbar icon and no panel opened. Nothing was in the
  console, because nothing was wrong with the drawer — the *page* had thrown it
  away. Medium's React hydrates the whole document, and hydration deletes every
  element in `<html>` that React did not put there, Discuss's drawer included,
  about half a second after it mounts. Every button went on working perfectly,
  into a piece of the document that was no longer in the document. Now the
  drawer notices and puts itself back: the same drawer, with the same
  conversation open in it, whether it was on screen at the time or is being
  asked for by the next selection.

- **Comments left on a review page now reach your bots.** A visitor without the
  Discuss extension writes in the review page's own margin, and until now that
  is where their comment stayed: a line in a file beside the document, invisible
  to your drawer, to the bots, to send review and to the export — while you,
  reading the same page with the extension, wrote somewhere else entirely. Two
  records of one conversation. Now they are one: turn it on with a single line
  in `review/review.config.json` —

  ```json
  "discuss": { "companion": "http://127.0.0.1:4189" }
  ```

  — and every comment in the margin becomes a Discuss thread on that page, under
  the name of whoever wrote it, anchored to the same words, at the time they
  wrote it. It joins send review, the pages library and the Obsidian note like
  any other comment. Whatever is said back — a bot's answer, your reply — comes
  home to the review page's own margin, so the visitor sees it where they wrote.
  A comment about the document rather than a passage lands in that page's chat
  instead of pretending to have an anchor. Filing a comment over there files the
  thread here; reopening it here is never undone. Nothing is ever deleted.
  Without that config line **nothing changes at all** — a clone with no
  companion, a collaborator's checkout, a static site opened from disk all keep
  exactly the commenting they have today.

- **Who said what, in one press.** The Comments pane now carries a row of
  pills — one per person who has written on this page, bots included, with
  **All** first — and pressing one narrows the pane to that person's threads:
  the open list, "Ready for review" and the resolved archive alike, each with
  its own count under the filter. A thread is yours if you said anything in it,
  so a thread you only replied in comes with you and is shown whole; a filter
  never cuts a conversation in half. Each pill wears that person's own colour,
  the one their messages already have. Clicking a highlight on the page still
  opens its thread, filter or no filter, and the tab's number does not move —
  it is how much is left to do, not how much is on screen. Nothing is
  remembered: a new page opens showing everyone. The reading room has the same
  thing as links, so a margin narrowed to one person is something you can send.

- **A project now has a task list of its own, and the bots keep it.** The
  checklist in a chat belongs to that chat and scrolls away with it. A project's
  work does not — so `projects/<id>/TASKS.md` is a standing list the bots read
  before they plan and keep current afterwards: they add items, tick them off
  when the work is genuinely done, and drop the ones that stopped mattering
  (saying why). They are told never to rewrite it wholesale, because everyone
  else's items live in it too. It shows up in both task panels — the council
  web panel and the Discuss drawer's card, above whatever the current
  conversation is working through — read-only in both, since the file is the
  bots' to keep and yours to edit. A project with no list simply has no section.
  Write it by hand if you like; they will pick it up.

- **Two chats working at once no longer write over each other's notes.** Now
  that the bots answer several pages side by side, two chats could be mid-turn
  in the same folder at the same instant — and the scratch files the controller
  keeps for a chat (the handoff it writes when an agent hands its context on,
  and its working copies of the implementation plan and checkpoint) were shared
  by everything in that folder, so the second writer's copy was simply the one
  that survived. Each chat now keeps its own under `work/scratch/<chat>/`. The
  plan and the checkpoint stay exactly where they were on disk, because you and
  the rest of the app open them there; each chat just also keeps a private copy,
  and reads it back instead of a stranger's if another chat has taken the shared
  file over. A plan you edited by hand is still the plan. Handoffs left by a
  previous version are still found.

- **A chat can no longer lose a whole exchange to a second window.** If two
  processes had the same chat open, the slower one used to write its older copy
  back over the newer, and the missing exchange left no trace anywhere. The save
  now notices that the file grew under it, refuses, and says so in the log and
  the crash log rather than deleting an answer silently.

- **Archiving a project can no longer drop a project someone else just made.**
  `set_status` was the last read-modify-write in the project store without the
  lock its neighbours take.

## 2026-08-24

- **Discuss: the bots answer several pages at once.** A turn on one page used to
  hold up every other page in the building: a question on an article queued
  behind a twelve-comment review round on a draft, and a *send review* fan-out
  froze the whole companion for minutes. Turns on different pages now run side
  by side. What stays strictly in order is what has to: a page's own chat is one
  conversation, and everything in one project takes its turn (they share a
  folder the bots may write in, and the record of what changed in it). A review
  round is unchanged — it is one page's conversation across many threads, so it
  is answered in order, and its progress strip still counts straight while
  something else is being answered elsewhere. Waiting now says which wait it is:
  *queued behind this conversation…* when your own last message is still being
  answered, *queued behind another chat…* when every agent is busy with somebody
  else. How many run at once is `bridge_pool` in `config.json` (default 3; `1`
  is exactly the old behaviour), and spare agents are retired after
  `bridge_idle_ms` of quiet (default 15 minutes). `GET /health` now also lists
  which pages have a turn running and which have one waiting.

- **Council: a chat stays in the project you filed it under.** Every save used
  to stamp the chat with whatever project happened to be *open* at that moment,
  so chats quietly hopped between projects — and a second tab left open on
  another project could re-file a chat it was not even showing. A chat now
  remembers its own project, written once when you file it (`/file`,
  `/project assign`, `/project open`, or at creation) and never inferred again.
  Chats filed before this keep exactly where they are listed today. Archiving a
  project no longer unfiles the chat you are sitting in either — the promise
  that "its chats are untouched" is now true of that one too.

- **Council: you say where a new chat goes, before it exists.** Every project
  row in the sidebar has its own **＋ new chat**, which starts a chat filed
  there with that project's files already in context — expanding a project used
  to be purely decorative. The top **New / chat** button now asks first:
  *File in: <project> / just a chat*. And an unfiled chat asks **before** your
  first message goes out — "where should this go?", with the message still in
  the box — instead of interrupting after it has already been sent.
  `/new --project <id>` and `/new --inbox` are the same two choices from the
  keyboard.

- **Discuss: a comment whose passage was silently rewritten is repaired, not
  orphaned.** When a bot rewrote (or deleted) the passage one of your comments
  was anchored to while working on a *different* comment, and said nothing
  about it in your thread, your comment lost its place: no highlight, no struck
  old wording, just a card marked `orphaned`. The turn-end diff already knew
  what had replaced it — it now puts that back into **your** thread, so the
  comment moves onto the new wording with the old one struck through before it,
  on your own card, exactly as a narrated change does. Where the passage was
  deleted outright, the card says so and the comment settles onto the paragraph
  that outlived it. A change absorbed this way no longer also opens a second
  thread about itself.

- **Discuss: a review round tells you how far along it is.** Send review answers
  each comment in its own thread, which meant the round itself — the thing you
  started — showed up nowhere: no count, no position, no end. A strip now sits
  above the status line for as long as a round runs: *answering comment 4 of
  12*, naming the comment being answered and scrolling to it when you click it,
  finishing with *round done — 12 of 12 answered*. It lives on the companion,
  so it survives a refresh, a reopened drawer and a second tab.

- **Discuss: a comment thread remembers who it is talking to.** Tag `@claude`
  under a passage and the follow-up used to summon nobody at all — an untagged
  reply was a note to self, so every back-and-forth message meant retyping the
  tag or watching the question die on the page. A thread now has an **address**:
  once you have written to a bot in it, untagged replies keep going to that bot,
  until you say otherwise. Tagging someone else in a later message re-aims the
  thread, and a bot writing "@codex, over to you" never does — the address is
  yours.

  And it is now something you can see and click rather than type: a small
  **`Note · Claude · Codex · All`** row sits over the reply box, lit on whoever
  the next message is for. Click one to aim it without an @-mention; type a tag
  and the row follows what you typed; **Note** sends to nobody, which is also how
  you step back out of a conversation and go back to taking notes. Both on the
  Mac and on the phone. Page chat is unchanged — plain text there means what it
  always meant.

- **Discuss: comments no longer land on the article you were reading before.**
  On a site that swaps articles without reloading the page — Medium, Substack
  and most modern publishers — the extension kept the identity it was given when
  the tab first opened, so a comment made on the second article could be filed
  against the first one, and the first one could quietly acquire the second's
  title. The extension now notices a client-side navigation, re-decides which
  document it is on, and re-checks once more before any message goes out. A
  site that merely rewrites its path per section of one article still counts as
  one article, exactly as before. One misfiled conversation was moved back to
  the page it belongs to.

## 2026-08-20

- **Default reasoning effort is now medium for both bots.** New council chats
  (and plugin pages) start Claude and Codex at `medium` instead of `high`;
  `OPENAI_REASONING_EFFORT`, the per-agent effort pickers and `/effort` still
  override per chat.

## 2026-08-19

- **Discuss: "▸ more" — a capped answer keeps its long half.** Replies in
  comment threads and page chat are capped short by design, which was wrong for
  the question that genuinely has a long answer. A bot can now put a
  `<!--more-->` line after the capped answer and write the long version below
  it; the reader sees the short answer with a "▸ more" disclosure that unfolds
  the rest. A marker inside a fenced code block is code, not a marker, and the
  Obsidian export keeps both halves.

- **Discuss: collateral edits — the changes nobody commented on.** When a bot's
  edit ripples beyond the passage a comment was anchored to (a cross-reference,
  a paragraph that now contradicts itself), those edits used to land invisibly.
  The companion now snapshots the artifact at turn-start, diffs it at turn-end,
  and opens a comment thread at every changed region no existing thread covers —
  so every edit gets the same before→after card and review flow as the ones you
  asked for. Bots are also told to narrate them ("also changed — this passage
  now reads: …") so the reason rides along.

- **Discuss: "send review" now answers in the comments.** The button used to
  hand your whole margin review to the bots as ONE chat message, and the answer
  came back as one essay in page chat — nothing attached to the comment it was
  about, no thread marked as dealt with. Now a click starts a **round**: a short
  note in page chat saying what is coming, and then **one turn per open comment,
  answered in that comment's own thread**, in page order. Each waiting thread
  says so on its own card ("queued in this review round…") and works through one
  at a time, so a reply lands where the comment is — which means the amber
  **ready for review** badge, the before→after card and the tracked change on
  the page all light up by themselves, for every comment, with no new machinery
  behind them.

  A round is addressed to the room, except in a thread where your last message
  tagged one bot — there that bot answers alone, because you already chose. The
  20-comment limit stays (the rest stay open: send review again and they go
  next); the old 8000-character limit on the whole review is gone, since no
  single turn carries all of it any more. Nothing is resolved for you, as
  before. If the companion is restarted mid-round the turns still queued are
  lost like any other queued turn — the comments they never reached are still
  open, so the same button sends exactly those.

  Fixed while proving it out: a bot's tool-activity line landing after its own
  answer used to strip the "ready for review" badge that answer had just earned.

- **Discuss: track changes, on the page itself.** When a bot's edit
  rewrites a passage a comment was anchored to, the thread now
  RE-ANCHORS to the new wording (the original kept as `prior_quote`)
  instead of orphaning — the amber highlight moves to where the change
  landed, and the change renders inline, Word-style: the old wording
  struck and dimmed just before the new wording in the green tint. A
  "show changes on the page" toggle (default on, per page) hides the
  markup; resolving a thread clears it and the highlight goes sage.
  The inserted "was" text is display-only — excluded from snapshots,
  text extraction and anchoring, so it can never feed back into the
  bots or the anchors.

- **Discuss: two comment pills never fight over one page again — and yours
  wins.** Open a review page — the review engine's build, or one of the
  `*.review.html` documents the review-doc skill makes — and the Discuss drawer
  now **keeps the margin**. Its 💬 is the one that answers your drag, and the
  page's own selection pill is quietly put away, so there is one commenting
  system on the page instead of two writing into records that know nothing
  about each other. Your comments land where the bots, **send review** and the
  project chat already are.

  Anyone reading that same page **without** the extension is untouched: the
  page's built-in commenting works exactly as it shipped. The suppression is a
  stylesheet the extension injects into a page it is already running in, and
  only the selection pill goes — **+ General comment**, **Copy feedback**,
  **Export** and the rest of the page's toolbar all stay exactly where they
  were.

  And you get the last word. One quiet line at the top of the Comments tab says
  which margin has the page and carries **use the page's own commenting**: one
  click hands it back, the choice is remembered for that page alone, and **let
  Discuss comment here** takes it again. Either way every Discuss thread
  already on the page still shows, still paints its highlight and still takes
  replies. Ordinary pages behave exactly as they always have — the whole thing
  hangs off one structural marker checked once when the drawer attaches, so a
  page without it never takes the branch at all.

- **Discuss: "ready for review" — the bots get a middle state.** After the bots
  work through a page of comments, you used to have to re-read all of them to
  find out which ones had moved. Now a thread a bot has replied into since you
  last wrote in it is marked **ready for review**: an amber badge on the card,
  an amber highlight on the passage (between the open yellow and the filed
  sage), and its own **Ready for review** section between the open list and the
  archive.

  **Resolving is still your click, and only yours.** A bot can say it did
  something; it can never close your question. The ✓ files a ready thread
  exactly as it files any other, and **↺ not done** puts it straight back in
  the open list if you disagree — as does simply replying to it, because that
  is a new question.

  **Send review only sends what is still open.** A thread the bots have already
  answered drops out of the count and out of the digest, so a second send after
  a round asks about the points still outstanding rather than the ones just
  done.

  And when a change **rewrites** the passage a comment was anchored to — which
  used to orphan the highlight and lose the link between the comment and what
  came of it — the bots are now asked to quote the new wording back. The card
  draws it as a **before → after**: the old words struck through, the new ones
  in green, right under the quote. Nothing to click, and nothing new stored.

- **Discuss: one button hands your whole margin review to the bots.** On a
  confirmed project artifact page, Page chat now carries **send review**
  under the chat bar. Click it, confirm the count, and every OPEN comment
  thread on the page — the passage you highlighted and the whole
  conversation under it, attributed — goes to both bots as a single
  page-chat turn, addressed to the room. This is the Obsidian-export move
  for a document review: you go down the draft leaving comments the way
  you would in Google Docs, and then hand the lot over without retyping
  any of it.

  The turn asks the bots to work through every point and, where a point
  calls for a change to the files, to **make** it — Phase 2's write rules
  already scope that to the project's own folder. The digest is posted as
  a real, visible message in your name, so you can read exactly what was
  sent (and edit or delete it like anything else you wrote). Threads are
  **not** auto-resolved: the bots answer in page chat and filing stays
  your click, in both directions.

  Honest about its limits. Resolved threads are left out (that argument is
  over), long quotes and long comments are clipped with an ellipsis, a
  very long thread keeps its latest messages and says how many it dropped,
  and past 20 threads or ~8k characters the turn ends with "…and N more
  open comment threads that did not fit in one turn" rather than
  truncating in silence. The button is disabled — with a tooltip saying
  why — on a page with nothing open. Guests get a 403, an unconfirmed
  council root a 409, and with the agents switched off the review is still
  written down and the refusal explains itself, the same as any other
  send.

- **Discuss: an artifact page's chat stops going stale.** Page chat on a
  project artifact mirrors a real council session — and that session is
  also driven from the TUI and from the council's own web UI, by a
  different bridge writing the same file. Turns made there never reached
  the mirror: you talked in the council, came back to the artifact tab,
  and saw a conversation that stopped an hour ago. Now the companion
  keeps a sync mark on the page record (the session file's mtime) and
  refills the tail from disk whenever the two disagree — on every read,
  and, while a tab is connected, from an `fs.watch` on the sessions
  directory, so an open drawer catches up without a reload. Nothing runs
  at rest: no client connected, no watchers.

  After a refill the **session file is the truth** — a message the drawer
  wrote becomes a restored entry like everything else. The exceptions are
  a turn still in flight (the refill waits for it rather than racing the
  reply about to land) and anything this companion stamped *after* the
  file's own mtime, which the file cannot hold and which is therefore
  kept. Half-typed drafts survive the re-render, as they survive every
  other one.

  Caveat, stated rather than solved: two bridges over one session works
  **sequentially**. Typing on both sides at the same moment is out of
  scope.

- **Discuss: plain text in an artifact's page chat goes to @all.**
  Everywhere else in Discuss an untagged message is a note and summons
  nobody, deliberately. But an artifact's Page chat *is* a council chat,
  and the council's rule is that plain text is addressed to the room —
  so on those pages, and only there, an untagged page-chat message is
  routed `@all` (companion-side, where the artifact is known) and the
  composer says so: *plain text goes to @all — or tag one bot*. Comment
  threads keep the old rule everywhere, artifact pages included, as does
  page chat on every ordinary page and on an unconfirmed council root.

- **Council: Word documents attach too.** `.docx`/`.doc` join images,
  PDFs and spreadsheets in both attachment paths. The web server sniffs
  content as ever — a docx is a zip with `word/` entries, a legacy .doc
  is an OLE2 file whose stream directory says "WordDocument" (an OLE2
  without it stays an xls, as before). The bots are told the way in
  (macOS `textutil -convert txt` extracts the text) and the way back
  (an edited version is a NEW file written into the workspace — an
  attachment is never edited in place).

- **Discuss: the checklist stops scrolling away here too.** The council
  web panel got a tasks section last week; the drawer now has the same
  thing. Pinned at the top of both panes — Comments and Page chat — is
  the checklist from the **newest message on this page that has one**,
  wherever it lives: twenty replies up a comment thread, or above a bot
  turn in the page chat. A revised list *replaces* it, so there is
  exactly one list there and it is the current state. No list anywhere on
  the page, no card.

  **The boxes are the transcript's own.** The card is rendered from the
  source message's text and keeps the same `data-tick` ordinals, so a tick
  in the card is the same `POST /tick` a tick in the thread is — the
  message edit the companion already performs, answered with the
  authoritative body. The card holds no checkbox state of its own, which
  is why both renderings move together and there is nothing to keep in
  sync. Nothing is stored and no event changed shape: the card is derived
  from the page record by the renders that already happen (a message
  arriving, a tick coming back, a refetch), so nothing polls.

  A quiet line says who wrote it, how many are done, and which passage
  it hangs off (or "page chat"); `↑ source` crosses to the right tab,
  unfolds the thread and marks the message itself; the fold is a reading
  position, kept for the session. A list that came out of a **restored
  council chat** shows read-only, with the reason in plain words — *from
  the council chat — tick it there* — because ticking it would mean
  editing a session this companion does not own; for the same reason
  those messages' checkboxes are now locked in the transcript too, beside
  the ✎ and ✕ they were already refused.

## 2026-08-18

- **Council web: the task list stops scrolling away.** The bots write and
  rewrite markdown checklists as a plan moves, and the live one was
  wherever the transcript happened to have left it. The agents panel now
  opens with a **tasks** section holding the checklist from the newest
  message that has one — user's or bot's — and a revision *replaces* it,
  so there is exactly one list there and it is the current state. Its
  checkboxes are not a copy: they are the same tick records as the
  message's (keyed by message hash + ordinal in `localStorage`), so
  ticking in the panel ticks the transcript and the other way round, and
  both survive a reload or a replay. A quiet line says who it came from
  and how many are done; `↑ source` scrolls back to the message that
  holds it; the section collapses (remembered) and disappears in a chat
  that has no list.

  Nothing is stored and no event changed shape: the panel is derived from
  the transcript on the fly — each rendered message offers itself as the
  candidate, with a rescan only where the transcript is rebuilt wholesale
  (replay, chat switch, clear), so a chat switch shows that chat's own
  latest list. Because ticks are keyed per message, a revised list starts
  from the `[x]` marks the bots baked into it rather than guessing which
  old item became which new one.

- **Discuss: the artifact you open from the chat is the same page as the
  file on disk.** A bot links the HTML it wrote as `/files/<rel>` on the
  council web server, so that link is usually how you meet it — and until
  now the browser treated it as an ordinary web page: no project, no chat
  archive, and a second record beside the `file://` one. Now the
  companion recognises a `/files/…` url as the same project artifact and
  hands the tab the **file: url as its identity**, so the two views are
  one Discuss page — one record, one set of threads, the project's own
  chat behind both, and the Phase-2 write scope unchanged.

  **Only from an origin you have named.** What a url proves is who served
  the bytes, and `https://evil.com/files/projects/<id>/index.html` spells
  the same path as the real thing. So trust is an exact-origin allowlist
  and nothing else: your `council_web` setting, its `http://localhost:4187`
  default, and an optional `council_web_origins` list for a council
  reached over a tunnel — one line in the companion's `config.json`:
  `"council_web_origins": ["https://council.example.com"]`. Any other
  origin stays an ordinary web page, because what hangs off a yes here is
  your project's chat archive and a write-enabled bridge.

  A root has to have been seen once at a `file://` address (that is what
  records it as yours) before its web view can be recognised, and a
  record created for the https address *before* this change is left where
  it is rather than migrated.

- **The web council bills what you tell it to, per agent.** The agents
  panel gained a billing section: `auto` (a saved key if there is one,
  else the subscription — Claude Code's own rule), `subscription`, or
  `API key`, chosen per agent and applied to the environment every
  bridge child is spawned with. Every path that means "no key" *deletes*
  the variable rather than emptying it — including one the server
  inherited from the shell or LaunchAgent that started it, and including
  the sibling auth sources (`ANTHROPIC_AUTH_TOKEN`, the
  Bedrock/Vertex/Foundry switches, `CODEX_*`) that would answer the same
  question behind your back. The mode is the only authority.

  **Keys never cross the tunnel.** The switch works from anywhere you
  can sign in; saving or removing a key is refused for any request that
  arrived through a proxy (`CF-*`/`X-Forwarded-*`) or from a non-loopback
  peer, and the panel then hides the fields and tells you to add keys
  from the Mac the server runs on. Keys are write-only over the API:
  `GET /keys` answers `set` or `unset` and nothing else, and no response,
  log or error ever carries key material.

  The store is now **shared with Discuss** (`frontends/shared/keys.mjs`,
  moved out of the plugin): one key pasted once serves both products,
  while the mode stays each product's own (the council's in its
  workspace state, Discuss's where it always was). Honest about timing —
  a running chat keeps the billing it started with, since a process's
  environment is fixed when it starts, and no live bridge is killed to
  answer a settings click.

- **Discuss: the bots can edit a project's artifact, and the tab
  reloads itself.** On a confirmed project artifact page
  (`…/projects/spaceship-engineering/index.html`) the agents may now
  create and modify files under *that project's folder* — and nowhere
  else. The scope is not a promise made in a prompt: the bridge child
  for such a page is spawned with that one directory as its write root,
  which becomes Claude's `permissions.allow` Edit rules and Codex's
  `workspace-write` sandbox root, so a write anywhere else is refused
  by the CLI itself. (One honest gap: Claude's `Bash` runs in a sandbox
  whose workspace also holds the council root, since the bots must read
  it — a *shell* write elsewhere inside the council is instructed
  against rather than blocked. Codex is bounded either way, and
  everything outside the council root is blocked for both.) Bridges are
  now one per (council, project) rather than one per council, because
  an environment is fixed when a process starts. Ordinary web pages,
  PDFs and library chat keep deny-all writes exactly as before, and no
  guest ever gains writes.

  When a turn ends and something under the project moved, the companion
  says so: the page's own file changing reloads the tab, siblings
  changing get one line in the chat instead of throwing away your
  scroll and half-typed comment. It is a census taken around the turn,
  not a watcher — nothing runs while you are reading, and `sessions/`
  is never counted. The "is this your council?" card now says what a
  yes buys; an already-confirmed council keeps working unchanged.

- **Discuss: project archives work on the original vault layout.** The
  chat archive read only the project-local sessions store
  (`work/sessions/`); a council using the legacy self-hosted layout
  (`<root>/sessions/` — the original vault) listed "no chats in this
  project yet" over a folder full of them. Both layouts are read now.
  And a restored chat says what it is: one line over the tail —
  "Restored council chat — the last 60 of 382 messages" — linking to
  the complete chat in the council web UI, instead of pretending the
  tail is the whole conversation.

- **Council: spreadsheets attach too.** `.xlsx`, `.xls` (and `.csv` in
  the terminal) join images and PDFs in both attachment paths — drag
  into the TUI, or the web council's picker/paste/drop. The bots are
  told "[Attached spreadsheet: … — read it with your tools
  (python/pandas or openpyxl work well)]". The web server sniffs
  content as ever: an xlsx must be a zip with `xl/` entries (a docx is
  refused), a legacy xls must carry the OLE2 magic; the browser's
  claimed type is never trusted.

## 2026-08-17

- **Council: PDFs attach like images.** Drag a PDF into the terminal (or
  Finder Cmd+C → Cmd+V its path) and it becomes a `[file N]` attachment,
  staged the same way images are; the bots are handed the staged path as
  "[Attached PDF: … — read it with your file-reading tool]". Claude
  reads PDFs natively; Codex gets the path and does what its own tooling
  allows. Same rules as images: a bad path stays visible as text, a
  missing file at send time is reported in the room.

  The web council takes them too: the attach button, paste and drag-drop
  all accept PDFs now (on iOS the picker's "Choose File" reaches Files).
  The composer shows a name chip instead of a thumbnail, sent messages
  render a "PDF · name" pill that opens the file, and the server sniffs
  the `%PDF` magic bytes the same way it refuses fake images — the
  attachment's type is derived from the stored bytes, never from what
  the browser claims.

- **Discuss: idle composers fold to one line.** Every thread used to
  carry a full-height Reply box; now an idle composer is a single quiet
  line, and its hint/Send row appears only while it is focused or holds
  a draft. The active box grows with the text as you type (up to about
  half the panel), so a long comment keeps its own context on screen
  instead of scrolling inside a two-line slot — and that applies to the
  in-place message editor too, which opens showing the whole message.
  While an edit is open, the thread's own Reply box (dead weight under
  an editor) is hidden until save/cancel.

- **Discuss: the pages your council writes are now Discuss pages.** Open
  a project's own HTML —
  `file:///…/botference/projects/spaceship-engineering/index.html` — and
  the drawer is there, with no setup at all. The extension used to
  refuse every `file://` page outright; it now lets one through when the
  companion recognises it: a folder above it holding `project.json`,
  `work/` and `projects/`, with the file inside `projects/<id>/`. The
  header says which project it belongs to. The first time a new council
  folder turns up the drawer asks once whether it is yours, and keeps
  the answer — a no is kept as firmly as a yes.

  The chat behind such a page is not a plugin chat. It is filed under
  the **real project in your real council**, beside everything else that
  project has ever said, by a second bridge running with that folder as
  its workspace. So Page chat becomes the project's chat archive: the
  bar names the chat you are standing in, the list behind it is every
  chat the project has (titles and ages, newest first), and you can open
  any of them — the recent history renders, folded, and typing carries
  it on. "+ new" starts a fresh one, filed in the same place.

  The page is identified by its PATH, deliberately and unlike a local
  PDF: these files are rebuilt in place by the project that owns them,
  so a content hash would strand every annotation at the next build.
  Bots still cannot write files here — that is next — and deleting the
  page never deletes the council chat behind it.

## 2026-08-16

- **Fix: old Discuss pages could never rejoin their chat.** The project
  panel snapshot shortlists each project's eight most recent chats, and
  the companion confirms a `/resume` by finding the session flagged
  active in those rows — so once a project held more than eight chats,
  any page whose chat had aged off the shortlist failed every resume
  with "couldn't resume this page's chat — nothing was sent". The
  active session is now always included in the panel rows, shortlist or
  not. (Surfaced when Plugin pages reached its twelfth chat.)

## 2026-08-12

- **Site: Discuss shows itself moving.** The plugin screenshot on
  botference.com is now a silent 12-second loop of the real thing —
  highlight, comment, both bots, a code cell running into a plot, the
  resolved highlight turning green — filmed on an actual blog post,
  with a "watch the 40-second tour" link to the full cut with music.
  Reduced-motion readers get a poster and a play button instead of an
  autoplaying loop.

- **Discuss: the focused thread gets a spotlight.** Clicking a highlight
  on the page, or a thread in the drawer, now dims every other card to
  42% — the reader was deleting neighbours they mistook for the one they
  meant. Hover restores any dimmed card, blank space in the list lifts
  the spotlight, and a new comment's composer arrives already under it:
  send passes the light to the thread it just became, cancel returns
  the drawer to the standard view.

- **Discuss: comment threads resolve.** A quiet ✓ on every thread row —
  one click, no dialog — files the thread into a collapsed
  `Resolved (N)` digest at the foot of the list, and the Comments count
  now counts only what's still open, so a crowded page visibly thins as
  you sweep. The highlight itself stays on the page but turns a muted
  sage green: still there, marked handled, and clicking it opens exactly
  that filed thread, unfolded, Reopen in reach. A filed thread renders
  as a digest card — the quote, then a summary, then the full thread
  folded inside. The summary starts as an instant snippet and is
  replaced by 3–5 agent-written sentences (what the question was, what
  the outcome was) that arrive through the normal queue without ever
  becoming a message in the thread. Any new message — yours or a
  bot's — reopens the thread on its own; Reopen is just the impatient
  version. Resolved state lives on the server, so it holds across
  devices, the phone reading room gets the same digest and the same
  buttons, resolved threads leave the context the bots read, and the
  Obsidian export files them under who resolved them. Works identically
  on PDFs.

- **Discuss: the council's chat manners came back home.** Claude replies in
  a serif, codex in a grotesque, each in the council's speaker colours in
  both themes; your own turns sit on a green ground with a green right
  edge instead of wearing a hashed hue like any other handle. Every
  settled message has a copy button that puts rich HTML and raw markdown
  on the clipboard together, and any room-protocol JSON footer that leaks
  into a reply renders as a quiet chip — unless it lives inside a code
  fence, which stays untouched so Run buttons keep addressing their
  blocks. The braid mark keeps its own fixed colours (the toolbar icon is
  rasterised from them), so it may sit a shade apart from a Claude reply.

- **Council: the chat renders like the plugin now.** Your messages and the
  bots' go through one markdown renderer — links, bold, lists, headings,
  tables — built the plugin's way (DOM nodes, never innerHTML). Links may
  be root-relative (`/files/…`), which the council serves itself;
  `javascript:` and protocol-relative `//host` stay literal. The
  room-protocol JSON footers (`{"status":"continuing",…}`) no longer print
  as raw JSON in the prose: they render as a quiet metadata chip — the
  summary, and who has the floor — wherever in the message they appeared.

- **Council: recommendations are checkboxes.** `- [ ]` task lists render as
  real tickable checkboxes whose state survives reloads and chat switches,
  and the room prompt now asks both bots to write user-actionable items
  that way.

- **Council: agents panel grew effort pickers,** per agent, alongside the
  model pickers — the status line now reports each bot's effort level too.

- **Council: you can find yourself while scrolling.** New palette in both
  themes; claude speaks in a serif, codex in a grotesque, each with its own
  accent rail; your own bubble sits right-aligned on a green ground. Every
  message has a copy button that puts both rich HTML and plain markdown on
  the clipboard, and selecting text by hand copies with its links intact.

- **Claude is told to be terse where it actually listens.** Codex's CLI is
  laconic by nature; Claude Code's harness prompt rewards thorough
  structured reports, and every botference brevity rule used to arrive as
  turn text that decays as the transcript grows. The claude adapters now
  carry a standing room-style contract in the real system prompt
  (`--append-system-prompt`), the free-form thread injects exactly one
  length instruction every bot turn (the overage cap when the last reply
  blew the threshold, a standing terse line otherwise), and the plugin's
  per-turn length lines gained numeric caps — 60 words for short, 120 for
  long — because a number holds where an adjective drifts.

- **Site: the braid draws itself.** The three strands trace on from the
  left like an oscilloscope, staggered so they take turns, spark at the
  crossings, and fuse into the plan line last; then a phosphor head runs
  one strand at a time, forever, carrying its colour down the fused line.
  Pure inline CSS/SVG. `prefers-reduced-motion` gets the original static
  braid, pixel-identical.

## 2026-08-10

- **Discuss: a code block that ran and printed nothing now says so.**
  `doubling_time = log(2)/0.61` is a perfectly ordinary line of Python. It
  exits cleanly, in about 79 milliseconds, and it prints absolutely
  nothing — and until now the drawer answered it with absolutely nothing
  too, which is exactly what a broken button looks like. Every finished run
  now leaves one quiet line under the block: `✓ ran · 79 ms · no output`
  when there was nothing to show, `✓ ran · 214 ms` above the output when
  there was, and the red `exit 1 · 214 ms` when it fell over. The rule is
  simply that a run that happened never again looks like a run that did
  not. Results you ran in an earlier session get the same line when the
  page is opened again.

- **Discuss: reloading the extension no longer fills open tabs with red.**
  Reloading Discuss orphans the copy of it already running in every tab
  you had open: it keeps going, but everything it tries to ask the
  extension now fails, and those failures were landing in the console as
  uncaught errors on pages you were only reading. Such a tab now says one
  line, once — "Discuss was updated — reload this tab to reconnect." — and
  goes quiet. Reloading the tab brings it back, as it always did.

- **Discuss: the reading pages have a favicon.** `/pages`, a page's
  comments, an article and the sign-in screen all wear the braid in the
  browser tab, so a Discuss tab is findable in a row of twenty. It is also
  the end of a small stream of `/favicon.ico` 404s in the log.

- **Discuss: the PDFs on your own disk are pages now too.** Open a
  `file://` PDF and it opens in Discuss, with the same highlights,
  comments, `@claude`, page numbers, Obsidian export and phone reading
  that a PDF on the web has had. It needs one switch, once, which no
  extension is permitted to set for you: brave://extensions → Botference
  Discuss → Details → "Allow access to file URLs". The settings page tells
  you whether it is on, and if you land in the viewer without it, the
  viewer tells you the same thing rather than showing you a blank page.

  The reason this took a while is worth saying, because it is the whole
  design: a path is not an identity. A PDF filed under
  `/Users/you/Downloads/paper.pdf` loses every comment the moment you
  rename it to something you would recognise in a year and file it in a
  folder — which is what people do with papers. So Discuss identifies a
  local PDF by *what it is* rather than *where it is*: a hash of its
  contents. Move it, rename it, keep a copy on a second Mac, and it is the
  same page with the same conversation. Edit the file and it becomes a new
  page, honestly — different contents, different document — and the old one
  keeps its comments under the old name. The same paper read from the web
  and from your disk are two pages, for the same reason. The note in your
  vault names the file it came out of, since a hash tells you nothing.

  Your file never leaves the machine: nothing is uploaded, copied or
  stored. What your phone reads is the text, exactly as for any other PDF.
  And Discuss annotates nothing else on your disk — a local page that is
  not a PDF is left completely alone.

- **Discuss: a second PDF tab no longer silences the first.** Two PDFs open
  at once, and one of them could come up with its comments missing until
  reloaded: the viewer is one of the extension's own pages, and a message
  meant for the background could be answered by the OTHER tab first, with
  a shrug. A tab now says nothing about messages that are not its business.

- **Discuss: a PDF opens in Discuss every time now, not most times.** If you
  had ever used a PDF's "original" link to look at it in the browser's own
  viewer, that document quietly stopped opening in Discuss — for good, while
  every other PDF carried on working. The one-shot exception that link creates
  was supposed to last a minute, but the timer that removed it lived inside
  the extension's background worker, and the browser shuts that worker down
  whenever it feels like it. The exception outlived its minute by however long
  the document survived. It is now written down with an expiry and swept from
  three directions, so it cannot outlast the click it belongs to. On top of
  that there is now a safety net: any PDF that reaches the browser's own
  viewer for any reason at all — including the first one you open straight
  after installing or reloading the extension — is noticed and reopened in
  Discuss, once, quietly. (Turning web PDFs off on the settings page still
  turns all of it off.)

- **Discuss: renaming a PDF renames it everywhere, while you watch.** Renaming
  a page left the PDF viewer's own title bar showing the document's old name
  until the tab was reloaded. The bar, the browser tab and the drawer now all
  follow the name you chose, live, whether you renamed it here, in another tab
  or from your phone — and clearing the rename puts the document's own name
  back, which it could not reliably do before.

- **Discuss: no more "Companion offline" while the companion is running.** The
  drawer sometimes opened with the full "start your local server" walkthrough
  over a companion that was up and answering — most often on PDFs. It was
  reading one number for two different things: whether the companion replied,
  and whether the live update socket had finished connecting. A socket that
  has not connected yet now means nothing at all, a single failed request is
  retried twice before anything is said, and if the banner does appear it
  takes itself down the moment the connection is back, without you pressing
  Retry.

- **Discuss: an archive you can actually find things in.** The pages list
  gained the three things a growing library needs. **Filter by what a page
  is** — quiet chips above the list, All · Articles · PDFs · Docs, drawn
  only for the kinds you have; the kind comes from the site adapter (a PDF
  is a PDF whatever url its viewer wears) and everything annotated before
  today is filled in from its url, with no migration. **Rename a page** —
  the `✎` on any row, because `2601.01234v2.pdf` is not what that paper is
  called; the name you give it wins in the list, on your phone, in the
  Obsidian note's title *and its file name*, and on the botference chat
  behind the page, which is renamed on that page's next message rather
  than by waking the agents for it. Re-exporting after a rename **replaces**
  the old note instead of leaving a second copy of the same page in the
  vault. **Tag a page** — `#`, type, complete against tags you have already
  used; a tag chip filters the list (combinable with the kind, both
  remembered per browser), and your tags go into the note's frontmatter
  beside `botference-discuss`, so Obsidian's own search and graph pick them
  up. The phone gets the same filters as plain links (`/pages?kind=&tag=`),
  the same tags on every row, and — for the owner — rename and tag boxes on
  a page's own view. Renaming and tagging are owner-only end to end: a
  guest on a shared companion sees the list and its filters and no editing
  at all.

- **Discuss: run the code in a message.** Any fenced ```` ```python ````
  block — one you pasted, one a bot wrote — now carries a quiet **Run**
  button. Press it and the snippet runs on this Mac, in a fresh
  directory of its own, with what it printed appearing under the block:
  stdout in a mono block, stderr marked as stderr, an exit line only
  when something went wrong, and **matplotlib figures as inline
  thumbnails** — click one and it fills the window so a plot is
  something you can actually read. Results are stored on the message, so
  they survive a refetch, a reload and a second tab, and they go into
  the Obsidian note under the code fence, with the figures copied into
  `<vault>/<folder>/attachments/` as ordinary markdown images. Running
  again replaces the last result; deleting the message (or the thread,
  or the page) deletes everything it left on disk.
  · **No sandbox, and no claim of one.** The button's tooltip says
    "Runs this code on this Mac as you", because that is exactly what it
    does: your user, your files, your network. Treat a bot-written block
    the way you would treat pasting a stranger's script into your
    terminal — a page you are annotating can try to talk the bots into
    writing one. `"run_python": false` in `.botference/plugin/config.json`
    removes the button and refuses the endpoint.
  · **Yours alone.** It is owner-only end to end: a guest on a shared
    companion never sees the button, `/run` refuses them, and the
    figures are served through the same gate. On your phone the results
    are readable (owner only, thumbnails and lightbox included) but
    nothing can be started there — the button lives beside the machine
    it runs on.
  · Runs stop themselves after 30 seconds, output is cut at 64KB per
    stream with an honest marker, and there is a stop button while one
    is going.

## 2026-08-10

- **Discuss: ask about everything you have read.** Until now every
  conversation was about one page. The pages list now opens with a
  library — one conversation about the whole archive. Ask it what you
  have been reading about, what you disagreed with, whether two pieces
  contradict each other; the bots answer by actually reading your saved
  pages, quotes and comments off disk and citing which page and which
  passage each claim came from, rather than reconstructing it from
  memory. They read only: writing files is refused here as everywhere
  else. It behaves like any other conversation — mentions, markdown,
  maths, tool rows, export to Obsidian as a "Library" note, clear it and
  start over — and it is on your phone at `/pages` as well.

## 2026-08-10

- **Discuss: PDFs on the web are pages now.** Half of what anyone reads
  seriously is a PDF, and until today Discuss could not see one: the
  browser hands a PDF to its own viewer, which is another extension's
  document, closed to every extension including this one. So Discuss
  brings its own viewer. Open any address ending in `.pdf` and it opens
  in Discuss instead — real selectable text, highlights, comments,
  `@claude`, Obsidian export, and the same page readable from your phone,
  exactly as on an article. The renderer is Mozilla's PDF.js, vendored
  into the extension: no CDN, no network, nothing fetched at read time.
  · **A quote carries its page.** Highlight something on page 12 and the
    note in your vault says so, under the blockquote where an attribution
    belongs. Older comments have no page and are written exactly as they
    always were.
  · **The record belongs to the PDF, not to the viewer.** The address bar
    shows the extension while you read, but the page is filed under the
    paper's own URL — so the same PDF opened on another machine, or from
    a different link, is the same page with the same comments.
  · **Two honest limits, said out loud.** A PDF whose address does not end
    in `.pdf` (a `/download?id=…` link) is not opened automatically —
    click the toolbar button on it and it opens in Discuss anyway. And a
    scanned PDF is an image of words: one quiet line says so, nothing is
    highlightable, and the bots are told nothing rather than being handed
    the viewer's own furniture. There is no OCR.
  · Local `file://` PDFs are deliberately not supported, and the extension
    asks for no file access: a path on one disk is not an identity a
    shared record can be filed under.
  · The whole thing has an off switch on the extension's options page, and
    a way back to the browser's own viewer on every PDF.

- **Discuss: PDF selections land on the words again.** The first cut of the
  viewer put the invisible text layer three-quarters of the way across the
  page it was covering, so a PDF read fine and selected wrong: highlight
  bars spilled into the margins, doubled over each other, and pooled into
  solid blocks in the white space between paragraphs. The cause was a unit
  mix-up of mine — the page was measured in CSS pixels while the text layer
  was told to lay itself out in PDF points, a difference of exactly one
  third — and it hid behind a page that still looked correct, because the
  drawing was stretched to fit the box it was given. Every part of a page is
  now measured once, from one object, and the test suite measures the result
  against the document's own coordinates at three zoom levels, so this
  particular mistake cannot be made twice.

## 2026-08-09

- **Discuss: one page, one identity — and the right title on it.** Some
  sites rewrite the address bar as you move through a long article, and a
  reading could end up scattered across several Discuss pages. The
  extension now decides which page it is on once, when the document
  loads, and never looks again; a `<link rel="canonical">` naming the
  real article is preferred where believing it can only merge a section
  back into its parent (never where it would merge two different pieces).
  Separately, and this is what you actually saw on
  defensesindepth.bio: a page that uses big headings for its appendices
  was being filed under "Appendix A" instead of its own name, because the
  first `<h1>` on the page was an appendix. Where a page has more than one
  such heading, its own published title wins. Pages already filed under
  the wrong name stay as they are — renaming them is a separate job.

- **Discuss: pick the model before you ask the question.** The model and
  effort pickers used to be dead until the agents were awake, which meant
  the one moment you most want to choose a model — before the first
  message — was the one moment you could not. Both are now preferences
  the companion keeps: choose them whenever you like, and they are
  imposed on the agents at every wake, ahead of the very message that
  woke them. A running bridge is still told immediately; a sleeping one
  is not woken just to be told, and the gear says which happened. The
  option lists the agents advertise are remembered too, so the pickers
  still work when nothing is running.

- **Discuss: billing is a switch now, and it tells the truth.** Each agent's
  gear-menu control is two positions — subscription or API key — showing what
  your saved keys actually resolve to rather than the three-way mode
  underneath. Ask for a key you have not saved and it does not pretend:
  the switch is held mid-flight and the extension's settings open at that
  key's field, which is still the only place a key is ever typed (the drawer
  runs inside the pages you read). Save one and the switch settles itself;
  don't, and it goes back. Settings now lead with the keys, and the companion
  address moved below them as the optional thing it is.

- **Discuss: bring your own API key.** Discuss has always run on whatever
  the `claude` and `codex` CLIs are logged into, and that is still the
  default. If you would rather bill a key, the extension's options page
  now takes one per agent and the drawer's gear menu says when to use
  it: **auto** (a saved key is used, otherwise your subscription — the
  same rule Claude Code applies), **subscription**, or **key**. Keys live
  on the companion's machine in a 0600 file and only ever travel one
  way: the page can save one or remove one, and all it can read back is
  "set" or "unset". They cannot be set through the tunnel at all, not
  even by you — a key has no reason to cross a network to reach the CLIs
  running beside it. Removing one is a real delete, and anything meaning
  "not a key" takes the variable out of the bots' environment rather
  than blanking it, along with the other auth sources that could
  override a subscription just as quietly.
  One honest caveat, because the two CLIs genuinely differ: Claude Code
  prefers a key whenever one is set, while Codex prefers its ChatGPT
  login and only falls back to a key when you are logged out. The
  billing picker says so rather than promising an override that would
  not happen.

- **Discuss: one anonymous ping a day, and a section of the README that
  says exactly what is in it.** I have no idea whether anyone is using
  this, which is the only thing that decides whether it keeps being
  built. So the companion now sends one event a day: a random install id
  and a version number. No URL, no page, no comment text, no name, no
  location, no counts — the README quotes the literal payload and a test
  asserts the payload matches it. `BOTFERENCE_NO_TELEMETRY=1` or
  `"telemetry": false` in the config turns it off before anything
  touches the network, and a clone with no analytics secret compiled in
  never sends anything at all.

- **Discuss: the install instructions stand on their own.** The site's
  Discuss panel and the README now open with the three steps for people
  who only want the annotator — clone, `./botference discuss`, load the
  extension — instead of leaving them to work out which parts of a
  planning-council README apply to them. The council is optional and now
  reads that way.

- **botference.com is art-led now.** The landing page is the braid, drawn as responsive SVG instead of the raster share card, one sentence, the clone line, and one screenshot per surface (Council, Discuss) with a single caption each — the feature grids, transcript, quickstart steps and FAQ prose are gone, the FAQ surviving as a collapsed `<details>` so the FAQPage schema still matches what a reader can see.

- **The web annotator is now Discuss, at discuss.botference.com.** It had
  been "the plugin" — a name describing how it was wired rather than what
  it is for, which is discussing whatever you are reading with Claude and
  Codex. The extension calls itself Botference Discuss, so do the reading
  room and the sign-in page, and `botference discuss` is the command
  (`botference plugin` keeps working, and always will). Nothing under the
  hood was renamed on purpose: your annotations, LaunchAgents, service
  names and workspace memo all stay exactly where they are, so there is
  nothing to migrate and nothing you typed last week to unlearn.
  `plugin.botference.com` is still answered too — the tunnel serves both
  addresses from one companion rather than redirecting, so an old
  bookmark or an extension you configured before the rename lands on the
  same annotations. Bookmark the new one; it is the one the installer
  prints.

- **Web annotator: your phone can annotate, not just read.** Until now a
  phone could see the conversation about a page but never the page, so
  the one thing you actually wanted to do out there — mark a sentence
  and ask about it — was the one thing you could not. Annotating a page
  now sends the companion a clean copy of the article, and
  `plugin.botference.com/a/<page>` serves that copy back with your
  highlights painted where you made them: tap one to open its thread,
  select text to start a new one, ask `@claude`, export to Obsidian.
  It is the review-doc experience, for any article you read. A passage
  you mark on the train is highlighted in the page itself when you next
  open it on the Mac, because the phone runs the extension's own
  anchoring code rather than an imitation of it. The copy is rebuilt
  from an allowlist on arrival — no scripts, no iframes, no event
  handlers, no `javascript:` links — and served under a policy that can
  run nothing the page did not itself nonce. Pages annotated before
  this existed say so and offer their comments; opening one on the Mac
  captures it.

- **Web annotator: one owner identity, the one you already have.** You
  were a guest on your own annotations: the remote password made
  everybody a guest, so from a phone you could not export, delete, or
  summon the bots without a grant. Owner identity is now the *same* one
  the review documents use — a browser already approved as an owner
  device for the review hub is the owner at the annotator too, with
  nothing typed, and the owner password is the single value the hub
  hands to every paper server. Sign in with it from anywhere and you
  have every owner right. Your machine on `127.0.0.1` still needs no
  password at all.

- **Web annotator: a name you cannot take from someone.** A signed-in
  guest's name lived outside the signature on their session cookie, so
  anyone already through the gate could rename themselves to another
  guest and write under that name. The name is now signed with the role;
  moving it invalidates the cookie. Sessions also last 30 days and renew
  themselves as you use them, so a phone should meet the password once
  and then not again — and `/signout` is there when you want it.

- **Web annotator: one address, forever.** `--share` was always a
  conversation — a random `trycloudflare.com` URL that died with the
  terminal, which is no use at all for the thing you actually want,
  which is your annotations on your phone. `botference plugin
  --install-tunnel` gives them a permanent one:
  `https://plugin.botference.com/pages`, backed by a named Cloudflare
  tunnel that dials out from your machine (no ports opened, nothing
  inbound), kept up at every login by its own LaunchAgent, with the
  companion moved to hosted mode so a password gate is what strangers
  meet. The password is generated once — four words and a number, so it
  can be typed from a phone screen — and lives in
  `~/.botference/plugin-password` at mode 0600, never in a plist:
  launchd starts the launcher, and the launcher reads the file. Run it
  twice and it reuses the tunnel, the DNS record and the password;
  `--uninstall-tunnel` takes the address down and puts the companion
  back on localhost, leaving the Cloudflare side intact so bringing it
  back is one command. Set `BOTFERENCE_PLUGIN_HOSTNAME` if the domain
  is not this one.

- **Web annotator: a tunnel is never the owner.** This machine is the
  owner of its own annotations and needs no password for them — but
  cloudflared runs on this machine too, so its hop to the companion
  arrives from 127.0.0.1 exactly like the browser extension's, and the
  distinction is the whole security boundary. It is now three
  independent tests, all of which must pass: a loopback `Host`, a
  loopback socket, and the absence of every header a proxy adds
  (`CF-Connecting-IP`, `CF-Ray`, `CF-Visitor`, `X-Forwarded-*`,
  `X-Real-IP`…). Cloudflare stamps those at its edge and a visitor
  cannot suppress them, so a request that came through the tunnel is a
  guest even if the `Host` line claims otherwise.

- **Web annotator: fold a thread yourself.** Any thread with three or
  more exchanges now carries a quiet control in the same place the
  expander sits — "Hide 13 earlier replies" when it is open, "Show 13
  earlier replies" when it is folded — so a thread you have finished
  with can be put away, and a short one the automatic rule leaves open
  can be folded anyway. A fold you asked for is tighter than one the
  drawer chose (the quote's own message and the newest reply stay), and
  whichever way you set it, it stays that way for the session: a bot
  answering into a folded thread shows up at the bottom without
  springing the middle open, and a thread you opened by hand never
  re-folds behind your back. The page chat behaves the same.

- **Web annotator: export what you actually want.** The Obsidian
  crystal now asks: **Comments only** or **Everything**. "Comments only"
  is the reading without the conversation — no bot replies, and none of
  your own messages that were addressed to a bot, since those are
  questions rather than notes — while every highlight survives,
  including one whose whole thread filtered away, because the passage
  you marked is the annotation. The page chat is left out of that mode
  entirely. "Everything" is the note exactly as it was. Your choice is
  remembered and preselected, the note is still one file per page
  (re-exporting replaces it, so changing your mind costs one click), and
  a row's crystal in the Pages list runs your remembered choice straight
  away rather than asking again.

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
