import { describe, expect, it } from "vitest";
import type { PermissionPrompt, Ticket } from "@/lib/domain/types";
import { pendingPermissionsOf, resumeHint } from "./pending";

const prompt = (id: string, status: PermissionPrompt["status"], askedAt: string): PermissionPrompt => ({
  id, tool: "Bash", summary: "npm test", detail: "", canRemember: true, status, decidedBy: null, askedAt,
});
const ticket = (id: string, permissions: PermissionPrompt[]): Ticket => ({ id, key: id.toUpperCase(), permissions }) as unknown as Ticket;

describe("pendingPermissionsOf", () => {
  it("lists pending prompts of every task (not only the focused one), oldest first", () => {
    const a = ticket("a", [prompt("a1", "allowed", "2026-11-06T10:00:00Z"), prompt("a2", "pending", "2026-11-06T10:05:00Z")]);
    const b = ticket("b", [prompt("b1", "pending", "2026-11-06T10:01:00Z")]);
    const c = ticket("c", []);
    expect(pendingPermissionsOf([a, b, c]).map((p) => `${p.ticket.id}:${p.prompt.id}`)).toEqual(["b:b1", "a:a2"]);
    expect(pendingPermissionsOf([c, { ...c, permissions: undefined }])).toEqual([]);
  });
});

describe("resumeHint", () => {
  it("local: same worktree", () => {
    expect(resumeHint(undefined, true)).toBe("Um clique responde e a tarefa continua de onde parou, no mesmo worktree.");
    expect(resumeHint("local", false)).toBe("Ao responder, a tarefa continua de onde parou, no mesmo worktree. ⌘/Ctrl + Enter envia.");
  });

  it("remote: restarts from the base with the decisions in the prompt, never 'same worktree'", () => {
    expect(resumeHint("pool", true)).toBe("Um clique responde e a tarefa volta para a fila e recomeça da base em um worker do pool, com suas decisões no prompt.");
    expect(resumeHint("agentcore", false)).toContain("recomeça da base em uma nova sessão AgentCore");
    expect(resumeHint("agentcore", false)).not.toContain("mesmo worktree");
  });
});
