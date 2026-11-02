"use client";

import { useEffect, useMemo, useState } from "react";
import { AsciiReveal } from "ascii-reveal";
import { RefreshCw, Search } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { KnowledgeGraph } from "@/components/knowledge/KnowledgeGraph";
import { IndexProgress, useIndexStatus } from "@/components/setup/Launch";
import { Button } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/client/api";
import type { KnowledgeKind } from "@/lib/domain/types";
import { DEMO_CORPUS } from "@/lib/knowledge/corpus";
import { retrieve, type KnowledgeDoc } from "@/lib/knowledge/retrieve";

interface KbFile {
  readonly path: string;
  readonly kind: "code" | "test" | "doc" | "config";
  readonly symbols: readonly string[];
  readonly summary: string;
}

interface Result {
  readonly id: string;
  readonly ref: string;
  readonly text: string;
  readonly score: number;
}

const KIND_SHAPE: Readonly<Record<KbFile["kind"], KnowledgeKind>> = { code: "code", doc: "doc", test: "ticket", config: "lesson" };
const DEMO_SUGGESTIONS = ["rate limit login 429", "paginação cursor", "estado vazio dashboard", "lgpd log email"];
const LIVE_SUGGESTIONS = ["autenticação login", "rotas api", "testes", "banco de dados schema"];

function legend(isLive: boolean) {
  return [
    { kind: "code", label: "código", shape: "size-2.5 rounded-full bg-ink" },
    { kind: "doc", label: isLive ? "docs" : "docs / ADR", shape: "size-2.5 border border-ink" },
    { kind: "ticket", label: isLive ? "testes" : "tickets / PRs", shape: "size-2.5 rotate-45 bg-ink" },
    { kind: "lesson", label: isLive ? "config" : "lições", shape: "size-2.5 rounded-full border border-accent" },
  ];
}

function toDocs(files: readonly KbFile[], edges: readonly (readonly [string, string])[]): readonly KnowledgeDoc[] {
  const links = new Map<string, string[]>();
  for (const [src, dst] of edges) links.set(src, [...(links.get(src) ?? []), dst]);
  return files.map((f) => ({ id: f.path, kind: KIND_SHAPE[f.kind], ref: f.path, text: `${f.symbols.join(" ")} ${f.summary}`, links: links.get(f.path) ?? [] }));
}

