import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(here, name);

/** Fake `ssh`: drops options, then runs the remote command in a fake server home. */
const FAKE_SSH = `#!/bin/bash
while [ $# -gt 0 ]; do case "$1" in -o|-S|-p|-O|-R|-L) shift 2;; -*) shift;; *) break;; esac; done
shift
[ -n "$FAKE_SSH_FAIL" ] && exit 255
cd "$FAKE_HOME" && HOME="$FAKE_HOME" exec bash -c "$*"
`;

/** Fake `orca`: records its arguments, answers the two environment calls. */
const FAKE_ORCA = `#!/bin/bash
printf '%s\\n' "$*" >> "$FAKE_ORCA_LOG"
case "$1 $2" in "environment list") if [ -n "$FAKE_PAIRED" ]; then echo '[{"name":"coop-vps"}]'; else echo '[]'; fi;; "environment add") echo '{"ok":true}';; esac
`;

let root;
let env;

function writeExec(file, body) {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

async function git(cwd, ...args) {
  return (await run("git", args, { cwd, env })).stdout.trim();
}

beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), "coop-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "server"));
  writeExec(path.join(bin, "ssh"), FAKE_SSH);
  writeExec(path.join(bin, "orca"), FAKE_ORCA);
  env = {
    ...process.env,
    COOP_HOME: path.join(root, "coop-home"),
    COOP_SSH: path.join(bin, "ssh"),
    COOP_ORCA: path.join(bin, "orca"),
    GIT_SSH_COMMAND: path.join(bin, "ssh"),
    GIT_SSH_VARIANT: "simple",
    FAKE_HOME: path.join(root, "server"),
    FAKE_ORCA_LOG: path.join(root, "orca.log"),
    GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  };
  await run(script("init.sh"), ["vps", "carbon@example.test"], { env });
});

describe("init.sh", () => {
  it("writes a 0600 profile without secrets", () => {
    const file = path.join(env.COOP_HOME, "vps", "config.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ name: "vps", target: "carbon@example.test", port: 16768, proxyPort: 8787, environment: "coop-vps" });
  });

  it("refuses root as the worker account", async () => {
    await expect(run(script("init.sh"), ["x", "root@example.test"], { env })).rejects.toMatchObject({ stderr: expect.stringContaining("não use root") });
  });
});

describe("code-sync.sh", () => {
  async function repo(name = "app") {
    const dir = path.join(root, name);
    mkdirSync(dir);
    await git(dir, "init", "-q", "-b", "main");
    writeFileSync(path.join(dir, "a.txt"), "1\n");
    await git(dir, "add", ".");
    await git(dir, "commit", "-qm", "base");
    return dir;
  }

  it("pushes the committed HEAD, prepares the server clone and fetches the worker branch back", async () => {
    const dir = await repo();
    writeFileSync(path.join(dir, "dirty.txt"), "não vai\n");

    const pushed = await run(script("code-sync.sh"), ["push", "vps", "add-test"], { cwd: dir, env });
    expect(pushed.stdout).toContain(`REPO_PATH=${path.join(env.FAKE_HOME, "coop", "app")}`);
    expect(pushed.stdout).toContain("BASE=origin/coop/base-add-test");
    expect(pushed.stderr).toContain("NÃO vão para o servidor");

    // The worker commits in the server clone and pushes coop/<slug> to the bare repo.
    const clone = path.join(env.FAKE_HOME, "coop", "app");
    expect(await git(clone, "ls-tree", "--name-only", "origin/coop/base-add-test")).toBe("a.txt");
    await git(clone, "checkout", "-q", "-b", "coop/add-test", "origin/coop/base-add-test");
    writeFileSync(path.join(clone, "b.txt"), "trabalho remoto\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "remote work");
    await git(clone, "push", "-q", "origin", "HEAD:refs/heads/coop/add-test");

    const fetched = await run(script("code-sync.sh"), ["fetch", "vps", "add-test"], { cwd: dir, env });
    expect(fetched.stdout).toContain("REF=coop-vps/coop/add-test");
    expect(fetched.stdout).toContain("remote work");
    expect(fetched.stdout).toContain("b.txt");
  });

  it("refuses a repository listed in blockedRepos", async () => {
    const dir = await repo("payments-ms");
    writeFileSync(path.join(env.COOP_HOME, "config.json"), JSON.stringify({ blockedRepos: ["payments-ms"] }));
    await expect(run(script("code-sync.sh"), ["push", "vps", "x"], { cwd: dir, env })).rejects.toMatchObject({ stderr: expect.stringContaining("blockedRepos") });
  });

  it("explains a missing worker branch", async () => {
    const dir = await repo();
    await run(script("code-sync.sh"), ["push", "vps", "y"], { cwd: dir, env });
    await expect(run(script("code-sync.sh"), ["fetch", "vps", "y"], { cwd: dir, env })).rejects.toMatchObject({ stderr: expect.stringContaining("ainda não fez push") });
  });
});

describe("pair.sh", () => {
  const SECRET = "orca://pair?code=S3CR3T-pairing&host=127.0.0.1";

  it("hands the pairing link to orca without printing it, then redacts the server log", async () => {
    const log = path.join(env.FAKE_HOME, ".carbon-coop", "serve.log");
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, `{"listening":"127.0.0.1:16768"}\n{"pairingUrl":"${SECRET}"}\n`);

    const { stdout, stderr } = await run(script("pair.sh"), ["vps"], { env });

    expect(stdout + stderr).not.toContain("S3CR3T");
    expect(stdout).toContain("pareado: coop-vps");
    expect(readFileSync(env.FAKE_ORCA_LOG, "utf8")).toContain(`environment add --name coop-vps --pairing-code ${SECRET}`);
    expect(readFileSync(log, "utf8")).not.toContain("orca://pair");
    expect(readFileSync(path.join(env.COOP_HOME, "vps", "pair.json"), "utf8")).not.toContain("S3CR3T");
  });

  it("still redacts the fresh link a restarted server printed when the environment is already paired", async () => {
    const log = path.join(env.FAKE_HOME, ".carbon-coop", "serve.log");
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, `{"pairingUrl":"${SECRET}"}\n`);

    const { stdout } = await run(script("pair.sh"), ["vps"], { env: { ...env, FAKE_PAIRED: "1" } });

    expect(stdout).toContain("já pareado: coop-vps");
    expect(readFileSync(log, "utf8")).not.toContain("orca://pair");
  });

  it("fails clearly when the server has no link", async () => {
    await expect(run(script("pair.sh"), ["vps"], { env })).rejects.toMatchObject({ stderr: expect.stringContaining("não tem link de pareamento") });
  });
});

