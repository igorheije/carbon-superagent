#!/usr/bin/env node
// Bundles the standalone worker entrypoints into single ESM files for Node 22, no Next.js, no
// database: src/worker/main.ts → dist/worker.mjs (pool machines, `carbon worker`) and
// src/worker/agentcore-entry.ts → dist/agentcore.mjs (AgentCore Runtime container). Fails if
// `server-only` (or anything else panel-only) ends up in a bundle — it would crash at import time.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGETS = [
  { entry: "src/worker/main.ts", outfile: path.join(ROOT, "dist", "worker.mjs") },
  { entry: "src/worker/agentcore-entry.ts", outfile: path.join(ROOT, "dist", "agentcore.mjs") },
];
/** Packages that only work inside the panel (Next.js server). */
const FORBIDDEN = ["server-only", "next", "react", "react-dom"];

const packageOf = (input) => {
  const marker = "node_modules/";
  const at = input.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = input.slice(at + marker.length).split("/");
  return parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
};

async function bundle({ entry, outfile }) {
  mkdirSync(path.dirname(outfile), { recursive: true });
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: [entry],
    outfile,
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
  const name = path.relative(ROOT, outfile);
  if (leaked.length > 0 || serverFiles.length > 0) {
    console.error(`build:worker falhou: ${name} importa código do painel: ${[...leaked, ...serverFiles].join(", ")}`);
    process.exit(1);
  }
  const bytes = result.metafile.outputs[name]?.bytes ?? 0;
  console.log(`${name} gerado (${(bytes / 1024).toFixed(0)} KB, ${inputs.length} módulos)`);
}

for (const target of TARGETS) await bundle(target);
