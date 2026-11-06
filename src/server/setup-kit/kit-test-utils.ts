import { createRequire } from "node:module";
import type { WorkerKitOptions } from "./worker-kit";

/** Fake token in the real format (cwk_ + 43 base64url chars). Not a credential. */
export const FAKE_TOKEN = `cwk_${"FakeTokenForTests0123456789-_abcdefghijklmn".slice(0, 43)}`;

export const KIT_OPTIONS: WorkerKitOptions = {
  workerName: "maquina-sp-01",
  panelUrl: "https://carbon.exemplo.local:3418",
  token: FAKE_TOKEN,
  image: "ghcr.io/acme/carbon-worker:0.2.0",
  replicas: 2,
  parallel: 3,
  executors: ["claude", "codex"],
  cpu: "1500m",
  memory: "4Gi",
};

/** Patterns of real AI/git/cloud credentials that must never appear in a generated kit. */
export const REAL_SECRET_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/,
  /sk-(?:proj-)?[A-Za-z0-9]{20,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abp]-[A-Za-z0-9-]+/,
];

type YamlLoader = (source: string) => unknown;

/**
 * js-yaml is present only as a transitive dev dependency (via @eslint/eslintrc), so it is loaded
 * optionally — no new dependency. Without it, `parseYaml` returns null and tests fall back to the
 * structural check below.
 */
function loadYamlParser(): YamlLoader | null {
  try {
    const mod = createRequire(import.meta.url)("js-yaml") as { load?: YamlLoader };
    return typeof mod.load === "function" ? mod.load : null;
  } catch {
    return null;
  }
}

const loader = loadYamlParser();

export function parseYaml(source: string): unknown {
  return loader ? loader(source) : null;
}

/** Minimal structural check: consistent 2-space indentation, `key: value` / `- item` lines only. */
export function looksLikeBlockYaml(source: string): boolean {
  return source
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .every((line) => {
      const indent = line.length - line.trimStart().length;
      const body = line.trimStart();
      return indent % 2 === 0 && !line.includes("\t") && (/^- /.test(body) || /^("[^"]*"|[A-Za-z0-9_.\-/]+):( |$)/.test(body));
    });
}

/** Asserts a document is valid YAML (parsed when js-yaml is available) and returns it. */
export function yamlDoc(source: string): Record<string, unknown> {
  if (!looksLikeBlockYaml(source)) throw new Error(`YAML com estrutura inesperada:\n${source}`);
  const parsed = parseYaml(source);
  return (parsed ?? {}) as Record<string, unknown>;
}

export const hasYamlParser = loader !== null;
