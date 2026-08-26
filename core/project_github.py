"""
project_github.py - Publish a project's folder to a NEW PRIVATE GitHub repo.

A project is already a durable folder on disk (``projects/<id>/``): notes,
PROJECT.md, TASKS.md, whatever the bots wrote there. This module turns that
folder into a git repo and pushes it to a private repo on GitHub, using the
``gh`` CLI's own auth — Botference never sees a token.

Everything that touches the outside world goes through the *run* callable, so
tests drive the whole flow with a mock ``gh``/``git`` and no network, no repo.
The rule the tests enforce: **nothing is created without a confirmed name**,
and a failure at any step reports which step failed rather than leaving the
caller guessing.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Sequence


# GitHub's own repo-name rules: letters, digits, '.', '-', '_'. Anything else
# in a project title becomes a hyphen, and a run of them collapses.
_NAME_CLEAN = re.compile(r"[^a-zA-Z0-9._-]+")
_NAME_DASHES = re.compile(r"-{2,}")

REPO_NAME_MAX = 100


@dataclass(frozen=True)
class RunResult:
    code: int
    stdout: str = ""
    stderr: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0

    @property
    def message(self) -> str:
        text = (self.stderr or "").strip() or (self.stdout or "").strip()
        return " ".join(text.split())[:400]


Runner = Callable[[Sequence[str], Path], RunResult]


def default_runner(argv: Sequence[str], cwd: Path) -> RunResult:
    """Run a command for real. Replaced wholesale in tests."""
    try:
        proc = subprocess.run(
            list(argv),
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=180,
        )
    except FileNotFoundError:
        return RunResult(127, "", f"{argv[0]}: not found")
    except subprocess.TimeoutExpired:
        return RunResult(124, "", f"{argv[0]}: timed out")
    except OSError as exc:  # pragma: no cover - defensive
        return RunResult(1, "", str(exc))
    return RunResult(proc.returncode, proc.stdout or "", proc.stderr or "")


def slugify_repo_name(title: str, *, fallback: str = "botference-project") -> str:
    """Turn a project title into a GitHub-legal repo name.

    Not the same slug as the project id: GitHub allows dots and underscores,
    and rejects names that are only punctuation.
    """
    name = _NAME_CLEAN.sub("-", str(title or "").strip())
    name = _NAME_DASHES.sub("-", name).strip("-._")
    name = name[:REPO_NAME_MAX].strip("-._")
    return name or fallback


@dataclass
class PublishOutcome:
    """What happened, in words the UI can print unchanged."""

    ok: bool
    url: str = ""
    #: 'created' (new repo), 'pushed' (existing remote), or '' on failure.
    action: str = ""
    error: str = ""
    #: Short step name that failed — 'gh-missing', 'gh-auth', 'git-init', …
    step: str = ""
    steps: list[str] = field(default_factory=list)


_URL_RE = re.compile(r"https://[^\s'\"]+")


def _first_url(*texts: str) -> str:
    for text in texts:
        match = _URL_RE.search(text or "")
        if match:
            return match.group(0).rstrip(".,)")
    return ""


def preflight(*, run: Runner = default_runner, cwd: Path | None = None) -> PublishOutcome:
    """Is ``gh`` installed and logged in? Cheap, read-only, no side effects.

    Used to grey the action out (or explain it) before anyone confirms
    anything, because "create a repo" failing halfway is much worse than
    "you are not logged in" failing immediately.
    """
    here = Path(cwd or Path.cwd())
    if shutil.which("gh") is None:
        return PublishOutcome(
            ok=False,
            step="gh-missing",
            error=(
                "The GitHub CLI (gh) is not installed. "
                "Install it (brew install gh) and run `gh auth login`."
            ),
        )
    status = run(["gh", "auth", "status"], here)
    if not status.ok:
        return PublishOutcome(
            ok=False,
            step="gh-auth",
            error=(
                "The GitHub CLI is installed but not logged in. "
                "Run `gh auth login`, then try again."
            ),
        )
    return PublishOutcome(ok=True, step="ready")


def publish_project(
    project_root: Path,
    repo_name: str,
    *,
    run: Runner = default_runner,
    private: bool = True,
) -> PublishOutcome:
    """Make ``project_root`` a git repo and push it to GitHub.

    Three shapes of starting point, all handled:

    * **not a repo** — ``git init``, commit everything, then
      ``gh repo create <name> --private --source . --push``.
    * **a repo with no ``origin``** — commit anything outstanding, then the
      same ``gh repo create --source . --push``: gh adds the remote itself.
    * **a repo that already has ``origin``** — nothing is created. We push the
      current branch and report the existing remote's URL. Creating a second
      repo for a folder that already has one is the destructive surprise this
      whole function exists to avoid.

    *private* is a keyword and defaults to True; no caller in Botference
    passes False. It exists so a future "publish this publicly" is an argument
    rather than a copy of this function.
    """
    root = Path(project_root)
    steps: list[str] = []

    def fail(step: str, result: RunResult, hint: str = "") -> PublishOutcome:
        detail = result.message or f"exit {result.code}"
        return PublishOutcome(
            ok=False,
            step=step,
            error=f"{hint or step}: {detail}".strip(": "),
            steps=steps,
        )

    if not root.is_dir():
        return PublishOutcome(
            ok=False,
            step="no-folder",
            error=f"{root} is not a folder — nothing to publish.",
        )

    name = slugify_repo_name(repo_name)
    if not name:
        return PublishOutcome(
            ok=False, step="bad-name", error="A repository name is required.",
        )

    ready = preflight(run=run, cwd=root)
    if not ready.ok:
        return ready

    is_repo = (root / ".git").exists()
    if not is_repo:
        result = run(["git", "init"], root)
        if not result.ok:
            return fail("git-init", result, "Could not create a git repo here")
        steps.append("git init")

    # A repo with no commits cannot be pushed, and `gh repo create --push`
    # does not commit for you. Stage-and-commit is idempotent: with a clean
    # tree `git commit` exits non-zero saying "nothing to commit", which is
    # success as far as we are concerned.
    add = run(["git", "add", "-A"], root)
    if not add.ok:
        return fail("git-add", add, "Could not stage the project files")
    commit = run(
        ["git", "commit", "-m", "Botference project snapshot"], root,
    )
    if commit.ok:
        steps.append("commit")
    else:
        head = run(["git", "rev-parse", "--verify", "HEAD"], root)
        if not head.ok:
            # Nothing staged AND no commit exists: the folder is empty.
            return PublishOutcome(
                ok=False,
                step="empty",
                error=(
                    "There is nothing to commit in this project folder yet. "
                    "Add a file (PROJECT.md, notes) and try again."
                ),
                steps=steps,
            )
        steps.append("already committed")

    remote = run(["git", "remote", "get-url", "origin"], root)
    if remote.ok and remote.stdout.strip():
        existing = remote.stdout.strip()
        push = run(["git", "push", "-u", "origin", "HEAD"], root)
        if not push.ok:
            return fail("git-push", push, "Could not push to the existing remote")
        steps.append("push")
        return PublishOutcome(
            ok=True,
            url=_normalize_remote(existing),
            action="pushed",
            step="pushed",
            steps=steps,
        )

    argv = ["gh", "repo", "create", name, "--source", ".", "--push"]
    argv.insert(4, "--private" if private else "--public")
    created = run(argv, root)
    if not created.ok:
        return fail("gh-create", created, "GitHub refused to create the repo")
    steps.append("gh repo create")
    url = _first_url(created.stdout, created.stderr)
    if not url:
        after = run(["git", "remote", "get-url", "origin"], root)
        url = _normalize_remote(after.stdout.strip()) if after.ok else ""
    return PublishOutcome(ok=True, url=url, action="created", step="created", steps=steps)


def _normalize_remote(remote: str) -> str:
    """git@github.com:me/x.git and https://…/x.git → a browsable https URL."""
    remote = (remote or "").strip()
    if not remote:
        return ""
    if remote.startswith("git@"):
        host, _, path = remote.partition(":")
        host = host.split("@", 1)[-1]
        remote = f"https://{host}/{path}"
    if remote.endswith(".git"):
        remote = remote[: -len(".git")]
    return remote
