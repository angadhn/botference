# Implementation Plan — Fix Context Occupancy Reporting From Per-Turn Snapshots

**Thread:** fix-context-occupancy  
**Created:** 2026-03-29  
**Architecture:** serial  
**Autonomy:** stage-gates

## Problem

After a single council exchange, the status line can show values like:

- `Claude: ~715%`
- `Codex: ~153%`

These two numbers have different causes.

### Claude root cause

Claude context % is currently derived from the CLI `result` event. That event reports **cumulative billing totals across the entire internal tool loop**, not point-in-time prompt occupancy.

Observed evidence from `run/debug-claude.log`:

| Source | input_tokens | cache_creation | cache_read | footprint |
|---|---:|---:|---:|---:|
| Last assistant event | 1 | 114 | 104,850 | ~104,965 |
| Final result event | 7,939 | 91,065 | 1,281,129 | ~1,380,133 |

The last assistant event is the right occupancy signal. The final result event is a cumulative accounting signal. Using the cumulative result event for the status line inflates Claude to nonsensical percentages.

### Codex root cause

Codex does **not** show the same telemetry bug. `turn.completed.input_tokens=184,437` appears to be genuine first-turn prompt occupancy against a yield limit of `272,000 * 0.45 = 122,400`. The Codex overage is a **prompt-budget issue**, not an adapter parsing issue.

## Agent Inventory

No new agent is needed. The built-in `coder` agent covers the parser, controller, test, and help-text changes in this thread.

## Design Decisions

1. The status line reports **occupancy**, not cumulative billing.
2. Claude occupancy is derived from the **last assistant-event usage snapshot** seen during a single `send()` or `resume()` call.
3. Add a dedicated `occupancy_tokens` field to `AdapterResponse`.
4. Separate **parsing** from **policy**:
   - parsing task captures `occupancy_tokens` from the Claude stream
   - policy task computes Claude context % from `occupancy_tokens`
5. Claude next-turn projection uses:
   - `occupancy_tokens + len(resp.text) // 4`
6. Claude context % must **not** add:
   - cumulative `result.cache_read_input_tokens`
   - cumulative `result.output_tokens`
   - `tool_result_tokens_estimate`
7. If no Claude assistant snapshot is available, use a conservative fallback:
   - `input_tokens + cache_creation_tokens`
   - do **not** fall back to cumulative `cache_read_tokens`
8. Codex context math remains unchanged.
9. Codex first-turn over-limit messaging is a separate UX task after the core telemetry fix.
10. Remove `_baseline_tokens` dead code from `ClaudeAdapter`.
11. `/help` must describe occupancy semantics accurately.

## Tasks

- [x] 1. Capture Claude occupancy from the last assistant event (red/green TDD) — **coder**
  RED: `tests/test_cli_adapters.py::TestContextPercent::test_claude_send_captures_occupancy_from_last_assistant_event`: construct a synthetic Claude JSONL stream with multiple assistant events carrying usage snapshots and a final cumulative `result` event; assert `resp.occupancy_tokens == 104965`; fails because `AdapterResponse` does not track occupancy from assistant events.
  GREEN: `core/cli_adapters.py:AdapterResponse` — add `occupancy_tokens: int = 0`; `core/cli_adapters.py:ClaudeAdapter._drain()` — in the `etype == "assistant"` branch, read `event["message"]["usage"]` and overwrite `response.occupancy_tokens` with `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` whenever usage is present.
  VERIFY: `python -m pytest tests/test_cli_adapters.py::TestContextPercent::test_claude_send_captures_occupancy_from_last_assistant_event -xvs`
  Commits: `test(red): assert Claude adapter captures occupancy from last assistant event` and `fix(green): track Claude occupancy_tokens from assistant event usage`

- [x] 2. Rewrite Claude context % to use occupancy snapshot semantics (red/green TDD) (depends: 1) — **coder**
  RED: `tests/test_cli_adapters.py::TestContextPercent::test_claude_context_percent_uses_occupancy_snapshot_and_visible_text`: assert that `AdapterResponse(text="x"*2000, occupancy_tokens=105000, input_tokens=7939, cache_creation_tokens=91065, cache_read_tokens=1281129, tool_result_tokens_estimate=50000, context_window=1000000)` yields `52.75%`; fails because `ClaudeAdapter.context_percent()` currently uses cumulative result fields and tool-result inflation.
  GREEN: `core/cli_adapters.py:ClaudeAdapter.context_percent()` — compute `base = resp.occupancy_tokens if resp.occupancy_tokens else (resp.input_tokens + resp.cache_creation_tokens)`; compute `projected = base + len(resp.text) // 4`; return `percent_of_limit(projected, 0, 0, window)`.
  VERIFY: `python -m pytest tests/test_cli_adapters.py::TestContextPercent::test_claude_context_percent_uses_occupancy_snapshot_and_visible_text -xvs`
  Commits: `test(red): assert Claude context percent uses occupancy snapshot semantics` and `fix(green): compute Claude context percent from occupancy_tokens and visible text`

