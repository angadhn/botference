"""Shared pricing table for Anthropic and OpenAI models.

Single source of truth — imported by botference_agent.py and scripts/usage_report.py.
"""

# Per-million-token pricing
# Anthropic: https://docs.anthropic.com/en/docs/about-claude/models
# OpenAI:    https://platform.openai.com/docs/pricing
PRICING = {
    # Anthropic
    "claude-opus-4-6":   {"input": 15.0, "output": 75.0, "cache_read": 1.5,  "cache_create": 18.75},
    "claude-sonnet-4-6": {"input": 3.0,  "output": 15.0, "cache_read": 0.3,  "cache_create": 3.75},
    "claude-haiku-4-5":  {"input": 0.8,  "output": 4.0,  "cache_read": 0.08, "cache_create": 1.0},
    # OpenAI — GPT-5.4 (high thinking) is the recommended model
    "gpt-5.4":           {"input": 2.5,  "output": 15.0, "cache_read": 0.25, "cache_create": 0},
    "gpt-4o":            {"input": 2.5,  "output": 10.0, "cache_read": 0, "cache_create": 0},
    "gpt-4o-mini":       {"input": 0.15, "output": 0.6,  "cache_read": 0, "cache_create": 0},
    "o3":                {"input": 10.0, "output": 40.0, "cache_read": 0, "cache_create": 0},
    "o4-mini":           {"input": 1.1,  "output": 4.4,  "cache_read": 0, "cache_create": 0},
}
