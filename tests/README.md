> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

Test suite. Run with `pytest` from the repo root.

| Test file | Covers |
|-----------|--------|
| `test_botference.py` | `botference.py` — parsing, routing, transcripts, caucus footer |
| `test_botference_ui.py` | `botference_ui.py` — TUI panes, status line, transcript rendering |
| `test_cli_adapters.py` | `cli_adapters.py` — fixture-driven adapter parsing and session logic |
| `test_handoff.py` | `handoff.py` — schema, validation, serialization, relay |
| `test_paths.py` | `paths.py` — path resolution, work prefixes, handoff paths |
| `test_room_prompts.py` | `room_prompts.py` — prompt template assembly |

Fixtures live in `tests/fixtures/`.
