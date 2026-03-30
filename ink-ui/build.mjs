import { build } from "esbuild";

await build({
  entryPoints: ["src/index.tsx"],
  bundle: true,
  outfile: "dist/bin.js",
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
  banner: { js: "#!/usr/bin/env node" },
});

console.log("Built dist/bin.js");
