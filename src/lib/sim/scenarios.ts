import type { TicketSpec } from "./script";

/**
 * Demo tickets. Repos, people and code are fictional placeholders used only
 * by the simulator (phase F0); real data arrives via GitHub/Linear in F1.
 */
export const DEMO_SPECS: readonly TicketSpec[] = [
  {
    id: "t1",
    key: "ENG-142",
    title: "Rate limit no endpoint de login",
    source: "linear",
    repo: "demo/api-gateway",
    requester: "ana.dev",
    priority: "urgent",
    plan: [
      "Mapear middleware de auth e store disponível",
      "Implementar limiter por IP + conta (sliding window)",
      "Cobrir 429, reset de janela e bypass interno com testes",
      "Revisar segurança (enumeração de usuário, headers)",
      "Abrir PR e atualizar issue no Linear",
    ],
    hits: [
      { id: "h1", kind: "code", ref: "src/middleware/auth.ts:12-58", score: 0.92, excerpt: "export function requireSession(req, res, next) {…" },
      { id: "h2", kind: "doc", ref: "docs/adr/007-redis-cache.md", score: 0.84, excerpt: "Redis é o store compartilhado para estado efêmero…" },
      { id: "h3", kind: "ticket", ref: "ENG-98 · PR #311", score: 0.77, excerpt: "rate limit do /otp usou janela fixa; review pediu sliding window" },
      { id: "h4", kind: "lesson", ref: "lição L-07", score: 0.71, excerpt: "headers Retry-After obrigatórios em respostas 429" },
    ],
    files: [
      { path: "src/middleware/rate-limit.ts", additions: 64, deletions: 0, snippet: ["+export const loginLimiter = slidingWindow({", "+  key: (req) => `${req.ip}:${req.body.email}`,", "+  limit: 5, windowMs: 60_000,", "+})"] },
      { path: "src/routes/auth.ts", additions: 3, deletions: 1, snippet: ["-router.post('/login', login)", "+router.post('/login', loginLimiter, login)"] },
      { path: "tests/rate-limit.test.ts", additions: 88, deletions: 0, snippet: ["+it('returns 429 with Retry-After after 5 attempts', …)"] },
    ],
    tests: { added: 6, total: 214, flakyFirstRun: true },
    findings: [
      { severity: "HIGH", text: "chave do limiter expõe e-mail em log de debug" },
      { severity: "LOW", text: "extrair 60_000 para constante nomeada" },
    ],
    prNumber: 482,
    lesson: {
      rule: "Ao testar rate limiters, isolar o store por teste (beforeEach) para evitar vazamento de janela",
      evidence: "1ª execução falhou: expected 429, received 200 (ENG-142)",
      scope: "demo/api-gateway · tests/**",
      confidence: 0.82,
    },
  },
  {
    id: "t2",
    key: "ENG-157",
    title: "Paginação por cursor na listagem de agendamentos",
    source: "linear",
    repo: "demo/api-gateway",
    requester: "bruno.pm",
    priority: "high",
    plan: [
      "Ler contrato atual da listagem e consumidores",
      "Trocar offset por cursor opaco mantendo compatibilidade",
      "Testes de borda: página vazia, cursor inválido, último item",
      "Revisar índice e plano de query",
      "Abrir PR com nota de migração no contrato",
    ],
    hits: [
      { id: "h5", kind: "code", ref: "src/modules/schedule/list.ts:1-74", score: 0.9, excerpt: "const rows = await db.select().offset(page * size)…" },
      { id: "h6", kind: "doc", ref: "docs/api/pagination.md", score: 0.81, excerpt: "Novos endpoints usam cursor base64url(id, createdAt)…" },
      { id: "h7", kind: "lesson", ref: "lição L-03", score: 0.74, excerpt: "validar cursor com zod antes de decodificar" },
    ],
    files: [
      { path: "src/modules/schedule/list.ts", additions: 41, deletions: 18, snippet: ["-  .offset(page * size)", "+  .where(gt(schedule.id, cursor.id))", "+  .limit(size + 1)"] },
      { path: "src/lib/cursor.ts", additions: 27, deletions: 0, snippet: ["+export const cursorSchema = z.object({ id: z.string(), ts: z.number() })"] },
      { path: "tests/schedule-list.test.ts", additions: 73, deletions: 4, snippet: ["+it('rejects tampered cursor with 400', …)"] },
    ],
    tests: { added: 9, total: 223, flakyFirstRun: false },
    findings: [{ severity: "MEDIUM", text: "considerar índice composto (created_at, id)" }],
    prNumber: 483,
    lesson: {
      rule: "Mudança de paginação exige nota de compatibilidade no PR e manter `page` como fallback por 1 release",
      evidence: "consumidores legados identificados via RAG (ENG-157)",
      scope: "demo/api-gateway · src/modules/**",
      confidence: 0.68,
    },
  },
  {
    id: "t3",
    key: "#219",
    title: "Corrigir estado vazio quebrado no dashboard do RH",
    source: "github",
    repo: "demo/web-app",
    requester: "carla.fe",
    priority: "medium",
    plan: [
      "Reproduzir estado vazio com fixture sem dados",
      "Corrigir componente e adicionar skeleton acessível",
      "Teste de componente + snapshot visual",
      "Revisar a11y (contraste, aria-live)",
      "Abrir PR e responder na issue",
    ],
    hits: [
      { id: "h8", kind: "code", ref: "src/features/dashboard/Overview.tsx", score: 0.88, excerpt: "data.items.map(…) // crash quando items undefined" },
      { id: "h9", kind: "doc", ref: "design-system/README.md#empty-states", score: 0.79, excerpt: "Estado vazio: título, uma frase, uma ação primária" },
    ],
    files: [
      { path: "src/features/dashboard/Overview.tsx", additions: 22, deletions: 6, snippet: ["-  {data.items.map(renderRow)}", "+  {items.length === 0 ? <EmptyState … /> : items.map(renderRow)}"] },
      { path: "src/features/dashboard/Overview.test.tsx", additions: 35, deletions: 0, snippet: ["+it('renders empty state when there are no items', …)"] },
    ],
    tests: { added: 3, total: 141, flakyFirstRun: false },
    findings: [{ severity: "LOW", text: "aria-live='polite' no contêiner de carregamento" }],
    prNumber: 220,
    lesson: {
      rule: "Componentes de listagem do web-app devem tratar `items` ausente como lista vazia na borda (parse com zod)",
      evidence: "crash reproduzido com fixture vazia (#219)",
      scope: "demo/web-app · src/features/**",
      confidence: 0.74,
    },
  },
];
