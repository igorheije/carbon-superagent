import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { NO_COMMITS_REF, type ClaimedTask, type CodeSource, type ContextFile } from "@/shared/worker-protocol";
import { cleanup, commitAll, deliverCode, prepareCode } from "./code";

// Real git in a temp folder: a bare local "origin", panel-made bundles and a fake git wrapper
// that records argv to prove the token never leaves the environment.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-code-"));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const ID = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string => execFileSync("git", [...ID, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const IDENTITY = { name: "Carbon Agent", email: "carbon@localhost" };
const BRANCH = "agent/eng-1-abc123";
let counter = 0;
const dir = (name: string): string => {
  const d = path.join(sandbox, `${name}-${++counter}`);
  mkdirSync(d, { recursive: true });
  return d;
};

function task(code: CodeSource, files: ContextFile[] = []): ClaimedTask {
  return {
    taskId: `t${counter}-id`,
    key: "ENG-1",
    leaseMs: 60_000,
    executor: "claude",
    model: { model: null, effort: null, label: "auto", reason: "teste" },
    prompt: "p",
    resume: null,
    code,
    limits: { maxRunMinutes: 10 },
    permissionRules: [],
    settings: { permissionProfile: "guarded", isolateClaudeConfig: false, approvalPolicy: "ask" },
    files,
  };
}

/** Source repo with one commit on main, plus a bare clone acting as origin. */
function remote(): { source: string; bare: string } {
  const source = dir("source");
  git(source, "init", "-q", "-b", "main");
  writeFileSync(path.join(source, "README.md"), "# projeto\n");
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "init");
  const bare = path.join(dir("bare"), "origin.git");
  git(sandbox, "clone", "-q", "--bare", source, bare);
  // Partial clones of a local path need the server side to allow filters.
  git(bare, "config", "uploadpack.allowFilter", "true");
  return { source, bare };
}

const gitCode = (bare: string): CodeSource => ({ transport: "git", remoteUrl: `file://${bare}`, baseRef: "main", branch: BRANCH });

const CONTEXT: ContextFile[] = [
  { path: ".carbon/PROJECT_MAP.md", content: "# mapa\n" },
  { path: ".claude/skills/carbon-x/SKILL.md", content: "skill\n" },
  { path: "docs/contexto.md", content: "contexto\n" },
];

describe("git transport", () => {
  it("clones, commits, pushes and the branch shows up in the remote", async () => {
    const { bare } = remote();
    const t = task(gitCode(bare), CONTEXT);
    const prepared = await prepareCode(t, dir("work"));
    expect(prepared.baseCommit).toBe(git(bare, "rev-parse", "main"));
    expect(git(prepared.path, "branch", "--show-current")).toBe(BRANCH);
    expect(readFileSync(path.join(prepared.path, ".carbon/PROJECT_MAP.md"), "utf8")).toBe("# mapa\n");

    writeFileSync(path.join(prepared.path, "README.md"), "# projeto\nmudança\n");
    const commit = await commitAll(prepared.path, "feat: mudança", IDENTITY);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const delivered = await deliverCode(prepared.path, t, { allowBundleFallback: false });
    expect(delivered).toEqual({ transport: "push", commit });
    expect(git(bare, "rev-parse", BRANCH)).toBe(commit);

    cleanup(prepared.path);
    expect(existsSync(prepared.path)).toBe(false);
  });

  it("does not commit context files", async () => {
    const { bare } = remote();
    const prepared = await prepareCode(task(gitCode(bare), CONTEXT), dir("work"));
    writeFileSync(path.join(prepared.path, "novo.txt"), "x\n");
    await commitAll(prepared.path, "feat: novo", IDENTITY);
    const tracked = git(prepared.path, "ls-tree", "-r", "--name-only", "HEAD").split("\n");
    expect(tracked).toContain("novo.txt");
    for (const file of CONTEXT) expect(tracked).not.toContain(file.path);
  });

  it("returns null when nothing changed", async () => {
    const { bare } = remote();
    const prepared = await prepareCode(task(gitCode(bare), CONTEXT), dir("work"));
    expect(await commitAll(prepared.path, "nada", IDENTITY)).toBeNull();
  });

  it("falls back to a bundle when the push is refused", async () => {
    const { bare } = remote();
    const hook = path.join(bare, "hooks", "pre-receive");
    writeFileSync(hook, "#!/bin/sh\necho recusado >&2\nexit 1\n");
    chmodSync(hook, 0o755);
    const t = task(gitCode(bare));
    const prepared = await prepareCode(t, dir("work"));
    writeFileSync(path.join(prepared.path, "a.txt"), "a\n");
    const commit = await commitAll(prepared.path, "feat: a", IDENTITY);

    await expect(deliverCode(prepared.path, t, { allowBundleFallback: false })).rejects.toThrow(/push falhou/);
    const delivered = await deliverCode(prepared.path, t, { allowBundleFallback: true });
    expect(delivered.transport).toBe("bundle");
    if (delivered.transport !== "bundle") return;
    expect(delivered.commit).toBe(commit);

    // The panel side: the bundle needs only the base it already has.
    const panel = dir("panel");
    git(panel, "clone", "-q", bare, "repo");
    const repo = path.join(panel, "repo");
    git(repo, "bundle", "verify", delivered.bundleFile);
    git(repo, "fetch", "-q", delivered.bundleFile, `${BRANCH}:${BRANCH}`);
    expect(git(repo, "rev-parse", BRANCH)).toBe(commit);
    cleanup(prepared.path);
    expect(existsSync(delivered.bundleFile)).toBe(false);
  });
});

