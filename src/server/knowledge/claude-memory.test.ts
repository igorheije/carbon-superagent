import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeConfigDirs, claudeProjectSlug, MEMORY_WORKTREE_DIR, memoryPromptSection, readRepoMemory } from "./claude-memory";

describe("claudeProjectSlug", () => {
  it("replaces every non-alphanumeric character with a dash, like Claude Code", () => {
    expect(claudeProjectSlug("/Users/ana/Projects/my.app")).toBe("-Users-ana-Projects-my-app");
    expect(claudeProjectSlug("/private/tmp/claude-501/x_y")).toBe("-private-tmp-claude-501-x-y");
  });
});

describe("claudeConfigDirs", () => {
  it("prefers CLAUDE_CONFIG_DIR, then ~/.claude, without duplicates", () => {
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: "/cfg" }, "/home/ana")).toEqual(["/cfg", "/home/ana/.claude"]);
    expect(claudeConfigDirs({}, "/home/ana")).toEqual(["/home/ana/.claude"]);
    expect(claudeConfigDirs({ CLAUDE_CONFIG_DIR: "/home/ana/.claude" }, "/home/ana")).toEqual(["/home/ana/.claude"]);
  });
});

describe("readRepoMemory", () => {
  let root: string;
  let configDir: string;
  const repo = "/Users/ana/Projects/shop";
  const memoryDir = () => path.join(configDir, "projects", claudeProjectSlug(repo), "memory");

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "carbon-mem-"));
    configDir = path.join(root, "cfg");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("returns null when the repository has no Claude memory", () => {
    expect(readRepoMemory(repo, { configDirs: [configDir] })).toBeNull();
  });

  it("reads MEMORY.md first, then the other markdown files in name order", () => {
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(path.join(memoryDir(), "b-rule.md"), "use pnpm");
    writeFileSync(path.join(memoryDir(), "a-user.md"), "senior backend dev");
    writeFileSync(path.join(memoryDir(), "MEMORY.md"), "- [Rule](b-rule.md)");
    writeFileSync(path.join(memoryDir(), "notes.txt"), "ignored");

    const memory = readRepoMemory(repo, { configDirs: [configDir] });

    expect(memory?.dir).toBe(memoryDir());
    expect(memory?.files.map((f) => f.name)).toEqual(["MEMORY.md", "a-user.md", "b-rule.md"]);
    expect(memory?.isTruncated).toBe(false);
  });

  it("uses the first config dir that has memory for the repo", () => {
    const other = path.join(root, "home-claude");
    const dir = path.join(other, "projects", claudeProjectSlug(repo), "memory");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "MEMORY.md"), "from home");

    const memory = readRepoMemory(repo, { configDirs: [configDir, other] });

    expect(memory?.files[0]?.content).toBe("from home");
  });

  it("caps each file and the number of files, flagging truncation", () => {
    mkdirSync(memoryDir(), { recursive: true });
    writeFileSync(path.join(memoryDir(), "a.md"), "x".repeat(500));
    writeFileSync(path.join(memoryDir(), "b.md"), "y".repeat(500));
    writeFileSync(path.join(memoryDir(), "c.md"), "z".repeat(500));

    const memory = readRepoMemory(repo, { configDirs: [configDir], maxFileBytes: 300, maxFiles: 2 });

    expect(memory?.files.map((f) => f.content.length)).toEqual([300, 300]);
    expect(memory?.isTruncated).toBe(true);
  });

  it("skips symlinks so the memory folder cannot pull in files from elsewhere", () => {
    mkdirSync(memoryDir(), { recursive: true });
    const secret = path.join(root, "secret.md");
    writeFileSync(secret, "TOKEN=abc");
    symlinkSync(secret, path.join(memoryDir(), "link.md"));
    writeFileSync(path.join(memoryDir(), "MEMORY.md"), "ok");

    const memory = readRepoMemory(repo, { configDirs: [configDir] });

    expect(memory?.files.map((f) => f.name)).toEqual(["MEMORY.md"]);
  });

  it("returns null when the folder exists but holds no markdown", () => {
    mkdirSync(memoryDir(), { recursive: true });
    expect(readRepoMemory(repo, { configDirs: [configDir] })).toBeNull();
  });
});

describe("memoryPromptSection", () => {
  it("fences each file and states that the task rules take precedence", () => {
    const section = memoryPromptSection({ dir: "/m", files: [{ name: "MEMORY.md", content: "use pnpm" }], isTruncated: false });
    expect(section).toContain("## Claude Code memory for this repository");
    expect(section).toContain('<memory-file name="MEMORY.md">\nuse pnpm\n</memory-file>');
    expect(section).toContain("rules above take precedence");
    expect(section).not.toContain("More memory files");
  });

  it("inlines what fits the budget and lists the rest by worktree path", () => {
    const files = [
      { name: "MEMORY.md", content: "index" },
      { name: "a.md", content: "a".repeat(10) },
      { name: "b.md", content: "b".repeat(10) },
    ];
    const section = memoryPromptSection({ dir: "/m", files, isTruncated: false }, 16);
    expect(section).toContain('<memory-file name="a.md">');
    expect(section).not.toContain('<memory-file name="b.md">');
    expect(section).toContain(`- ${MEMORY_WORKTREE_DIR}/b.md`);
  });
});
