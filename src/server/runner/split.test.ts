import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { parseMarkers } from "@/shared/executors/protocol";
import { applyExecutorEvent, emptyContext } from "./apply";
import { distributedPhase, integrateSection, SPLIT_SECTION, subtaskSection } from "./split-prompt";

// Distributed task, end to end on the panel's own runner: a fake `claude` on PATH plays the three
// phases (split → parts → integrate), with real git worktrees and merges in a throwaway repo.
const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-split-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

const IDENTITY = ["-c", "user.name=Test", "-c", "user.email=test@localhost", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Fake Claude Code: reads the stream-json prompt from stdin and acts by phase. SAME_FILE makes both parts edit one file. */
const FAKE_CLAUDE = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log("fake-claude 1.0"); process.exit(0); }
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const say = (text) => out({ type: "assistant", message: { content: [{ type: "text", text }] } });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  if (!buf.includes("\\n")) return;
  const prompt = JSON.stringify(JSON.parse(buf.slice(0, buf.indexOf("\\n"))));
  const same = process.env.SAME_FILE === "1";
  out({ type: "system", subtype: "init", session_id: "sess-" + Math.random().toString(16).slice(2), model: "fake" });
  say("CARBON_PLAN: fazer a parte que me cabe");
  if (prompt.includes("## Distributed mode")) {
    writeFileSync("shared.txt", "contrato comum\\n");
    say("CARBON_SUBTASK: parte A | " + (same ? "same.txt" : "a.txt") + " | crie o arquivo com A");
    say("CARBON_SUBTASK: parte B | " + (same ? "same.txt" : "b.txt") + " | crie o arquivo com B");
  } else if (prompt.includes("You are one part")) {
    const mine = prompt.includes("crie o arquivo com A") ? "A" : "B";
    writeFileSync(same ? "same.txt" : mine.toLowerCase() + ".txt", "parte " + mine + "\\n");
  } else if (prompt.includes("Integration of the distributed parts")) {
    writeFileSync("integration.txt", prompt.includes("conflicted") ? "conflito resolvido\\n" : "integrado\\n");
  } else {
    writeFileSync("plain.txt", "tarefa comum\\n");
  }
  say("CARBON_DONE: 1");
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 } });
  process.exit(0);
});
`;

type Modules = {
  db: typeof import("@/server/db");
  tasks: typeof import("@/server/repo/tasks");
  projects: typeof import("@/server/repo/projects");
  users: typeof import("@/server/repo/users");
  settings: typeof import("@/server/repo/settings");
  runner: typeof import("./runner");
  split: typeof import("./split");
};
let m: Modules;
let repo = "";
let projectId = "";
let userId = "";

beforeAll(async () => {
  const bin = path.join(sandbox, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(path.join(bin, "claude"), 0o755);
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  m = {
    db: await import("@/server/db"),
    tasks: await import("@/server/repo/tasks"),
    projects: await import("@/server/repo/projects"),
    users: await import("@/server/repo/users"),
    settings: await import("@/server/repo/settings"),
    runner: await import("./runner"),
    split: await import("./split"),
  };
  userId = m.users.createUser({ email: "a@b.c", name: "Ana", passwordHash: "x", persona: "engineering", role: "admin", mustChangePassword: false }).id;
});
afterAll(() => {
  m.runner.shutdownRunner();
  rmSync(sandbox, { recursive: true, force: true });
});
beforeEach(() => {
  repo = mkdtempSync(path.join(sandbox, "repo-"));
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(path.join(repo, "README.md"), "# repo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  m.db.getDb().exec("DELETE FROM tasks; DELETE FROM projects");
  projectId = m.projects.createProject({ name: "demo", repoPath: repo, baseBranch: "main" }).id;
  m.settings.saveSettings({ autoPush: false, permissionProfile: "unrestricted", useClaudeMemory: false });
  m.runner.setEnabled(true);
});

function newTask(distributed: boolean) {
  return m.tasks.createTask({
    projectId, key: null, title: "feature grande", description: "duas partes independentes", source: "manual", sourceRef: null,
    requesterId: userId, requesterName: "Ana", persona: "engineering", executor: "claude", model: "auto", effort: "auto",
    priority: "medium", repo: "demo", modelLabel: "fake", runtime: "local", distributed,
  });
}

/** Drives the runner like the panel does: kick + reconcile, until the task is final. */
async function runUntilFinal(id: string, timeoutMs = 40_000): Promise<Ticket> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    m.split.reconcileSplits();
    m.runner.kick();
    const task = m.tasks.findTask(id);
    if (task && (task.status === "done" || task.status === "failed") && !m.runner.runnerStatus().activeTaskId) return task.snapshot;
    if (Date.now() > deadline) throw new Error(`timeout: ${task?.status} · ${task?.snapshot.logs.map((l) => l.text).join(" | ")}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

const show = (ref: string) => git(repo, "show", ref);

