> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

Utility scripts for iteration lifecycle and metrics.

| Script | Purpose |
|--------|---------|
| `archive.sh` | Archives completed thread state into the resolved archive directory (`botference/archive/` in project-local mode, `archive/` in legacy mode) |
| `evaluate_iteration.py` | Post-iteration metric collection -- tokens, costs, file changes, quality gates |
| `extract_session_usage.py` | Extracts token usage from Claude CLI session JSONL files |
| `update_loc_badge.py` | Counts tracked source lines and writes `docs/badges/loc.json` for the README badge |
