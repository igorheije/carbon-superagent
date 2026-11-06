import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The standalone worker imports this module in plain Node, where `server-only` throws and
 * there is no DB or Next.js. Vitest aliases `server-only` to a stub, so importing the module
 * here would prove nothing: walk the static import graph from index.ts instead.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENTRY = join(SRC, "shared/executors/index.ts");
const ALLOWED_DIRS = ["shared/", "lib/domain/"];
const FORBIDDEN_PACKAGES = ["server-only", "next", "react", "better-sqlite3"];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function specifiersOf(file: string): readonly string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]).filter((s): s is string => Boolean(s));
}

function resolveLocal(fromFile: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(fromFile), spec) : null;
  if (!base) return null;
  const candidate = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find((p) => existsSync(p));
  if (!candidate) throw new Error(`cannot resolve ${spec} from ${relative(SRC, fromFile)}`);
  return candidate;
}

interface Graph {
  readonly files: readonly string[];
  readonly packages: readonly string[];
}

function walk(entry: string): Graph {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of specifiersOf(file)) {
      const local = resolveLocal(file, spec);
      if (local) queue.push(local);
      else packages.add(spec);
    }
  }
  return { files: [...seen].map((f) => relative(SRC, f)), packages: [...packages] };
}

describe("shared executors boundary", () => {
  const graph = walk(ENTRY);

  it("reaches every executor module from index.ts", () => {
    for (const name of ["events", "claude-parse", "codex-parse", "protocol", "spawn", "resolve"]) {
      expect(graph.files).toContain(`shared/executors/${name}.ts`);
    }
  });

  it("stays inside src/shared and src/lib/domain (no server, repo, db or app code)", () => {
    const outside = graph.files.filter((f) => !ALLOWED_DIRS.some((dir) => f.startsWith(dir)));
    expect(outside).toEqual([]);
  });

  it("imports no server-only, Next.js, React or DB packages", () => {
    const bad = graph.packages.filter((p) => FORBIDDEN_PACKAGES.some((name) => p === name || p.startsWith(`${name}/`)));
    expect(bad).toEqual([]);
  });

  it("uses only node: builtins as external packages", () => {
    expect(graph.packages.filter((p) => !p.startsWith("node:"))).toEqual([]);
  });
});
