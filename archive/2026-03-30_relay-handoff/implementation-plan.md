# Implementation Plan — relay-handoff

**Thread:** relay-handoff  
**Created:** 2026-03-29  
**Architecture:** serial  
**Autonomy:** stage-gates

## Goal

Add a `/relay` command to council plan mode that resets one model's session mid-conversation and transfers working state through a structured handoff document.

This is a **context reset**, not compaction:
- the old session/thread is discarded
- a fresh session starts later
- the fresh session receives a handoff artifact plus only the post-relay transcript delta
- pre-relay transcript history is not replayed into the new session

## Locked Decisions

### Command surface
- Canonical command: `/relay @claude` and `/relay @codex`
- Supported aliases:
  - `/relay-claude`
  - `/relay-codex`
  - `/tag @claude`
  - `/tag @codex`
- No `/resume` command in v1
- `/relay` is a single compound operation: create handoff, tear down old session, arm next bootstrap to consume the handoff

### Session semantics
- Relay is **lazy bootstrap**, not immediate bootstrap
- `/relay @model` does **not** trigger a ceremonial "I'm back" response
- The next message routed to that model starts a fresh session and consumes the handoff
- This applies in plan mode only; build mode is out of scope

### Handoff semantics
- Relay uses a structured handoff document inspired by the create/resume handoff pattern discussed during planning
- Format is **YAML frontmatter + Markdown body**
- The handoff prompt and the handoff file schema are separate artifacts
- Controller validates required sections before accepting a generated handoff
- If validation fails, fall through to the next generation tier

### Storage layout
- Live handoff files:
  - `work/handoff-claude.md`
  - `work/handoff-codex.md`
- Timestamped history:
  - `work/handoffs/claude/YYYY-MM-DDTHH-MM-SSZ_handoff.md`
  - `work/handoffs/codex/YYYY-MM-DDTHH-MM-SSZ_handoff.md`
- On archive:
  - move `work/handoffs/` into the thread archive
  - clear live handoff files
- Active live files are runtime pointers, not the archival record

### Fallback tiers
- Tier 1: self-authored handoff when yield pressure is low
- Tier 2: cross-authored handoff when yield pressure is moderate
- Tier 3: mechanical handoff when yield pressure is high or LLM generation is unavailable
- Cross-authored relay only uses the peer model if that peer already has a live session; otherwise fall back to mechanical

### Pressure thresholds
- Default thresholds:
  - `< 70` yield-pressure percent: self-authored
  - `70 <= pct < 90`: cross-authored
  - `>= 90`: mechanical
- These thresholds must be implemented as named constants, not scattered literals

### UI scope
- `/help` must document `/relay`
- Room/system messages must confirm relay actions and failures
- No new dedicated Ink "relay event" in v1
- No relay counter or extra relay badge in `/status` in v1 unless needed by tests or UX gaps discovered during implementation

## Non-Goals

- Auto-relay based on threshold crossing
- Explicit `/resume-handoff <file>` recovery flow
- Renaming council to Botalks or changing product branding
- Adding plan-mode web browsing/tools
- Relay support for build-mode agents

## Required Code Changes

## Task 1. Add Python-side path resolution for relay files and templates — **coder**

Problem:
- The shell already resolves `work/` vs legacy root paths in `lib/config.sh`
- `Council` and the Ink bridge do not currently receive resolved work/prompt/template paths
- Hardcoding `work/...` in Python would diverge from the existing path model

Deliverables:
- Add a small Python path helper consistent with the shell path model
- Resolve:
  - work dir
  - build dir
  - handoff live file paths (`work/handoff-claude.md`, `work/handoff-codex.md`)
  - handoff history dir (`work/handoffs/`)
  - template path (`templates/handoff.md`)
  - prompt path (`prompts/relay.md`)
- Inject resolved paths into `Council`

Acceptance:
- Relay works whether the project uses `work/` or legacy root-layout files
- No direct `Path("work/...")` assumptions remain in controller logic

## Task 2. Extend command parsing for relay — **coder**

Add to `core/council.py`:
- `InputKind.RELAY`
- parsing for:
  - `/relay @claude`
  - `/relay @codex`
  - `/relay-claude`
  - `/relay-codex`
  - `/tag @claude`
  - `/tag @codex`

Rules:
- `/relay` and `/tag` require exactly one target model
- only `claude` and `codex` are valid relay targets
- invalid relay commands return a clear usage message in the room

Acceptance:
- parsing is covered by unit tests
- aliases map to the same controller path

## Task 3. Persist relay-relevant controller state — **coder**

Add relay state to `Council`:
- last normalized yield pressure per model
- relay boundary turn index per model
- optional relay metadata if needed for logging/debugging

