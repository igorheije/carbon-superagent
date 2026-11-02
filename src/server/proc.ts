import "server-only";
import { execFile } from "node:child_process";

export interface ProcResult {
  readonly ok: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 8 * 1024 * 1024;

/**
 * Runs a binary with an argument array (never through a shell, so task text can't inject
 * commands). Never throws: spawn failures come back as ok=false with code -1.
 */
export function run(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ProcResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env: options.env ?? process.env },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        resolve({ ok: !error, code, stdout: String(stdout), stderr: String(stderr || (error && !stderr ? error.message : "")) });
      },
    );
  });
}

export const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";
