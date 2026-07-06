"""
user_settings.py — tiny per-user (global) settings store.

Chat state lives in the per-project session store; this file holds the
handful of preferences that follow the *user* across projects (currently
just desktop notifications). JSON at ~/.botference/settings.json,
overridable via BOTFERENCE_SETTINGS_FILE (tests point it into tmp_path).
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def settings_file() -> Path:
    env = os.environ.get("BOTFERENCE_SETTINGS_FILE", "")
    if env:
        return Path(env)
    return Path.home() / ".botference" / "settings.json"


def load_user_settings() -> dict:
    try:
        data = json.loads(settings_file().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_user_setting(key: str, value: object) -> None:
    settings = load_user_settings()
    settings[key] = value
    path = settings_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(settings, indent=2) + "\n", encoding="utf-8"
        )
    except OSError:
        pass  # a failed preference write must never take a turn down
