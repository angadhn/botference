"""Helpers for redacting secret-like content from logs and exported artifacts."""

from __future__ import annotations

import re


_PEM_BLOCK_RE = re.compile(
    r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    re.DOTALL,
)

_JSON_SECRET_RE = re.compile(
    r'("(?:(?:access|refresh)_token|accessToken|refreshToken|api_key|openai_api_key|'
    r'client_secret|auth_token|authorization|token|secret)")(\s*:\s*)"([^"]+)"',
    re.IGNORECASE,
)

_ENV_SECRET_RE = re.compile(
    r"(?m)\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD))=([^\s\"']+)"
)

_TOKEN_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"),
    re.compile(r"sk-proj-[A-Za-z0-9_-]{10,}"),
    re.compile(r"sk-[A-Za-z0-9_-]{20,}"),
    re.compile(r"Bearer\s+[A-Za-z0-9._-]{20,}", re.IGNORECASE),
    re.compile(r"ghp_[A-Za-z0-9]{36,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
]


def redact_text(text: str) -> str:
    """Replace secret-like substrings with redacted placeholders."""
    if not text:
        return text

    redacted = _PEM_BLOCK_RE.sub("[REDACTED PRIVATE KEY]", text)
    redacted = _JSON_SECRET_RE.sub(r'\1\2"[REDACTED]"', redacted)
    redacted = _ENV_SECRET_RE.sub(r"\1=[REDACTED]", redacted)
    for pattern in _TOKEN_PATTERNS:
        redacted = pattern.sub("[REDACTED]", redacted)
    return redacted


def preview_text(text: str, limit: int = 200) -> str:
    """Return a redacted preview, appending an ellipsis if truncated."""
    raw = text or ""
    suffix = "..." if len(raw) > limit else ""
    return redact_text(raw[:limit]) + suffix
