"""
handoff.py — Handoff document schema, validation, and serialization.

A handoff is YAML frontmatter + Markdown body.  The controller generates
handoff content and validates it before writing to disk.  Invalid handoffs
are rejected so the relay flow can fall through to the next generation tier.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Optional


# ── Schema constants ──────────────────────────────────────

REQUIRED_FRONTMATTER_KEYS = frozenset({
    "model",
    "session_id",
    "created",
    "room_mode",
    "lead",
    "yield_pct",
    "context_tokens",
    "context_window",
    "generation_tier",
})

VALID_MODELS = frozenset({"claude", "codex"})
VALID_ROOM_MODES = frozenset({"public", "caucus", "draft", "review"})
VALID_LEADS = frozenset({"auto", "@claude", "@codex"})
VALID_TIERS = frozenset({"self", "cross", "mechanical"})

# Ordered list — validation checks headings appear in this order and
# each appears exactly once.
REQUIRED_HEADINGS = [
    "Objective",
    "Resolved Decisions",
    "Open Questions",
    "Positions In Play",
    "Converging",
    "Contested",
    "Constraints",
    "Current Thread",
    "Response Obligation",
    "Decision Criteria",
    "Next Action",
]

# ── Frontmatter parsing ──────────────────────────────────

_FRONTMATTER_RE = re.compile(
    r"\A---[ \t]*\n(.*?\n)---[ \t]*\n",
    re.DOTALL,
)


def _parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """Split YAML frontmatter from Markdown body.

    Returns (frontmatter_dict, body).  Uses simple key: value parsing —
    no PyYAML dependency needed for flat string/number fields.
    """
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return {}, text

    fm_block = m.group(1)
    body = text[m.end():]

    fm: dict[str, str] = {}
    for line in fm_block.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        colon = line.find(":")
        if colon < 1:
            continue
        key = line[:colon].strip()
        val = line[colon + 1:].strip()
        fm[key] = val
    return fm, body


# ── Heading extraction ────────────────────────────────────

_HEADING_RE = re.compile(r"^(#{2,3})\s+(.+)$", re.MULTILINE)


def _extract_headings(body: str) -> list[str]:
    """Return all ## and ### heading texts from the Markdown body."""
    return [m.group(2).strip() for m in _HEADING_RE.finditer(body)]


# ── Validation ────────────────────────────────────────────

@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    errors: list[str]


def validate_handoff(text: str) -> ValidationResult:
    """Validate a handoff document against the schema.

    Returns a ValidationResult with valid=True if the document passes
    all checks, or valid=False with a list of error descriptions.
    """
    errors: list[str] = []

    # -- Frontmatter --
    fm, body = _parse_frontmatter(text)
    if not fm:
        errors.append("Missing or malformed YAML frontmatter")
        return ValidationResult(valid=False, errors=errors)

    missing_keys = REQUIRED_FRONTMATTER_KEYS - fm.keys()
    if missing_keys:
        errors.append(
            f"Missing frontmatter keys: {', '.join(sorted(missing_keys))}"
        )

    # Value validation for present keys
    if "model" in fm and fm["model"] not in VALID_MODELS:
        errors.append(
            f"Invalid model '{fm['model']}': must be one of {sorted(VALID_MODELS)}"
        )
    if "room_mode" in fm and fm["room_mode"] not in VALID_ROOM_MODES:
        errors.append(
            f"Invalid room_mode '{fm['room_mode']}': must be one of {sorted(VALID_ROOM_MODES)}"
        )
    if "lead" in fm and fm["lead"] not in VALID_LEADS:
        errors.append(
            f"Invalid lead '{fm['lead']}': must be one of {sorted(VALID_LEADS)}"
        )
    if "generation_tier" in fm and fm["generation_tier"] not in VALID_TIERS:
        errors.append(
            f"Invalid generation_tier '{fm['generation_tier']}': "
            f"must be one of {sorted(VALID_TIERS)}"
        )

    # Numeric fields
    for nkey in ("yield_pct", "context_tokens", "context_window"):
        if nkey in fm:
            try:
                float(fm[nkey])
            except ValueError:
                errors.append(f"Frontmatter '{nkey}' must be numeric, got '{fm[nkey]}'")

    # -- Body headings --
    headings = _extract_headings(body)
    for required in REQUIRED_HEADINGS:
        count = headings.count(required)
        if count == 0:
            errors.append(f"Missing required heading: ## {required}")
        elif count > 1:
            errors.append(
                f"Duplicate heading: ## {required} (appears {count} times)"
            )

    return ValidationResult(valid=len(errors) == 0, errors=errors)


# ── Frontmatter builder ──────────────────────────────────

def build_frontmatter(
    model: str,
    session_id: str,
    created: str,
    room_mode: str,
    lead: str,
    yield_pct: float,
    context_tokens: int,
    context_window: int,
    generation_tier: str,
) -> str:
    """Build the YAML frontmatter block for a handoff document."""
    return (
        f"---\n"
        f"model: {model}\n"
        f"session_id: {session_id}\n"
        f"created: {created}\n"
        f"room_mode: {room_mode}\n"
        f"lead: {lead}\n"
        f"yield_pct: {yield_pct}\n"
        f"context_tokens: {context_tokens}\n"
        f"context_window: {context_window}\n"
        f"generation_tier: {generation_tier}\n"
        f"---\n"
    )
