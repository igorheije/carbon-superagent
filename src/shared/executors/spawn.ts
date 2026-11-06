import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelChoice } from "@/lib/domain/models";
import { parseClaudeLine } from "./claude-parse";
import { parseCodexLine } from "./codex-parse";
import type { ExecutorEvent } from "./events";

/** Executors Carbon can drive. Mirrors `EXECUTORS` in the panel settings. */
export type ExecutorId = "claude" | "codex";

/**
 * The slice of the panel settings the command builder reads. Plain data so a standalone
 * worker (no DB, no Next.js) can build the same command; the panel `Settings` satisfies it.
 */
export interface ExecutorSettings {
  readonly permissionProfile: "guarded" | "auto" | "unrestricted";
  readonly isolateClaudeConfig: boolean;
}

/** The runner owns commits/pushes; agents never push or rewrite history. */
const CLAUDE_DISALLOWED = ["Bash(git push:*)", "Bash(git commit:*)", "Bash(git reset --hard:*)", "Bash(rm -rf:*)"];

const CLAUDE_GUARDED_ALLOWED = [
  "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "TodoWrite", "Skill",
  "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(ls:*)",
  "Bash(npm test:*)", "Bash(npm run:*)", "Bash(npx vitest:*)", "Bash(npx jest:*)", "Bash(npx tsc:*)", "Bash(npx eslint:*)",
  "Bash(pnpm test:*)", "Bash(pnpm run:*)", "Bash(yarn test:*)", "Bash(yarn run:*)",
  "Bash(pytest:*)", "Bash(python -m pytest:*)", "Bash(go test:*)", "Bash(go build:*)", "Bash(cargo test:*)", "Bash(cargo build:*)",
];

export interface ExecutorCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly parse: (line: string) => readonly ExecutorEvent[];
  /** When set, the prompt goes in over stdin (stream-json) and the host can answer permission prompts. */
  readonly stdinPrompt?: string;
}

/**
 * Personal Claude settings (default permission mode, hooks, MCP servers) would override the
 * profile chosen in the panel and inflate every run's context, so they are skipped by default.
 * Project settings (.claude/settings.json in the repo) still apply. OAuth login is unaffected.
 */
const CLAUDE_ISOLATION = ["--setting-sources", "project,local", "--strict-mcp-config"];

/**
 * `resumeSessionId` continues an earlier Claude Code session (same cwd) instead of starting a new one.
 * Codex is always a fresh run: the caller puts earlier decisions in the prompt instead.
 */
export function buildCommand(
  executor: ExecutorId,
  prompt: string,
  cwd: string,
  settings: ExecutorSettings,
  choice: ModelChoice,
  resumeSessionId: string | null = null,
): ExecutorCommand {
  if (executor === "claude") {
    const mode = settings.permissionProfile === "guarded" ? "acceptEdits" : settings.permissionProfile === "auto" ? "auto" : "bypassPermissions";
    const asksHost = settings.permissionProfile !== "unrestricted";
    const args = [
      "-p",
      ...(resumeSessionId ? ["--resume", resumeSessionId] : []),
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--permission-mode", mode,
      ...(asksHost ? ["--permission-prompts", "host", "--permission-prompt-tool", "stdio"] : []),
      ...(settings.isolateClaudeConfig ? CLAUDE_ISOLATION : []),
      ...(choice.model ? ["--model", choice.model] : []),
      ...(choice.effort ? ["--effort", choice.effort] : []),
      ...(settings.permissionProfile === "guarded" ? ["--allowedTools", ...CLAUDE_GUARDED_ALLOWED] : []),
      "--disallowedTools", ...CLAUDE_DISALLOWED,
    ];
    return { bin: "claude", args, parse: parseClaudeLine, stdinPrompt: prompt };
  }
  const sandbox =
    settings.permissionProfile === "unrestricted" ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"];
  const args = [
    "exec", "--json", "-C", cwd, ...sandbox,
    ...(choice.model ? ["-m", choice.model] : []),
    ...(choice.effort ? ["-c", `model_reasoning_effort=${choice.effort}`] : []),
    prompt,
  ];
  return { bin: "codex", args, parse: parseCodexLine };
}

export type PermissionDecision =
  | { readonly behavior: "allow"; readonly input: unknown; readonly remember: readonly unknown[] }
  | { readonly behavior: "deny"; readonly message: string };

export interface RunningExecutor {
  readonly done: Promise<{ readonly code: number; readonly stderrTail: string; readonly timedOut: boolean }>;
  readonly cancel: () => void;
  /** Answers a permission prompt (stdin executors only). Returns false if the process is gone. */
  readonly respond: (requestId: string, decision: PermissionDecision) => boolean;
}

