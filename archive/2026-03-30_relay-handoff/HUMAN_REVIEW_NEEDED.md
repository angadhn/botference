# Human Review Needed — Manual Relay Verification

**Task:** 10. Manual verification — end-to-end plan session checks  
**Thread:** relay-handoff  
**Status:** Requires interactive plan session with live LLM APIs

## Pre-check results

- All 372 automated tests pass
- Code paths audited and correctly wired

## Manual verification checklist

Run these steps in an actual plan session:

### 1. Start a room with both models active

```
# Start a plan session, ensure both claude and codex respond
```

- [ ] Both models initialize and respond

### 2. Relay Claude

```
/relay @claude
```

- [ ] Room message confirms relay: "Relayed claude (tier: ...)"
- [ ] `work/handoff-claude.md` exists with YAML frontmatter + Markdown body
- [ ] `work/handoffs/claude/` has a timestamped history file

### 3. Send next message to Claude

Route a message to Claude (e.g., `@claude summarize where we are`).

- [ ] New Claude session starts (room says "Resuming claude session…")
- [ ] Response is coherent — handoff content was consumed
- [ ] `work/handoff-claude.md` is deleted after successful response
- [ ] History file in `work/handoffs/claude/` remains
- [ ] Pre-relay history is NOT in the new session's context

### 4. Relay Codex

```
/relay @codex
```

- [ ] Room message confirms relay
- [ ] `work/handoff-codex.md` exists
- [ ] `work/handoffs/codex/` has a timestamped history file

### 5. Send next message to Codex

Route a message to Codex.

- [ ] New Codex session starts
- [ ] Handoff consumed, live file deleted
- [ ] History file remains

### 6. Alias check

```
/tag @claude
```

- [ ] Works identically to `/relay @claude`

### 7. Archive the thread

```
./scripts/archive.sh
```

- [ ] `work/handoffs/` moved into the archive directory
- [ ] `work/handoff-claude.md` cleared
- [ ] `work/handoff-codex.md` cleared
- [ ] Next fresh thread has no stale relay state

## What was completed in this thread

All 10 implementation tasks for relay-handoff are code-complete. Tasks 1–9 are verified by 372 automated tests. Task 10 (this checklist) requires a human operator with live API access.
