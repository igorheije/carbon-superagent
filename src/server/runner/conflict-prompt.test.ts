import { describe, expect, it } from "vitest";
import { conflictSection } from "./prompt";

describe("conflictSection", () => {
  const section = conflictSection("main", ["README.md", "src/a.ts"]);

  it("allows only a no-commit merge of the target and lists the files", () => {
    expect(section).toContain("git merge --no-commit --no-ff main");
    expect(section).toContain("- README.md\n- src/a.ts");
    expect(section).toContain("Do NOT run `git commit`");
  });

  it("asks to keep both sides and to ask a human instead of guessing", () => {
    expect(section).toMatch(/BOTH intentions survive/);
    expect(section).toContain("CARBON_QUESTION");
  });
});