Why:
- current controller stores raw occupancy/token display state, not the normalized yield-pressure value needed for tier selection
- relay bootstrap needs a boundary marker that excludes pre-relay history

Implementation:
- update `_update_pct()` to persist both:
  - raw occupancy display state
  - normalized yield-pressure state

Acceptance:
- relay tier selection uses stored normalized pressure, not raw occupancy
- controller has enough state to bootstrap from a relay without recomputing from missing response objects

## Task 4. Define handoff schema, template, and validation — **coder**

Add a handoff template artifact at `templates/handoff.md` with:
- YAML frontmatter placeholders
- exact Markdown section headers

Add a relay generation prompt artifact at `prompts/relay.md` with:
- exact required section names
- instructions to fill every section
- permission to write `None` where a section is empty
- instructions to attribute positions to speakers
- instruction not to invent agreement

Required frontmatter fields:
```yaml
---
model: claude|codex
session_id: <old session or thread id>
created: <ISO 8601 UTC timestamp>
room_mode: public|caucus|draft|review
lead: auto|@claude|@codex
yield_pct: <number>
context_tokens: <number>
context_window: <number>
generation_tier: self|cross|mechanical
---
```

Required body sections:
```markdown
## Objective

## Resolved Decisions

## Open Questions

## Positions In Play

### Converging

### Contested

## Constraints

## Current Thread

## Response Obligation

## Decision Criteria

## Next Action
```

Validation rules:
- required frontmatter keys must exist
- required headings must exist exactly once
- invalid or partial output is rejected
- rejected output falls through to the next generation tier

Acceptance:
- validation is covered by tests
- controller never stores malformed handoff content as the live handoff

## Task 5. Implement relay generation on `Council` — **coder**

Add `async def _relay_model(self, model: str, ui: UIPort)`.

Flow:
1. Validate target model
2. Validate that the target currently has a live session; otherwise return a helpful room message
3. Read stored normalized yield pressure for the target
4. Choose generation tier
5. Generate handoff
6. Validate handoff
7. Write live handoff file
8. Write timestamped history copy
9. Record relay boundary
10. Tear down session state
11. Reset relay-related UI/controller fields for that model
12. Post room/system confirmation
13. Update status snapshot

Tier behavior:
- Self-authored:
  - use target model's existing live session via `resume()`
- Cross-authored:
  - only if the peer model has a live session
  - otherwise skip directly to mechanical
- Mechanical:
  - no LLM call

Session teardown behavior:
- Claude:
  - clear `session_id`
- Codex:
  - clear `thread_id`
  - clear cumulative token counters
- Both:
  - remove model from `_models_initialized`
  - clear one-time over-limit warning state for that model
  - clear current raw occupancy/status fields for that model
  - if the relayed model was the current lead: clear `_pending_draft` and `_pending_lead` and warn the user that any in-progress draft is lost

Acceptance:
- relay works for both models
- relay can fail cleanly without corrupting existing session state
- room message confirms success or explains failure

## Task 6. Implement mechanical handoff generation — **coder**

Mechanical handoff must be conservative but not empty.

Inputs:
- transcript entries
- task/system prompt
- current mode/lead
- current status/pressure state

Mechanical extraction rules:
- `Objective`:
  - derive from current task if present
  - otherwise derive from the latest user-directed thread in the transcript
- `Resolved Decisions`:
  - preserve only explicit agreements clearly stated by user or system, or unambiguous model consensus in the room
- `Open Questions`:
  - extract unresolved asks from recent user/model turns
- `Positions In Play`:
  - summarize recent attributed positions from the tail of the transcript
- `Constraints`:
  - preserve explicit user constraints and "must/don't/should/not" requirements conservatively
- `Current Thread`:
  - use the active topic from the most recent turns
- `Response Obligation`:
  - state what the fresh model should answer or do first
- `Decision Criteria`:
  - include only explicit criteria already stated; otherwise `None`
- `Next Action`:
  - one concrete first step

Acceptance:
- mechanical relay preserves enough state to continue the thread
- it does not blank out obvious user constraints or settled decisions

## Task 7. Bootstrap from handoff safely — **coder**

Modify the first-turn bootstrap path so that relay consumption is atomic.

Required behavior:
- when a model with no live session receives its next routed turn:
  - detect live handoff file for that model
  - build initial prompt using:
    - normal room preamble
    - system prompt
    - task
    - handoff document
    - only transcript entries after the relay boundary
- call `adapter.send(...)`
- only after a successful send:
  - delete the live handoff file
  - keep history copy intact

