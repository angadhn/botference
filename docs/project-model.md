# Project Model

Botference now supports a project-local `botference/` directory for brownfield
and greenfield work outside the Botference engine repo.

## Daily UX

From a target project root:

```bash
botference init
botference plan --ink
botference research-plan --ink
botference build
```

`init` is explicit. Botference does not silently create project state on first
run.

The state directory name defaults to `botference`, but can be changed:

```bash
botference init --project-dir=spaceship
botference --project-dir=spaceship plan --ink
```

Use the same `--project-dir` value on later commands, or set
`BOTFERENCE_PROJECT_DIR_NAME=spaceship` in the project environment. Slugs may
contain letters, numbers, hyphens, and underscores. Bare slugs are prefixed, so
`spaceship` resolves to `botference-spaceship/`; explicit names like
`botference-spaceship` are accepted as-is.

## Project Layout

After `botference init`, a project contains:

```text
project-root/
  botference/
    README.md
    project.json
    .gitignore
    implementation-plan.md
    checkpoint.md
    inbox.md
    HUMAN_REVIEW_NEEDED.md
    iteration_count
    CHANGELOG.md
    handoffs/
    agents/
    build/
      AI-generated-outputs/
      logs/
      run/
    archive/
```

The visible directory is intentional:

- users can inspect `implementation-plan.md`, `checkpoint.md`, and draft outputs
- uninstall is simple: remove `botference/`
- Botference-owned state stays contained instead of leaking into the project root

With a custom directory name, the same layout is created under that name.

## Policy File

`botference/project.json` is the project-local Botference policy file. With a
custom state directory, the policy file lives at `<project-dir>/project.json`.

Current enforced fields:

- `profile`
- `modes.plan`
- `modes.research_plan`
- `modes.build`
- `write_roots.plan`
- `write_roots.build`
- `agent_overrides`

Current default shape:

```json
{
  "version": 1,
  "profile": "vault-drafter",
  "modes": {
    "plan": true,
    "research_plan": true,
    "build": true
  },
  "write_roots": {
    "plan": ["botference"],
    "build": ["botference"]
  },
  "agent_overrides": []
}
```

Interpretation:

- plan/research-plan may write only inside the declared `write_roots.plan`
- build may write only inside the declared `write_roots.build`
- the default init policy explicitly grants `botference/**` to both modes
- a project may disable `build` entirely
- reserved built-in agent names may only be overridden if explicitly listed in
  `agent_overrides`
- anything outside declared write roots is treated as read-only
- nested `.git` directories stay blocked even if they appear under a writable root

## Permission Enforcement

Botference enforces project policy in three places:

1. Pre-run gate: blocked modes fail before model startup.
2. Runtime adapter / tool layer: writable paths are derived from the same
   project policy and out-of-policy file mutations are rejected before write.
3. Post-run audit: changed files are checked against the policy and the run
   fails closed on violations.

The post-run audit works in both git and non-git projects. In git repos it uses
git status-style snapshots. In non-git projects it snapshots only Botference-
owned paths plus configured writable roots; it does not hash the whole project
tree.

## Vault Profile

For vault-style projects, the intended default is:

- read/search: whole project, but lazy and on-demand
- `plan` writes: `botference/**`
- `build` writes: `botference/**`
- vault notes and content: read-only

This keeps build useful for draft generation without granting direct write
access to the vault itself.

If you later want a narrower boundary, shrink `write_roots` to subpaths such as
`botference/build` or `botference/wiki` instead of widening writes to the vault
in general.

## Agent Resolution

Botference resolves agent files per name, not per directory tree.

Resolution order:

1. Explicit project override of a reserved built-in name
2. `botference/agents/{name}.md`
3. `.claude/agents/{name}.md` compatibility fallback
4. `BOTFERENCE_HOME/.claude/agents/{name}.md`

Built-in agent names are reserved by default. If a project defines `coder.md`,
`plan.md`, or another built-in without listing it in `agent_overrides`,
Botference exits with a validation error instead of silently shadowing the
engine agent.

Prompt resolution and tool resolution follow the same source selection so a
project agent cannot accidentally use a framework tool manifest for a different
agent definition.

## Compatibility

The Botference engine repo still supports the legacy self-hosted layout:

- `work/`
- `build/`
- `archive/`
- root-level `implementation-plan.md`, `checkpoint.md`, and `CHANGELOG.md`

That fallback remains because this repo already contains an executable named
`botference`, which prevents the repo itself from also having a top-level
directory named `botference/`.
