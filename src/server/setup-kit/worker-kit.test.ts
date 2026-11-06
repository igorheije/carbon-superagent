import { describe, expect, it } from "vitest";
import { hasYamlParser, KIT_OPTIONS, parseYaml } from "./kit-test-utils";
import { assertKitOptions, SetupKitError, slugifyWorkerName, toYaml, validateKitOptions } from "./worker-kit";

describe("validateKitOptions", () => {
  it("accepts the fixture", () => {
    expect(validateKitOptions(KIT_OPTIONS)).toEqual([]);
  });

  it.each([
    ["newline in workerName", { workerName: "maquina\nkind: Pod" }],
    ["uppercase workerName", { workerName: "Maquina" }],
    ["workerName too long", { workerName: "a".repeat(41) }],
    ["workerName with trailing hyphen", { workerName: "maquina-" }],
    ["quote in panelUrl", { panelUrl: 'https://x.local/"; rm -rf /' }],
    ["newline in panelUrl", { panelUrl: "https://x.local\nCARBON_GIT_TOKEN=x" }],
    ["$ in panelUrl", { panelUrl: "https://x.local/${HOME}" }],
    ["credentials in panelUrl", { panelUrl: "https://user:pass@x.local" }],
    ["non-http panelUrl", { panelUrl: "ftp://x.local" }],
    ["bad token prefix", { token: "abc_" + "x".repeat(43) }],
    ["token with newline", { token: `cwk_${"x".repeat(42)}\n` }],
    ["image with space", { image: "ghcr.io/acme/carbon worker" }],
    ["image with $", { image: "ghcr.io/acme/${IMG}" }],
    ["replicas 0", { replicas: 0 }],
    ["fractional parallel", { parallel: 1.5 }],
    ["no executors", { executors: [] }],
    ["unknown executor", { executors: ["gpt"] }],
    ["cpu with injection", { cpu: "1\n" }],
    ["memory without binary suffix", { memory: "4G" }],
  ])("rejects %s", (_label, patch) => {
    const errors = validateKitOptions({ ...KIT_OPTIONS, ...patch } as typeof KIT_OPTIONS);
    expect(errors.length).toBeGreaterThan(0);
    expect(() => assertKitOptions({ ...KIT_OPTIONS, ...patch } as typeof KIT_OPTIONS)).toThrow(SetupKitError);
  });

  it("does not echo the token in error messages", () => {
    const bad = { ...KIT_OPTIONS, token: "segredo-que-nao-pode-vazar" };
    expect(validateKitOptions(bad).join(" ")).not.toContain("segredo-que-nao-pode-vazar");
  });

  it("de-duplicates executors", () => {
    expect(assertKitOptions({ ...KIT_OPTIONS, executors: ["claude", "claude"] }).executors).toEqual(["claude"]);
  });
});

describe("slugifyWorkerName", () => {
  it("turns free-form names into DNS labels", () => {
    expect(slugifyWorkerName("Máquina do João #2")).toBe("maquina-do-joao-2");
    expect(slugifyWorkerName("  --  ")).toBe("worker");
    expect(slugifyWorkerName("x".repeat(80))).toHaveLength(40);
    expect(validateKitOptions({ ...KIT_OPTIONS, workerName: slugifyWorkerName("Linha 1\nLinha 2: ataque") })).toEqual([]);
  });
});

describe("toYaml", () => {
  it("quotes every string so special characters cannot change the structure", () => {
    const tricky = { a: 'linha1\nlinha2: "x" # não é comentário', "chave com espaço": ["- item", "{}", "yes", ""], n: 3, b: false, e: {}, l: [] };
    const yaml = toYaml(tricky, ["comentário"]);
    expect(yaml.startsWith("# comentário\n")).toBe(true);
    expect(yaml).toContain('a: "linha1\\nlinha2: \\"x\\" # não é comentário"');
    if (hasYamlParser) expect(parseYaml(yaml)).toEqual(tricky);
  });

  it("emits sequences of mappings in block style", () => {
    expect(toYaml({ list: [{ name: "a", value: "1" }, {}] })).toBe('list:\n  - name: "a"\n    value: "1"\n  - {}\n');
  });
});