Important:
- do **not** delete the live handoff during prompt construction
- if fresh bootstrap fails, the live handoff must remain available for retry

Acceptance:
- a failed fresh bootstrap does not lose relay state
- successful fresh bootstrap consumes the live handoff exactly once

## Task 8. Integrate relay history with archive/reset flow — **coder**

Update shell path config and archive behavior.

Changes:
- add a canonical handoff history path variable in `lib/config.sh`
- update `scripts/archive.sh` to:
  - move `work/handoffs/` into the archive if present
  - clear `work/handoff-claude.md`
  - clear `work/handoff-codex.md`
- do not rely on live handoff files as the archival record

Acceptance:
- archive captures historical relay artifacts
- a new thread starts with no stale live handoff files
- archive behavior remains compatible with current work/build path model

## Task 9. Update help text and tests — **coder**

Help text:
- add `/relay @claude|@codex`
- mention ` /tag ` as alias if kept in help

Tests:
- parsing tests for all relay command forms
- controller tests for:
  - tier selection
  - self relay
  - cross relay
  - cross relay fallback to mechanical when peer is not initialized
  - relay state reset
  - safe live-handoff retention on bootstrap failure
  - live-handoff deletion after successful bootstrap
  - post-relay bootstrap excludes pre-relay history
  - post-relay bootstrap includes post-relay history
  - sequential relay of both models: `/relay @claude` then immediately `/relay @codex` — second relay cannot use cross-authored tier since Claude was just torn down
- archive tests for handoff history sweep and live-file clearing

Acceptance:
- relay lifecycle is covered by unit tests
- archive path changes are covered by shell or integration tests

## Task 10. Manual verification — **coder**

Run manual checks in a real plan session:

1. Start a room with both models active
2. Relay Claude
3. Send next message to Claude
4. Confirm:
   - new Claude session starts
   - handoff file is consumed
   - timestamped history exists
   - pre-relay history is not replayed
5. Relay Codex
6. Repeat the same checks
7. Archive the thread
8. Confirm:
   - `work/handoffs/` moved into archive
   - live handoff files cleared
   - next fresh thread has no stale relay state

## Dependency-Ordered Task List

- [x] 1. Add Python-side path resolution for relay files and templates — **coder**
- [x] 2. Extend command parsing for relay — **coder**
- [x] 3. Persist relay-relevant controller state (depends: 2) — **coder**
- [x] 4. Define handoff schema, template, and validation (depends: 1,3) — **coder**
- [x] 5. Implement relay generation on `Council` (depends: 3,4) — **coder**
- [x] 6. Implement mechanical handoff generation (depends: 4,5) — **coder**
- [x] 7. Bootstrap from handoff safely (depends: 3,4,5) — **coder**
- [x] 8. Integrate relay history with archive/reset flow (depends: 1,5) — **coder**
- [x] 9. Update help text and tests (depends: 2,5,7,8) — **coder**
- [x] 10. Manual verification (depends: 9) — **coder** (needs human)

## Risks and Mitigations

### Risk: relay deletes the only usable handoff before the new session actually starts
Mitigation:
- keep the live handoff file until `adapter.send(...)` succeeds
- only then consume/delete it

### Risk: relay tier selection uses the wrong metric
Mitigation:
- persist normalized yield-pressure percent explicitly
- do not use raw occupancy percent for tier selection

### Risk: cross-authored relay crashes when the peer session is not live
Mitigation:
- require live peer session for cross-authored tier
- otherwise fall through to mechanical

### Risk: path handling breaks in legacy-root layouts or split `work/` layouts
Mitigation:
- use one Python path helper aligned with the existing shell path model
- do not hardcode `work/` in controller logic

### Risk: mechanical relay loses important state
Mitigation:
- preserve explicit user constraints and clearly agreed decisions conservatively
- do not emit empty shells for core sections when transcript evidence exists

### Risk: relay during caucus or review creates confusion
Mitigation:
- allow relay in all plan-room modes
- post an explicit room/system notice naming the relayed model and stating that the next routed turn will start a fresh session

## Completion Criteria

This thread is complete when all of the following are true:

- `/relay @claude` and `/relay @codex` work in plan mode
- `/tag` works as an alias if retained
- relay writes valid handoff documents in YAML+Markdown format
- relay stores timestamped handoff history
- relay tears down the target session cleanly
- the next routed turn to that model starts a fresh session
- fresh bootstrap consumes the handoff safely
- fresh bootstrap excludes pre-relay history
- fresh bootstrap includes post-relay transcript delta
- failed fresh bootstrap does not lose the live handoff
- archive sweeps handoff history and clears live handoff files
- automated tests cover parsing, relay tiers, safe consumption, and archive integration
