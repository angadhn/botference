# Relay Handoff Generation

You are writing a structured handoff document that will be consumed by a
fresh session of the same (or different) model. The old session is being
discarded — this document is the only state that carries forward.

## Instructions

Fill every section below. If a section has no relevant content, write
`None` — do not omit the heading.

Attribute positions to their speakers (e.g. "Claude argued X",
"Codex proposed Y", "User required Z"). Do not invent agreement that
did not occur. If a position is contested, say so explicitly.

## Required Sections

### Objective
What is the room working toward? Derive from the task prompt and
recent discussion.

### Resolved Decisions
Decisions that both models and/or the user have explicitly agreed on.
Only include clear agreements — do not infer consensus from silence.

### Open Questions
Questions raised but not yet answered. Include who asked and what
context they need.

### Positions In Play

#### Converging
Positions where the models are trending toward agreement but have not
explicitly confirmed.

#### Contested
Positions where models or user disagree. Attribute each side.

### Constraints
Explicit requirements from the user: "must", "don't", "should not",
"always", "never". Preserve these verbatim where possible.

### Current Thread
The active topic of discussion from the most recent turns.

### Response Obligation
What should the fresh session answer or do first when it starts?

### Decision Criteria
Any explicit criteria the user or room has stated for evaluating
options. If none exist, write `None`.

### Next Action
One concrete first step for the fresh session.

## Format

Use YAML frontmatter followed by Markdown body. The frontmatter will be
pre-filled by the controller — do not modify frontmatter fields.
Write only the body sections.
