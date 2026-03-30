"""Shared path resolution for tool modules.

Single source of truth for resolving framework paths (scripts/, etc.)
when BOTFERENCE_HOME may differ from CWD.
"""

import os
from pathlib import Path


def scripts_dir() -> Path:
    """Resolve scripts/ directory via BOTFERENCE_HOME, falling back to repo-relative."""
    botference_home = os.environ.get("BOTFERENCE_HOME", "")
    if botference_home:
        return Path(botference_home) / "scripts"
    return Path(__file__).resolve().parent.parent / "scripts"
