import { afterEach, describe, expect, it } from "vitest";
import { agentEnv, startExecutor, type ExecutorCommand } from "./spawn";

const SOURCE: Record<string, string> = {
  PATH: "/usr/bin",
  HOME: "/home/carbon",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  ANTHROPIC_API_KEY: "sk-ant",
  CLAUDE_CODE_OAUTH_TOKEN: "oauth",
  CLAUDE_CODE_USE_BEDROCK: "1",
  AWS_REGION: "us-east-1",
  AWS_CONTAINER_CREDENTIALS_FULL_URI: "http://169.254.170.23/v1/credentials",
  OPENAI_API_KEY: "sk-oa",
  CODEX_HOME: "/home/carbon/.codex",
  CARBON_WORKER_TOKEN: "cwk_secret_secret_secret",
  CARBON_GIT_TOKEN: "ghp_secret",
  CARBON_PANEL_URL: "https://panel",
  GITHUB_TOKEN: "ghs_secret",
  DATABASE_URL: "postgres://x",
};

describe("agentEnv", () => {
  it("inherit mode (local runner) keeps the whole environment", () => {
    const env = agentEnv(SOURCE);
    expect(env.DATABASE_URL).toBe("postgres://x");
    expect(env.CARBON_PANEL_URL).toBe("https://panel");
    expect(env.FORCE_COLOR).toBe("0");
  });

  it("allowlist mode (worker) drops CARBON_* tokens and unrelated secrets but keeps model credentials", () => {
    const env = agentEnv(SOURCE, { mode: "allowlist" });
    expect(Object.keys(env).filter((k) => k.startsWith("CARBON_"))).toEqual([]);
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    for (const kept of ["PATH", "HOME", "LANG", "LC_ALL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_CONTAINER_CREDENTIALS_FULL_URI", "OPENAI_API_KEY", "CODEX_HOME"]) {
      expect(env[kept], kept).toBe(SOURCE[kept]);
    }
  });

  it("extra vars are applied on top of the policy", () => {
    const env = agentEnv(SOURCE, { mode: "allowlist", extra: { TMPDIR: "/w/task-1.tmp" } });
    expect(env.TMPDIR).toBe("/w/task-1.tmp");
  });
});

describe("startExecutor env", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  function dumpEnv(): ExecutorCommand {
    const lines: string[] = [];
    return {
      bin: process.execPath,
      args: ["-e", "process.stdout.write(JSON.stringify(process.env) + '\\n')"],
      parse: (line) => {
        lines.push(line);
        return [{ type: "text", text: line }];
      },
    };
  }

  async function childEnv(mode: "inherit" | "allowlist"): Promise<Record<string, string>> {
    let captured = "";
    const running = startExecutor(dumpEnv(), process.cwd(), 20_000, (event) => {
      if (event.type === "text") captured = event.text;
    }, { mode });
    const exit = await running.done;
    expect(exit.code).toBe(0);
    return JSON.parse(captured) as Record<string, string>;
  }

  it("worker mode: the child process never receives CARBON_WORKER_TOKEN / CARBON_GIT_TOKEN", async () => {
    process.env.CARBON_WORKER_TOKEN = "cwk_should_not_leak_0123456789";
    process.env.CARBON_GIT_TOKEN = "ghp_should_not_leak";
    process.env.ANTHROPIC_API_KEY = "sk-ant-kept";
    const env = await childEnv("allowlist");
    expect(env.CARBON_WORKER_TOKEN).toBeUndefined();
    expect(env.CARBON_GIT_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-kept");
    expect(JSON.stringify(env)).not.toContain("should_not_leak");
  });

  it("local mode keeps inheriting the environment (unchanged behaviour)", async () => {
    process.env.CARBON_LOCAL_MARKER = "kept";
    const env = await childEnv("inherit");
    expect(env.CARBON_LOCAL_MARKER).toBe("kept");
  });
});
