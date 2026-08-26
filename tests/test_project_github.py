"""Publishing a project folder to a NEW PRIVATE GitHub repo.

NOTHING HERE TOUCHES GITHUB. Every `gh` and `git` invocation goes through a
recording fake, so the suite proves the choreography — which command, in which
order, with which arguments, and what is refused before anything is created —
without a network, an account, or a repository that would then have to be
deleted by hand.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "core"))

from project_github import (  # noqa: E402
    RunResult,
    preflight,
    publish_project,
    slugify_repo_name,
)


class FakeGh:
    """A recording stand-in for gh/git. `answers` maps a command prefix to a
    RunResult; anything unlisted succeeds silently, which is what the happy
    path of git looks like."""

    def __init__(self, answers=None):
        self.calls: list[list[str]] = []
        self.answers = answers or {}

    def __call__(self, argv, cwd) -> RunResult:
        argv = list(argv)
        self.calls.append(argv)
        for prefix, result in self.answers.items():
            if argv[: len(prefix)] == list(prefix):
                return result
        return RunResult(0, "", "")

    @property
    def words(self) -> list[str]:
        return [" ".join(c) for c in self.calls]


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "projects" / "adrianas-paper"
    root.mkdir(parents=True)
    (root / "PROJECT.md").write_text("# Adriana's paper\n", encoding="utf-8")
    return root


@pytest.fixture
def gh_on_path(monkeypatch):
    monkeypatch.setattr("project_github.shutil.which", lambda name: "/fake/bin/gh")


class TestRepoNames:
    def test_a_title_becomes_a_github_legal_name(self):
        assert slugify_repo_name("Adriana's paper") == "Adriana-s-paper"
        assert slugify_repo_name("  spaces   everywhere  ") == "spaces-everywhere"
        assert slugify_repo_name("dots.and_underscores-ok") == "dots.and_underscores-ok"

    def test_a_name_of_pure_punctuation_falls_back(self):
        # GitHub rejects it, so we never send it.
        assert slugify_repo_name("!!!") == "botference-project"
        assert slugify_repo_name("", fallback="my-project") == "my-project"

    def test_the_name_is_bounded(self):
        assert len(slugify_repo_name("x" * 500)) == 100


class TestPreflight:
    def test_no_gh_is_a_sentence_the_reader_can_act_on(self, monkeypatch, project):
        monkeypatch.setattr("project_github.shutil.which", lambda name: None)
        out = preflight(run=FakeGh(), cwd=project)
        assert not out.ok
        assert out.step == "gh-missing"
        assert "gh auth login" in out.error

    def test_gh_installed_but_logged_out_says_so(self, gh_on_path, project):
        fake = FakeGh({("gh", "auth", "status"): RunResult(1, "", "not logged in")})
        out = preflight(run=fake, cwd=project)
        assert not out.ok
        assert out.step == "gh-auth"
        assert "gh auth login" in out.error

    def test_preflight_creates_nothing(self, gh_on_path, project):
        fake = FakeGh()
        assert preflight(run=fake, cwd=project).ok
        assert fake.words == ["gh auth status"], "read-only, and only that"


class TestPublishing:
    def test_a_plain_folder_becomes_a_new_private_repo(self, gh_on_path, project):
        fake = FakeGh({
            ("gh", "repo", "create"): RunResult(
                0, "https://github.com/me/adrianas-paper\n", "",
            ),
        })
        out = publish_project(project, "adrianas-paper", run=fake)
        assert out.ok
        assert out.action == "created"
        assert out.url == "https://github.com/me/adrianas-paper"
        assert fake.words == [
            "gh auth status",
            "git init",
            "git add -A",
            "git commit -m Botference project snapshot",
            "git remote get-url origin",
            "gh repo create adrianas-paper --private --source . --push",
        ]

    def test_private_is_not_optional_in_practice(self, gh_on_path, project):
        fake = FakeGh()
        publish_project(project, "x", run=fake)
        create = next(c for c in fake.calls if c[:3] == ["gh", "repo", "create"])
        assert "--private" in create
        assert "--public" not in create

    def test_a_folder_that_is_already_a_repo_is_not_re_initialised(
        self, gh_on_path, project,
    ):
        (project / ".git").mkdir()
        fake = FakeGh()
        assert publish_project(project, "x", run=fake).ok
        assert "git init" not in fake.words

    def test_a_repo_that_already_has_an_origin_creates_NOTHING(
        self, gh_on_path, project,
    ):
        # The one destructive surprise this function exists to avoid: a second
        # repo for a folder that already has one. We push to the remote it has
        # and report that remote's URL.
        (project / ".git").mkdir()
        fake = FakeGh({
            ("git", "remote", "get-url", "origin"): RunResult(
                0, "git@github.com:me/already-there.git\n", "",
            ),
        })
        out = publish_project(project, "a-different-name", run=fake)
        assert out.ok
        assert out.action == "pushed"
        assert out.url == "https://github.com/me/already-there"
        assert not any(c[:3] == ["gh", "repo", "create"] for c in fake.calls)
        assert "git push -u origin HEAD" in fake.words

    def test_a_clean_tree_with_a_commit_already_in_it_still_publishes(
        self, gh_on_path, project,
    ):
        # `git commit` exits non-zero on "nothing to commit", which is success
        # as far as publishing is concerned — as long as a commit exists.
        fake = FakeGh({
            ("git", "commit"): RunResult(1, "nothing to commit", ""),
            ("git", "rev-parse"): RunResult(0, "abc123\n", ""),
        })
        out = publish_project(project, "x", run=fake)
        assert out.ok
        assert out.action == "created"

    def test_an_empty_folder_is_refused_before_anything_is_created(
        self, gh_on_path, project,
    ):
        fake = FakeGh({
            ("git", "commit"): RunResult(1, "nothing to commit", ""),
            ("git", "rev-parse"): RunResult(128, "", "unknown revision HEAD"),
        })
        out = publish_project(project, "x", run=fake)
        assert not out.ok
        assert out.step == "empty"
        assert "nothing to commit" in out.error
        assert not any(c[:3] == ["gh", "repo", "create"] for c in fake.calls)

    def test_a_refusal_from_github_is_reported_in_githubs_own_words(
        self, gh_on_path, project,
    ):
        fake = FakeGh({
            ("gh", "repo", "create"): RunResult(
                1, "", "GraphQL: Name already exists on this account",
            ),
        })
        out = publish_project(project, "taken", run=fake)
        assert not out.ok
        assert out.step == "gh-create"
        assert "Name already exists" in out.error

    def test_a_missing_folder_is_not_an_exception(self, gh_on_path, tmp_path):
        out = publish_project(tmp_path / "nope", "x", run=FakeGh())
        assert not out.ok
        assert out.step == "no-folder"

    def test_the_url_is_recovered_from_the_remote_when_gh_prints_none(
        self, gh_on_path, project,
    ):
        seen = {"n": 0}

        def run(argv, cwd):
            argv = list(argv)
            if argv[:4] == ["git", "remote", "get-url", "origin"]:
                seen["n"] += 1
                # empty before gh creates the repo, set afterwards
                if seen["n"] == 1:
                    return RunResult(1, "", "no such remote")
                return RunResult(0, "https://github.com/me/quiet.git\n", "")
            return RunResult(0, "", "")

        out = publish_project(project, "quiet", run=run)
        assert out.ok
        assert out.url == "https://github.com/me/quiet"
