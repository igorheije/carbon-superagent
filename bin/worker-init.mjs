// `carbon worker init`: writes a worker setup kit (Compose, Kubernetes or AgentCore) to a folder.
// Runs on the panel host: for compose/k8s it creates the worker straight in the panel database
// (like reset-password) and returns the token once. Only the token's sha256 is stored.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import path from "node:path";

export const INIT_TARGETS = ["compose", "k8s", "agentcore"];
const EXECUTORS = ["claude", "codex"];
const MAX_NAME_LENGTH = 80;
const SECRET_FILES = new Set([".env", "secret.yaml"]);
const EXECUTABLE_FILES = new Set(["deploy.sh"]);
const DEFAULT_CPU = "2";
const DEFAULT_MEMORY = "4Gi";
/** Syntactically valid stand-in token: validates the options before the worker exists. */
const PROBE_TOKEN = `cwk_${"A".repeat(43)}`;

export const INIT_USAGE = `uso: carbon worker init --target compose|k8s|agentcore --out <pasta> [opções]
  --name <nome>          nome da máquina (obrigatório para compose/k8s)
  --panel-url <url>      URL pública do painel (obrigatória para compose/k8s)
  --replicas <N>         réplicas (padrão 1)
  --parallel <N>         tarefas por worker (padrão 1)
  --executors <lista>    claude,codex (padrão claude)
  --image <imagem>       imagem do worker (padrão carbon-worker:<versão>)
  --region <região>      região AWS (agentcore; padrão sa-east-1)
  --force                escreve mesmo se a pasta não estiver vazia`;

export class InitError extends Error {
  constructor(message) {
    super(message);
    this.name = "InitError";
  }
}

const BOOLEAN_FLAGS = new Set(["force"]);
const VALUE_FLAGS = new Set(["target", "name", "panel-url", "replicas", "parallel", "executors", "image", "region", "out"]);

function readFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new InitError(`argumento inesperado: ${arg}`);
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    if (!VALUE_FLAGS.has(key)) throw new InitError(`opção desconhecida: ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new InitError(`${arg} precisa de um valor`);
    flags[key] = value;
    i += 1;
  }
  return flags;
}

function positiveInt(raw, label) {
  if (raw === undefined) return 1;
  if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new InitError(`${label} precisa ser um inteiro ≥ 1`);
  return Number(raw);
}

/** Parses `worker init` arguments (everything after `init`). Throws InitError with a pt-BR message. */
export function parseInitArgs(argv) {
  const flags = readFlags(argv);
  const target = flags.target;
  if (!INIT_TARGETS.includes(target)) throw new InitError(`--target precisa ser ${INIT_TARGETS.join(", ")}`);
  if (!flags.out) throw new InitError("--out <pasta> é obrigatório");
  const executors = (flags.executors ?? "claude").split(",").map((e) => e.trim()).filter(Boolean);
  const unknown = executors.filter((e) => !EXECUTORS.includes(e));
  if (executors.length === 0 || unknown.length > 0) throw new InitError(`--executors aceita ${EXECUTORS.join(",")}`);
  const name = (flags.name ?? "").trim();
  if (target !== "agentcore") {
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw new InitError(`--name é obrigatório (1 a ${MAX_NAME_LENGTH} caracteres)`);
    if (!flags["panel-url"]) throw new InitError("--panel-url é obrigatório (URL pública por onde o worker alcança o painel)");
  }
  return {
    target,
    name,
    panelUrl: flags["panel-url"] ?? null,
    replicas: positiveInt(flags.replicas, "--replicas"),
    parallel: positiveInt(flags.parallel, "--parallel"),
    executors: [...new Set(executors)],
    image: flags.image ?? null,
    region: flags.region ?? null,
    out: flags.out,
    force: flags.force === true,
  };
}

/**
 * Bundles the TypeScript renderers (src/server/setup-kit) in memory with esbuild — the same
 * devDependency `carbon worker` uses — so the CLI and the panel share one generator.
 */
export async function loadRenderers(root) {
  const { build } = await import("esbuild");
  const result = await build({
    stdin: {
      contents: [
        'export { renderCompose } from "./compose";',
        'export { renderK8s } from "./k8s";',
        'export { renderAgentCore } from "./agentcore";',
        'export { slugifyWorkerName, validateKitOptions } from "./worker-kit";',
      ].join("\n"),
      resolveDir: path.join(root, "src", "server", "setup-kit"),
      loader: "ts",
    },
    absWorkingDir: root,
    tsconfig: path.join(root, "tsconfig.json"),
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
  });
  const code = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

function assertWritableDir(out, force) {
  if (existsSync(out) && readdirSync(out).length > 0 && !force) {
    throw new InitError(`a pasta ${out} não está vazia; use --force para sobrescrever`);
  }
}

/**
 * Writes `body` to a fresh temp file created with `mode` (O_EXCL: never an existing file or a
 * symlink planted at that name), then renames it over `target`. A secret is never readable by
 * others, not even for an instant, and a reader never sees a half-written file (L8).
 */
function writeAtomic(target, body, mode) {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), mode);
  try {
    fchmodSync(fd, mode); // exact mode whatever the umask
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/** Writes the kit; secret files get 0600, deploy.sh 0755, everything else 0644. */
export function writeKitFiles(out, files) {
  mkdirSync(out, { recursive: true });
  const written = [];
  for (const [file, body] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const target = path.resolve(out, file);
    if (!target.startsWith(path.resolve(out) + path.sep)) throw new InitError(`caminho inválido no kit: ${file}`);
    mkdirSync(path.dirname(target), { recursive: true });
    const base = path.basename(file);
    const mode = SECRET_FILES.has(base) ? 0o600 : EXECUTABLE_FILES.has(base) ? 0o755 : 0o644;
    writeAtomic(target, body, mode);
    written.push(file);
  }
  return written;
}

/** Same format as src/server/auth/worker-auth.ts: `cwk_` + base64url(32 bytes); sha256 hex stored. */
export function createWorkerRecord(db, name, now = Date.now()) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workers'").get();
  if (!table) throw new InitError("o banco ainda não tem a tabela de workers: inicie o painel uma vez (carbon start) para migrar");
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (!admin) throw new InitError("nenhum admin no painel ainda: abra /setup primeiro");
  const token = `cwk_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO workers (id, name, kind, token_hash, created_by, created_at) VALUES (?, ?, 'pool', ?, ?, ?)").run(id, name, tokenHash, admin.id, now);
  return { id, token };
}

function workerKitOptions(renderers, opts, token, version) {
  return {
    workerName: renderers.slugifyWorkerName(opts.name),
    panelUrl: opts.panelUrl,
    token,
    image: opts.image ?? `carbon-worker:${version}`,
    replicas: opts.replicas,
    parallel: opts.parallel,
    executors: opts.executors,
    cpu: DEFAULT_CPU,
    memory: DEFAULT_MEMORY,
  };
}

/**
 * Runs `worker init`. `openDb` returns a node:sqlite DatabaseSync of the panel (only called for
 * compose/k8s, after the options validated). Returns what was written and the token (null for agentcore).
 */
export async function runWorkerInit(opts, { root, version, openDb }) {
  const out = path.resolve(opts.out);
  assertWritableDir(out, opts.force);
  const renderers = await loadRenderers(root);

  if (opts.target === "agentcore") {
    const files = renderers.renderAgentCore({ panelUrl: opts.panelUrl ?? undefined, region: opts.region ?? undefined });
    return { out, files: writeKitFiles(out, files), worker: null, token: null };
  }

  const problems = renderers.validateKitOptions(workerKitOptions(renderers, opts, PROBE_TOKEN, version));
  if (problems.length > 0) throw new InitError(problems.join("; "));
  const db = openDb();
  let created;
  try {
    created = createWorkerRecord(db, opts.name);
  } finally {
    db.close();
  }
  const options = workerKitOptions(renderers, opts, created.token, version);
  const files = opts.target === "compose" ? renderers.renderCompose(options) : renderers.renderK8s(options);
  return { out, files: writeKitFiles(out, files), worker: { id: created.id, name: opts.name }, token: created.token };
}