describe("bundle transport", () => {
  it("restores from the panel bundle and returns an incremental bundle", async () => {
    const { source } = remote();
    const base = path.join(dir("dl"), "base.bundle");
    git(source, "bundle", "create", "-q", base, "main");
    const t = task({ transport: "bundle", baseRef: "main", branch: BRANCH, bundleUrl: "/api/worker/tasks/x/bundle" }, CONTEXT);
    const prepared = await prepareCode(t, dir("work"), { bundleFile: base });
    expect(prepared.baseCommit).toBe(git(source, "rev-parse", "main"));
    expect(git(prepared.path, "branch", "--show-current")).toBe(BRANCH);

    writeFileSync(path.join(prepared.path, "b.txt"), "b\n");
    const commit = await commitAll(prepared.path, "feat: b", IDENTITY);
    const delivered = await deliverCode(prepared.path, t, { allowBundleFallback: false });
    expect(delivered.transport).toBe("bundle");
    if (delivered.transport !== "bundle") return;
    // Incremental: requires the base commit as prerequisite.
    expect(git(source, "bundle", "list-heads", delivered.bundleFile)).toContain(`refs/heads/${BRANCH}`);
    git(source, "fetch", "-q", delivered.bundleFile, `${BRANCH}:${BRANCH}`);
    expect(git(source, "rev-parse", BRANCH)).toBe(commit);
    expect(git(source, "ls-tree", "-r", "--name-only", BRANCH)).not.toContain(".carbon/PROJECT_MAP.md");
  });

  it("handles a repo without commits (snapshot baseline on the task branch)", async () => {
    const panelRepo = dir("unborn");
    git(panelRepo, "init", "-q", "-b", "main");
    git(panelRepo, "checkout", "-q", "--orphan", BRANCH);
    writeFileSync(path.join(panelRepo, "app.txt"), "app\n");
    git(panelRepo, "add", "-A");
    git(panelRepo, "commit", "-q", "-m", "chore: baseline snapshot");
    const baseline = git(panelRepo, "rev-parse", "HEAD");
    const base = path.join(dir("dl"), "base.bundle");
    git(panelRepo, "bundle", "create", "-q", base, `refs/heads/${BRANCH}`);

    const t = task({ transport: "bundle", baseRef: NO_COMMITS_REF, branch: BRANCH, bundleUrl: "/x" });
    const prepared = await prepareCode(t, dir("work"), { bundleFile: base });
    expect(prepared.baseCommit).toBeNull();
    expect(git(prepared.path, "rev-parse", "HEAD")).toBe(baseline);

    writeFileSync(path.join(prepared.path, "app.txt"), "app v2\n");
    const commit = await commitAll(prepared.path, "feat: v2", IDENTITY);
    const delivered = await deliverCode(prepared.path, t, { allowBundleFallback: false });
    if (delivered.transport !== "bundle") throw new Error("esperava bundle");
    // Whole branch: a fresh repo can import it with no prerequisites.
    const fresh = dir("fresh");
    git(fresh, "init", "-q");
    git(fresh, "fetch", "-q", delivered.bundleFile, `${BRANCH}:${BRANCH}`);
    expect(git(fresh, "rev-parse", BRANCH)).toBe(commit);
  });

  it("fails clearly when the bundle was not downloaded or lacks the base", async () => {
    const { source } = remote();
    const base = path.join(dir("dl"), "base.bundle");
    git(source, "bundle", "create", "-q", base, "main");
    const code: CodeSource = { transport: "bundle", baseRef: "develop", branch: BRANCH, bundleUrl: "/x" };
    await expect(prepareCode(task(code), dir("work"))).rejects.toThrow(/bundle da base/);
    await expect(prepareCode(task(code), dir("work"), { bundleFile: base })).rejects.toThrow(/não contém a base/);
  });
});