describe("preflight.sh", () => {
  it("reports a server that does not accept the SSH key, without asking for a password", async () => {
    const result = await run(script("preflight.sh"), ["vps"], { env: { ...env, FAKE_SSH_FAIL: "1" } }).catch((error) => error);
    expect(result.stdout).toMatch(/^FALTA ssh carbon@example\.test não entra por chave/m);
    expect(result.code).toBeGreaterThanOrEqual(1);
  });
});

describe("proxy.sh with the port already taken", () => {
  async function occupy(handler) {
    const server = http.createServer(handler);
    const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
    await run(script("init.sh"), ["busy", "carbon@example.test", "--proxy-port", String(port)], { env }).catch(() => {});
    return { server, port };
  }

  it("refuses a program that is not a carbon auth proxy", async () => {
    const { server } = await occupy((_q, r) => r.end("outra coisa"));
    await expect(run(script("proxy.sh"), ["start", "busy"], { env })).rejects.toMatchObject({ stderr: expect.stringContaining("não é um carbon-auth-proxy") });
    server.close();
  });

  it("reuses a carbon auth proxy proven by its identity route", async () => {
    const { server, port } = await occupy((q, r) => r.end(q.url === "/__carbon-auth-proxy" ? "carbon-auth-proxy" : "x"));
    const { stdout } = await run(script("proxy.sh"), ["start", "busy"], { env });
    expect(stdout).toContain(`porta ${port} já tem um carbon-auth-proxy`);
    server.close();
  });
});

describe("embedded auth proxy", () => {
  it("is byte-identical to bin/claude-auth-proxy.mjs (the skill must not depend on the Carbon checkout)", () => {
    const repoRoot = path.resolve(here, "../../..");
    expect(readFileSync(script("claude-auth-proxy.mjs"), "utf8")).toBe(readFileSync(path.join(repoRoot, "bin", "claude-auth-proxy.mjs"), "utf8"));
  });
});
