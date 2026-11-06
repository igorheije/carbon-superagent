import { describe, expect, it } from "vitest";
import { resolveExecutor } from "./resolve";

const onlyClaude = { claude: true, codex: false };
const onlyCodex = { claude: false, codex: true };
const both = { claude: true, codex: true };

describe("resolveExecutor", () => {
  it("uses the default when it is installed", () => {
    expect(resolveExecutor(undefined, "codex", both)).toEqual({ ok: true, executor: "codex" });
  });

  it("falls back to the other executor when the default is missing", () => {
    expect(resolveExecutor(undefined, "codex", onlyClaude)).toEqual({ ok: true, executor: "claude" });
    expect(resolveExecutor(undefined, "claude", onlyCodex)).toEqual({ ok: true, executor: "codex" });
  });

  it("accepts an explicit request for an installed executor", () => {
    expect(resolveExecutor("claude", "codex", onlyClaude)).toEqual({ ok: true, executor: "claude" });
  });

  it("rejects an explicit request for a missing executor with a clear message", () => {
    const result = resolveExecutor("codex", "claude", onlyClaude);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Codex não está instalado");
  });

  it("fails when neither executor is installed", () => {
    const result = resolveExecutor(undefined, "claude", { claude: false, codex: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("basta um");
  });
});
