Implementation Plan - Fix Codex CLI Timeout in Ink Interface

**Thread:** codex-ink-stdin-fix
**Created:** 2026-04-01
**Architecture:** serial
**Autonomy:** stage-gates

## Context

CodexAdapter._run_once() in core/cli_adapters.py spawns codex exec
without redirecting stdin. In the Ink bridge, the parent stdin is a
pipe from Node.js that never closes, so codex blocks waiting for EOF.
This causes a 300s timeout. Claude is unaffected (uses its own stdin
pipe). Textual is unaffected (parent stdin is a real TTY, not a pipe).

## Tasks

- [x] 1. Add stdin=DEVNULL to CodexAdapter._run_once() in core/cli_adapters.py -- **coder**
- [x] 2. Add regression test asserting stdin=DEVNULL via CodexAdapter.send() -- **coder**
- [ ] 3. Manual validation: Ink and Textual smoke tests -- **coder**

## Out of Scope

- cwd divergence between Ink and Textual (separate follow-up)
