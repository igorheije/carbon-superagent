import { describe, expect, it } from "vitest";
import { isValidModelName, resolveModel, routeTier } from "./models";

describe("routeTier", () => {
  it("routes small copy fixes to the fast tier", () => {
    expect(routeTier("Corrigir typo no README", "").tier).toBe("fast");
  });

  it("routes short, unspecific tasks to fast", () => {
    expect(routeTier("Adicionar função subtract", "Exportar subtract em math.js").tier).toBe("fast");
  });

  it("routes broad or risky work to the deep tier with the reason", () => {
    const decision = routeTier("Refatorar auth", "Migrar sessões para tokens e revisar segurança do login");
    expect(decision.tier).toBe("deep");
    expect(decision.reason).toContain("refator");
  });

  it("treats tasks that cite many files as deep", () => {
    const description = "Mexer em src/a/x.ts, src/b/y.ts, src/c/z.ts e src/d/w.ts";
    expect(routeTier("Ajuste", description).tier).toBe("deep");
  });

  it("defaults to balanced for medium tasks", () => {
    const description = "Criar endpoint de listagem de agendamentos com filtro por data, validação de entrada e testes de integração cobrindo os casos de borda principais do fluxo.";
    expect(routeTier("Listagem com filtro", description).tier).toBe("balanced");
  });
});

describe("resolveModel", () => {
  it("maps auto model + auto effort to a Claude alias and effort", () => {
    const choice = resolveModel("claude", "auto", "Refatorar auth", "migração e segurança");
    expect(choice).toMatchObject({ model: "opus", effort: "high" });
    expect(choice.reason).toContain("profundo");
  });

  it("keeps the CLI model for Codex auto and only sets effort", () => {
    expect(resolveModel("codex", "auto", "Corrigir typo", "")).toMatchObject({ model: null, effort: "low" });
  });

  it("uses a manual effort with an auto model", () => {
    expect(resolveModel("claude", "auto", "Corrigir typo", "", "max")).toMatchObject({ model: "haiku", effort: "max" });
  });

  it("decides the effort from the task even when the model is manual", () => {
    const choice = resolveModel("claude", "sonnet", "Refatorar auth", "migração e segurança");
    expect(choice).toMatchObject({ model: "sonnet", effort: "high" });
    expect(choice.reason).toContain("modelo manual, esforço auto");
  });

  it("passes fully manual choices through", () => {
    expect(resolveModel("claude", "opus", "x", "", "low")).toMatchObject({ model: "opus", effort: "low", label: "opus · esforço low" });
    expect(resolveModel("codex", "default", "x", "", "medium")).toMatchObject({ model: null, effort: "medium" });
  });

  it("falls back to auto for an effort the executor does not support", () => {
    expect(resolveModel("codex", "default", "Corrigir typo", "", "max").effort).toBe("low");
  });
});

describe("isValidModelName", () => {
  it("accepts real-looking names and rejects shell-ish input", () => {
    expect(isValidModelName("gpt-5.1-codex")).toBe(true);
    expect(isValidModelName("claude-opus-5-5")).toBe(true);
    expect(isValidModelName("--dangerous")).toBe(false);
    expect(isValidModelName("a b")).toBe(false);
    expect(isValidModelName("x;rm -rf")).toBe(false);
  });
});
