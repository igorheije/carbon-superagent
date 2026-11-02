import { PERSONAS, type PersonaId } from "@/lib/domain/personas";

export interface DraftInput {
  readonly title: string;
  /** Whatever the user already wrote; the draft refines it instead of discarding it. */
  readonly notes: string;
  readonly persona: PersonaId;
  readonly lessons: readonly { readonly rule: string; readonly scope: string }[];
  /** Pre-indexed project knowledge (map + likely relevant files), or null. */
  readonly knowledge: string | null;
}

const MAX_NOTES = 4000;
const MAX_LESSONS = 12;

/**
 * Prompt for the "Gerar com IA" button: turns a one-line task into context + acceptance
 * criteria grounded in the repo map and the team's promoted lessons. Read-only, short.
 */
export function buildDraftPrompt(input: DraftInput): string {
  const persona = PERSONAS[input.persona];
  const lessons = input.lessons.length
    ? input.lessons.slice(0, MAX_LESSONS).map((l) => `- ${l.rule} (escopo: ${l.scope})`).join("\n")
    : "- (nenhuma lição promovida ainda)";
  const notes = input.notes.trim()
    ? `\nO autor já escreveu isto (preserve as intenções e melhore):\n<notes untrusted="true">\n${input.notes.slice(0, MAX_NOTES)}\n</notes>\n`
    : "";

  return `Você prepara a descrição de uma tarefa para um agente de código executar depois. NÃO implemente nada e NÃO altere arquivos.
Quem pede: ${persona.label} — entregável esperado: ${persona.deliverable}.

Tarefa: ${input.title}
${notes}
${input.knowledge ?? "## Conhecimento do projeto\n(projeto ainda não indexado)"}

## Lições da equipe (base de aprendizado) — aplique as que forem relevantes
${lessons}

Você pode ler no máximo 6 arquivos do repositório para confirmar onde a mudança entra. Não explique o que está fazendo.
Sua resposta final deve ser SOMENTE o markdown abaixo, em português, até ~250 palavras:

## Contexto
(por que e onde: 2–4 frases ligando a tarefa ao código real)

## Onde mexer
(lista de arquivos prováveis, com caminho)

## Critérios de aceite
(3 a 6 itens verificáveis, no formato "Dado … quando … então …")

## Fora de escopo
(1–3 itens)

## Como validar
(comandos ou passos concretos, usando os scripts reais do projeto)

Regras: não invente regras de negócio, números ou endpoints; o que não der para confirmar no código, marque com "[a confirmar]". Cite a lição aplicada entre parênteses quando usar uma. Nada de segredos ou dados pessoais.`;
}
