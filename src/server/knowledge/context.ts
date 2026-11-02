import "server-only";
import { getOverview, listIndexedFiles, neighbors, searchFiles, type KbOverview } from "./store";

const RELEVANT = 8;
const MAX_MAP_FILES = 600;
const MAX_SYMBOLS_IN_MAP = 8;

export interface KnowledgeContext {
  /** Compact section injected into the agent prompt. */
  readonly prompt: string;
  /** Full map written into the worktree (.carbon/PROJECT_MAP.md, never committed). */
  readonly mapMarkdown: string;
  readonly relevant: readonly { readonly path: string; readonly score: number; readonly summary: string }[];
}

function header(o: KbOverview): string {
  return [
    `Stack: ${o.stack.join(", ") || "n/d"}`,
    `Comandos: ${o.scripts.map((s) => `\`${s.name}\``).join(", ") || "n/d"}`,
    `Pontos de entrada: ${o.entryPoints.join(", ") || "n/d"}`,
    `Diretórios principais: ${o.dirs.slice(0, 12).map((d) => `${d.dir} (${d.files})`).join(", ")}`,
    `Arquivos centrais (mais importados): ${o.hubs.slice(0, 10).map((h) => h.path).join(", ") || "n/d"}`,
  ].join("\n");
}

function fullMap(projectId: string, o: KbOverview): string {
  const rows = listIndexedFiles(projectId, MAX_MAP_FILES);
  const lines = rows.map((r) => {
    const symbols = (JSON.parse(r.symbols) as string[]).slice(0, MAX_SYMBOLS_IN_MAP).join(", ");
    return `- \`${r.path}\` [${r.kind}]${symbols ? ` — ${symbols}` : ""}${r.summary ? ` — ${r.summary.slice(0, 120)}` : ""}`;
  });
  return `# Mapa do projeto (gerado pelo Carbon)\n\nIndexado em ${o.indexedAt} · commit ${o.commit.slice(0, 8)} · ${o.fileCount} arquivos · ${o.edgeCount} conexões de import\n\n${o.aiSummary ? `## Visão geral\n\n${o.aiSummary}\n\n` : ""}## Estrutura\n\n${header(o)}\n\n## Arquivos\n\n${lines.join("\n")}\n`;
}

/** Retrieval for one task: the project map plus the files most likely to matter. */
export function buildKnowledgeContext(projectId: string, title: string, description: string): KnowledgeContext | null {
  const overview = getOverview(projectId);
  if (!overview) return null;
  const hits = searchFiles(projectId, `${title} ${title} ${description}`, RELEVANT);
  const related = neighbors(projectId, hits.slice(0, 4).map((h) => h.path), 8);
  const relevantList = hits.length
    ? hits.map((h) => `- \`${h.path}\` (relevância ${h.score.toFixed(2)})${h.symbols.length ? ` — exporta: ${h.symbols.slice(0, 6).join(", ")}` : ""}${h.summary ? ` — ${h.summary.slice(0, 140)}` : ""}`).join("\n")
    : "- (nenhum arquivo casou com a tarefa; use o mapa)";
  const prompt = `## Project knowledge (pre-indexed — use it instead of exploring the whole repo)
${overview.aiSummary ? `### What this project does\n${overview.aiSummary.slice(0, 2500)}\n\n` : ""}### Structure
${header(overview)}

### Files most likely relevant to this task (full-text + symbol search)
${relevantList}
${related.length ? `\nConnected through imports: ${related.map((p) => `\`${p}\``).join(", ")}` : ""}

The full file map with exported symbols is at .carbon/PROJECT_MAP.md. Start research from the files above; open others only when needed.`;
  return {
    prompt,
    mapMarkdown: fullMap(projectId, overview),
    relevant: hits.map((h) => ({ path: h.path, score: h.score, summary: h.summary })),
  };
}