describe("distributed task · end to end on the local runner", () => {
  it("splits, runs the parts, merges them and delivers one branch with everything", async () => {
    const parent = newTask(true);
    const done = await runUntilFinal(parent.id);

    expect(done.status).toBe("done");
    expect(done.split?.phase).toBe("done");
    expect(done.split?.children.map((c) => [c.key, c.merge])).toEqual([[`${parent.key}.1`, "merged"], [`${parent.key}.2`, "merged"]]);
    const branch = done.workspace?.branch ?? "";
    expect(show(`${branch}:shared.txt`)).toBe("contrato comum");
    expect(show(`${branch}:a.txt`)).toBe("parte A");
    expect(show(`${branch}:b.txt`)).toBe("parte B");
    expect(show(`${branch}:integration.txt`)).toBe("integrado");
    expect(done.diff.map((d) => d.path).sort()).toEqual(["a.txt", "b.txt", "integration.txt", "shared.txt"]);

    for (const ref of done.split?.children ?? []) {
      const child = m.tasks.findTask(ref.id)?.snapshot;
      expect(child?.status).toBe("done");
      expect(child?.parent?.key).toBe(parent.key);
      expect(child?.pr).toBeNull();
      expect(child?.logs.some((l) => l.text.includes("a tarefa principal integra"))).toBe(true);
    }
    expect(done.logs.some((l) => l.text.includes("tarefa dividida em 2 parte(s)"))).toBe(true);
  });

  it("a part sent to a remote machine starts from the parent branch through a bundle", async () => {
    const parent = newTask(true);
    const done = await runUntilFinal(parent.id);
    const branch = done.workspace?.branch ?? "";
    const child = m.tasks.findTask(done.split?.children[0]?.id ?? "");
    const { planCode } = await import("./prepare-claim");
    git(repo, "remote", "add", "origin", "https://example.invalid/repo.git");
    const plan = await planCode(repo, child?.snapshot.baseBranch ?? "", child!);
    expect(child?.snapshot.baseBranch).toBe(branch);
    expect(plan.code).toMatchObject({ transport: "bundle", baseRef: branch });
  });

  it("a conflict between parts is aborted and handed to the agent as a patch", async () => {
    process.env.SAME_FILE = "1";
    try {
      const parent = newTask(true);
      const done = await runUntilFinal(parent.id);
      expect(done.status).toBe("done");
      expect(done.split?.children.map((c) => c.merge)).toEqual(["merged", "conflict"]);
      expect(show(`${done.workspace?.branch}:integration.txt`)).toBe("conflito resolvido");
      expect(git(repo, "status", "--porcelain")).toBe("");
    } finally {
      delete process.env.SAME_FILE;
    }
  });

  it("an ordinary task ignores the distributed protocol", async () => {
    const plain = newTask(false);
    const done = await runUntilFinal(plain.id);
    expect(done.status).toBe("done");
    expect(done.split).toBeUndefined();
    expect(show(`${done.workspace?.branch}:plain.txt`)).toBe("tarefa comum");
  });
});

describe("CARBON_SUBTASK marker", () => {
  it("parses title, files and brief, and rejects unsafe or incomplete lines", () => {
    expect(parseMarkers("CARBON_SUBTASK: API | src/api/*.ts, ./src/db.ts | crie a rota | com testes")).toEqual([
      { kind: "subtask", title: "API", files: ["src/api/*.ts", "src/db.ts"], brief: "crie a rota | com testes" },
    ]);
    for (const bad of ["CARBON_SUBTASK: API | | brief", "CARBON_SUBTASK: API | ../etc/passwd | x", "CARBON_SUBTASK: API | /abs.ts | x", "CARBON_SUBTASK: | a.ts | x", "CARBON_SUBTASK: API | a.ts |"]) {
      expect(parseMarkers(bad)).toEqual([]);
    }
  });

  const base = { id: "t", key: "FRG-1", logs: [], stage: "plan" } as unknown as Ticket;
  const text = (t: string) => ({ type: "text" as const, text: t });

  it("is collected only by a distributed task that has not split, capped at 4 and deduplicated", () => {
    const lines = ["a", "b", "b", "c", "d", "e"].map((n) => `CARBON_SUBTASK: parte ${n} | ${n}.ts | faça ${n}`).join("\n");
    const distributed = applyExecutorEvent({ ...base, distributed: true }, emptyContext, text(lines));
    expect(distributed.ctx.subtasks.map((s) => s.title)).toEqual(["parte a", "parte b", "parte c", "parte d"]);
    expect(applyExecutorEvent(base, emptyContext, text(lines)).ctx.subtasks).toEqual([]);
    const child = { ...base, distributed: true, parent: { id: "p", key: "FRG-0", title: "x" } };
    expect(applyExecutorEvent(child, emptyContext, text(lines)).ctx.subtasks).toEqual([]);
  });
});

describe("distributed prompt sections", () => {
  it("picks the phase from the ticket", () => {
    const t = { distributed: true } as Ticket;
    expect(distributedPhase(t)).toBe("split");
    expect(distributedPhase({ ...t, split: { phase: "running", children: [], createdAt: "" } })).toBeNull();
    expect(distributedPhase({ ...t, split: { phase: "integrating", children: [], createdAt: "" } })).toBe("integrate");
    expect(distributedPhase({ parent: { id: "p", key: "K", title: "x" }, subtask: { title: "a", files: ["a"], brief: "b" } } as unknown as Ticket)).toBe("subtask");
    expect(distributedPhase({} as Ticket)).toBeNull();
  });

  it("writes the split rules, the subtask boundaries and the merge report", () => {
    expect(SPLIT_SECTION).toContain("CARBON_SUBTASK: <short title>");
    const sub = subtaskSection({ parentKey: "FRG-9", parentTitle: "grande", brief: "faça A", files: ["a.ts"] });
    expect(sub).toContain("FRG-9");
    expect(sub).toContain("`a.ts`");
    expect(sub).toContain("never print CARBON_SUBTASK");
    const report = integrateSection([
      { key: "FRG-9.1", title: "A", result: "merged" },
      { key: "FRG-9.2", title: "B", result: "conflict", detail: "+linha" },
      { key: "FRG-9.3", title: "C", result: "failed", detail: "boom" },
    ]);
    expect(report).toContain("FRG-9.1 · A: merged cleanly");
    expect(report).toContain("```diff\n+linha\n```");
    expect(report).toContain("boom");
  });
});
