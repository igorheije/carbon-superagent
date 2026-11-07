import type { ExecutorId } from "../../shared/executors";

/**
 * Shared input of the setup-kit renderers (compose.ts, k8s.ts). Every value lands inside YAML,
 * `.env` files or shell commands in a README, so all of them are validated against strict
 * allow-lists here: a newline in a name, a quote in a URL or a `$` in an image reference is
 * rejected instead of escaped. The YAML emitter below still quotes every string (defense in depth).
 */

export interface WorkerKitOptions {
  /** DNS label (lowercase letters, digits, `-`): used for resource names. See slugifyWorkerName. */
  readonly workerName: string;
  /** https URL the worker uses to reach the panel (http only on loopback). */
  readonly panelUrl: string;
  /**
   * SHA-256 of the panel's self-signed listener certificate (direct IP connection). The worker
   * pins it and refuses any other certificate before sending the token. Canonical 64 hex.
   */
  readonly panelFingerprint?: string | null;
  /** `cwk_…` worker token. Written only to `.env` (Compose) and `secret.yaml` (Kubernetes). */
  readonly token: string;
  /** Container image, e.g. `ghcr.io/acme/carbon-worker:0.2.0`. */
  readonly image: string;
  readonly replicas: number;
  /** Tasks per worker process (CARBON_WORKER_PARALLEL). */
  readonly parallel: number;
  readonly executors: readonly ExecutorId[];
  /** Kubernetes CPU quantity: `2`, `1.5` or `500m`. */
  readonly cpu: string;
  /** Kubernetes memory quantity with a binary suffix: `512Mi`, `4Gi`. */
  readonly memory: string;
}

export type KitFiles = Record<string, string>;

export class SetupKitError extends Error {
  constructor(readonly errors: readonly string[]) {
    super(`opções do kit inválidas: ${errors.join("; ")}`);
    this.name = "SetupKitError";
  }
}

export const MAX_WORKER_NAME_LENGTH = 40;
export const MAX_REPLICAS = 100;
export const MAX_PARALLEL = 64;
/** Work dir inside the image (deploy/worker/Dockerfile) — a volume in Compose, emptyDir in Kubernetes. */
export const CONTAINER_WORK_DIR = "/home/carbon/work";

const KNOWN_EXECUTORS: readonly ExecutorId[] = ["claude", "codex"];
const WORKER_NAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const TOKEN = /^cwk_[A-Za-z0-9_-]{43}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
/** Registry/repository[:tag][@digest] with no whitespace, quotes, `$` or shell metacharacters. */
const IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9._-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/;
const CPU = /^(?:[1-9]\d{0,3}m|\d{1,3}(?:\.\d{1,3})?)$/;
const MEMORY = /^[1-9]\d{0,6}(?:Mi|Gi)$/;
/** Characters allowed in the panel URL: unreserved + a few reserved ones; no quotes, `$`, `#`, `\`, spaces. */
const URL_CHARS = /^[A-Za-z0-9\-._~:/?[\]@!&()*+,;=%]+$/;

/** Turns a free-form machine name (panel allows up to 80 chars) into a valid workerName. */
export function slugifyWorkerName(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, MAX_WORKER_NAME_LENGTH)
    .replace(/^-+|-+$/g, "");
  return slug || "worker";
}

function checkPanelUrl(raw: string, errors: string[]): void {
  if (!URL_CHARS.test(raw)) {
    errors.push("panelUrl contém caracteres não permitidos (espaço, aspas, $, #, \\ ou quebra de linha)");
    return;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") errors.push("panelUrl precisa ser http(s)");
    // The worker refuses plain http outside loopback (worker/config.ts): the token travels in every request.
    else if (url.protocol === "http:" && !/^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\])$/.test(url.hostname)) {
      errors.push("panelUrl precisa usar https (http só para 127.0.0.1/localhost)");
    }
    if (url.username || url.password) errors.push("panelUrl não pode conter usuário/senha");
  } catch {
    errors.push("panelUrl precisa ser uma URL válida");
  }
}

const isIntIn = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

