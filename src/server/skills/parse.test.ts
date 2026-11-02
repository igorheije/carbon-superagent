import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../auth/password";
import { normalizeSkillUrl, parseSkillMarkdown, toSkillMarkdown } from "./parse";

const VALID = `---
name: api-review
description: Revisa contratos de API REST antes de abrir PR.
---

# API review
Checar versionamento, paginação e códigos de erro.
`;

describe("parseSkillMarkdown", () => {
  it("parses a valid SKILL.md", () => {
    const result = parseSkillMarkdown(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skill.name).toBe("api-review");
  });

  it("supports folded descriptions", () => {
    const md = VALID.replace("description: Revisa contratos de API REST antes de abrir PR.", "description: >\n  Revisa contratos\n  de API REST.");
    const result = parseSkillMarkdown(md);
    expect(result.ok && result.skill.description).toBe("Revisa contratos de API REST.");
  });

  it("rejects missing frontmatter and invalid names", () => {
    expect(parseSkillMarkdown("# sem frontmatter").ok).toBe(false);
    const bad = parseSkillMarkdown(VALID.replace("api-review", "API Review"));
    expect(bad.ok).toBe(false);
  });

  it("round-trips through toSkillMarkdown", () => {
    const first = parseSkillMarkdown(VALID);
    if (!first.ok) throw new Error("expected ok");
    const again = parseSkillMarkdown(toSkillMarkdown(first.skill));
    expect(again).toEqual(first);
  });
});

describe("normalizeSkillUrl", () => {
  it("converts github blob urls to raw", () => {
    expect(normalizeSkillUrl("https://github.com/acme/skills/blob/main/x/SKILL.md")).toBe(
      "https://raw.githubusercontent.com/acme/skills/main/x/SKILL.md",
    );
  });

  it("rejects non-github hosts, http and credentials (SSRF guard)", () => {
    expect(normalizeSkillUrl("https://evil.example.com/SKILL.md")).toBeNull();
    expect(normalizeSkillUrl("http://raw.githubusercontent.com/a/b/c")).toBeNull();
    expect(normalizeSkillUrl("https://user:pw@raw.githubusercontent.com/a/b/c")).toBeNull();
    expect(normalizeSkillUrl("https://169.254.169.254/latest")).toBeNull();
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong", stored)).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});
