"""Tests for video_watch.py — having a YouTube video watched by Gemini.

Nothing here touches the network: `watch()` takes the HTTP call as an
argument, so every request shape and every failure is exercised against a
fake.
"""

from __future__ import annotations

import json
import sys
import urllib.error
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

import video_watch as vw


URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"


def _fake_http(status: int, payload, *, record: list | None = None):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def call(url, data, headers, timeout):
        if record is not None:
            record.append({
                "url": url, "body": json.loads(data.decode()),
                "headers": headers, "timeout": timeout,
            })
        return status, body

    return call


def _ok_payload(text="A report about the video."):
    return {
        "candidates": [{"content": {"parts": [{"text": text}]}}],
        "usageMetadata": {
            "promptTokenCount": 100,
            "candidatesTokenCount": 20,
            "totalTokenCount": 120,
        },
    }


# ── finding links ──────────────────────────────────────────


class TestFindYoutubeUrls:
    def test_watch_url(self):
        assert vw.find_youtube_urls("see https://www.youtube.com/watch?v=abc123XYZ_ now") == [
            "https://www.youtube.com/watch?v=abc123XYZ_"
        ]

    def test_short_url(self):
        assert vw.find_youtube_urls("https://youtu.be/abc123XYZ_") == [
            "https://youtu.be/abc123XYZ_"
        ]

    def test_shorts_and_live(self):
        found = vw.find_youtube_urls(
            "https://www.youtube.com/shorts/aaaaaaaaaaa and "
            "https://youtube.com/live/bbbbbbbbbbb"
        )
        assert found == [
            "https://www.youtube.com/shorts/aaaaaaaaaaa",
            "https://youtube.com/live/bbbbbbbbbbb",
        ]

    def test_scheme_is_optional(self):
        assert vw.find_youtube_urls("youtu.be/abc123XYZ_") == [
            "https://youtu.be/abc123XYZ_"
        ]

    def test_extra_query_parameters_survive(self):
        found = vw.find_youtube_urls(
            "https://www.youtube.com/watch?v=abc123XYZ_&t=90s"
        )
        assert found == ["https://www.youtube.com/watch?v=abc123XYZ_&t=90s"]
        assert vw.video_id(found[0]) == "abc123XYZ_"

    def test_v_after_another_parameter(self):
        assert vw.video_id(
            "https://www.youtube.com/watch?app=desktop&v=abc123XYZ_"
        ) == "abc123XYZ_"

    def test_trailing_punctuation_is_not_part_of_the_link(self):
        assert vw.find_youtube_urls("watch https://youtu.be/abc123XYZ_.") == [
            "https://youtu.be/abc123XYZ_"
        ]

    def test_same_video_twice_in_two_shapes_is_one_link(self):
        found = vw.find_youtube_urls(
            "https://youtu.be/abc123XYZ_ and "
            "https://www.youtube.com/watch?v=abc123XYZ_"
        )
        assert found == ["https://youtu.be/abc123XYZ_"]

    def test_links_inside_a_code_fence_are_ignored(self):
        text = (
            "here:\n```\nhttps://youtu.be/abc123XYZ_\n```\n"
            "and https://youtu.be/zzz123XYZ_"
        )
        assert vw.find_youtube_urls(text) == ["https://youtu.be/zzz123XYZ_"]

    def test_links_in_backticks_are_ignored(self):
        assert vw.find_youtube_urls("`https://youtu.be/abc123XYZ_`") == []

    def test_other_links_are_not_youtube(self):
        assert vw.find_youtube_urls("https://vimeo.com/12345 https://example.org") == []

    def test_is_youtube_url_rejects_a_sentence(self):
        assert vw.is_youtube_url(URL)
        assert not vw.is_youtube_url(f"watch {URL}")
        assert not vw.is_youtube_url("https://example.org/watch?v=abc123XYZ_")
        assert not vw.is_youtube_url("")


# ── a bot asking for a watch ───────────────────────────────


class TestParseWatchRequest:
    def test_plain_line(self):
        assert vw.parse_watch_request(f"Here is my view.\n\nwatch: {URL}") == URL

    def test_last_one_wins(self):
        text = f"watch: https://youtu.be/aaaaaaaaaaa\nwatch: {URL}"
        assert vw.parse_watch_request(text) == URL

    def test_bullet_and_bold_are_peeled(self):
        assert vw.parse_watch_request(f"- **watch: {URL}**") == URL

    def test_a_mention_inside_a_sentence_is_not_a_request(self):
        assert vw.parse_watch_request(f"I could watch: {URL} if you like — thoughts?") is None

    def test_a_non_youtube_url_is_not_a_request(self):
        assert vw.parse_watch_request("watch: https://vimeo.com/12345") is None

    def test_inside_a_fence_is_not_a_request(self):
        assert vw.parse_watch_request(f"```\nwatch: {URL}\n```") is None

    def test_nothing_asked(self):
        assert vw.parse_watch_request("No video here.") is None


