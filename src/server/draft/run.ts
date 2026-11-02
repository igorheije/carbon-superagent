import "server-only";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ExecutorName } from "../executors/resolve";
import { parseClaudeDraftLine, parseCodexDraftLine, type DraftEvent } from "./stream";

const DRAFT_TIMEOUT_MS = 120_000;
const KILL_GRACE_MS = 3000;

/** Read-only agent run: fast model, low effort, only Read/Glob/Grep, personal settings isolated. */
function commandFor(executor: ExecutorName, prompt: string, cwd: string): { bin: string; args: string[]; parse: (l: string) => readonly DraftEvent[] } {
  if (executor === "claude") {
    return {
      bin: "claude",
      parse: parseClaudeDraftLine,
      args: [
        "-p", prompt,
        "--output-format", "stream-json", "--verbose", "--include-partial-messages",
        "--permission-mode", "dontAsk", "--allowedTools", "Read", "Glob", "Grep",
        "--setting-sources", "project,local", "--strict-mcp-config",
        "--model", "haiku", "--effort", "low",
      ],
    };
  }
  return {
    bin: "codex",
    parse: parseCodexDraftLine,
    args: ["exec", "--json", "-C", cwd, "--sandbox", "read-only", "-c", "model_reasoning_effort=low", prompt],
  };
}

/** Streams draft events; resolves when the process ends. Abort via the signal (dialog closed). */
export function runDraft(
  executor: ExecutorName,
  prompt: string,
  cwd: string,
  signal: AbortSignal,
  onEvent: (event: DraftEvent) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const { bin, args, parse } = commandFor(executor, prompt, cwd);
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, FORCE_COLOR: "0" } });
    let stderrTail = "";
    let sawFinal = false;
    const kill = () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      onEvent({ type: "error", message: "tempo esgotado ao gerar a descrição" });
      kill();
    }, DRAFT_TIMEOUT_MS);
    signal.addEventListener("abort", kill, { once: true });

    createInterface({ input: child.stdout }).on("line", (line) => {
      for (const event of parse(line)) {
        if (event.type === "final") sawFinal = true;
        onEvent(event);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-1000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      onEvent({ type: "error", message: `${bin} não pôde ser iniciado: ${error.message}` });
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!sawFinal && !signal.aborted && code !== 0) {
        onEvent({ type: "error", message: stderrTail.split("\n").filter(Boolean).at(-1) ?? `${bin} saiu com código ${code}` });
      }
      resolve();
    });
  });
}
