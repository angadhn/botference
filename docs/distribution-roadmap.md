# Distribution Roadmap

This document records the long-term goal of making Botference feel like an
installed tool rather than a cloned repo workflow.

## Target End State

The desired UX is:

```bash
botference init
botference plan --ink
```

with `botference` available on `PATH` from a package manager or installer.

Possible distribution channels:

- npm global package
- Homebrew formula
- standalone installer script
- cloned repo for contributors and internals work

The command model should be the same regardless of how Botference is installed.

## Why Packaging Is Deferred

Packaging is not the current implementation target because the runtime model had
to be stabilized first.

The brownfield project model comes first:

- one engine install
- one project-local `botference/` directory per project
- one project-local policy file
- one consistent permission model across Claude and Codex

Without that, packaging would freeze the wrong assumptions into the installer.

## Packaging Prerequisites

Before packaging, Botference should have:

- stable `botference init` behavior
- robust `BOTFERENCE_HOME` resolution when launched from `PATH`
- a documented project-local layout and migration story
- project-local permission enforcement that works in git and non-git projects
- clear dependency checks for Python, Bash, optional Node, `claude`, and `codex`
- a first-run experience that explains missing dependencies cleanly

## Non-Goals For This Phase

This phase does not attempt to:

- ship npm packaging
- remove cloned-repo workflows
- rewrite Botference into a pure Node application
- depend on Claude-specific or Codex-specific local config formats for policy

## Compatibility Goal

When packaging does happen later, the project contract should stay the same:

- users still run `botference`
- projects still keep local state under `botference/`
- uninstall still means removing the installed command and deleting
  `project-root/botference/`

That is the main reason the current implementation is being shaped around the
global-command model now.
