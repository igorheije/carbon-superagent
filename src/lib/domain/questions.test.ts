import { describe, expect, it } from "vitest";
import { answerFromOption, inferOptions, optionsOf } from "./questions";
import type { AgentQuestion } from "./types";

const FRG1 =
  "Antes do push para o GitHub privado, preciso de duas definições. (a) Qual o nome do repositório (owner/repo)? (b) O que fazer com os 238 arquivos de mídia e saída (out/, public/, work/, *.mp4) já commitados no commit-base: A) tirar do repo antes do push (recomendo; os arquivos continuam no seu disco) ou B) subir como está?";

const question = (over: Partial<AgentQuestion> = {}): AgentQuestion => ({
  id: "q1", stage: "reflect", text: FRG1, askedAt: "", answer: null, answeredBy: null, answeredAt: null, ...over,
});

describe("inferOptions", () => {
  it("finds lettered options in a question written as text", () => {
    expect(inferOptions(FRG1)).toEqual([
      { label: "A) tirar do repo antes do push", detail: "os arquivos continuam no seu disco", recommended: true },
      { label: "B) subir como está", detail: null, recommended: false },
    ]);
  });

  it("returns nothing for open questions", () => {
    expect(inferOptions("Qual o nome do repositório?")).toEqual([]);
    expect(inferOptions("Use A) apenas")).toEqual([]);
  });
});

describe("optionsOf", () => {
  it("prefers the options the agent sent", () => {
    const sent = [{ label: "leolegends/instagram", detail: "privado, novo", recommended: true }];
    expect(optionsOf(question({ options: sent }))).toBe(sent);
    expect(optionsOf(question())).toHaveLength(2);
  });

  it("turns an option into the answer text", () => {
    expect(answerFromOption({ label: "B) subir como está", detail: null, recommended: false })).toBe("B) subir como está");
    expect(answerFromOption({ label: "A) tirar", detail: "continuam no disco", recommended: true })).toBe("A) tirar — continuam no disco");
  });
});
