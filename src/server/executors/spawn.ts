import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ModelChoice } from "@/lib/domain/models";
import type { ExecutorId, Settings } from "../repo/settings";
import { parseClaudeLine } from "./claude-parse";
import { parseCodexLine } from "./codex-parse";
import type { ExecutorEvent } from "./events";

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

export function buildCommand(executor: ExecutorId, prompt: string, cwd: string, settings: Settings, choice: ModelChoice): ExecutorCommand {
  if (executor === "claude") {
    const mode = settings.permissionProfile === "guarded" ? "acceptEdits" : settings.permissionProfile === "auto" ? "auto" : "bypassPermissions";
    const asksHost = settings.permissionProfile !== "unrestricted";
    const args = [
      "-p",
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

const STDERR_TAIL = 4000;
const KILL_GRACE_MS = 5000;

/** Spawns the executor (no shell), streams parsed events, enforces a wall-clock limit. */
export function startExecutor(
  command: ExecutorCommand,
  cwd: string,
  timeoutMs: number,
  onEvent: (event: ExecutorEvent) => void,
): RunningExecutor {
  const isInteractive = command.stdinPrompt !== undefined;
  const child = spawn(command.bin, [...command.args], {
    cwd,
    stdio: [isInteractive ? "pipe" : "ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
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
