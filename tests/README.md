> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

Test suite. Run with `pytest` from the repo root.

| Test file | Covers |
|-----------|--------|
| `test_botference.py` | `botference.py` — parsing, routing, transcripts, room footer, free-form threads |
| `test_cli_adapters.py` | `cli_adapters.py` — fixture-driven adapter parsing and session logic |
| `test_handoff.py` | `handoff.py` — schema, validation, serialization, relay |
| `test_paths.py` | `paths.py` — path resolution, work prefixes, handoff paths |
| `test_room_prompts.py` | `room_prompts.py` — prompt template assembly |
| `review-engine.test.mjs` | review engine (detect + build + server) on generated single-file and multi-file fixture papers — run with `node --test tests/review-engine.test.mjs` (needs pandoc) |

Fixtures live in `tests/fixtures/`.
