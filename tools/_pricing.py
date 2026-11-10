"""Price table for Anthropic and OpenAI models, per million tokens.

The numbers live in core/model_catalog.py (the one model list). This module
keeps the old name ``PRICING`` for importers: id -> {input, output,
cache_read, cache_create}, holding ONLY the models whose price is known.

A model missing from PRICING has price "not known". Callers must say so
(``cost_usd`` below returns None) and never substitute another model's price.
"""

import sys
from pathlib import Path

_CORE_DIR = str(Path(__file__).resolve().parent.parent / "core")
if _CORE_DIR not in sys.path:
    sys.path.insert(0, _CORE_DIR)

import model_catalog  # noqa: E402

PRICING = model_catalog.builtin_prices()


def cost_usd(model, input_tokens, output_tokens, cache_read_tokens=0, cache_create_tokens=0):
    """Dollar cost rounded to 6 places, or None when the model's price is not known."""
    prices = PRICING.get(model)
    if prices is None:
        return None
    return round(
        (input_tokens * prices["input"]
         + output_tokens * prices["output"]
         + cache_read_tokens * prices["cache_read"]
         + cache_create_tokens * prices["cache_create"]) / 1_000_000,
        6,
    )
