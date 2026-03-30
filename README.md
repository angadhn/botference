# Botference

> [!NOTE]
> This README was AI-generated. I (Angadh) have skimmed and supervised its creation.

Multi-LLM planning where you and the AIs collaborate in a **council** (open
room, you steer) or the AIs hash things out in a **caucus** (private sidebar,
they converge). The result is an `implementation-plan.md` and `checkpoint.md`
you can take into any workflow.

**The primary contribution of this repository is plan mode** — a multi-LLM
planning session where Claude and Codex collaborate in real time. This is the
part that works well and is ready for use.

> [!WARNING]
> This is vibe-coded. Use at your own risk. Research-plan mode and build mode
> are deeply experimental — under active development, will change without
> notice, and not recommended for general use. If you are here to get things
> done, use `./botference plan` and take the resulting plan into your own
> workflow.

## Approach

Botference uses two metaphors for multi-LLM collaboration, shown as two panels
in the TUI:

- **Council** — an open room where you and the AIs all talk. You steer the
  conversation, ask questions, push back, and direct who speaks. This is plan
  mode: you're in the room with Claude and Codex, hashing out what to build.

- **Caucus** — a private sidebar where the AIs talk to each other without you.
  You kick it off with `/caucus <topic>` and the models debate, negotiate, and
  converge on a recommendation. You get the summary and decide what to do with
  it.

The council is where decisions get made. The caucus is where the AIs work out
their disagreements so they can bring you a coherent proposal instead of
conflicting opinions.

## Quick Start

```bash
# Planning (the main event)
./botference plan                          # Council: you + Claude + Codex
./botference plan --claude                 # Solo Claude (no Codex)
./botference plan --ink                    # Use Ink TUI instead of Textual

# Building (experimental)
./botference build                         # Interactive build loop
./botference -p build                      # Headless build loop
./botference -p build 10                   # Headless, max 10 iterations
./botference -p build --parallel           # Phase-level parallelism

./botference --help                        # Full usage + supported models
```

> **API keys:** If your terminal already has Claude Code and Codex configured
> via subscription accounts (e.g. Claude Max, OpenAI Plus), Botference works
> out of the box with no extra setup. In build mode, subscription users run
> through the MCP fallback path (`fallback_agent_mcp.py` → `claude -p`).
>
> If you provide an API key, build mode uses the direct agent runner
> (`botference_agent.py`) instead, which owns the tool-calling loop and
> gives finer control over retries, context tracking, and token accounting.
> Copy the example env file and add your keys:
> ```bash
> cp .env.example .env
> # Then edit .env with your ANTHROPIC_API_KEY and/or OPENAI_API_KEY
> ```
> Botference will auto-load keys from `.env` when they are not already in
> your environment. Do **not** commit `.env` to version control.

## Using the Chat

### Messaging

Type freely to send a message. By default your first message goes to both
models; after that, messages are sticky to whoever you last addressed.

| Input | Effect |
|-------|--------|
| `@all <msg>` | Send to both Claude and Codex |
| `@claude <msg>` | Send to Claude only |
| `@codex <msg>` | Send to Codex only |
| `<msg>` | Auto-routed (first message → @all, then sticky to last target) |

Messages in the council panel are labelled by speaker:

- **Claude** — Claude's responses
- **Codex** — Codex's responses
- **You** — your messages
- **System** — the framework talking to you, not an LLM. Covers:
  - Session lifecycle (starting, relaying, or tearing down a model)
  - Mode changes (caucus started, draft complete)
  - Errors and warnings
  - Command feedback (lead set, usage info)
  - Approval prompts ("Write plan? [y/n]")

### Commands

| Command | What it does |
|---------|-------------|
| `/caucus <topic>` | Start a caucus — Claude and Codex debate the topic privately (3-5 rounds) and return a summary with a recommendation. If they agree on a writer, the lead is set automatically. |
| `/lead @claude\|@codex` | Manually set which model writes the plan. You can also use `/lead auto` to let a future caucus decide. |
| `/draft` | The lead model drafts a plan based on the conversation so far. No files are written yet. Requires a lead (set one manually or let `/caucus` pick). |
| `/finalize` | The lead drafts, the other model reviews, then plan files (`implementation-plan.md`, `checkpoint.md`) are written after your approval. |
| `/relay @claude\|@codex` | Tear down a model's session and bootstrap a fresh one with a structured handoff. Useful when context is getting long. |
| `/status` | Show context usage, lead, mode, and session state. |
| `/help` | Show the command reference. |
| `/quit` | Exit without writing files. |

**Typical workflow:** discuss → `/caucus` → `/lead` (or let caucus decide) →
`/finalize` → approve (y/n).

### Navigation and input

The TUI has two panels: **council** (left) and **caucus** (right), with a text
input field at the bottom.

- **Arrow keys do not move between panels.** Use the mouse to scroll within
  each panel.
- **Shift+Enter** inserts a newline (Ink backend only). In the Textual backend
  the input is single-line.
- The Ink text field can be glitchy when resizing the terminal window — if it
  gets stuck, try narrowing and re-widening the window.

> [!WARNING]
> The status line below the text field shows context usage (tokens / window)
> for each model. This works reasonably well for Claude but can be glitchy for
> Codex. Treat the numbers as a rough guide, not a precise measurement.

### Interface options

The TUI has two backends:

| Flag | Backend | Notes |
|------|---------|-------|
| `--textual` | Textual (Python) | Default. No extra install needed. |
| `--ink` | Ink (Node.js/React) | Requires `npm install` in `ink-ui/`. Supports multiline input (Shift+Enter). |

