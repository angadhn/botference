# CLAUDE.md

- **TUI app**: `core/` (Python controller + CLI adapters + bridge) and `ink-ui/` (Ink/React terminal UI; build with `npm run build` in `ink-ui/`). Launcher: `./botference` + `lib/*.sh`. Tests: `pytest tests/` and `npm test` in `ink-ui/`.
- **Website** (botference.com): `site/` — static HTML, auto-deploys to GitHub Pages on push.
- **No desktop app exists.** Possibly worth building one (the controller is headless; only the Ink frontend would need replacing).
