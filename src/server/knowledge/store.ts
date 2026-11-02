import "server-only";
import { getDb } from "../db";
import type { FileKind, ScannedFile } from "./scan";

export interface KbOverview {
  readonly repoPath: string;
  readonly commit: string;
  readonly indexedAt: string;
  readonly fileCount: number;
  readonly edgeCount: number;
  readonly languages: readonly { readonly lang: string; readonly files: number }[];
  readonly stack: readonly string[];
  readonly scripts: readonly { readonly name: string; readonly command: string }[];
  readonly dirs: readonly { readonly dir: string; readonly files: number }[];
  readonly hubs: readonly { readonly path: string; readonly inDegree: number }[];
  readonly entryPoints: readonly string[];
  readonly aiSummary: string | null;
}

export interface KbFileRow {
  readonly path: string;
  readonly lang: string;
  readonly kind: FileKind;
  readonly symbols: readonly string[];
  readonly summary: string;
  readonly inDegree: number;
  readonly outDegree: number;
}

interface RawFileRow {
  path: string;
  lang: string;
  kind: string;
  symbols: string;
  summary: string;
  in_degree: number;
  out_degree: number;
}

const MAX_BODY = 8000;

const toRow = (r: RawFileRow): KbFileRow => ({
  path: r.path,
  lang: r.lang,
  kind: r.kind as FileKind,
  symbols: JSON.parse(r.symbols) as string[],
  summary: r.summary,
  inDegree: r.in_degree,
  outDegree: r.out_degree,
});

/** Replaces one project's index atomically: a reader never sees a half-written graph. */
export function replaceIndex(
  projectId: string,
  files: readonly (ScannedFile & { readonly size: number; readonly body: string })[],
  edges: readonly (readonly [string, string])[],
): void {
  const db = getDb();
  const inDeg = new Map<string, number>();
  const outDeg = new Map<string, number>();
  for (const [src, dst] of edges) {
    outDeg.set(src, (outDeg.get(src) ?? 0) + 1);
    inDeg.set(dst, (inDeg.get(dst) ?? 0) + 1);
  }
  db.exec("BEGIN");
  try {
    for (const table of ["kb_files", "kb_edges", "kb_fts"]) db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
    const insertFile = db.prepare(
      "INSERT INTO kb_files (project_id, path, lang, kind, size, symbols, summary, in_degree, out_degree) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const insertFts = db.prepare("INSERT INTO kb_fts (project_id, file, path, symbols, body) VALUES (?, ?, ?, ?, ?)");
    for (const f of files) {
      insertFile.run(projectId, f.path, f.lang, f.kind, f.size, JSON.stringify(f.symbols), f.summary, inDeg.get(f.path) ?? 0, outDeg.get(f.path) ?? 0);
      // Path segments are split so "rate-limit" also matches "rate" and "limit".
      insertFts.run(projectId, f.path, f.path.replace(/[/._-]+/g, " "), f.symbols.join(" "), `${f.summary}\n${f.body.slice(0, MAX_BODY)}`);
    }
    const insertEdge = db.prepare("INSERT OR IGNORE INTO kb_edges (project_id, src, dst) VALUES (?, ?, ?)");
    for (const [src, dst] of edges) insertEdge.run(projectId, src, dst);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveOverview(projectId: string, overview: KbOverview): void {
  getDb()
    .prepare("INSERT INTO kb_meta (project_id, key, value) VALUES (?, 'overview', ?) ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value")
    .run(projectId, JSON.stringify(overview));
}

export function getOverview(projectId: string): KbOverview | null {
  const row = getDb().prepare("SELECT value FROM kb_meta WHERE project_id = ? AND key = 'overview'").get(projectId) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as KbOverview;
  } catch {
    return null;
  }
}

/** Turns free text into a safe FTS5 OR-query of word prefixes (no operators from users). */
export function toFtsQuery(text: string): string | null {
  const words = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2)
    .slice(0, 24);
  const unique = [...new Set(words)];
  return unique.length ? unique.map((w) => `"${w}"*`).join(" OR ") : null;
}

export function searchFiles(projectId: string, text: string, limit = 10): readonly (KbFileRow & { readonly score: number })[] {
  const query = toFtsQuery(text);
  if (!query) return [];
  const rows = getDb()
    .prepare(
      `SELECT f.*, bm25(kb_fts, 0.0, 0.0, 4.0, 3.0, 1.0) AS rank
       FROM kb_fts JOIN kb_files f ON f.project_id = kb_fts.project_id AND f.path = kb_fts.file
       WHERE kb_fts MATCH ? AND kb_fts.project_id = ? ORDER BY rank LIMIT ?`,
    )
    .all(query, projectId, limit) as unknown as (RawFileRow & { rank: number })[];
  return rows.length ? normalize(rows) : [];
}

/** bm25 is "lower is better" and unbounded: map the result set to a readable 0.35..1 range. */
function normalize(rows: readonly (RawFileRow & { rank: number })[]) {
  const best = rows[0]?.rank ?? 0;
  const worst = rows.at(-1)?.rank ?? 0;
  const span = worst - best;
  return rows.map((r) => ({ ...toRow(r), score: span === 0 ? 1 : 0.35 + (0.65 * (worst - r.rank)) / span }));
}

export function neighbors(projectId: string, paths: readonly string[], limit = 12): readonly string[] {
  if (paths.length === 0) return [];
  const marks = paths.map(() => "?").join(",");
  const rows = getDb()
    .prepare(
      `SELECT dst AS p FROM kb_edges WHERE project_id = ? AND src IN (${marks})
       UNION SELECT src AS p FROM kb_edges WHERE project_id = ? AND dst IN (${marks}) LIMIT ?`,
    )
    .all(projectId, ...paths, projectId, ...paths, limit) as unknown as { p: string }[];
  const seen = new Set(paths);
  return rows.map((r) => r.p).filter((p) => !seen.has(p));
}

/** Top files by connectivity, for the knowledge graph view. */
export function graphSample(projectId: string, limit = 120): { readonly files: readonly KbFileRow[]; readonly edges: readonly (readonly [string, string])[] } {
  const db = getDb();
  const files = (db
    .prepare("SELECT * FROM kb_files WHERE project_id = ? ORDER BY (in_degree * 2 + out_degree) DESC, kind = 'doc' DESC LIMIT ?")
    .all(projectId, limit) as unknown as RawFileRow[]).map(toRow);
  const set = new Set(files.map((f) => f.path));
  const edges = (db.prepare("SELECT src, dst FROM kb_edges WHERE project_id = ?").all(projectId) as unknown as { src: string; dst: string }[])
    .filter((e) => set.has(e.src) && set.has(e.dst))
    .map((e) => [e.src, e.dst] as const);
  return { files, edges };
}

/** Full file list for the project map written into worktrees. */
export function listIndexedFiles(projectId: string, limit: number): readonly { path: string; kind: string; symbols: string; summary: string }[] {
  return getDb()
    .prepare("SELECT path, kind, symbols, summary FROM kb_files WHERE project_id = ? ORDER BY path LIMIT ?")
    .all(projectId, limit) as unknown as { path: string; kind: string; symbols: string; summary: string }[];
}
