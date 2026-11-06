#!/usr/bin/env node
// Bundles the standalone worker (src/worker/main.ts) into dist/worker.mjs: one ESM file for
// Node 22, no Next.js, no database. Fails if `server-only` (or anything else panel-only) ends up
// in the bundle — the worker would crash at import time on a pool machine.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTFILE = path.join(ROOT, "dist", "worker.mjs");
/** Packages that only work inside the panel (Next.js server). */
const FORBIDDEN = ["server-only", "next", "react", "react-dom"];

const packageOf = (input) => {
  const marker = "node_modules/";
  const at = input.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = input.slice(at + marker.length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

mkdirSync(path.dirname(OUTFILE), { recursive: true });
const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ["src/worker/main.ts"],
  outfile: OUTFILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // `@/` comes from tsconfig.json "paths"; esbuild reads it from the tsconfig below.
  tsconfig: path.join(ROOT, "tsconfig.json"),
  // Some CommonJS dependencies call require() for Node builtins; give the ESM bundle a require.
  banner: { js: 'import { createRequire as __carbonCreateRequire } from "node:module";\nconst require = __carbonCreateRequire(import.meta.url);' },
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

const inputs = Object.keys(result.metafile.inputs);
const leaked = [...new Set(inputs.map(packageOf).filter((name) => name && FORBIDDEN.includes(name)))];
const serverFiles = inputs.filter((input) => !input.includes("node_modules/") && /(^|\/)src\/(app|server\/(db|repo|runner|auth))\//.test(input));
if (leaked.length > 0 || serverFiles.length > 0) {
  console.error(`build:worker falhou: o bundle importa código do painel: ${[...leaked, ...serverFiles].join(", ")}`);
  process.exit(1);
}
const bytes = result.metafile.outputs[path.relative(ROOT, OUTFILE)]?.bytes ?? 0;
console.log(`dist/worker.mjs gerado (${(bytes / 1024).toFixed(0)} KB, ${inputs.length} módulos)`);