Both present the same council + caucus interface. Use `--claude` to skip Codex
and run a solo Claude session (no TUI, just the Claude CLI).

## Overview

Botference has two main modes: **planning** and **building**.

### Planning

There are two options for planning:

**Plan mode** (`./botference plan`) — Freeform planning room. Multi-agent mode
(Claude + Codex TUI) is the default; use `--claude` for solo Claude. No
structured prompts or system instructions are injected.

Plan mode is read-only during the conversation — the models cannot write files
while you're discussing. Only when you `/finalize` and approve does it write,
and even then it is restricted to exactly two files:

- `work/implementation-plan.md`
- `work/checkpoint.md`

These permissions are enforced at the adapter level (the writer session's
`allowed_tools` whitelist). Nothing else in your repo is touched.

**Research-plan mode** (`./botference research-plan`) — ⚠️ *Experimental.*
Structured planning with `prompts/plan.md` and `.claude/agents/plan.md`,
following the multi-step planning workflow. Multi-agent mode by default; use
`--claude` for solo Claude.

#### Freeform Planning

A chat session with no system prompts to seed the conversation:

```bash
./botference plan                          # Freeform planning (Claude + Codex)
./botference plan --claude                 # Freeform planning (solo Claude)
```

#### Research Planning

A structured session guided by the plan agent and prompt templates:

```bash
./botference research-plan                 # Structured planning (Claude + Codex)
./botference research-plan --claude        # Structured planning (solo Claude)
```

### Building ⚠️ Experimental

Build mode uses the **Ralph Loop**: a managed iteration cycle that executes the
plan one task at a time. Each iteration picks the next unchecked task from
`implementation-plan.md`, runs the appropriate agent, and updates
`checkpoint.md` before yielding.

#### Two execution paths

The build system has two agent runners that serve the same role through
different mechanisms:

- **`botference_agent.py`** (primary) — A direct API agent runner that loads
  per-agent tool registries and runs its own tool-calling loop. Requires an
  `ANTHROPIC_API_KEY`. This follows
  [ghuntley's coding agent architecture](https://ghuntley.com/agent): colocated
  tool definitions and handlers, registered per-agent, with the agent runner
  owning the full loop.

- **`fallback_agent_mcp.py`** (fallback) — Exposes the same per-agent tool
  registry as an MCP server, so `claude -p` can call botference's tools
  natively. Used automatically when no API key is present (OAuth/Max plan
  users). Same tools, same boundaries, different execution substrate.

Botference detects which path to use at runtime: if an Anthropic API key is
set, the primary agent runner handles the task directly; otherwise, it falls
back to the MCP path through the Claude CLI.

The ghuntley philosophy — that a coding agent with the right tools is the core
unit of work — originally targets software engineering. Botference extends this
to research agents (scout, deep-reader, critic, paper-writer, etc.) by giving
each agent its own scoped tool registry. For most people building software, the
coder agent alone may be sufficient. Whether that holds for research workflows
is an open question this project is exploring.

#### Context management

Botference includes context-aware session management that monitors token usage
and yields before exhausting the context window. The thresholds are:

- **20%** of the window for 1M-token models (Opus 4.6, Sonnet 4.6)
- **45%** of the window for 200K-272K models (Haiku, GPT-5.4, o3, o4-mini)

#### Interactive Mode

Launches an interactive Claude session that builds using the instructions in
`prompts/build.md`:

```bash
./botference build                         # Interactive build loop
```

#### Headless Mode

Runs non-interactively (suitable for CI or unattended execution):

```bash
./botference -p build                      # Non-interactive build loop
./botference -p build 10                   # Max 10 iterations
```

#### Architecture Modes

Botference supports serial (default), parallel, and orchestrated architectures.
Parallel and orchestrated modes are experimental:

```bash
./botference -p build --serial             # One task at a time (default)
./botference -p build --parallel           # Phase-level parallelism
./botference -p build --orchestrated       # AI-driven dispatch
```

## Repo Structure

```
botference/
├── botference           # Entry point (shell script)
├── work/                # Active thread state (checkpoint, plan, inbox)
├── build/               # Generated outputs, logs, runtime (gitignored)
├── archive/             # Archived completed threads
├── core/                # Python modules (orchestrator, TUI, adapters, agent runner)
├── prompts/             # Dispatcher prompts for plan and build modes
├── .claude/agents/      # Agent definitions (plan, coder, orchestrator, etc.)
├── lib/                 # Shell libraries (config, detection, monitoring, post-run)
├── tools/               # Python tool implementations (MCP server, file ops, search, etc.)
├── scripts/             # Utility scripts (archive, evaluation, usage extraction)
├── specs/               # Specifications and design documents
├── templates/           # Blank templates for checkpoint and plan files
└── tests/               # Test suite
```

### Directory Roles

- **`work/`** — Thread state files: `checkpoint.md`, `implementation-plan.md`, `inbox.md`, `HUMAN_REVIEW_NEEDED.md`, `iteration_count`. Tracked in git (except `iteration_count`).
- **`build/`** — Generated and runtime artifacts: `AI-generated-outputs/`, `logs/`, `run/`. Fully gitignored.
- **`archive/`** — Completed threads archived by `./botference archive`. Each subdirectory is a flat snapshot of one thread.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `BOTFERENCE_HOME` | Path to this framework (auto-detected) |
| `ANTHROPIC_MODEL` | Global model override (e.g. `claude-sonnet-4-6`) |
| `OPENAI_MODEL` | Codex participant model (default: `gpt-5.4`) |
| `ANTHROPIC_API_KEY` | API key for Claude models (only if not using subscription) |
| `OPENAI_API_KEY` | API key for OpenAI models (only if not using subscription) |