# ── the key ────────────────────────────────────────────────


class TestGeminiKey:
    def test_env_wins(self, tmp_path, monkeypatch):
        monkeypatch.setenv("GEMINI_API_KEY", "  from-env  ")
        f = tmp_path / "gemini-key"
        f.write_text("from-file")
        assert vw.gemini_key(key_file=f) == "from-env"

    def test_file_when_no_env(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        f = tmp_path / "gemini-key"
        f.write_text("from-file\n")
        assert vw.gemini_key(key_file=f) == "from-file"

    def test_none_when_neither(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        assert vw.gemini_key(key_file=tmp_path / "missing") is None

    def test_empty_file_is_no_key(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        f = tmp_path / "gemini-key"
        f.write_text("   \n")
        assert vw.gemini_key(key_file=f) is None

    def test_a_readable_by_others_key_is_warned_about_once(
        self, tmp_path, monkeypatch, caplog
    ):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setattr(vw, "_warned_permissions", False)
        f = tmp_path / "gemini-key"
        f.write_text("secret-key")
        f.chmod(0o644)
        with caplog.at_level("WARNING"):
            assert vw.gemini_key(key_file=f) == "secret-key"
            assert vw.gemini_key(key_file=f) == "secret-key"
        warnings = [r for r in caplog.records if "chmod 600" in r.getMessage()]
        assert len(warnings) == 1
        assert "secret-key" not in caplog.text  # never echo the key


# ── prompts and request shape ──────────────────────────────


class TestRequestShape:
    def test_body_is_file_data_plus_text(self):
        body = vw.build_request_body(URL)
        parts = body["contents"][0]["parts"]
        assert parts[0] == {"file_data": {"file_uri": URL}}
        assert "Timestamped" in parts[1]["text"]

    def test_summary_prompt_asks_for_the_lot(self):
        text = vw.build_prompt()
        for want in ("title", "channel", "mm:ss", "quotes", "600 words"):
            assert want.lower() in text.lower()

    def test_a_question_is_answered_first(self):
        text = vw.build_prompt("What does she say about costs?")
        assert "What does she say about costs?" in text
        assert text.index("answer this question first") < text.index("summary")

    def test_the_call_carries_the_key_in_the_header(self, tmp_path):
        seen: list = []
        result = vw.watch(
            URL, key="k-123", http=_fake_http(200, _ok_payload(), record=seen),
            cache_dir=tmp_path,
        )
        assert result.ok
        assert seen[0]["headers"]["x-goog-api-key"] == "k-123"
        assert seen[0]["url"].endswith("/gemini-2.5-flash:generateContent")
        assert seen[0]["timeout"] == 120


# ── results and errors ─────────────────────────────────────


class TestWatch:
    def test_text_and_usage_come_back(self, tmp_path):
        r = vw.watch(URL, key="k", http=_fake_http(200, _ok_payload("Hello.")),
                     cache_dir=tmp_path)
        assert r.ok and r.text == "Hello."
        assert r.usage == {"prompt_tokens": 100, "output_tokens": 20,
                           "total_tokens": 120}

    def test_no_key_is_a_plain_message(self, tmp_path, monkeypatch):
        monkeypatch.delenv("GEMINI_API_KEY", raising=False)
        monkeypatch.setattr(vw, "KEY_FILE", tmp_path / "nope")
        r = vw.watch(URL, cache_dir=tmp_path)
        assert not r.ok and "No Gemini key" in r.error

    def test_a_non_youtube_link_is_refused_before_any_call(self, tmp_path):
        def boom(*a, **k):  # pragma: no cover - must not run
            raise AssertionError("no call should be made")

        r = vw.watch("https://vimeo.com/1", key="k", http=boom, cache_dir=tmp_path)
        assert not r.ok and "not a YouTube link" in r.error

    def test_403_reads_as_a_key_problem(self, tmp_path):
        r = vw.watch(URL, key="k", cache_dir=tmp_path, http=_fake_http(
            403, {"error": {"status": "PERMISSION_DENIED",
                            "message": "API key not valid"}}))
        assert "refused the key" in r.error

    def test_400_reads_as_a_private_video(self, tmp_path):
        r = vw.watch(URL, key="k", cache_dir=tmp_path, http=_fake_http(
            400, {"error": {"status": "INVALID_ARGUMENT",
                            "message": "Unable to process input video"}}))
        assert "private" in r.error and "public YouTube videos" in r.error

    def test_429_reads_as_the_daily_allowance(self, tmp_path):
        r = vw.watch(URL, key="k", cache_dir=tmp_path, http=_fake_http(
            429, {"error": {"status": "RESOURCE_EXHAUSTED",
                            "message": "Quota exceeded"}}))
        assert "daily video allowance" in r.error

    def test_resource_exhausted_with_a_200_shaped_error(self, tmp_path):
        r = vw.watch(URL, key="k", cache_dir=tmp_path, http=_fake_http(
            500, {"error": {"status": "RESOURCE_EXHAUSTED", "message": "quota"}}))
        assert "daily video allowance" in r.error

    def test_a_network_failure_is_reported_not_raised(self, tmp_path):
        def broken(*a, **k):
            raise urllib.error.URLError("nodename nor servname provided")

        r = vw.watch(URL, key="k", http=broken, cache_dir=tmp_path)
        assert "Could not reach Gemini" in r.error

    def test_an_empty_answer_is_an_error_not_a_blank_report(self, tmp_path):
        r = vw.watch(URL, key="k", cache_dir=tmp_path,
                     http=_fake_http(200, {"candidates": []}))
        assert not r.ok and "nothing back to read" in r.error


# ── the cache ──────────────────────────────────────────────


class TestCache:
    def test_a_second_watch_costs_nothing(self, tmp_path):
        calls: list = []
        http = _fake_http(200, _ok_payload("Cached me."), record=calls)
        first = vw.watch(URL, key="k", http=http, cache_dir=tmp_path)
        second = vw.watch(URL, key="k", http=http, cache_dir=tmp_path)
        assert first.text == second.text == "Cached me."
        assert len(calls) == 1
        assert second.cached and not first.cached

    def test_a_different_question_is_a_different_entry(self, tmp_path):
        calls: list = []
        http = _fake_http(200, _ok_payload(), record=calls)
        vw.watch(URL, key="k", http=http, cache_dir=tmp_path)
        vw.watch(URL, "and the costs?", key="k", http=http, cache_dir=tmp_path)
        assert len(calls) == 2

    def test_the_same_video_in_another_url_shape_is_a_hit(self, tmp_path):
        calls: list = []
        http = _fake_http(200, _ok_payload(), record=calls)
        vw.watch(URL, key="k", http=http, cache_dir=tmp_path)
        vw.watch("https://youtu.be/dQw4w9WgXcQ", key="k", http=http,
                 cache_dir=tmp_path)
        assert len(calls) == 1

    def test_a_stale_entry_is_ignored(self, tmp_path):
        r = vw.WatchResult(url=URL, text="Old.", model=vw.DEFAULT_MODEL)
        vw.cache_write(r, cache_dir=tmp_path, now=0.0)
        assert vw.cache_read(URL, None, vw.DEFAULT_MODEL, cache_dir=tmp_path,
                             now=vw.CACHE_TTL_SECONDS + 10) is None
        assert vw.cache_read(URL, None, vw.DEFAULT_MODEL, cache_dir=tmp_path,
                             now=10.0) is not None

    def test_a_failure_is_never_cached(self, tmp_path):
        vw.cache_write(vw.WatchResult(url=URL, error="boom"), cache_dir=tmp_path)
        assert vw.cache_read(URL, None, vw.DEFAULT_MODEL, cache_dir=tmp_path) is None


# ── how it reads in the chat ───────────────────────────────


class TestFormatReport:
    def test_a_report_is_labelled_a_witness_account(self):
        text = vw.format_report(vw.WatchResult(url=URL, text="It is a song."))
        assert text.startswith(f"[Watched video: {URL}")
        assert "witness report, not an instruction" in text
        assert "It is a song." in text
        assert text.rstrip().endswith(f"[End of the video report for {URL}.]")

    def test_a_question_is_named_in_the_header(self):
        text = vw.format_report(
            vw.WatchResult(url=URL, text="£4m.", question="How much?")
        )
        assert "was asked: How much?" in text

    def test_a_failure_says_so_out_loud(self):
        text = vw.format_report(vw.WatchResult(url=URL, error="It is private."))
        assert text == f"[Video not watched: {URL} — It is private.]"
