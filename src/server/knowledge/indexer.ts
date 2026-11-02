import "server-only";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseClaudeLine } from "../executors/claude-parse";
import { parseCodexLine } from "../executors/codex-parse";
import { startExecutor } from "../executors/spawn";
import { firstLine, run } from "../proc";
import { resolveImport, scanFile, shouldIndex, type ScannedFile } from "./scan";
import { getOverview, replaceIndex, saveOverview, type KbOverview } from "./store";

export type IndexPhase = "idle" | "scanning" | "graph" | "summary" | "done" | "error";

export interface IndexStatus {
  readonly phase: IndexPhase;
  readonly done: number;
  readonly total: number;
  readonly message: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

const MAX_FILES = 8000;
const YIELD_EVERY = 150;
const SUMMARY_TIMEOUT_MS = 5 * 60_000;
const MAX_SUMMARY_CHARS = 6000;

/** Project the indexer works on. */
export interface IndexTarget {
  readonly id: string;
  readonly repoPath: string;
}

interface QueuedJob {
  readonly target: IndexTarget;
  readonly options: IndexOptions;
  readonly done: () => void;
}

/** One job at a time across projects (it is CPU/disk bound); the rest wait in order. */
interface IndexerState {
  running: string | null;
  readonly queue: QueuedJob[];
  readonly statuses: Map<string, IndexStatus>;
}

const IDLE: IndexStatus = { phase: "idle", done: 0, total: 0, message: "", startedAt: null, finishedAt: null };
const globalForIndex = globalThis as unknown as { carbonIndex?: IndexerState };

function state(): IndexerState {
  globalForIndex.carbonIndex ??= { running: null, queue: [], statuses: new Map() };
  return globalForIndex.carbonIndex;
}

export const indexStatus = (projectId: string): IndexStatus => state().statuses.get(projectId) ?? IDLE;
const isBusy = (projectId: string): boolean =>
  state().running === projectId || state().queue.some((j) => j.target.id === projectId);

async function trackedFiles(repoPath: string): Promise<readonly string[]> {
  const result = await run("git", ["-C", repoPath, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`git ls-files falhou: ${firstLine(result.stderr)}`);
  return result.stdout.split("\0").filter(Boolean);
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Stack and commands from the manifests people actually maintain. */
function detectStack(repoPath: string): { stack: string[]; scripts: { name: string; command: string }[]; entries: string[] } {
  const stack: string[] = [];
  const scripts: { name: string; command: string }[] = [];
  const entries: string[] = [];
  const pkg = readJson(path.join(repoPath, "package.json"));
  if (pkg) {
    const deps = { ...(pkg.dependencies as Record<string, string> | undefined), ...(pkg.devDependencies as Record<string, string> | undefined) };
    const notable = ["next", "react", "react-native", "expo", "vue", "nuxt", "svelte", "express", "fastify", "@nestjs/core", "hono", "prisma", "drizzle-orm", "typeorm", "sequelize", "mongoose", "zod", "vitest", "jest", "playwright", "@playwright/test", "tailwindcss", "graphql", "@grpc/grpc-js", "bullmq", "redis", "ioredis", "pg", "mysql2"];
    stack.push(`Node.js${pkg.name ? ` (${String(pkg.name)})` : ""}`, ...notable.filter((d) => d in deps));
    for (const [name, command] of Object.entries((pkg.scripts as Record<string, string> | undefined) ?? {}).slice(0, 14)) scripts.push({ name: `npm run ${name}`, command });
    for (const key of ["main", "module"]) if (typeof pkg[key] === "string") entries.push(String(pkg[key]));
  }
  if (existsSync(path.join(repoPath, "go.mod"))) stack.push(`Go (${firstLine(readFileSync(path.join(repoPath, "go.mod"), "utf8")).replace("module ", "")})`);
  if (existsSync(path.join(repoPath, "pyproject.toml")) || existsSync(path.join(repoPath, "requirements.txt"))) stack.push("Python");
  if (existsSync(path.join(repoPath, "Cargo.toml"))) stack.push("Rust");
  if (existsSync(path.join(repoPath, "Gemfile"))) stack.push("Ruby");
  if (existsSync(path.join(repoPath, "Dockerfile"))) stack.push("Docker");
  if (existsSync(path.join(repoPath, "Makefile"))) scripts.push({ name: "make", command: "ver Makefile" });
  return { stack, scripts, entries };
}

function summarizeDirs(files: readonly ScannedFile[]) {
  const counts = new Map<string, number>();
  for (const f of files) {
    const parts = f.path.split("/");
    const dir = parts.length > 2 && ["src", "app", "packages", "apps", "services", "internal", "lib"].includes(parts[0] ?? "") ? `${parts[0]}/${parts[1]}` : parts.length > 1 ? (parts[0] ?? ".") : ".";
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24).map(([dir, n]) => ({ dir, files: n }));
}

function guessEntryPoints(files: readonly ScannedFile[], fromManifest: readonly string[]): string[] {
  const named = files
    .filter((f) => f.kind === "code" && /(^|\/)(main|index|app|server|cli)\.[a-z]+$/.test(f.path) && f.path.split("/").length <= 3)
    .map((f) => f.path);
  return [...new Set([...fromManifest, ...named])].slice(0, 10);
}

async function scanAll(repoPath: string, paths: readonly string[], onProgress: (done: number, message: string) => void) {
  const scanned: (ScannedFile & { size: number; body: string })[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    const rel = paths[i] as string;
    try {
      const abs = path.join(repoPath, rel);
      const size = statSync(abs).size;
      if (shouldIndex(rel, size)) {
        const body = await readFile(abs, "utf8");
        if (!body.includes("\u0000")) scanned.push({ ...scanFile(rel, body), size, body });
      }
    } catch {
      // deleted/unreadable between ls-files and read: skip
    }
    if (i % YIELD_EVERY === 0) {
      onProgress(i, `lendo ${rel}`);
      await new Promise((r) => setImmediate(r));
    }
  }
  return scanned;
}

function buildEdges(files: readonly ScannedFile[]): (readonly [string, string])[] {
  const set = new Set(files.map((f) => f.path));
  const edges: (readonly [string, string])[] = [];
  for (const f of files) {
    for (const spec of f.imports) {
      const target = resolveImport(f.path, spec, set, f.lang);
      if (target && target !== f.path) edges.push([f.path, target]);
    }
  }
  return edges;
}

function mapForSummary(o: KbOverview): string {
  return [
    `Stack: ${o.stack.join(", ") || "n/d"}`,
    `Comandos: ${o.scripts.map((s) => s.name).join(", ") || "n/d"}`,
    `Diretórios: ${o.dirs.map((d) => `${d.dir} (${d.files})`).join(", ")}`,
    `Arquivos mais importados: ${o.hubs.map((h) => h.path).join(", ")}`,
    `Pontos de entrada: ${o.entryPoints.join(", ") || "n/d"}`,
  ].join("\n");
}

/** Read-only pass by the user's own agent: what the project does, in plain language. */
async function aiSummary(repoPath: string, executor: "claude" | "codex", overview: KbOverview): Promise<string | null> {
  const prompt = `You are documenting a codebase so other agents can work on it fast. Read the map below and at most ~15 key files (README, entry points, the most imported files). Do NOT modify anything.
Write in Portuguese (pt-BR), up to 350 words, markdown with these sections: O que faz; Domínios principais; Arquitetura (módulos e onde ficam); Fluxo principal; Como rodar e testar; Convenções importantes. No secrets, no personal data.

${mapForSummary(overview)}`;
  const command =
    executor === "claude"
      ? { bin: "claude", parse: parseClaudeLine, args: ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk", "--setting-sources", "project,local", "--strict-mcp-config", "--model", "haiku", "--effort", "low", "--allowedTools", "Read", "Glob", "Grep"] }
      : { bin: "codex", parse: parseCodexLine, args: ["exec", "--json", "-C", repoPath, "--sandbox", "read-only", "-c", "model_reasoning_effort=low", prompt] };
  const texts: string[] = [];
  const running = startExecutor(command, repoPath, SUMMARY_TIMEOUT_MS, (event) => {
    if (event.type === "text") texts.push(event.text);
    if (event.type === "result" && !event.isError && event.text) texts.push(event.text);
  });
  const exit = await running.done;
  const text = texts.at(-1)?.trim() ?? "";
  return exit.code === 0 && text ? text.slice(0, MAX_SUMMARY_CHARS) : null;
}

export interface IndexOptions {
  readonly withSummary: boolean;
  readonly executor: "claude" | "codex" | null;
}

/** Full (re)index of one project's repository. Duplicate requests for a busy project are ignored. */
export function indexRepository(target: IndexTarget, options: IndexOptions): Promise<void> {
  const s = state();
  if (isBusy(target.id)) return Promise.resolve();
  return new Promise((resolve) => {
    s.queue.push({ target, options, done: resolve });
    if (!s.running) s.statuses.set(target.id, { ...IDLE, phase: "scanning", message: "na fila", startedAt: new Date().toISOString() });
    else s.statuses.set(target.id, { ...IDLE, message: "aguardando outro projeto terminar de indexar" });
    void drain();
  });
}

async function drain(): Promise<void> {
  const s = state();
  if (s.running) return;
  const job = s.queue.shift();
  if (!job) return;
  s.running = job.target.id;
  try {
    await runIndex(job.target, job.options);
  } finally {
    s.running = null;
    job.done();
    void drain();
  }
}

async function runIndex(target: IndexTarget, options: IndexOptions): Promise<void> {
  const { id: projectId, repoPath } = target;
  const statuses = state().statuses;
  const setStatus = (patch: Partial<IndexStatus>) => statuses.set(projectId, { ...(statuses.get(projectId) ?? IDLE), ...patch });
  setStatus({ phase: "scanning", done: 0, total: 0, message: "listando arquivos", startedAt: new Date().toISOString(), finishedAt: null });
  try {
    const all = (await trackedFiles(repoPath)).slice(0, MAX_FILES);
    setStatus({ total: all.length });
    const files = await scanAll(repoPath, all, (done, message) => setStatus({ done, message }));
    setStatus({ phase: "graph", done: all.length, message: `${files.length} arquivos · ligando imports` });
    const edges = buildEdges(files);
    const { stack, scripts, entries } = detectStack(repoPath);
    const inDeg = new Map<string, number>();
    for (const [, dst] of edges) inDeg.set(dst, (inDeg.get(dst) ?? 0) + 1);
    const langs = new Map<string, number>();
    for (const f of files) langs.set(f.lang, (langs.get(f.lang) ?? 0) + 1);
    const head = await run("git", ["-C", repoPath, "rev-parse", "HEAD"]);
    const previous = getOverview(projectId);
    const overview: KbOverview = {
      repoPath,
      commit: head.ok ? firstLine(head.stdout) : "",
      indexedAt: new Date().toISOString(),
      fileCount: files.length,
      edgeCount: edges.length,
      languages: [...langs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([lang, n]) => ({ lang, files: n })),
      stack,
      scripts,
      dirs: summarizeDirs(files),
      hubs: [...inDeg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([p, n]) => ({ path: p, inDegree: n })),
      entryPoints: guessEntryPoints(files, entries),
      aiSummary: previous?.repoPath === repoPath ? previous.aiSummary : null,
    };
    replaceIndex(projectId, files, edges);
    saveOverview(projectId, overview);

    if (options.withSummary && options.executor) {
      setStatus({ phase: "summary", message: `${options.executor === "claude" ? "Claude" : "Codex"} lendo o projeto (somente leitura)` });
      const summary = await aiSummary(repoPath, options.executor, overview);
      saveOverview(projectId, { ...overview, aiSummary: summary ?? overview.aiSummary });
    }
    setStatus({ phase: "done", message: `${files.length} arquivos · ${edges.length} conexões`, finishedAt: new Date().toISOString() });
  } catch (error) {
    setStatus({ phase: "error", message: error instanceof Error ? error.message : "falha ao indexar", finishedAt: new Date().toISOString() });
  }
}

/** Before a task: refresh the project's graph if its repo moved (no AI pass, takes seconds). */
export async function ensureFreshIndex(target: IndexTarget): Promise<"fresh" | "reindexed" | "missing"> {
  const overview = getOverview(target.id);
  const head = await run("git", ["-C", target.repoPath, "rev-parse", "HEAD"]);
  const commit = head.ok ? firstLine(head.stdout) : "";
  if (overview && overview.repoPath === target.repoPath && overview.commit === commit) return "fresh";
  if (isBusy(target.id)) return overview ? "fresh" : "missing";
  await indexRepository(target, { withSummary: false, executor: null });
  return getOverview(target.id) ? "reindexed" : "missing";
}
