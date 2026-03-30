# Task 9 Summary — Update help text and tests

## What was done
1. Added `/relay @claude|@codex` to `_show_help()` in the Commands section
2. Added an Aliases line documenting `/relay-claude`, `/relay-codex`, `/tag @claude`, `/tag @codex`
3. Added `test_help_documents_relay` — verifies help text mentions both `/relay` and `/tag`
4. Added `test_sequential_relay_both_models` — relays claude then codex, confirms both sessions torn down, both live handoff files written
5. Added `test_sequential_relay_second_skips_cross` — relays claude first, then codex at cross-tier pressure; confirms cross tier is skipped (peer torn down) and mechanical tier is used

## Files changed
- `core/council.py` — help text additions (2 lines)
- `tests/test_council.py` — 3 new tests (help + 2 sequential relay)

## Test results
- 372 tests pass, 0 failures
- Pre-existing coverage from tasks 2-8 already covered: parsing (all forms), tier selection, self/cross/mechanical relay, cross fallback when peer not initialized, relay state reset, safe handoff retention on bootstrap failure, handoff deletion on success, pre/post-relay history filtering, archive sweep

## Coverage audit against task 9 requirements
| Required test | Status | Test name |
|---|---|---|
| Parsing — all relay command forms | ✅ (task 2) | TestRelayParsing (14 tests) |
| Tier selection | ✅ (task 5) | test_self_authored_relay_success, test_cross_authored_relay, test_self_fails_falls_to_mechanical |
| Self relay | ✅ (task 5) | test_self_authored_relay_success, test_self_authored_relay_codex |
| Cross relay | ✅ (task 5) | test_cross_authored_relay, test_fallthrough_self_to_cross |
| Cross fallback to mechanical (peer not init'd) | ✅ (task 5) | test_cross_skipped_when_peer_not_initialized |
| Relay state reset | ✅ (task 5) | test_relay_warned_overlimit_cleared, test_relay_pending_draft_warning |
| Safe handoff retention on bootstrap failure | ✅ (task 7) | test_bootstrap_retains_handoff_on_failure, test_ensure_initialized_retains_handoff_on_failure |
| Handoff deletion after successful bootstrap | ✅ (task 7) | test_bootstrap_consumes_handoff_on_success, test_ensure_initialized_consumes_handoff |
| Post-relay bootstrap excludes pre-relay history | ✅ (task 7) | test_bootstrap_excludes_pre_relay_history |
| Post-relay bootstrap includes post-relay history | ✅ (task 7) | test_bootstrap_includes_post_relay_history |
| Sequential relay both models | ✅ (task 9) | test_sequential_relay_both_models |
| Sequential — second can't use cross tier | ✅ (task 9) | test_sequential_relay_second_skips_cross |
| Archive — handoff history sweep | ✅ (task 8) | test_archive_moves_handoff_history |
| Archive — live-file clearing | ✅ (task 8) | test_archive_clears_live_handoff_files, test_archive_succeeds_without_handoff_files |
| Help text documents /relay | ✅ (task 9) | test_help_documents_relay |
