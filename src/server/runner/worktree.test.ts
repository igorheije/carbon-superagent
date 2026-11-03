import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prepareWorktree, resolveBase } from "./worktree";

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost"];
let sandbox = "";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function makeRepo(name: string, branch: string, withCommit: boolean): string {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", branch);
  writeFileSync(path.join(dir, "README.md"), "# projeto\n");
  writeFileSync(path.join(dir, ".gitignore"), "segredo.env\n");
  writeFileSync(path.join(dir, "segredo.env"), "TOKEN=nao-copiar\n");
  if (withCommit) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

beforeEach(() => {
  sandbox = mkdtempSync(path.join(tmpdir(), "carbon-wt-"));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("resolveBase", () => {
  it("falls back to the branch that exists when the configured base is missing", async () => {
    const repo = makeRepo("legacy", "master", true);
    const base = await resolveBase(repo, "main");
    expect(base).toMatchObject({ ref: "master", prBase: "master" });
    expect(base?.note).toContain('a base "main" não existe');
  });

  it("uses origin/<base> when the branch only exists on the remote", async () => {
    const origin = makeRepo("origin", "main", true);
    git(origin, "branch", "staging");
    const clone = path.join(sandbox, "clone");
    git(sandbox, "clone", "-q", origin, clone);
    const base = await resolveBase(clone, "staging");
    expect(base).toMatchObject({ ref: "origin/staging", prBase: "staging" });
  });

  it("returns null for a repository without commits", async () => {
    expect(await resolveBase(makeRepo("empty", "main", false), "main")).toBeNull();
  });
});

describe("prepareWorktree", () => {
  it("creates the worktree from a fallback base instead of failing", async () => {
    const repo = makeRepo("legacy", "master", true);
    const wt = await prepareWorktree(repo, "main", "FRG-1", "abcdef123", path.join(sandbox, "wts"));
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(wt.prBase).toBe("master");
    expect(wt.notes.join(" ")).toContain("não existe");
  });

  it("snapshots an unborn repository into an orphan branch without touching the user's branch", async () => {
    const repo = makeRepo("unborn", "main", false);
    const wt = await prepareWorktree(repo, "main", "FRG-1", "abcdef123", path.join(sandbox, "wts"));
    expect(readFileSync(path.join(wt.path, "README.md"), "utf8")).toBe("# projeto\n");
    expect(existsSync(path.join(wt.path, "segredo.env"))).toBe(false);
    expect(git(wt.path, "log", "--oneline")).toContain("baseline snapshot");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
    expect(wt.prBase).toBeNull();
    expect(() => git(repo, "rev-parse", "--verify", "HEAD")).toThrow();
  });

  it("leaves generated folders and large files out of the snapshot, listing what was omitted", async () => {
    const repo = makeRepo("media", "main", false);
    mkdirSync(path.join(repo, "motion", ".venv", "lib"), { recursive: true });
    writeFileSync(path.join(repo, "motion", ".venv", "lib", "pkg.py"), "x = 1\n");
    mkdirSync(path.join(repo, "out"), { recursive: true });
    writeFileSync(path.join(repo, "out", "video.mp4"), Buffer.alloc(11 * 1024 * 1024));
    const wt = await prepareWorktree(repo, "main", "FRG-1", "abcdef123", path.join(sandbox, "wts"));
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(existsSync(path.join(wt.path, "motion", ".venv"))).toBe(false);
    expect(existsSync(path.join(wt.path, "out", "video.mp4"))).toBe(false);
    expect(readFileSync(path.join(wt.path, ".carbon", "OMITTED_FILES.md"), "utf8")).toContain("out/video.mp4");
    expect(wt.notes.join(" ")).toContain("ficaram fora da cópia");
    expect(git(wt.path, "status", "--porcelain")).toBe("");
  });

  it("reuses the task branch when its folder was deleted after an earlier attempt", async () => {
    const repo = makeRepo("repo", "main", true);
    const root = path.join(sandbox, "wts");
    const first = await prepareWorktree(repo, "main", "FRG-2", "abcdef123", root);
    writeFileSync(path.join(first.path, "trabalho.txt"), "feito\n");
    git(first.path, "add", "-A");
    git(first.path, "commit", "-q", "-m", "trabalho do agente");
    rmSync(first.path, { recursive: true, force: true });

    const again = await prepareWorktree(repo, "main", "FRG-2", "abcdef123", root);
    expect(readFileSync(path.join(again.path, "trabalho.txt"), "utf8")).toBe("feito\n");
    expect(again.notes.join(" ")).toContain("reaproveitado");
  });

  it("moves an invalid leftover folder aside and starts clean", async () => {
    const repo = makeRepo("repo", "main", true);
    const root = path.join(sandbox, "wts");
    mkdirSync(path.join(root, "frg-3-abcdef"), { recursive: true });
    writeFileSync(path.join(root, "frg-3-abcdef", "lixo.txt"), "x");
    const wt = await prepareWorktree(repo, "main", "FRG-3", "abcdef123", root);
    expect(existsSync(path.join(wt.path, "README.md"))).toBe(true);
    expect(wt.notes.join(" ")).toContain("movida");
  });
});
