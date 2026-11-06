import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AGENTCORE_KIT_DEFAULTS, InvalidKitOptions, renderAgentCore } from "./agentcore";

const hasShellcheck = spawnSync("shellcheck", ["--version"], { stdio: "ignore" }).status === 0;
const hasBash = spawnSync("bash", ["--version"], { stdio: "ignore" }).status === 0;
const dir = mkdtempSync(path.join(tmpdir(), "carbon-agentcore-kit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeScript(content: string): string {
  const file = path.join(dir, `deploy-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, content);
  return file;
}

describe("renderAgentCore", () => {
  it("renders exactly the four kit files", () => {
    expect(Object.keys(renderAgentCore()).sort()).toEqual(["Dockerfile", "README.md", "deploy.sh", "iam-policy.json"]);
  });

  it("is deterministic", () => {
    expect(renderAgentCore()).toEqual(renderAgentCore());
  });

  it("matches the snapshot (defaults)", () => {
    expect(renderAgentCore()).toMatchSnapshot();
  });

  it("matches the snapshot (custom options)", () => {
    expect(
      renderAgentCore({ region: "us-east-1", runtimeName: "carbon_prod", repositoryName: "acme/carbon", panelUrl: "https://carbon.acme.test/", idleTimeoutSeconds: 600, maxLifetimeSeconds: 7200 }),
    ).toMatchSnapshot();
  });

  it("Dockerfile follows the AgentCore contract (arm64, 8080, non-root, pinned Claude Code)", () => {
    const dockerfile = renderAgentCore()["Dockerfile"];
    expect(dockerfile).toContain("FROM --platform=linux/arm64 node:22-bookworm-slim");
    expect(dockerfile).toMatch(/apt-get install -y --no-install-recommends git ca-certificates/);
    expect(dockerfile).toContain(`ARG CLAUDE_CODE_VERSION=${AGENTCORE_KIT_DEFAULTS.claudeCodeVersion}`);
    expect(dockerfile).toContain('npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"');
    expect(dockerfile).toContain("COPY dist/agentcore.mjs");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).toContain("EXPOSE 8080");
    expect(dockerfile).toMatch(/^CMD \["node", "\/opt\/carbon\/agentcore\.mjs"\]$/m);
    expect(dockerfile.indexOf("USER node")).toBeLessThan(dockerfile.indexOf("CMD"));
  });

  it("iam-policy.json is valid JSON limited to ECR pull and CloudWatch logs", () => {
    const policy = JSON.parse(renderAgentCore()["iam-policy.json"]) as { Statement: { Action: string[]; Resource: string }[] };
    const actions = policy.Statement.flatMap((s) => s.Action);
    expect(actions.every((a) => a.startsWith("ecr:") || a.startsWith("logs:"))).toBe(true);
    expect(actions).toEqual(expect.arrayContaining(["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer", "ecr:GetAuthorizationToken", "logs:PutLogEvents"]));
    expect(policy.Statement.filter((s) => s.Resource === "*").flatMap((s) => s.Action)).toEqual(["ecr:GetAuthorizationToken"]);
  });

  it("deploy.sh is strict, uses arm64 buildx, create/update runtime, lifecycle and prints the ARN", () => {
    const script = renderAgentCore()["deploy.sh"];
    expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
    expect(script).toContain("set -euo pipefail");
    expect(script).toContain('REGION="${REGION:-sa-east-1}"');
    expect(script).toContain('ACCOUNT_ID="${ACCOUNT_ID:?');
    expect(script).toContain('RUNTIME_NAME="${RUNTIME_NAME:-carbon_worker}"');
    expect(script).toContain("docker buildx build --platform linux/arm64");
    expect(script).toContain("aws bedrock-agentcore-control create-agent-runtime");
    expect(script).toContain("aws bedrock-agentcore-control update-agent-runtime");
    expect(script).toContain("idleRuntimeSessionTimeout");
    expect(script).toContain("maxLifetime");
    expect(script).toContain("--environment-variables");
    expect(script).toContain('echo "  $RUNTIME_ARN"');
  });

  it("README is pt-BR with the experimental warning and the open risks", () => {
    const readme = renderAgentCore()["README.md"];
    expect(readme).toContain("> [!WARNING]");
    expect(readme).toContain("Experimental — não validado em conta AWS real");
    for (const risk of ["Egress", "CLAUDE_CODE_USE_BEDROCK=1", "ANTHROPIC_API_KEY", "60 min", "8h", "Revise antes de aplicar"]) expect(readme).toContain(risk);
  });

  it("contains placeholders only, never secrets", () => {
    const all = Object.values(renderAgentCore()).join("\n");
    expect(all).not.toMatch(/sk-ant-[A-Za-z0-9]/);
    expect(all).not.toMatch(/cwk_[A-Za-z0-9]/);
    expect(all).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(all).not.toMatch(/gh[pousr]_[A-Za-z0-9]{20,}/);
    expect(all).not.toMatch(/\b\d{12}\b/);
    expect(all).toContain("<ACCOUNT_ID>");
  });

  it.each([
    [{ region: "sa-east-1; rm -rf /" }, /region/],
    [{ runtimeName: "carbon-worker" }, /runtimeName/],
    [{ runtimeName: "$(id)" }, /runtimeName/],
    [{ repositoryName: "Bad Repo" }, /repositoryName/],
    [{ claudeCodeVersion: "latest" }, /claudeCodeVersion/],
    [{ panelUrl: 'https://x.test/"$(id)"' }, /panelUrl/],
    [{ panelUrl: "ftp://x.test" }, /panelUrl/],
    [{ panelUrl: "http://carbon.acme.test" }, /https/],
    [{ maxLifetimeSeconds: 28_801 }, /maxLifetimeSeconds/],
    [{ idleTimeoutSeconds: 10 }, /idleTimeoutSeconds/],
    [{ idleTimeoutSeconds: 3600, maxLifetimeSeconds: 1800 }, /idleTimeoutSeconds/],
  ])("rejects unsafe options %o", (opts, message) => {
    expect(() => renderAgentCore(opts)).toThrow(InvalidKitOptions);
    expect(() => renderAgentCore(opts)).toThrow(message);
  });
});

describe("deploy.sh syntax", () => {
  it.skipIf(!hasBash)("passes bash -n", () => {
    for (const opts of [{}, { region: "us-west-2", runtimeName: "x1" }]) {
      const result = spawnSync("bash", ["-n", writeScript(renderAgentCore(opts)["deploy.sh"])], { encoding: "utf8" });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  it.skipIf(!hasShellcheck)("passes shellcheck", () => {
    const result = spawnSync("shellcheck", ["-s", "bash", writeScript(renderAgentCore()["deploy.sh"])], { encoding: "utf8" });
    expect(result.stdout).toBe("");
    expect(result.status).toBe(0);
  });

  it.skipIf(!hasBash)("refuses a non-https or placeholder CARBON_PANEL_URL and an invalid CARBON_GIT_HOSTS (H2)", () => {
    const script = writeScript(renderAgentCore()["deploy.sh"]);
    const base = { NODE_ENV: "test" as const, PATH: "/usr/bin:/bin", ACCOUNT_ID: "123456789012", ROLE_ARN: "arn:aws:iam::123456789012:role/x" };
    const run = (env: Record<string, string>) => spawnSync("bash", [script], { encoding: "utf8", env: { ...base, ...env }, cwd: dir });
    expect(run({}).stderr).toContain("defina CARBON_PANEL_URL");
    expect(run({ CARBON_PANEL_URL: "http://carbon.acme.test" }).stderr).toContain("precisa ser https");
    expect(run({ CARBON_PANEL_URL: "https://carbon.acme.test", CARBON_GIT_HOSTS: "github.com;id" }).stderr).toContain("CARBON_GIT_HOSTS");
  });

  it("deploy.sh passes CARBON_GIT_HOSTS to the runtime and the README documents it", () => {
    const files = renderAgentCore();
    expect(files["deploy.sh"]).toContain("CARBON_GIT_HOSTS: $gitHosts");
    expect(files["README.md"]).toMatch(/CARBON_GIT_HOSTS/);
    expect(files["README.md"]).toMatch(/\*\*obrigatório\*\*/);
  });

  it.skipIf(!hasBash)("fails fast without ACCOUNT_ID and never reaches AWS", () => {
    const result = spawnSync("bash", [writeScript(renderAgentCore()["deploy.sh"])], { encoding: "utf8", env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" }, cwd: dir });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ACCOUNT_ID");
  });
});
