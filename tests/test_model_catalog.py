"""core/model_catalog.py — the one model list, discovery from the CLIs' own
model files, the merge order, the "new model on offer" record, and the rule
that an unknown price is reported as not known (never as Sonnet's).

Every discovery test points BOTFERENCE_CLAUDE_MODEL_CACHE /
BOTFERENCE_CODEX_MODEL_CACHE at fixture files in tmp_path; conftest.py turns
discovery off and points the seen-record into tmp_path for everything else.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "core"))
sys.path.insert(0, str(REPO))

import model_catalog as mc  # noqa: E402


# ── fixtures ─────────────────────────────────────────────────


def _claude_file(models: list[dict]) -> dict:
    return {"version": 1, "fetchedAt": 1, "staleAt": 2,
            "catalog": {"config": {"models": models}}}


def _claude_model(mid: str, window: int = 1_000_000, name: str = "") -> dict:
    return {"id": mid, "name": name or mid, "section": "main",
            "thinking": {"type": "adaptive", "effort_options": [{"id": "low", "name": "Low"}]},
            "runtime": {"max_input_tokens": window, "max_output_tokens": 64000}}


def _codex_file(models: list[dict]) -> dict:
    return {"fetched_at": "x", "etag": "y", "client_version": "z", "models": models}


def _codex_model(slug: str, priority: int, visibility: str = "list",
                 window: int = 500_000, name: str = "") -> dict:
    return {"slug": slug, "display_name": name or slug, "visibility": visibility,
            "priority": priority, "context_window": window,
            "default_reasoning_level": "medium",
            "supported_reasoning_levels": [{"effort": "low", "description": ""}]}


@pytest.fixture
def sources(tmp_path, monkeypatch):
    """Discovery on, both cache paths pointed at tmp files (written by the test)."""
    claude = tmp_path / "claude-models.json"
    codex = tmp_path / "codex-models.json"
    monkeypatch.setenv("BOTFERENCE_MODEL_DISCOVERY", "1")
    monkeypatch.setenv("BOTFERENCE_CLAUDE_MODEL_CACHE", str(claude))
    monkeypatch.setenv("BOTFERENCE_CODEX_MODEL_CACHE", str(codex))
    mc._cache.clear()

    def write(path: Path, payload) -> None:
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload),
                        encoding="utf-8")
        mc._cache.clear()
    return claude, codex, write


# ── the built-in table keeps every number it had ─────────────

# Copied from the three tables this replaced (core/cli_adapters.py,
# core/providers.py, tools/_pricing.py as of 2026-11-09). A change here must
# be deliberate.
OLD_CONTEXT_WINDOWS = {
    "claude-fable-5-2": 1_000_000, "claude-fable-5-1": 1_000_000,
    "claude-fable-5": 1_000_000, "claude-opus-5-5": 1_000_000,
    "claude-opus-5": 1_000_000, "claude-opus-4-8": 1_000_000,
    "claude-opus-4-6": 1_000_000, "claude-opus-4-7": 1_000_000,
    "claude-sonnet-4-6": 1_000_000, "claude-haiku-4-5": 200_000,
    "gpt-5-latest": 272_000, "gpt-6-astra": 1_050_000, "gpt-6-sol": 1_050_000,
    "gpt-6-luna": 1_050_000, "gpt-5.6-sol": 1_050_000, "gpt-5.6-terra": 1_050_000,
    "gpt-5.6-luna": 1_050_000, "gpt-5.5": 258_000, "gpt-5.4": 272_000,
    "gpt-4o": 128_000, "gpt-4o-mini": 128_000, "o3": 200_000, "o4-mini": 200_000,
}
OLD_PRICING = {
    "claude-fable-5-2":  {"input": 8.0,  "output": 40.0, "cache_read": 0.2,  "cache_create": 10.0},
    "claude-fable-5-1":  {"input": 10.0, "output": 50.0, "cache_read": 0.25, "cache_create": 12.5},
    "claude-fable-5":    {"input": 10.0, "output": 50.0, "cache_read": 1.0,  "cache_create": 12.5},
    "claude-opus-4-8":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_create": 18.75},
    "claude-opus-4-7":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_create": 18.75},
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_create": 18.75},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_create": 3.75},
    "claude-haiku-4-5":  {"input": 0.8,  "output": 4.0,  "cache_read": 0.08, "cache_create": 1.0},
    "gpt-5.4":           {"input": 2.5,  "output": 15.0, "cache_read": 0.25, "cache_create": 0},
    "gpt-4o":            {"input": 2.5,  "output": 10.0, "cache_read": 0, "cache_create": 0},
    "gpt-4o-mini":       {"input": 0.15, "output": 0.6,  "cache_read": 0, "cache_create": 0},
    "o3":                {"input": 10.0, "output": 40.0, "cache_read": 0, "cache_create": 0},
    "o4-mini":           {"input": 1.1,  "output": 4.4,  "cache_read": 0, "cache_create": 0},
}


class TestBuiltinTable:
    def test_context_windows_unchanged_and_in_order(self):
        import cli_adapters
        import providers
        assert list(mc.builtin_context_windows().items()) == list(OLD_CONTEXT_WINDOWS.items())
        assert cli_adapters._CONTEXT_WINDOWS == OLD_CONTEXT_WINDOWS
        assert providers._CONTEXT_WINDOWS == OLD_CONTEXT_WINDOWS

    def test_prices_unchanged_and_none_invented(self):
        from tools._pricing import PRICING
        assert PRICING == OLD_PRICING
        assert mc.builtin_prices() == OLD_PRICING

    def test_every_entry_is_well_formed(self):
        ids = [m.id for m in mc.BUILTIN]
        assert len(ids) == len(set(ids))
        for m in mc.BUILTIN:
            assert m.bot in mc.BOTS
            assert (m.bot == "claude") == m.id.startswith("claude-")
            assert m.context_window and m.context_window > 0
            assert m.built_in

    def test_pickers_offer_the_builtin_list_when_discovery_is_off(self):
        from botference import _known_claude_models, _known_codex_models
        assert _known_claude_models() == [i for i in OLD_CONTEXT_WINDOWS if i.startswith("claude-")]
        assert _known_codex_models() == [i for i in OLD_CONTEXT_WINDOWS if not i.startswith("claude-")]

    def test_get_context_window_reads_the_catalogue(self):
        from providers import get_context_window
        assert get_context_window("claude-haiku-4-5") == 200_000
        assert get_context_window("no-such-model") == 200_000


# ── hand-written lists that must name every built-in model ───


def _js_fallback_models(path: Path) -> dict[str, list[str]]:
    text = path.read_text(encoding="utf-8")
    m = re.search(r"const FALLBACK_MODELS = \{(.*?)\};", text, re.S)
    assert m, f"no FALLBACK_MODELS in {path}"
    out = {}
    for bot in mc.BOTS:
        b = re.search(bot + r":\s*\[(.*?)\]", m.group(1), re.S)
        assert b, f"no {bot} list in FALLBACK_MODELS of {path}"
        out[bot] = re.findall(r"'([^']+)'", b.group(1))
    return out


@pytest.mark.parametrize("rel", [
    "frontends/council/assets/app.js",
    "frontends/review/assets/review.js",
])
def test_js_fallback_lists_name_every_builtin_model(rel):
    lists = _js_fallback_models(REPO / rel)
    for bot in mc.BOTS:
        missing = [i for i in mc.builtin_ids(bot) if i not in lists[bot]]
        assert not missing, f"{rel} FALLBACK_MODELS.{bot} lacks {missing}"


def test_config_help_names_every_builtin_model():
    text = (REPO / "lib" / "config.sh").read_text(encoding="utf-8")
    block = text.split("Supported models:", 1)[1].split("Model resolution order:", 1)[0]
    listed = set(re.findall(r"^  ([a-z0-9][a-z0-9.\-]+)\s", block, re.M))
    missing = [m.id for m in mc.BUILTIN if m.id not in listed]
    assert not missing, f"lib/config.sh 'Supported models' lacks {missing}"


# ── discovery: the three source states ───────────────────────


class TestDiscoveryStates:
    def test_missing_files(self, sources):
        reads = mc.discover()
        assert reads["claude"].state == "missing"
        assert reads["codex"].state == "missing"
        assert mc.offered_ids("claude") == mc.builtin_ids("claude")
        assert mc.offered_ids("codex") == mc.builtin_ids("codex")

    def test_ok(self, sources):
        claude, codex, write = sources
        write(claude, _claude_file([_claude_model("claude-sonnet-5-5")]))
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1)]))
        reads = mc.discover()
        assert reads["claude"].state == "ok"
        assert reads["codex"].state == "ok"
        assert [m.id for m in reads["claude"].models] == ["claude-sonnet-5-5"]

    @pytest.mark.parametrize("payload", [
        "{not json",
        "",
        "[]",
        json.dumps({"catalog": {"config": {"models": "nope"}}}),
        json.dumps({"catalog": None}),
        json.dumps(_claude_file([])),                         # zero usable entries
        json.dumps(_claude_file([{"id": 7}, "x", None])),     # nothing usable
    ])
    def test_claude_unreadable(self, sources, payload, caplog):
        claude, _codex, write = sources
        write(claude, payload)
        with caplog.at_level("WARNING", logger="model_catalog"):
            read = mc.discover()["claude"]
        assert read.state == "unreadable"
        assert read.models == ()
        assert mc.offered_ids("claude") == mc.builtin_ids("claude")
        assert any("unreadable" in r.getMessage() and str(claude) in r.getMessage()
                   for r in caplog.records)

    @pytest.mark.parametrize("payload", [
        "{",
        json.dumps({"models": {}}),
        json.dumps(_codex_file([_codex_model("gpt-x1", 1, visibility="hide")])),
    ])
    def test_codex_unreadable(self, sources, payload):
        _claude, codex, write = sources
        write(codex, payload)
        assert mc.discover()["codex"].state == "unreadable"
        assert mc.offered_ids("codex") == mc.builtin_ids("codex")

    def test_unreadable_is_logged_once(self, sources, caplog):
        claude, _codex, write = sources
        write(claude, "{bad")
        mc._logged.clear()
        with caplog.at_level("WARNING", logger="model_catalog"):
            mc.discover(); mc.discover(); mc.offered_ids("claude")
        lines = [r for r in caplog.records if "claude model list" in r.getMessage()]
        assert len(lines) == 1

    def test_discovery_off_reads_nothing(self, sources, monkeypatch):
        claude, codex, write = sources
        write(claude, _claude_file([_claude_model("claude-sonnet-5-5")]))
        monkeypatch.setenv("BOTFERENCE_MODEL_DISCOVERY", "0")
        assert mc.discover() == {}
        assert "claude-sonnet-5-5" not in mc.offered_ids("claude")

    def test_state_is_one_named_value(self):
        with pytest.raises(ValueError):
            mc.SourceRead("claude", None, "half-ok")
        with pytest.raises(ValueError):
            mc.SourceRead("claude", None, "ok")  # ok with no models is not ok

    def test_never_raises_on_a_directory_of_junk(self, sources, tmp_path, monkeypatch):
        d = tmp_path / "catalog-dir"
        d.mkdir()
        (d / "a.json").write_bytes(b"\xff\xfe\x00garbage")
        monkeypatch.setenv("BOTFERENCE_CLAUDE_MODEL_CACHE", str(d))
        mc._cache.clear()
        assert mc.discover()["claude"].state == "unreadable"


class TestDiscoveryPaths:
    def test_folder_means_newest_json(self, sources, tmp_path, monkeypatch):
        d = tmp_path / "model-catalog"
        d.mkdir()
        old, new = d / "old.json", d / "new.json"
        old.write_text(json.dumps(_claude_file([_claude_model("claude-old-1")])))
        new.write_text(json.dumps(_claude_file([_claude_model("claude-new-1")])))
        os.utime(old, (time.time() - 100, time.time() - 100))
        monkeypatch.setenv("BOTFERENCE_CLAUDE_MODEL_CACHE", str(d))
        mc._cache.clear()
        read = mc.discover()["claude"]
        assert read.path == new
        assert [m.id for m in read.models] == ["claude-new-1"]

    def test_claude_config_dir_and_codex_home_are_honoured(self, tmp_path, monkeypatch):
        monkeypatch.delenv("BOTFERENCE_CLAUDE_MODEL_CACHE", raising=False)
        monkeypatch.delenv("BOTFERENCE_CODEX_MODEL_CACHE", raising=False)
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "cc"))
        monkeypatch.setenv("CODEX_HOME", str(tmp_path / "cx"))
        assert mc.claude_cache_path() == tmp_path / "cc" / "cache" / "model-catalog"
        assert mc.codex_cache_path() == tmp_path / "cx" / "models_cache.json"


class TestDiscoveryFilters:
    def test_hostile_ids_are_dropped(self, sources):
        claude, codex, write = sources
        write(claude, _claude_file([
            _claude_model("claude-ok-1"),
            _claude_model("claude-$(rm -rf ~)"),
            _claude_model("claude-BIG"),
            _claude_model("--model=evil"),
            _claude_model("claude-" + "x" * 80),
            _claude_model("claude-a b"),
            _claude_model("gpt-6-sol"),          # not a Claude model
            {"id": ["claude-list"]},
        ]))
        write(codex, _codex_file([
            _codex_model("gpt-ok", 1),
            _codex_model("-rf", 2),
            _codex_model("gpt;ls", 3),
            _codex_model("claude-opus-5", 4),     # not a Codex model
            _codex_model("gpt\nnewline", 5),
        ]))
        assert [m.id for m in mc.discover()["claude"].models] == ["claude-ok-1"]
        assert [m.id for m in mc.discover()["codex"].models] == ["gpt-ok"]

    def test_hidden_codex_models_are_not_offered(self, sources):
        _claude, codex, write = sources
        write(codex, _codex_file([
            _codex_model("gpt-shown", 2),
            _codex_model("gpt-reserve", 1, visibility="hide"),
            _codex_model("codex-auto-review", 3, visibility="hide"),
            {**_codex_model("gpt-novis", 4), "visibility": None},
        ]))
        ids = mc.offered_ids("codex")
        assert "gpt-shown" in ids
        assert not {"gpt-reserve", "codex-auto-review", "gpt-novis"} & set(ids)

    def test_dated_claude_id_is_the_builtin_model(self, sources):
        claude, _codex, write = sources
        write(claude, _claude_file([
            _claude_model("claude-haiku-4-5-20251001", 200_000),
            _claude_model("claude-zeta-1-20260101"),   # no undated twin: kept as is
            _claude_model("claude-eta-2-20260101"),
            _claude_model("claude-eta-2"),             # undated twin listed too: one entry
        ]))
        ids = mc.offered_ids("claude")
        assert "claude-haiku-4-5" in ids
        assert "claude-haiku-4-5-20251001" not in ids
        assert ids.count("claude-haiku-4-5") == 1
        assert "claude-zeta-1-20260101" in ids
        assert ids.count("claude-eta-2") == 1
        assert "claude-eta-2-20260101" not in ids

    def test_display_names_are_tamed(self, sources):
        claude, _codex, write = sources
        write(claude, _claude_file([
            {**_claude_model("claude-nice-1"), "name": "Nice\x1b[31m 1\n" + "x" * 200},
        ]))
        name = mc.discover()["claude"].models[0].name
        assert "\x1b" not in name and "\n" not in name
        assert len(name) <= 60


# ── merge rule and order ─────────────────────────────────────


class TestMerge:
    def test_cli_order_first_then_builtins_it_does_not_list(self, sources):
        claude, codex, write = sources
        write(claude, _claude_file([
            _claude_model("claude-opus-5-5"),
            _claude_model("claude-sonnet-5-5", 900_000),
            _claude_model("claude-fable-5-1"),
        ]))
        write(codex, _codex_file([
            _codex_model("gpt-6-sol", 4, window=272_000),
            _codex_model("gpt-6.1-sol", 1),
            _codex_model("gpt-6-astra", 3, window=272_000),
            _codex_model("gpt-6.1-terra", 2),
        ]))
        claude_ids = mc.offered_ids("claude")
        assert claude_ids[:3] == ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"]
        rest = [i for i in mc.builtin_ids("claude") if i not in ("claude-opus-5-5", "claude-fable-5-1")]
        assert claude_ids[3:] == rest
        codex_ids = mc.offered_ids("codex")
        assert codex_ids[:4] == ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra", "gpt-6-sol"]
        assert codex_ids[4:] == [i for i in mc.builtin_ids("codex")
                                 if i not in ("gpt-6-astra", "gpt-6-sol")]

    def test_builtin_numbers_win_and_new_models_have_no_price(self, sources):
        claude, codex, write = sources
        write(claude, _claude_file([_claude_model("claude-sonnet-5-5", 900_000)]))
        write(codex, _codex_file([
            _codex_model("gpt-6-sol", 1, window=272_000),
            _codex_model("gpt-6.1-sol", 2, window=500_000),
        ]))
        assert mc.context_window("gpt-6-sol") == 1_050_000      # built-in wins
        assert mc.context_window("gpt-6.1-sol") == 500_000      # from the CLI
        assert mc.context_window("claude-sonnet-5-5") == 900_000
        assert mc.price_of("gpt-6.1-sol") is None
        assert mc.price_of("claude-sonnet-5-5") is None
        assert ("gpt-6-sol", 1_050_000, 272_000) in mc.context_disagreements()
        # the adapters' lookups see discovered windows too
        import cli_adapters  # noqa: F401  (imports model_catalog the same way)
        from providers import get_context_window
        assert get_context_window("gpt-6.1-sol") == 500_000

    def test_default_models_do_not_change(self, sources):
        import botference_ink_bridge as binkb
        claude, codex, write = sources
        write(claude, _claude_file([_claude_model("claude-sonnet-5-5")]))
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1)]))
        src = Path(binkb.__file__).read_text(encoding="utf-8")
        assert 'parser.add_argument("--openai-model", default="gpt-6-astra")' in src

    def test_unreadable_source_keeps_todays_order(self, sources):
        claude, codex, write = sources
        write(claude, "{")
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1)]))
        assert mc.offered_ids("claude") == mc.builtin_ids("claude")
        assert mc.offered_ids("codex")[0] == "gpt-6.1-sol"


# ── /model and the pickers see discovered models ─────────────


@pytest.mark.asyncio
async def test_model_command_accepts_a_discovered_model(sources, tmp_path):
    from botference import get_completion_context
    from test_botference import _make_botference
    _claude, codex, write = sources
    write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1, name="GPT-6.1-Sol")]))
    ctx = get_completion_context()
    assert ctx["scoped"]["/model @codex "][0] == "gpt-6.1-sol"
    c, _cl, cx, ui = _make_botference(tmp_path=tmp_path)
    await c.handle_input("/model @codex gpt-6.1-sol", ui)
    assert cx.model == "gpt-6.1-sol"
    await c.handle_input("/model @codex gpt-$(boom)", ui)
    assert cx.model == "gpt-6.1-sol"


# ── unknown price is not Sonnet's ────────────────────────────


class TestUnknownPrice:
    def test_cost_usd_is_none_without_a_price(self):
        from tools._pricing import cost_usd
        assert cost_usd("claude-opus-5-5", 1_000_000, 1_000_000) is None
        assert cost_usd("gpt-6.1-sol", 10, 10) is None
        sonnet = cost_usd("claude-sonnet-4-6", 1_000_000, 1_000_000)
        assert sonnet == 18.0

    def test_known_price_is_unchanged(self):
        from tools._pricing import cost_usd
        assert cost_usd("claude-fable-5-2", 1_000_000, 0, 1_000_000, 1_000_000) == 8.0 + 0.2 + 10.0

    def test_agent_runner_no_longer_falls_back_to_sonnet(self):
        src = (REPO / "core" / "botference_agent.py").read_text(encoding="utf-8")
        assert 'PRICING["claude-sonnet-4-6"]' not in src
        assert "cost_note" in src

    @pytest.mark.skipif(shutil.which("jq") is None or shutil.which("bash") is None,
                        reason="needs jq and bash")
    def test_post_run_summary_says_not_known(self, tmp_path):
        out = tmp_path / "out.json"
        out.write_text(json.dumps({
            "is_error": False, "num_turns": 1, "duration_ms": 1000,
            "total_cost_usd": None, "cost_note": "price not known for claude-opus-5-5",
            "modelUsage": {"claude-opus-5-5": {"inputTokens": 1}},
        }))
        script = (
            f'eval "$(sed -n \'/^print_output_json_summary()/,/^}}/p\' "{REPO}/lib/post-run.sh")"; '
            f'print_output_json_summary "{out}"'
        )
        res = subprocess.run(["bash", "-c", script], capture_output=True, text=True)
        assert "Cost: not known (price not known for claude-opus-5-5)" in res.stdout
        assert "Cost: $" not in res.stdout


# ── the "already seen" record ────────────────────────────────


class TestSeenRecord:
    @pytest.fixture
    def seen(self, tmp_path, monkeypatch):
        path = tmp_path / "home" / ".botference" / "models-seen.json"
        monkeypatch.setenv("BOTFERENCE_MODELS_SEEN_FILE", str(path))
        return path

    def test_first_run_is_silent_and_seeds_the_record(self, seen):
        assert mc.new_model_notice() == ""
        data = json.loads(seen.read_text())
        assert set(data["seen"]) == {m.id for m in mc.BUILTIN}

    def test_new_model_is_announced_once(self, seen, sources):
        _claude, codex, write = sources
        assert mc.new_model_notice() == ""            # seeds with the built-ins
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1, name="GPT-6.1-Sol")]))
        text = mc.new_model_notice()
        assert text == ("New model on offer: GPT-6.1-Sol (gpt-6.1-sol). "
                        "Pick it from the model menu.")
        assert "gpt-6.1-sol" in json.loads(seen.read_text())["seen"]
        assert mc.new_model_notice() == ""            # never again

    def test_several_new_models_make_one_sentence(self, seen, sources):
        claude, codex, write = sources
        mc.new_model_notice()
        write(claude, _claude_file([_claude_model("claude-sonnet-5-5", name="Sonnet 5.5")]))
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1, name="GPT-6.1-Sol")]))
        text = mc.new_model_notice()
        assert text == ("New models on offer: Sonnet 5.5 (claude-sonnet-5-5) and "
                        "GPT-6.1-Sol (gpt-6.1-sol). Pick them from the model menu.")
        assert "\n" not in text

    @pytest.mark.parametrize("junk", ["{not json", json.dumps({"seen": "x"}),
                                      json.dumps([1, 2]), json.dumps({"seen": [1]})])
    def test_unreadable_record_announces_nothing_and_is_left_alone(self, seen, sources, junk):
        _claude, codex, write = sources
        seen.parent.mkdir(parents=True)
        seen.write_text(junk)
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1)]))
        assert mc.new_model_notice() == ""
        assert seen.read_text() == junk

    def test_write_leaves_no_temp_files(self, seen, sources):
        _claude, codex, write = sources
        mc.new_model_notice()
        write(codex, _codex_file([_codex_model("gpt-6.1-sol", 1)]))
        mc.new_model_notice()
        assert sorted(p.name for p in seen.parent.iterdir()) == ["models-seen.json"]


# ── the notice in the room ───────────────────────────────────


def _seed_then_offer_new(seen_path: Path, codex_path: Path) -> None:
    seen_path.parent.mkdir(parents=True, exist_ok=True)
    seen_path.write_text(json.dumps({"version": 1, "seen": [m.id for m in mc.BUILTIN]}))
    codex_path.write_text(json.dumps(_codex_file([_codex_model("gpt-6.1-sol", 1, name="GPT-6.1-Sol")])))
    mc._cache.clear()


class TestRoomNotice:
    @pytest.fixture
    def setup(self, tmp_path, monkeypatch, sources):
        seen = tmp_path / "seen.json"
        monkeypatch.setenv("BOTFERENCE_MODELS_SEEN_FILE", str(seen))
        _seed_then_offer_new(seen, sources[1])
        from test_botference import _make_botference
        return _make_botference(tmp_path=tmp_path)

    def test_start_up_line_shows_once_and_is_not_saved_into_the_chat(self, setup):
        c, _cl, _cx, ui = setup
        c.announce_new_models(ui)
        lines = [t for s, t in ui.room_entries if "New model on offer" in t]
        assert lines == ["New model on offer: GPT-6.1-Sol (gpt-6.1-sol). Pick it from the model menu."]
        assert not any("New model" in e.text for e in c._room_history)
        c.announce_new_models(ui)                      # a second call is a no-op
        assert len([t for _s, t in ui.room_entries if "New model" in t]) == 1

    @pytest.mark.asyncio
    async def test_a_resume_during_the_first_input_shows_it_again(self, setup, tmp_path):
        from test_botference import _make_botference, _ok
        # a saved chat to resume
        first, _a, _b, first_ui = _make_botference(claude_responses=[_ok("hi")], tmp_path=tmp_path)
        await first.handle_input("@claude hello", first_ui)
        c, _cl, _cx, ui = setup
        c.announce_new_models(ui)
        await c.handle_input(f"/resume {first.session_id}", ui)   # wipes the screen, replays
        assert any("New model on offer" in t for _s, t in ui.room_entries)
        c.settle_model_notice()
        assert c._model_notice_mode == "done"
        ui.clear_panes()
        await c.handle_input(f"/resume {first.session_id}", ui)
        assert not any("New model on offer" in t for _s, t in ui.room_entries)

    def test_lifecycle_refuses_an_illegal_move(self, setup):
        from botference import MODEL_NOTICE_MODES
        c, *_ = setup
        assert c._model_notice_mode in MODEL_NOTICE_MODES
        with pytest.raises(ValueError):
            c._move_model_notice("done")              # none -> done is not a move
        c.settle_model_notice()                        # nothing showing: stays none
        assert c._model_notice_mode == "none"

    def test_opted_out_process_says_nothing_and_keeps_the_record(self, setup, monkeypatch, tmp_path):
        c, _cl, _cx, ui = setup
        monkeypatch.setenv("BOTFERENCE_MODEL_NOTICE", "0")
        before = (tmp_path / "seen.json").read_text()
        c.announce_new_models(ui)
        assert not any("New model" in t for _s, t in ui.room_entries)
        assert (tmp_path / "seen.json").read_text() == before

    @pytest.mark.asyncio
    async def test_bridge_start_up_emits_it(self, setup, monkeypatch):
        import botference_ink_bridge as binkb
        from test_botference_ink_bridge import _RecordingBridge
        c, *_ = setup
        monkeypatch.setattr(binkb, "emit", lambda obj: None)
        bridge = _RecordingBridge()
        task = await binkb._send_initial_state_and_schedule_hydration(bridge, c, c.paths)
        await asyncio.wait_for(task, timeout=2.0)
        texts = [str(a[1]) for name, a in bridge.calls if name == "add_room_entry"]
        assert any(t.startswith("New model on offer: GPT-6.1-Sol") for t in texts)
