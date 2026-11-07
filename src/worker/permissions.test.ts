import { describe, expect, it } from "vitest";
import { answerPermission } from "./permissions";

const settings = { permissionProfile: "guarded", isolateClaudeConfig: false, approvalPolicy: "smart" } as const;
const ask = (command: string) => ({ type: "permission_request", requestId: "r1", tool: "Bash", input: { command }, summary: command, suggestions: [] }) as unknown as Parameters<typeof answerPermission>[0];

describe("answerPermission on the worker with a task in \"sem pedir permissão\" mode", () => {
  it("approves ordinary work by itself and says why", () => {
    const outcome = answerPermission(ask("npm install"), "/clone", settings, [], false, true);
    expect(outcome?.decision.behavior).toBe("allow");
    expect(JSON.stringify(outcome?.report)).toContain("tarefa sem pedir permissão");
  });

  it("forwards infrastructure commands to a human even in that mode (e.g. docker on a production host)", () => {
    expect(answerPermission(ask("docker image prune -a -f"), "/clone", settings, [], false, true)).toBeNull();
  });

  it("without the mode, the same ordinary command still goes to a human", () => {
    expect(answerPermission(ask("npm install"), "/clone", settings, [], false, false)).toBeNull();
  });
});
