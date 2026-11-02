import { describe, expect, it } from "vitest";
import { buildDraftPrompt } from "./prompt";
import { cleanDraft, parseClaudeDraftLine, parseCodexDraftLine } from "./stream";

describe("buildDraftPrompt", () => {
  it("includes the task, promoted lessons, knowledge and the required sections", () => {
    const prompt = buildDraftPrompt({
      title: "Rate limit no login",
      notes: "",
      persona: "engineering",
      lessons: [{ rule: "Respostas 429 incluem Retry-After", scope: "api" }],
      knowledge: "## Project knowledge\n- src/auth.ts",
    });
    expect(prompt).toContain("Tarefa: Rate limit no login");
    expect(prompt).toContain("Respostas 429 incluem Retry-After");
    expect(prompt).toContain("src/auth.ts");
    for (const section of ["## Contexto", "## Onde mexer", "## Critérios de aceite", "## Fora de escopo", "## Como validar"]) {
      expect(prompt).toContain(section);
    }
    expect(prompt).toContain("[a confirmar]");
  });

  it("fences what the user already wrote as untrusted notes", () => {
    const prompt = buildDraftPrompt({ title: "x", notes: "manter compatibilidade", persona: "product", lessons: [], knowledge: null });
    expect(prompt).toMatch(/<notes untrusted="true">\nmanter compatibilidade\n<\/notes>/);
    expect(prompt).toContain("projeto ainda não indexado");
  });
});

describe("parseClaudeDraftLine", () => {
  it("streams text deltas and resets on each new message", () => {
    expect(parseClaudeDraftLine(JSON.stringify({ type: "stream_event", event: { type: "message_start" } }))).toEqual([{ type: "reset" }]);
    const delta = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "## Con" } } };
    expect(parseClaudeDraftLine(JSON.stringify(delta))).toEqual([{ type: "delta", text: "## Con" }]);
  });

  it("turns tool use into a status line and result into final/error", () => {
    const tool = { type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } }] } };
    expect(parseClaudeDraftLine(JSON.stringify(tool))).toEqual([{ type: "status", text: "lendo src/a.ts" }]);
    expect(parseClaudeDraftLine(JSON.stringify({ type: "result", subtype: "success", result: "## Contexto\nok" }))).toEqual([{ type: "final", text: "## Contexto\nok" }]);
    expect(parseClaudeDraftLine(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "" }))[0]?.type).toBe("error");
  });
});

describe("parseCodexDraftLine and cleanDraft", () => {
  it("uses the agent message as final text", () => {
    expect(parseCodexDraftLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "## Contexto" } }))).toEqual([{ type: "final", text: "## Contexto" }]);
  });

  it("drops a preface before the document", () => {
    expect(cleanDraft("Claro! Aqui está:\n\n## Contexto\nA")).toBe("## Contexto\nA");
    expect(cleanDraft("## Contexto\nA")).toBe("## Contexto\nA");
  });
});
