# Cutover runbook — 2026-05-30 fix

These changes are committed on `main` but **only take effect on the next app start**.
The currently-running session loaded its code/`dist` at launch and is unaffected until
you restart. Do the cutover at a natural stopping point.

## Why a restart is needed
- The ink UI runs the bundled `ink-ui/dist/bin.js` loaded at launch.
- The Python bridge imported `core/*.py` into memory at launch.
Editing/rebuilding source on disk does not reach the running process — only a relaunch does.

## Steps

1. **Checkpoint your work**, then quit botference cleanly with **Ctrl+C** in the app.
   Ctrl+C runs the terminal-restore (mouse mode, cursor, alt-screen) *and* persists the
   session. Avoid `kill -9` — it skips both.

2. **Un-wedge the existing session** (only after the app is fully quit):
   ```sh
   cd /Users/angadhnanjangud/MySiteFromObsidianVault/botference-main
   python scripts/unwedge_session.py
   ```
   It defaults to the wedged `ec53fd69…` session, makes a timestamped `.bak`, clears the
   stuck relay handoff, resets stale yield pressure, and trims oversized tool output. It
   **refuses to run while botference is live** (process + recent-mtime guards); if it
   refuses, the app is still running — quit it first.
   - Other session: pass the path — `python scripts/unwedge_session.py /path/to/session.json`
   - Options: `--no-trim-tools`, `--no-backup`, `--force` (override guards — unsafe).

3. **Rebuild the ink UI** (picks up the mouse/render/reload changes):
   ```sh
   cd ink-ui && node build.mjs && cd ..
   ```

4. **Relaunch**:
   ```sh
   ./botference plan
   ```
   Expected: the chat loads in one shot (no slow stream-in), typing stays responsive while
   bots work, trackpad scroll no longer selects text or emits gibberish, and a session that
   approaches its context limit relays cleanly (or prompts you to `/relay`) instead of wedging.

## Rollback
- Code: `git log --oneline` to find the pre-fix commit, then `git revert <range>` (or
  `git checkout <sha> -- <files>`), and rebuild ink-ui.
- Session: every `unwedge_session.py` run leaves a `…json.bak-<timestamp>` next to the
  session file — copy it back over the `.json` (while the app is quit) to restore.

## Verify (optional)
```sh
cd ink-ui && npx tsc --noEmit && node test.mjs            # 116 pass
cd .. && python -m pytest -q                              # 567 pass
```
