import type { KnowledgeDoc } from "./retrieve";

/** Fictional demo corpus (F0). Real corpus is indexed from GitHub/Linear in F3. */
export const DEMO_CORPUS: readonly KnowledgeDoc[] = [
  { id: "c1", kind: "code", ref: "src/middleware/auth.ts", text: "requireSession middleware valida sessão login token cookie httpOnly", links: ["c2", "d1", "l1"] },
  { id: "c2", kind: "code", ref: "src/middleware/rate-limit.ts", text: "rate limit sliding window redis chave ip conta login 429 retry-after", links: ["d2", "l1", "t1"] },
  { id: "c3", kind: "code", ref: "src/routes/auth.ts", text: "rota login logout refresh token sessão", links: ["c1", "c2"] },
  { id: "c4", kind: "code", ref: "src/modules/schedule/list.ts", text: "listagem agendamentos paginação offset cursor query drizzle", links: ["d3", "l2", "t2"] },
  { id: "c5", kind: "code", ref: "src/lib/cursor.ts", text: "cursor opaco base64url zod validação paginação", links: ["c4", "l2"] },
  { id: "c6", kind: "code", ref: "src/features/dashboard/Overview.tsx", text: "dashboard rh overview lista itens estado vazio skeleton", links: ["d4", "t3"] },
  { id: "c7", kind: "code", ref: "src/lib/logger.ts", text: "logger pino redação pii email cpf mascarar log", links: ["l3", "d5"] },
  { id: "c8", kind: "code", ref: "tests/setup.ts", text: "setup testes vitest store isolado beforeEach redis mock", links: ["l4"] },
  { id: "d1", kind: "doc", ref: "docs/adr/004-sessoes.md", text: "ADR sessões cookie httpOnly samesite expiração refresh", links: ["c1"] },
  { id: "d2", kind: "doc", ref: "docs/adr/007-redis-cache.md", text: "ADR redis store compartilhado estado efêmero rate limit cache", links: ["c2"] },
  { id: "d3", kind: "doc", ref: "docs/api/pagination.md", text: "padrão paginação cursor base64url id createdAt compatibilidade page", links: ["c4", "c5"] },
  { id: "d4", kind: "doc", ref: "design-system/README.md", text: "design system estado vazio título frase ação primária acessibilidade contraste", links: ["c6"] },
  { id: "d5", kind: "doc", ref: "docs/lgpd.md", text: "LGPD dados pessoais dados sensíveis saúde minimização log redação", links: ["c7", "l3"] },
  { id: "t1", kind: "ticket", ref: "ENG-98 · PR #311", text: "rate limit otp janela fixa review pediu sliding window retry-after", links: ["c2", "l1"] },
  { id: "t2", kind: "ticket", ref: "ENG-61", text: "bug produção cursor adulterado quebrou listagem paginação", links: ["c4", "l2"] },
  { id: "t3", kind: "ticket", ref: "#204", text: "crash dashboard rh quando api retorna items undefined estado vazio", links: ["c6"] },
  { id: "l1", kind: "lesson", ref: "lição L-07", text: "respostas 429 incluem retry-after e não revelam se conta existe login rate limit", links: ["c2", "t1"] },
  { id: "l2", kind: "lesson", ref: "lição L-03", text: "validar cursor parâmetros opacos com zod antes de decodificar paginação", links: ["c5", "t2"] },
  { id: "l3", kind: "lesson", ref: "lição L-11", text: "nunca logar email ou chave com pii usar logger com redação lgpd", links: ["c7", "d5"] },
  { id: "l4", kind: "lesson", ref: "lição L-14", text: "isolar store redis por teste beforeEach evita vazamento de janela rate limit", links: ["c8", "c2"] },
];
