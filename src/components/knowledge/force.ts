import type { KnowledgeDoc } from "@/lib/knowledge/retrieve";
import { layoutGroups, shortLabel } from "./layout";

/**
 * Deterministic, synchronous force layout. Runs to completion before anything is drawn,
 * so the graph appears already settled (no visible "jumping"). Same input → same output.
 */

export interface LaidOutNode {
  readonly doc: KnowledgeDoc;
  readonly degree: number;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

export interface Layout {
  readonly nodes: readonly LaidOutNode[];
  readonly bounds: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
}

/** Virtual space the layout is computed in; the view scales it to fit the canvas. */
export const VIRTUAL_W = 1000;
export const VIRTUAL_H = 620;

const ITERATIONS = 420;
const SPRING_LEN = 64;
const SPRING = 0.012;
const GROUP_PULL = 0.006;
const DAMPING = 0.82;
const COOLING = 0.99;
const CUTOFF = 180;
const WALL = 28;

interface Mutable {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function computeLayout(corpus: readonly KnowledgeDoc[]): Layout {
  const ids = new Set(corpus.map((d) => d.id));
  const index = new Map(corpus.map((d, i) => [d.id, i]));
  const degree = new Array<number>(corpus.length).fill(0);
  const edges: [number, number][] = [];
  corpus.forEach((d, i) => {
    for (const l of d.links) {
      const j = index.get(l);
      if (j === undefined || !ids.has(l) || j === i) continue;
      edges.push([i, j]);
      degree[i] = (degree[i] ?? 0) + 1;
      degree[j] = (degree[j] ?? 0) + 1;
    }
  });

  const { groupOf, anchors } = layoutGroups(corpus.map((d) => d.ref));
  const labels = shortLabel(corpus.map((d) => d.ref));
  const pos: Mutable[] = corpus.map((_, i) => {
    const [ax, ay] = anchors[groupOf[i] ?? 0] ?? [0.5, 0.5];
    const angle = i * 2.399963; // golden angle: deterministic, evenly spread start
    const spread = 18 + (i % 7) * 6;
    return { x: ax * VIRTUAL_W + Math.cos(angle) * spread, y: ay * VIRTUAL_H + Math.sin(angle) * spread, vx: 0, vy: 0 };
  });
  const repulsion = Math.max(900, 14000 / Math.sqrt(Math.max(1, corpus.length)));

  let alpha = 1;
  for (let it = 0; it < ITERATIONS; it += 1) {
    for (let i = 0; i < pos.length; i += 1) {
      const a = pos[i] as Mutable;
      for (let j = i + 1; j < pos.length; j += 1) {
        const b = pos[j] as Mutable;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > CUTOFF * CUTOFF) continue;
        const dist = Math.sqrt(Math.max(d2, 25));
        const force = (repulsion / (dist * dist)) * alpha;
        a.vx += (dx / dist) * force;
        a.vy += (dy / dist) * force;
        b.vx -= (dx / dist) * force;
        b.vy -= (dy / dist) * force;
      }
    }
    for (const [i, j] of edges) {
      const a = pos[i] as Mutable;
      const b = pos[j] as Mutable;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = (dist - SPRING_LEN) * SPRING * alpha;
      a.vx += (dx / dist) * force;
      a.vy += (dy / dist) * force;
      b.vx -= (dx / dist) * force;
      b.vy -= (dy / dist) * force;
    }
    pos.forEach((p, i) => {
      const [ax, ay] = anchors[groupOf[i] ?? 0] ?? [0.5, 0.5];
      p.vx += (ax * VIRTUAL_W - p.x) * GROUP_PULL * alpha;
      p.vy += (ay * VIRTUAL_H - p.y) * GROUP_PULL * alpha;
      if (p.x < WALL) p.vx += (WALL - p.x) * 0.08;
      if (p.x > VIRTUAL_W - WALL) p.vx -= (p.x - (VIRTUAL_W - WALL)) * 0.08;
      if (p.y < WALL) p.vy += (WALL - p.y) * 0.08;
      if (p.y > VIRTUAL_H - WALL) p.vy -= (p.y - (VIRTUAL_H - WALL)) * 0.08;
      p.vx *= DAMPING;
      p.vy *= DAMPING;
      p.x += p.vx;
      p.y += p.vy;
    });
    alpha *= COOLING;
  }

  const nodes = corpus.map((doc, i) => ({ doc, degree: degree[i] ?? 0, label: labels[i] ?? doc.ref, x: pos[i]?.x ?? 0, y: pos[i]?.y ?? 0 }));
  const bounds = nodes.reduce(
    (b, n) => ({ minX: Math.min(b.minX, n.x), minY: Math.min(b.minY, n.y), maxX: Math.max(b.maxX, n.x), maxY: Math.max(b.maxY, n.y) }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  return { nodes, bounds: nodes.length ? bounds : { minX: 0, minY: 0, maxX: VIRTUAL_W, maxY: VIRTUAL_H } };
}
