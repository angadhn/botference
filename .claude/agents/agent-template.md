## Identity

<!-- 1-2 sentences: What is this agent? What does it produce? -->
<agent-role> — <what it does and what it outputs>.

## Inputs (READ these)

<!-- List ONLY what this agent needs. Every item should justify its context cost. -->
- `checkpoint.md` — current state (Knowledge State table + Next Task)
- `<input-file-1>` — <why this agent needs it>
- `<input-file-2>` — <why this agent needs it>

## Tools

<!-- List tools this agent needs BEYOND the essentials (read_file, write_file, bash, git_commit, etc.).
     botference_agent.py reads this section to build the agent's tool registry.
     Only list tools from the Botference tool set (run: python3 tools/cli.py --list-tools).
     If this agent needs web access, add: `web_search` -->
- `<tool_name>` — <when/why to use it>

## Operational Guardrails

<!-- Constraints that keep this agent efficient and predictable. -->

- **Pre-estimate:** <how to budget context before starting>
- **Priority order:** (1) <most important>, (2) <next>, (3) <least critical, skip if context tight>
- **Context check:** <when to check and what to do at thresholds>

<!-- Optional: context threshold table for agents that do heavy reading -->
<!--
| Context % | Action |
|-----------|--------|
| < 30% | Safe — proceed normally |
| 30-40% | Caution — finish current item ONLY, then yield |
| >= 40% | STOP — write outputs immediately, commit, yield |
-->

## Output Format

```
AI-generated-outputs/<thread>/<phase-NN-name>/
├── <output-file-1>    # Description
├── <output-file-2>    # Description
├── <output-file-3>    # Description
└── phase-summary.md   # What was accomplished, key decisions, what passes to next phase
```

<!-- If this agent writes structured data (JSON, JSONL), define the schema: -->
<!--
### <filename> schema
```json
{
  "field1": "description",
  "field2": "description"
}
```
-->

## Workflow

1. Read `checkpoint.md` — determine current task from Knowledge State + Next Task
2. <Step 2>
4. <Step 4>
...
N-2. Write `AI-generated-outputs/<thread>/<phase-NN-name>/phase-summary.md` (~10 lines: what was accomplished, key decisions, what passes to next phase, issues/partial work)
N-1. Update `checkpoint.md` — replace Knowledge State section with current phase's table, update Next Task
N. Commit all outputs: phase outputs, phase-summary.md, checkpoint.md

## Botference Loop Yield Protocol

- Check `$BOTFERENCE_RUN/context-pct` before <when — e.g., every Read call, every major step>
- If `[ -f "$BOTFERENCE_RUN/yield" ]`: <what to save before exiting>
- Before exiting: commit <critical files>, checkpoint.md