export default function KnowledgePage() {
  const { mode } = useEngine();
  const isLive = mode === "live";
  const [version, setVersion] = useState(0);
  const [indexVersion, setIndexVersion] = useState(0);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly Result[]>([]);
  const [liveDocs, setLiveDocs] = useState<readonly KnowledgeDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { status, overview } = useIndexStatus(indexVersion);

  // Refetch only when a new index exists — polling returns a fresh object every tick,
  // and depending on it would rebuild (and visibly reset) the graph again and again.
  const indexedAt = overview?.indexedAt ?? null;
  useEffect(() => {
    if (!isLive || !indexedAt) return;
    api<{ files: KbFile[]; edges: [string, string][] }>("/api/knowledge/graph")
      .then((g) => setLiveDocs(toDocs(g.files, g.edges)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "falha ao carregar o grafo"));
  }, [isLive, indexedAt]);

  const corpus = isLive ? (liveDocs ?? []) : DEMO_CORPUS;
  const highlighted = useMemo(() => new Map(results.map((r) => [r.id, r.score])), [results]);

  const run = async (q: string) => {
    setQuery(q);
    setError(null);
    try {
      if (isLive) {
        const data = await api<{ results: (KbFile & { score: number })[] }>(`/api/knowledge/search?q=${encodeURIComponent(q)}`);
        setResults(data.results.map((r) => ({ id: r.path, ref: r.path, text: r.symbols.slice(0, 8).join(", ") || r.summary, score: r.score })));
      } else {
        setResults(retrieve(q, DEMO_CORPUS).map((r) => ({ id: r.doc.id, ref: r.doc.ref, text: r.doc.text, score: r.score })));
      }
      setVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha na busca");
    }
  };

  const reindex = async () => {
    try {
      await api("/api/knowledge/reindex", { body: { withSummary: true } });
      setIndexVersion((v) => v + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "falha ao reindexar");
    }
  };

  return (
    <div className="mx-auto flex max-w-[1400px] flex-col gap-5">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-2">
          <p className="eyebrow">{isLive ? "Grafo do seu repositório · imports + símbolos + busca" : "Demo · corpus de exemplo"}</p>
          <h1 className="text-[clamp(32px,4.5vw,52px)] font-semibold leading-[1.05] tracking-[-0.03em]">Base de conhecimento</h1>
          <p className="max-w-2xl text-[15px] leading-relaxed text-muted">
            Mapeada uma vez no setup e atualizada sozinha quando o repositório muda. Cada tarefa recebe o mapa e os arquivos mais relevantes, então o research não começa do zero.
          </p>
        </div>
        {isLive && <Button variant="ghost" onClick={() => void reindex()}><RefreshCw className="size-4" /> Reindexar</Button>}
      </section>

      {isLive && <IndexProgress status={status} overview={overview} />}

      <form className="card flex items-center gap-3 px-4 py-2.5" data-ascii="surface" onSubmit={(e) => { e.preventDefault(); void run(query); }}>
        <Search className="size-4 text-muted" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Pergunte à base: ex. onde fica a autenticação" aria-label="Consulta à base de conhecimento" className="flex-1 bg-transparent py-1.5 text-[15px] outline-none placeholder:text-subtle" />
        <button type="submit" className="rounded-full bg-btn px-4 py-1.5 text-[13px] font-medium text-btn-text transition-transform active:scale-[0.975]">Buscar</button>
      </form>
      <div className="-mt-2 flex flex-wrap gap-2">
        {(isLive ? LIVE_SUGGESTIONS : DEMO_SUGGESTIONS).map((s) => (
          <button key={s} type="button" onClick={() => void run(s)} className="rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted transition-colors hover:border-line-strong hover:text-ink">{s}</button>
        ))}
      </div>
      {error && <p className="font-mono text-[12px] text-danger">{error}</p>}

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <section className="card relative overflow-hidden lg:col-span-8" data-ascii="skip">
          {corpus.length > 0 ? (
            <KnowledgeGraph key={isLive ? `live-${indexedAt}` : "demo"} corpus={corpus} highlighted={highlighted} queryVersion={version} />
          ) : (
            <p className="flex h-[460px] items-center justify-center px-6 text-center text-[13px] text-muted">{isLive ? "O grafo aparece quando a indexação terminar." : ""}</p>
          )}
          <ul className="absolute bottom-3 left-3 flex flex-wrap gap-3 rounded-full border border-line bg-surface/90 px-3 py-1.5 backdrop-blur">
            {legend(isLive).map((l) => (
              <li key={l.kind} className="flex items-center gap-1.5 font-mono text-[10px] text-muted"><span className={l.shape} aria-hidden /> {l.label}</li>
            ))}
          </ul>
        </section>
        <div className="lg:col-span-4">
          <Panel eyebrow={isLive ? "Top-k · FTS5 + símbolos" : "Top-k · BM25 (demo)"} title={results.length ? `${results.length} arquivos` : "Sem consulta"}>
            {results.length === 0 && <p className="text-[13px] text-muted">Rode uma consulta para ver o ranking e o caminho no grafo.</p>}
            <AsciiReveal key={version} preset="blueprint" origin="top-left">
              <ol className="flex flex-col gap-2">
                {results.map((r, i) => (
                  <li key={r.id} className="rounded-xl border border-line p-3">
                    <div className="flex items-center gap-2 font-mono text-[11px]">
                      <span className="text-subtle">{String(i + 1).padStart(2, "0")}</span>
                      <span className="truncate">{r.ref}</span>
                      <span className="ml-auto text-accent">{r.score.toFixed(2)}</span>
                    </div>
                    {r.text && <p className="mt-1.5 line-clamp-2 text-[12px] leading-snug text-muted">{r.text}</p>}
                  </li>
                ))}
              </ol>
            </AsciiReveal>
          </Panel>
        </div>
      </div>
    </div>
  );
}
