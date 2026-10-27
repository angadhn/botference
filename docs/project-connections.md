# Project connections

Project connections is shared by Discuss and Council. A project can collect
reading conversations, source PDFs, and several outputs. The canonical blog
post, paper or other file stays in its existing directory.

## Use it from Discuss

Open the project-folder button in the drawer. The picker now includes:

- **Work this reading can feed:** find a registered blog post or paper by title
  and link the current reading to it.
- **Possibly related projects:** suggestions based on shared wording. Selecting
  one files the reading in that project; it does not move or edit documents.
- **Project connections:** open the full map and evidence inspector.
- The existing project list and **new project** action.

Ordinary chat does not create a project. When a new blog output emerges from
`/draft-blog` or direct site authoring, the companion links its canonical file
and source conversation to the existing project. If that source is unfiled, it
creates a project in the confirmed council. A second output from the same
conversation joins that project. If several projects are attached and no output
already identifies the project, the file stays unassigned until the owner links
it; the system does not guess.

You can also write an explicit organising request in page chat or a thread:

```text
Link this reading to What does it cost to run a university?
Use this article in Learning interfaces
Please add this PDF to Space engineering
```

An exact, unambiguous project/output title is resolved without an agent turn.
Ambiguous or missing matches produce an explanation and leave the association
unchanged. You can use the picker to choose. These requests and the network API
are owner-only. Local PDFs with `bfp-pdf://` identities can use the same direct
site-authoring scope as ordinary URLs when that mode is enabled.

## Use it from Council

**Project connections** is in the sidebar and opens `/project-network/view`.
Search projects or output titles, select a node, and inspect its outputs and
reading conversations. Select a connection to see its relationship, reason and
evidence. A project can have no outputs, one output, or many.

The inspector can register an existing project file as an output. It records a
reference; it does not move the file. Council accepts files within its projects
directory or roots already established by a registered output. Discuss also
accepts content files within confirmed sites. No association grants an agent
additional filesystem or network permissions.

Use **Refresh evidence** after editing an output outside Botference. The index
checks its current version and citations. Missing files keep a visible record
rather than silently disappearing. External file renames currently require
registering the new path; automatic rename reconciliation is not implemented.

## What the lines mean

- **Red, dashed:** a suggestion. Its reason identifies whether it came from
  text overlap or from an agent's interpretation.
- **Green, solid:** an explicit user link, or observed use that the user asked
  for. It means a useful relationship was recorded, not that claims are true
  or that two projects agree.
- **Muted, dashed:** the underlying evidence has changed. Inspect the current
  files before relying on the older interpretation.

An edge can be dismissed and restored. Refreshing suggestions or citations
does not silently undo a dismissal. “Link these projects” is available as an
explicit action, but approval clicks are not required for ordinary use.

For use-based evidence, the owner links a reading to a particular output. When
that output's body actually contains the source URL, the system records the
file revision, line and excerpt. If the source belongs to another project,
that can establish a green **shared source** connection. Generated citations
without that user-directed intent remain observations; they do not validate an
agent's guess. A **supports** suggestion does not become approved merely
because the same sources were used together.

Front-matter `source_url` fields and HTML comments do not count as citations.
The current implementation checks exact source URLs in the body; it does not
resolve every BibTeX key, DOI, paraphrase or local-PDF citation. Historical use
evidence retains up to 20 earlier revisions. Removing a citation marks the old
use inactive. Deleting a Discuss reading removes its cached source notes and
dependent evidence, without deleting output files.

## Suggestions and context

The first version retrieves candidates using weighted word overlap and shared
sources. It does **not** claim to run an embedding model. Common project-template
words are excluded and common vocabulary is downweighted. Agents receive a
bounded set of candidates and can propose a typed connection with a specific
reason during normal conversation. These remain red suggestions.

Agents in both interfaces receive bounded network context: canonical output
paths and references to related reading/discussion records, rather than the
entire project graph or every transcript. The network block is capped at 6,000
characters in Discuss and 4,000 in Council. Index failure does not prevent a
normal conversation or a source edit.

The map shows at most 60 projects at once; filtering narrows the view. Candidate
generation currently examines up to 300 active projects. These are first-version
limits, not claims that a larger research collection has been fully searched.
The layout is deterministic and force-directed. Its distances are a visual aid,
not calibrated semantic similarity or confidence.

## Storage and integration

Each confirmed council keeps `.botference/project-network.sqlite`. Both
frontends use `frontends/shared/project-network.mjs`; a small Python standard-
library SQLite helper provides transactions and WAL-backed concurrent writes.
There is no new hosted service or model API dependency.

Existing `projects/<id>/PROJECT.md` and `projects/portfolio.json` remain the
project catalogue. Existing Discuss page records retain their project filing.
The network adds output references, source membership, suggestions and evidence.
It does not replace the conversation stores or copy a blog into each project.

The full map is password-gated in hosted Council and owner-only in Discuss.
If multiple councils are confirmed, use the council selector. A configured
`discuss_web` URL in the companion config lets Council link local-PDF discussions
through the public reading room; otherwise it uses `http://127.0.0.1:4189`.

The implementation does not automatically merge projects, force a cluster into
a project, rewrite conflicting claims, or treat an AI detector as a quality
measure. Those are editorial decisions. A later embedding retriever can use the
same records and interface without changing the meaning of confirmed links.

## Verification

- `node --test tests/project-network.test.mjs tests/project-network-ui.test.mjs`
- `node frontends/plugin/test/project-network.test.mjs`
- `node --test tests/council-web.test.mjs`
- Existing Discuss authoring, drafting, filing, companion and menu suites.

The integration tests cover PDF-to-draft project emergence, multiple outputs,
natural-language linking, cross-interface visibility, guest refusal, persistence
of dismissals, versioned use evidence and concurrent database writers.
