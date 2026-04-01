> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

# core/

Python modules that power the botference framework. These are the runtime components — not standalone scripts.

## Modules

| Module | Purpose |
|--------|---------|
| `botference.py` | Botference mode controller — input parsing, routing, caucus orchestration, draft/review/write pipeline |
| `botference_ui.py` | Python/Textual backend for the status bar. The primary terminal frontend is now the Ink TUI (`ink-ui/`) |
| `cli_adapters.py` | Subprocess wrappers for Claude CLI and Codex CLI — session management, output parsing |
| `botference_agent.py` | Agent runner for build mode — loads agent prompts, registers tools, runs the tool-calling loop |
| `fallback_agent_mcp.py` | MCP fallback agent runner — exposes per-agent tools to `claude -p` when no API key is available (Python ≥ 3.10) |
| `providers.py` | LLM provider abstraction — Anthropic and OpenAI API clients, model detection, context windows |
| `room_prompts.py` | Prompt templates for botference mode — room preamble, caucus turns, writer/reviewer/write phases |
| `handoff.py` | Handoff schema, validation, serialization, and relay generation. Manages tier selection (self-authored, cross-authored, mechanical) and session teardown |
| `paths.py` | Centralized path resolution for all botference file locations (work dir, build dir, handoff paths, templates) |

## How They Connect

```
botference (shell)
  ├─ plan mode ──→ botference.py ──→ cli_adapters.py (Claude + Codex)
  │                    │              └─ room_prompts.py (prompt templates)
  │                    └─ botference_ui.py (TUI)
  │
  ├─ build mode ──→ botference_agent.py ──→ providers.py (API calls)
  │                      └─ tools/ (tool execution)
  │
  └─ build mode (no API key) ──→ fallback_agent_mcp.py ──→ claude -p (MCP)
                                      └─ tools/ (tool execution)
```

The `/relay` command tears down one model's session, generates a handoff
document, and restarts that model immediately in the same running controller.
Successful relays keep only a timestamped history copy in
`work/handoffs/<model>/`. Persisted live handoff files
(`work/handoff-claude.md`, `work/handoff-codex.md`) are now failure-only
artifacts and are not auto-loaded on a fresh CLI startup.

## Context Display

The botference status line shows **raw token counts** for Claude and Codex in the
format `tokens / window` (e.g. `12.7K / 1.0M`). This is the actual prompt
occupancy and context window size — not a derived percentage or yield metric.

Internally, `context_percent()` still computes a yield-threshold percentage
(via `providers.percent_of_limit()`) for internal botference decisions (e.g.
warning when context is high). But the **displayed number** comes from
`context_tokens()`, which returns the raw token count.

The percentage shown in color thresholds (yellow at 75%, red at 90%) is a
simple `tokens / window * 100` — percentage of the actual context window.

### Claude

Claude's API is stateless per-call: each `--resume` sends the full
conversation, and the response reports usage for that single API call. There
is no cumulative inflation across turns (unlike Codex).

`context_tokens()` uses a point-in-time occupancy snapshot from the last
`assistant` event in the Claude CLI stream:

- `occupancy_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

This is intentionally based on the last assistant-event usage snapshot rather
than the final `result` event, because the result usage can reflect cumulative
billing totals across an internal tool loop.

When `occupancy_tokens` is unavailable (zero), the fallback sums all input
components from the `result` event:

- `fallback = input_tokens + cache_creation_tokens + cache_read_tokens`

The `context_window` is read from `modelUsage.contextWindow` in the `result`
event when available, with a fallback to the `_CONTEXT_WINDOWS` table.

### Codex

Codex CLI `turn.completed.usage` is treated as cumulative session usage in
`codex exec --json`, not current-turn context occupancy. The adapter therefore
derives explicit last-turn deltas once it has a prior cumulative sample:

- `turn_input_tokens = cumulative_input_tokens - previous_cumulative_input_tokens`
- `turn_cached_input_tokens = cumulative_cached_input_tokens - previous_cumulative_cached_input_tokens`
- `turn_output_tokens = cumulative_output_tokens - previous_cumulative_output_tokens`

On the first Codex turn there is no previous cumulative baseline, so botference
now treats the context display as unavailable instead of showing the raw
cumulative total as if it were comparable to later deltas.

When a baseline exists, the Codex context percentage uses **last-turn input
only**:

- `projected_tokens = turn_input_tokens`

`output_tokens` and tool-result estimates are intentionally excluded from the
Codex context metric, because they inflated the status line and did not match
the intended notion of current-turn prompt footprint.
