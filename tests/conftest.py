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
    # `botference init` also registers the project with Discuss
    # (frontends/plugin/site-cli.mjs): never into the developer's real
    # ~/.botference/sites.json, and never by poking their running companion
    monkeypatch.setenv("BOTFERENCE_SITES_REGISTRY", str(tmp_path / "bf-sites.json"))
    monkeypatch.setenv("BOTFERENCE_PLUGIN_URL", "http://127.0.0.1:9")
    # Model discovery (core/model_catalog.py) never reads the developer's
    # real ~/.claude / ~/.codex lists, and the "new model" record never
    # lands in their ~/.botference: tests that want discovery turn it on
    # and point these at fixture files.
    monkeypatch.setenv("BOTFERENCE_MODEL_DISCOVERY", "0")
    monkeypatch.setenv("BOTFERENCE_CLAUDE_MODEL_CACHE", str(tmp_path / "bf-no-claude-models"))
    monkeypatch.setenv("BOTFERENCE_CODEX_MODEL_CACHE", str(tmp_path / "bf-no-codex-models.json"))
    monkeypatch.setenv("BOTFERENCE_MODELS_SEEN_FILE", str(tmp_path / "bf-models-seen.json"))
    # The Google poster's read_doc puts each Doc on the Doc-comment
    # watcher's list (core/gdoc_watchlist.py): never the developer's real
    # ~/.botference/gdoc-watch, and the watcher's log never their real one.
    monkeypatch.setenv("BOTFERENCE_GDOC_WATCH_HOME", str(tmp_path / "bf-gdoc-watch"))
    monkeypatch.setenv("BOTFERENCE_GDOC_WATCH_LOG", str(tmp_path / "bf-gdoc-watch.log"))
