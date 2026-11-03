import { describe, expect, it } from "vitest";
import type { ModelChoice } from "@/lib/domain/models";
import type { Settings } from "../repo/settings";
import { buildPrompt } from "../runner/prompt";
import { buildCommand } from "./spawn";

const settings = { permissionProfile: "guarded", isolateClaudeConfig: false } as unknown as Settings;
const choice: ModelChoice = { model: "opus", effort: "high", label: "opus · high", reason: "teste" };

describe("buildCommand resume", () => {
  it("passes --resume to Claude Code when a session id is given", () => {
    const cmd = buildCommand("claude", "continue", "/wt", settings, choice, "ab7181dd-1111");
    const at = cmd.args.indexOf("--resume");
    expect(at).toBeGreaterThan(-1);
    expect(cmd.args[at + 1]).toBe("ab7181dd-1111");
    expect(cmd.stdinPrompt).toBe("continue");
  });

  it("starts a new Claude session without a session id", () => {
    expect(buildCommand("claude", "go", "/wt", settings, choice).args).not.toContain("--resume");
  });

  it("never resumes Codex (decisions travel in the prompt instead)", () => {
    expect(buildCommand("codex", "go", "/wt", settings, choice, "thread-1").args).not.toContain("--resume");
  });
});

describe("buildPrompt decisions", () => {
  const input = {
    key: "FRG-3",
    title: "README",
    description: "reescrever o README",
    persona: "engineering" as const,
    requester: "ana",
    skills: [],
    lessons: [],
    executor: "claude" as const,
    knowledge: null,
  };

  it("includes earlier human decisions when present", () => {
    const prompt = buildPrompt({ ...input, decisions: "## Decisions already made by the human\n1. Question: aprova?\n   Answer: sim" });
    expect(prompt).toContain("## Decisions already made by the human");
    expect(prompt.indexOf("Decisions already made")).toBeLessThan(prompt.indexOf("## Skills"));
  });

  it("tells the agent to check decisions before asking", () => {
    expect(buildPrompt(input)).toContain("Before asking, check whether the task description or the decisions below already answer it");
  });
});
