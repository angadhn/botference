Checkpoint - Fix Codex CLI Timeout in Ink Interface

**Thread:** codex-ink-stdin-fix
**Last updated:** 2026-04-01
**Last agent:** coder
**Status:** validating

## Knowledge State

| Task | Status | Notes |
|------|--------|-------|
| Root cause analysis | done | Codex adapter inherits parent stdin; deadlocks in Ink bridge pipe |
| Code fix (cli_adapters.py) | done | stdin=DEVNULL added to CodexAdapter._run_once() |
| Regression test | done | TestCodexStdinDevnull in test_cli_adapters.py, 56 tests pass |
| Manual validation | pending | Ink and Textual smoke tests |

## Last Reflection

none yet

## Next Task

3. Manual validation: Ink and Textual smoke tests -- **coder**