describe("context file safety", () => {
  it.each(["../fora.txt", "/etc/x", "a/../../fora.txt", ".git/hooks/pre-commit"])("rejects %s", async (bad) => {
    const { bare } = remote();
    const work = dir("work");
    await expect(prepareCode(task(gitCode(bare), [{ path: bad, content: "x" }]), work)).rejects.toThrow(/recusado/);
    expect(existsSync(path.join(work, "fora.txt"))).toBe(false);
  });

  it("refuses to write through a symlink that leaves the clone", async () => {
    const { source } = remote();
    const outside = dir("outside");
    symlinkSync(outside, path.join(source, ".carbon"));
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "link");
    const base = path.join(dir("dl"), "base.bundle");
    git(source, "bundle", "create", "-q", base, "main");
    const t = task({ transport: "bundle", baseRef: "main", branch: BRANCH, bundleUrl: "/x" }, [{ path: ".carbon/PROJECT_MAP.md", content: "x" }]);
    await expect(prepareCode(t, dir("work"), { bundleFile: base })).rejects.toThrow(/sai do repositório/);
    expect(existsSync(path.join(outside, "PROJECT_MAP.md"))).toBe(false);
  });

  it("rejects an invalid branch name", async () => {
    const { bare } = remote();
    await expect(prepareCode(task({ ...gitCode(bare), branch: "-x bad..name" }), dir("work"))).rejects.toThrow(/branch inválido/);
  });
});

describe("git token", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it("reaches git only through askpass: never in argv nor .git/config", async () => {
    const TOKEN = "ghs_secretToken123456";
    const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const fake = dir("fakegit");
    const argvLog = path.join(fake, "argv.log");
    const askLog = path.join(fake, "askpass.log");
    // Wrapper: records argv and environment-visible askpass answer, then runs the real git.
    writeFileSync(
      path.join(fake, "git"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${argvLog}"
if [ -n "$GIT_ASKPASS" ]; then "$GIT_ASKPASS" "Username for 'https://x':" >> "${askLog}"; "$GIT_ASKPASS" "Password for 'https://x':" >> "${askLog}"; fi
exec "${realGit}" "$@"
`,
      { mode: 0o755 },
    );
    process.env.PATH = `${fake}${path.delimiter}${originalPath ?? ""}`;

    const { bare } = remote();
    const t = task(gitCode(bare));
    const prepared = await prepareCode(t, dir("work"), { gitToken: TOKEN });
    writeFileSync(path.join(prepared.path, "c.txt"), "c\n");
    await commitAll(prepared.path, "feat: c", IDENTITY);
    const delivered = await deliverCode(prepared.path, t, { gitToken: TOKEN, allowBundleFallback: false });
    expect(delivered.transport).toBe("push");

    expect(readFileSync(argvLog, "utf8")).toMatch(/clone/);
    expect(readFileSync(argvLog, "utf8")).not.toContain(TOKEN);
    expect(readFileSync(askLog, "utf8")).toContain(TOKEN);
    expect(readFileSync(askLog, "utf8")).toContain("x-access-token");
    expect(readFileSync(path.join(prepared.path, ".git", "config"), "utf8")).not.toContain(TOKEN);
    expect(git(prepared.path, "remote", "get-url", "origin")).not.toContain(TOKEN);
  });
});