/** Returns the list of problems (empty when the options are safe to render). */
export function validateKitOptions(opts: WorkerKitOptions): readonly string[] {
  const errors: string[] = [];
  if (opts.workerName.length > MAX_WORKER_NAME_LENGTH || !WORKER_NAME.test(opts.workerName)) {
    errors.push(`workerName precisa ter 1 a ${MAX_WORKER_NAME_LENGTH} caracteres: letras minúsculas, dígitos e hífen`);
  }
  checkPanelUrl(opts.panelUrl, errors);
  if (opts.panelFingerprint) {
    if (!FINGERPRINT.test(opts.panelFingerprint)) errors.push("panelFingerprint precisa ser o SHA-256 canônico (64 hex minúsculos)");
    else if (!opts.panelUrl.startsWith("https://")) errors.push("panelFingerprint exige panelUrl com https://");
  }
  if (!TOKEN.test(opts.token)) errors.push("token inválido (formato cwk_…)");
  if (opts.image.length > 255 || !IMAGE.test(opts.image)) errors.push("image inválida (ex.: ghcr.io/acme/carbon-worker:0.2.0)");
  if (!isIntIn(opts.replicas, 1, MAX_REPLICAS)) errors.push(`replicas precisa ser inteiro entre 1 e ${MAX_REPLICAS}`);
  if (!isIntIn(opts.parallel, 1, MAX_PARALLEL)) errors.push(`parallel precisa ser inteiro entre 1 e ${MAX_PARALLEL}`);
  const unknown = opts.executors.filter((e) => !KNOWN_EXECUTORS.includes(e));
  if (opts.executors.length === 0 || unknown.length > 0) errors.push(`executors aceita ${KNOWN_EXECUTORS.join(", ")} (ao menos um)`);
  if (!CPU.test(opts.cpu)) errors.push("cpu inválida (ex.: 2, 1.5 ou 500m)");
  if (!MEMORY.test(opts.memory)) errors.push("memory inválida (ex.: 512Mi, 4Gi)");
  return errors;
}

/** Throws SetupKitError when invalid; returns the options with executors de-duplicated. */
export function assertKitOptions(opts: WorkerKitOptions): WorkerKitOptions {
  const errors = validateKitOptions(opts);
  if (errors.length > 0) throw new SetupKitError(errors);
  return { ...opts, executors: [...new Set(opts.executors)] };
}

// ---------------------------------------------------------------------------------------------
// Minimal YAML emitter: block mappings/sequences, every string double-quoted via JSON.stringify
// (JSON strings are valid YAML double-quoted scalars), so values can never break the structure.

export type YamlValue = string | number | boolean | null | readonly YamlValue[] | { readonly [key: string]: YamlValue };

const SAFE_KEY = /^[A-Za-z0-9_.\-/]+$/;

const yamlKey = (key: string): string => (SAFE_KEY.test(key) ? key : JSON.stringify(key));

function yamlScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error("número inválido no YAML");
  return String(value);
}

const isEmptyCollection = (value: YamlValue): boolean =>
  value !== null && typeof value === "object" && (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0);

function yamlLines(value: YamlValue, indent: string): string[] {
  if (value === null || typeof value !== "object") return [`${indent}${yamlScalar(value)}`];
  if (Array.isArray(value)) {
    return (value as readonly YamlValue[]).flatMap((item) => {
      if (item !== null && typeof item === "object" && !isEmptyCollection(item)) {
        const [first, ...rest] = yamlLines(item, `${indent}  `);
        return [`${indent}- ${first.trimStart()}`, ...rest];
      }
      return [`${indent}- ${inline(item)}`];
    });
  }
  return Object.entries(value as Record<string, YamlValue>).flatMap(([key, item]) => {
    if (item !== null && typeof item === "object" && !isEmptyCollection(item)) {
      return [`${indent}${yamlKey(key)}:`, ...yamlLines(item, `${indent}  `)];
    }
    return [`${indent}${yamlKey(key)}: ${inline(item)}`];
  });
}

function inline(value: YamlValue): string {
  if (value !== null && typeof value === "object") return Array.isArray(value) ? "[]" : "{}";
  return yamlScalar(value as string | number | boolean | null);
}

/** Serializes `value` as a YAML document, optionally preceded by `# comment` lines. */
export function toYaml(value: YamlValue, comments: readonly string[] = []): string {
  const header = comments.map((line) => (line ? `# ${line}` : "#"));
  return [...header, ...yamlLines(value, "")].join("\n") + "\n";
}
