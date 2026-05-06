#!/usr/bin/env python3
"""Scaffold a project-local Botference state directory."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path


README_TEMPLATE = """# {project_dir_name}/

Project-local Botference state and configuration.

Files you will usually care about:
- `implementation-plan.md` — the current execution plan
- `checkpoint.md` — current status and next task
- `inbox.md` — operator notes for the next run
- `build/` — generated drafts, runtime files, and logs
- `archive/` — archived threads
- `agents/` — project-specific Botference agents
- `project.json` — project-local Botference policy

This directory is self-contained on purpose. Removing it uninstalls the
project-local Botference state without touching the rest of the project.

By default, writes stay inside this directory. To opt into another owned output
area later, add it explicitly under `write_roots` in `project.json`.
"""


GITIGNORE_TEXT = """implementation-plan.md
checkpoint.md
inbox.md
HUMAN_REVIEW_NEEDED.md
iteration_count
handoffs/
build/
archive/
CHANGELOG.md
"""


def build_project_json(profile: str, project_dir_name: str) -> dict:
    return {
        "version": 1,
        "profile": profile,
        "modes": {
            "plan": True,
            "research_plan": True,
            "build": True,
        },
        "write_roots": {
            "plan": [f"{project_dir_name}"],
            "build": [f"{project_dir_name}"],
        },
        "agent_overrides": [],
    }


def valid_project_dir_name(value: str) -> bool:
    return bool(value) and value not in {".", ".."} and re.fullmatch(r"[A-Za-z0-9_-]+", value) is not None


def normalize_project_dir_name(value: str) -> str:
    if not valid_project_dir_name(value):
        raise ValueError("project dir must be a slug using letters, numbers, hyphens, or underscores")
    if value == "botference" or value.startswith(("botference-", "botference_")):
        return value
    return f"botference-{value}"


def ensure_text(path: Path, text: str) -> None:
    if not path.exists():
        path.write_text(text, encoding="utf-8")


def ensure_copy(src: Path, dst: Path) -> None:
    if not dst.exists():
        shutil.copyfile(src, dst)


def main() -> int:
    parser = argparse.ArgumentParser(description="Initialize project-local Botference state.")
    parser.add_argument("--profile", default="vault-drafter")
    parser.add_argument("--project-dir", default=None, help="Project-local state directory slug/name.")
    args = parser.parse_args()

    botference_home = Path(os.environ["BOTFERENCE_HOME"]).resolve()
    project_root = Path(os.environ.get("BOTFERENCE_PROJECT_ROOT", os.getcwd())).resolve()
    raw_project_dir_name = args.project_dir or os.environ.get("BOTFERENCE_PROJECT_DIR_NAME", "botference")
    try:
        project_dir_name = normalize_project_dir_name(raw_project_dir_name)
    except ValueError as exc:
        print(f"Error: --project-dir {exc}.", file=sys.stderr)
        return 2
    project_dir = project_root / project_dir_name

    if project_dir.exists() and not project_dir.is_dir():
        if project_root == botference_home and project_dir_name == "botference":
            print(
                "Error: the Botference source repo uses the legacy self-hosted layout "
                "(work/, build/, archive/) instead of a top-level botference/ directory.",
                file=sys.stderr,
            )
            print(
                "Run ./botference plan --ink directly from the repo root, or set "
                "BOTFERENCE_PROJECT_DIR_NAME to scaffold a different project-local directory.",
                file=sys.stderr,
            )
            return 1
        print(f"Error: {project_dir} exists but is not a directory.", file=sys.stderr)
        return 1

    project_dir.mkdir(parents=True, exist_ok=True)
    (project_dir / "agents").mkdir(exist_ok=True)
    (project_dir / "handoffs").mkdir(exist_ok=True)
    (project_dir / "archive").mkdir(exist_ok=True)
    (project_dir / "build" / "AI-generated-outputs").mkdir(parents=True, exist_ok=True)
    (project_dir / "build" / "logs").mkdir(parents=True, exist_ok=True)
    (project_dir / "build" / "run").mkdir(parents=True, exist_ok=True)

    templates = botference_home / "templates"
    ensure_copy(templates / "implementation-plan.md", project_dir / "implementation-plan.md")
    ensure_copy(templates / "checkpoint.md", project_dir / "checkpoint.md")
    ensure_copy(templates / "HUMAN_REVIEW_NEEDED.md", project_dir / "HUMAN_REVIEW_NEEDED.md")

    ensure_text(project_dir / "README.md", README_TEMPLATE.format(project_dir_name=project_dir_name))
    ensure_text(project_dir / ".gitignore", GITIGNORE_TEXT)
    ensure_text(project_dir / "inbox.md", "")
    ensure_text(project_dir / "iteration_count", "0\n")
    ensure_text(project_dir / "CHANGELOG.md", "# CHANGELOG\n")

    project_json = project_dir / "project.json"
    if not project_json.exists():
        project_json.write_text(
            json.dumps(build_project_json(args.profile, project_dir_name), indent=2) + "\n",
            encoding="utf-8",
        )

    print(f"Initialized {project_dir}")
    print("Daily usage:")
    print("  botference plan --ink")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