- [x] 3. Update Claude regression expectations to occupancy semantics (depends: 2) — **coder**
  Scope: `tests/test_cli_adapters.py` — update the existing Claude context-percent regressions to build responses with `occupancy_tokens`, remove expectations that `tool_result_tokens_estimate` inflates Claude %, preserve Codex expectations unchanged, and keep the fixture-driven parsing coverage aligned with the new semantics.
  VERIFY: `python -m pytest tests/test_cli_adapters.py -xvs`
  Commits: `test: update Claude context percent regressions for occupancy snapshot semantics`

- [x] 4. Add a first-turn over-limit warning for Codex prompt budget (red/green TDD) (depends: 2) — **coder**
  RED: `tests/test_council.py::TestContextWarnings::test_first_turn_over_limit_emits_warning_for_codex`: assert that the first `@codex` turn with `codex.context_percent(resp) == 153.0` adds one system room entry containing `initial prompt exceeds yield limit`; fails because council records the percent but emits no warning.
  GREEN: `core/council.py:Council` — add `_warned_overlimit_models: set[str]`; emit a one-time system warning after first-turn percent calculation when a model exceeds `100%`; keep the warning path outside the core adapter math.
  VERIFY: `python -m pytest tests/test_council.py::TestContextWarnings::test_first_turn_over_limit_emits_warning_for_codex -xvs`
  Commits: `test(red): assert first-turn over-limit warning for codex` and `feat(green): warn once when initial prompt exceeds yield limit`

- [x] 5. Remove `_baseline_tokens` dead code (depends: 2) — **coder**
  Scope: `core/cli_adapters.py:ClaudeAdapter` — remove `_baseline_tokens` from `__init__` and remove the unused assignment block in `_drain()`.
  VERIFY: `python -m pytest tests/test_cli_adapters.py -xvs`
  Commits: `refactor: remove unused Claude baseline token state`

- [x] 6. Update `/help` text to describe occupancy rather than cumulative billing (red/green TDD) (depends: 2) — **coder**
  RED: `tests/test_council.py::TestHelpText::test_help_explains_occupancy_not_cumulative_billing`: assert `/help` includes `last internal turn` and `not cumulative billing`; fails because help still describes the metric as projected usage.
  GREEN: `core/council.py:Council._show_help()` — replace the context explanation with `Context % = estimated next-turn occupancy as % of yield limit (100% = yield). Based on the model's last internal turn, not cumulative billing totals.`
  VERIFY: `python -m pytest tests/test_council.py::TestHelpText::test_help_explains_occupancy_not_cumulative_billing -xvs`
  Commits: `test(red): assert help explains occupancy not cumulative billing` and `docs(green): update help text for occupancy semantics`

- [x] 7. Run full regression suite and Ink verification pass (depends: 3,4,5,6) — **coder**
  Scope: run the full Python suite, run the Ink TypeScript check, then confirm manually in the Ink TUI that Claude no longer jumps to ~715% after one exchange.
  VERIFY: `python -m pytest tests/ -xvs` and `npx tsc -p ink-ui/tsconfig.json --noEmit`
  Results: 209/209 Python tests pass, Ink tsc clean. No source changes needed.

## Execution

After `implementation-plan.md` and `checkpoint.md` are written and approved:

1. Run build mode:
   `./council -p build`

2. After build completes, run the interactive Ink verification:
   `./council plan`

## Expected Outcome

After this thread:

- Claude context % is derived from per-turn occupancy, not cumulative billing totals.
- Claude no longer inflates occupancy with cumulative `cache_read_input_tokens`, cumulative `output_tokens`, or `tool_result_tokens_estimate`.
- Codex keeps its current occupancy math, but the user gets a clear first-turn warning when the bootstrap prompt already exceeds the yield limit.
- `_baseline_tokens` is removed.
- `/help` explains the metric accurately.
- The regression suite protects the new semantics.
