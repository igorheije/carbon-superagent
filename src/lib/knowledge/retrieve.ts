import type { KnowledgeKind } from "@/lib/domain/types";

export interface KnowledgeDoc {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly ref: string;
  readonly text: string;
  readonly links: readonly string[];
}

export interface ScoredDoc {
  readonly doc: KnowledgeDoc;
  readonly score: number;
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const LESSON_BOOST = 1.15;

/** Lowercases, strips accents and splits on non-word chars; drops 1-2 char tokens. */
export function tokenize(text: string): readonly string[] {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

/**
 * Lexical BM25 over the demo corpus, normalized to 0..1.
 * F3 replaces this with hybrid BM25 + pgvector fused by RRF and reranked;
 * promoted lessons keep a small boost there too.
 */
export function retrieve(query: string, corpus: readonly KnowledgeDoc[], k = 6): readonly ScoredDoc[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || corpus.length === 0) return [];

  const docs = corpus.map((doc) => ({ doc, tokens: tokenize(`${doc.ref} ${doc.text}`) }));
  const avgLen = docs.reduce((sum, d) => sum + d.tokens.length, 0) / docs.length;
  const docFreq = new Map(terms.map((term) => [term, docs.filter((d) => d.tokens.includes(term)).length]));

  const scored = docs.map(({ doc, tokens }) => {
    const raw = terms.reduce((sum, term) => {
      const tf = tokens.filter((t) => t === term).length;
      if (tf === 0) return sum;
      const df = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      const norm = tf + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / avgLen);
      return sum + idf * ((tf * (BM25_K1 + 1)) / norm);
    }, 0);
    return { doc, score: doc.kind === "lesson" ? raw * LESSON_BOOST : raw };
  });

  const ranked = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  const top = ranked[0]?.score ?? 1;
  return ranked.map((s) => ({ doc: s.doc, score: s.score / top }));
}
