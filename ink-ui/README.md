> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

TypeScript/React terminal UI for the dual-model botference plan mode, built with Ink 6.8.

## Architecture

Components: `App` (main controller), `layout` (pane rendering), `StatusBar` (context %).
Build with `npm run build` (esbuild -> `dist/main.js`, plus a `dist/bin.js`
loader that pins `NODE_ENV=production` before React loads — the dev
reconciler floods Node's unbounded user-timing buffer); develop with `npm run dev`.
Integrates with the Python core (`core/botference.py`) via subprocess.