/**
 * Environment the agent process gets. "inherit" (default, local runner) passes the panel's whole
 * environment. "allowlist" (worker mode) passes only what a CLI agent needs to run tools and reach
 * its model: never the worker/git tokens, which a prompt-injected agent could otherwise read with
 * `env` and send anywhere.
 */
export interface ExecutorEnvOptions {
  readonly mode: "inherit" | "allowlist";
  /** Added after the policy is applied (e.g. a per-task TMPDIR). */
  readonly extra?: Readonly<Record<string, string>>;
}

/** Exact names passed in allowlist mode. */
const AGENT_ENV_NAMES = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TMP", "TEMP", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "DISABLE_TELEMETRY",
  "JAVA_HOME", "GOPATH", "GOROOT", "GOCACHE", "GOMODCACHE", "CARGO_HOME", "RUSTUP_HOME",
  "NVM_DIR", "PYENV_ROOT", "VIRTUAL_ENV", "npm_config_cache", "CI",
]);
/** Prefixes passed in allowlist mode: locale, model credentials (API key, OAuth, Bedrock/AWS role). */
const AGENT_ENV_PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_CODE_", "AWS_", "OPENAI_", "CODEX_"];
/** Never passed, whatever the allowlist says. */
const AGENT_ENV_DENIED = /^(CARBON_|GIT_ASKPASS$|SSH_AUTH_SOCK$|GH_TOKEN$|GITHUB_TOKEN$)/;

/** Builds the child environment for the given policy. Pure: exported for tests. */
export type EnvMap = Record<string, string | undefined>;

export function agentEnv(source: Readonly<EnvMap>, options: ExecutorEnvOptions = { mode: "inherit" }): EnvMap {
  const base: EnvMap =
    options.mode === "inherit"
      ? { ...source }
      : Object.fromEntries(
          Object.entries(source).filter(
            ([name, value]) =>
              value !== undefined && !AGENT_ENV_DENIED.test(name) && (AGENT_ENV_NAMES.has(name) || AGENT_ENV_PREFIXES.some((p) => name.startsWith(p))),
          ),
        );
  return { ...base, ...(options.extra ?? {}), FORCE_COLOR: "0" };
}

const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 5000;

/** Spawns the executor (no shell), streams parsed events, enforces a wall-clock limit. */
export function startExecutor(
  command: ExecutorCommand,
  cwd: string,
  timeoutMs: number,
  onEvent: (event: ExecutorEvent) => void,
  envOptions: ExecutorEnvOptions = { mode: "inherit" },
): RunningExecutor {
  const isInteractive = command.stdinPrompt !== undefined;
  const child = spawn(command.bin, [...command.args], {
    cwd,
    stdio: [isInteractive ? "pipe" : "ignore", "pipe", "pipe"],
    env: agentEnv(process.env, envOptions) as NodeJS.ProcessEnv,
    // Own process group: stopping the task also stops the shells/tests the agent started.
    detached: process.platform !== "win32",
  });
  let stderrTail = "";
  let timedOut = false;

  const write = (message: unknown): boolean => {
    if (!child.stdin || child.stdin.destroyed || child.exitCode !== null) return false;
    child.stdin.write(`${JSON.stringify(message)}\n`);
    return true;
  };
  const closeInput = () => {
    if (child.stdin && !child.stdin.destroyed) child.stdin.end();
  };

  const signalTree = (signal: NodeJS.Signals) => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };
  const kill = () => {
    if (child.exitCode !== null) return;
    signalTree("SIGTERM");
    setTimeout(() => child.exitCode === null && signalTree("SIGKILL"), KILL_GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeoutMs);
  timer.unref();

  const { stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error(`${command.bin}: stdio indisponível`);

  createInterface({ input: stdout }).on("line", (line) => {
    for (const event of command.parse(line)) {
      onEvent(event);
      // The CLI keeps reading stdin for follow-up turns; one task = one turn.
      if (event.type === "result") closeInput();
    }
  });
  stderr.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL);
  });
  child.stdin?.on("error", () => undefined);

  if (isInteractive) write({ type: "user", message: { role: "user", content: command.stdinPrompt } });

  const done = new Promise<{ code: number; stderrTail: string; timedOut: boolean }>((resolve) => {
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderrTail: error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderrTail, timedOut });
    });
  });

  const respond = (requestId: string, decision: PermissionDecision): boolean => {
    const response =
      decision.behavior === "allow"
        ? { behavior: "allow", updatedInput: decision.input, ...(decision.remember.length ? { updatedPermissions: decision.remember } : {}) }
        : { behavior: "deny", message: decision.message };
    return write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  };

  return { done, cancel: kill, respond };
}
