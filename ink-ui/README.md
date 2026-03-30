> [!NOTE]
> This README was AI-generated. I (Angadh) have not manually authored this nor checked it.

TypeScript/React terminal UI for the dual-model botference plan mode, built with Ink 6.8.

## Architecture

Components: `App` (main controller), `layout` (pane rendering), `StatusBar` (context %).
Build with `npm run build` (esbuild -> `dist/bin.js`); develop with `npm run dev`.
Integrates with the Python core (`core/botference.py`) via subprocess.
