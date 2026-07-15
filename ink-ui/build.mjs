import { build } from "esbuild";
import { chmodSync, writeFileSync } from "node:fs";

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  outfile: "dist/main.js",
  format: "esm",
  platform: "node",
  target: "node18",
  jsx: "automatic",
  external: [
    // Keep npm deps external — node_modules resolves at runtime
    "ink",
    "react",
    "react/jsx-runtime",
    "wrap-ansi",
    "string-width",
  ],
});

// dist/bin.js is a tiny loader whose only job is to pin NODE_ENV before any
// React module is evaluated. react-reconciler picks its dev or prod build by
// reading NODE_ENV at import time; the dev build records a
// performance.measure() (with a props-diff payload) for every component
// render, and Node retains every user-timing entry for the life of the
// process — on long sessions that leaked ~1MB/s while re-rendering and
// OOM-crashed the TUI at the 4GB heap ceiling. ESM imports are hoisted, so
// the env pin cannot live in the same module as the imports — hence this
// wrapper with a dynamic import.
const wrapper = `#!/usr/bin/env node
if (!process.env.NODE_ENV) process.env.NODE_ENV = "production";
await import("./main.js");
`;
writeFileSync("dist/bin.js", wrapper);
chmodSync("dist/bin.js", 0o755);

console.log("Built dist/main.js + dist/bin.js");
