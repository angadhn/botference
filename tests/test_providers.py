"""Keychain lookup in core/providers.py: bounded in time, failures said once."""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

import providers  # noqa: E402


def test_keychain_lookup_has_a_timeout_and_reports_a_hang(monkeypatch, capsys):
    seen = {}

    def hang(cmd, **kwargs):
        seen["timeout"] = kwargs.get("timeout")
        raise subprocess.TimeoutExpired(cmd, kwargs.get("timeout"))

    monkeypatch.setattr(providers.subprocess, "run", hang)
    assert providers._keychain_json("Codex", ["-s", "Codex Auth"]) is None
    assert seen["timeout"] == providers._KEYCHAIN_TIMEOUT
    err = capsys.readouterr().err
    assert err.count("\n") == 1 and "did not answer" in err


def test_unreadable_entry_is_reported_without_the_secret(monkeypatch, capsys):
    monkeypatch.setattr(
        providers.subprocess, "run",
        lambda cmd, **kw: SimpleNamespace(returncode=0, stdout="SECRET-XYZ", stderr=""),
    )
    assert providers._keychain_json("Codex", ["-s", "Codex Auth"]) is None
    err = capsys.readouterr().err
    assert "not in the expected form" in err and "SECRET" not in err


def test_nothing_stored_is_silent(monkeypatch, capsys):
    monkeypatch.setattr(
        providers.subprocess, "run",
        lambda cmd, **kw: SimpleNamespace(returncode=44, stdout="", stderr="not found"),
    )
    assert providers._keychain_json("Codex", ["-s", "Codex Auth"]) is None
    assert capsys.readouterr().err == ""
