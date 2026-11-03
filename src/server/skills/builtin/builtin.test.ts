import { describe, expect, it } from "vitest";
import { PERSONA_IDS } from "@/lib/domain/personas";
import { parseSkillMarkdown, skillInputSchema, toSkillMarkdown } from "../parse";
import { BUILTIN_SKILLS } from "./index";

const PROTOCOL_MARKERS = new Set(["STAGE", "PLAN", "DONE", "SKIPPED", "TESTS", "FINDING", "LESSON", "QUESTION", "OPTION"]);
/** Engineering gets the most; product, design, QA and data still get a solid baseline. */
const MIN_SKILLS_PER_PERSONA = 8;

describe("built-in skills", () => {
  const names = BUILTIN_SKILLS.map((s) => s.name);

  it("ships the harness collection with unique carbon- names", () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(28);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("carbon-")).toBe(true);
  });

  it("every skill passes the same validation as user skills and survives SKILL.md round-trip", () => {
    for (const skill of BUILTIN_SKILLS) {
      const input = { name: skill.name, description: skill.description, body: skill.body };
      expect(skillInputSchema.safeParse(input).success, skill.name).toBe(true);
      const parsed = parseSkillMarkdown(toSkillMarkdown(input));
      expect(parsed.ok && parsed.skill.name === skill.name && parsed.skill.description === skill.description, skill.name).toBe(true);
    }
  });

  it("only targets real personas and gives every persona a useful set", () => {
    for (const skill of BUILTIN_SKILLS) for (const p of skill.personas) expect(PERSONA_IDS).toContain(p);
    for (const persona of PERSONA_IDS) {
      const count = BUILTIN_SKILLS.filter((s) => s.personas.length === 0 || s.personas.includes(persona)).length;
      expect(count, persona).toBeGreaterThanOrEqual(MIN_SKILLS_PER_PERSONA);
    }
  });

  it("only cites protocol markers and skills that exist", () => {
    for (const skill of BUILTIN_SKILLS) {
      for (const [, marker] of skill.body.matchAll(/CARBON_([A-Z]+)/g)) expect(PROTOCOL_MARKERS.has(marker ?? ""), `${skill.name}: CARBON_${marker}`).toBe(true);
      for (const [cited] of skill.body.matchAll(/carbon-[a-z0-9-]+/g)) expect(names, `${skill.name} cita ${cited}`).toContain(cited);
    }
  });

  it("never tells the agent to commit or push (Carbon delivers)", () => {
    for (const skill of BUILTIN_SKILLS) expect(skill.body, skill.name).not.toMatch(/\bgit (commit|push)\b/);
  });
});
