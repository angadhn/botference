"""Shared test scaffolding.

Redirects default path resolution into each test's tmp dir so tests that
construct Botference / SessionStore without explicit paths can never
persist sessions into the repository's own work/ store. (Before this
guard, a full pytest run littered hundreds of session files there.)

test_paths.py deletes these env vars in its own fixtures where it needs
to exercise the no-env fallback behavior.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_botference_state(tmp_path, monkeypatch):
    work = tmp_path / "bf-default-work"
    (work / "sessions").mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("BOTFERENCE_WORK_DIR", str(work))
    # Keep tests hermetic from the developer's real user settings too.
    monkeypatch.setenv(
        "BOTFERENCE_SETTINGS_FILE", str(tmp_path / "bf-user-settings.json")
    )
