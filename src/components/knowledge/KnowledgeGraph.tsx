"use client";

import { useEffect, useRef } from "react";
import type { KnowledgeKind } from "@/lib/domain/types";
import type { KnowledgeDoc } from "@/lib/knowledge/retrieve";
import { computeLayout, type LaidOutNode } from "./force";

interface KnowledgeGraphProps {
  readonly corpus: readonly KnowledgeDoc[];
  readonly highlighted: ReadonlyMap<string, number>;
  readonly queryVersion: number;
}

const HEIGHT = 520;
const FIT_PADDING = 48;
const MAX_FIT_ZOOM = 2.2;
const PULSE_MS = 1100;
const MAX_LABELS = 16;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 4;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function drawShape(ctx: CanvasRenderingContext2D, kind: KnowledgeKind, x: number, y: number, r: number): void {
  ctx.beginPath();
  if (kind === "doc") ctx.rect(x - r, y - r, r * 2, r * 2);
  else if (kind === "ticket") {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.3, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.lineTo(x - r * 1.3, y);
    ctx.closePath();
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
}

const radiusOf = (degree: number): number => 3 + Math.min(7, Math.sqrt(degree) * 1.6);

/**
 * Static map of the knowledge base. The force layout is computed up front (synchronously,
 * before the first paint), so nodes never move on their own: the first frame is the final
 * frame. Only user input changes the view (hover, wheel zoom, drag pan, double-click reset).
 * Frames are drawn on demand, not in a continuous loop.
 */
export function KnowledgeGraph({ corpus, highlighted, queryVersion }: KnowledgeGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const highlightRef = useRef(highlighted);
  const pulseRef = useRef(0);
  const requestDrawRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    highlightRef.current = highlighted;
    requestDrawRef.current();
  }, [highlighted]);

  useEffect(() => {
    if (queryVersion > 0) {
      pulseRef.current = performance.now();
      requestDrawRef.current();
    }
  }, [queryVersion]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return undefined;

    const { nodes, bounds } = computeLayout(corpus);
    const byId = new Map(nodes.map((n) => [n.doc.id, n]));
    const topLabels = new Set([...nodes].sort((a, b) => b.degree - a.degree).slice(0, MAX_LABELS).map((n) => n.doc.id));

    let width = canvas.clientWidth;
    const height = HEIGHT;
    let zoom = 1;
    let panX = 0;
    let panY = 0;
    let hasUserView = false;
    let hovered: LaidOutNode | null = null;
    let isDragging = false;
    let lastPointer = { x: 0, y: 0 };
    let frame = 0;

    /** Fits the precomputed layout into the canvas in one step (no easing, no motion). */
    const fit = () => {
      const bw = Math.max(1, bounds.maxX - bounds.minX);
      const bh = Math.max(1, bounds.maxY - bounds.minY);
      zoom = Math.min(MAX_FIT_ZOOM, (width - FIT_PADDING * 2) / bw, (height - FIT_PADDING * 2) / bh);
      panX = width / 2 - ((bounds.minX + bounds.maxX) / 2) * zoom;
      panY = height / 2 - ((bounds.minY + bounds.maxY) / 2) * zoom;
    };

    const toWorld = (px: number, py: number) => ({ x: (px - panX) / zoom, y: (py - panY) / zoom });

    const draw = (now: number) => {
      frame = 0;
      const hl = highlightRef.current;
      const hasQuery = hl.size > 0;
      const colors = { ink: cssVar("--text"), muted: cssVar("--text-subtle"), line: cssVar("--border-strong"), accent: cssVar("--accent"), bg: cssVar("--surface"), surface: cssVar("--surface-muted") };
      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);

      const pulseAge = now - pulseRef.current;
      const isPulsing = hasQuery && pulseAge >= 0 && pulseAge < PULSE_MS;
      if (isPulsing) {
        const t = pulseAge / PULSE_MS;
        const c = toWorld(width / 2, height / 2);
        ctx.beginPath();
        ctx.arc(c.x, c.y, (t * Math.max(width, height) * 0.6) / zoom, 0, Math.PI * 2);
        ctx.strokeStyle = colors.accent;
        ctx.globalAlpha = (1 - t) * 0.4;
        ctx.lineWidth = 1.5 / zoom;
        ctx.stroke();
      }

      const focus = hovered;
      ctx.lineWidth = 1 / zoom;
      for (const n of nodes) {
        for (const id of n.doc.links) {
          const m = byId.get(id);
          if (!m) continue;
          const isHot = (hl.has(n.doc.id) && hl.has(id)) || (focus !== null && (focus === n || focus === m));
          ctx.beginPath();
          ctx.moveTo(n.x, n.y);
          ctx.lineTo(m.x, m.y);
          ctx.strokeStyle = isHot ? colors.accent : colors.line;
          ctx.globalAlpha = isHot ? 0.85 : hasQuery || focus ? 0.12 : 0.35;
          ctx.stroke();
        }
      }

      const labelled: LaidOutNode[] = [];
      for (const n of nodes) {
        const score = hl.get(n.doc.id);
        const isHit = score !== undefined;
        const isNeighbor = focus !== null && (focus.doc.links.includes(n.doc.id) || n.doc.links.includes(focus.doc.id));
        const r = radiusOf(n.degree) + (isHit ? 2 + (score ?? 0) * 3 : 0);
        ctx.globalAlpha = (hasQuery && !isHit) || (focus && focus !== n && !isNeighbor) ? 0.25 : 1;
        drawShape(ctx, n.doc.kind, n.x, n.y, r);
        const isFilled = n.doc.kind === "code" || n.doc.kind === "ticket";
        ctx.fillStyle = isHit || focus === n ? colors.accent : isFilled ? colors.ink : colors.bg;
        ctx.fill();
        ctx.strokeStyle = isHit || n.doc.kind === "lesson" ? colors.accent : colors.ink;
        ctx.lineWidth = 1.2 / zoom;
        ctx.stroke();
        if (isHit || focus === n || (!hasQuery && !focus && topLabels.has(n.doc.id))) labelled.push(n);
      }

      ctx.globalAlpha = 1;
      ctx.font = `${11 / zoom}px ui-monospace, "Geist Mono", monospace`;
      const priority = (n: LaidOutNode) => (focus === n ? 3 : hl.has(n.doc.id) ? 2 + (hl.get(n.doc.id) ?? 0) / 10 : n.degree / 1000);
      const placed: { x: number; y: number; w: number; h: number }[] = [];
      for (const n of [...labelled].sort((a, b) => priority(b) - priority(a))) {
        const text = focus === n ? n.doc.ref : n.label;
        const tx = n.x + radiusOf(n.degree) + 5 / zoom;
        const metrics = ctx.measureText(text);
        const box = { x: tx - 3 / zoom, y: n.y - 9 / zoom, w: metrics.width + 6 / zoom, h: 14 / zoom };
        const collides = placed.some((p) => box.x < p.x + p.w && box.x + box.w > p.x && box.y < p.y + p.h && box.y + box.h > p.y);
        if (collides && focus !== n) continue;
        placed.push(box);
        ctx.fillStyle = colors.surface;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.globalAlpha = 1;
        ctx.fillStyle = focus === n || hl.has(n.doc.id) ? colors.ink : colors.muted;
        ctx.fillText(text, tx, n.y + 2 / zoom);
      }
      ctx.restore();
      // Keep animating only while the one-shot search pulse is visible.
      if (isPulsing) requestDraw();
    };

    const requestDraw = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    requestDrawRef.current = requestDraw;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      width = canvas.clientWidth;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!hasUserView) fit();
      requestDraw();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const pointer = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onMove = (e: PointerEvent) => {
      const p = pointer(e);
      if (isDragging) {
        hasUserView = true;
        panX += p.x - lastPointer.x;
        panY += p.y - lastPointer.y;
        lastPointer = p;
        requestDraw();
        return;
      }
      const w = toWorld(p.x, p.y);
      let best: LaidOutNode | null = null;
      let bestD = (12 / zoom) ** 2;
      for (const n of nodes) {
        const d = (n.x - w.x) ** 2 + (n.y - w.y) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      if (best !== hovered) {
        hovered = best;
        canvas.style.cursor = best ? "pointer" : "grab";
        requestDraw();
      }
    };
    const onDown = (e: PointerEvent) => {
      isDragging = true;
      lastPointer = pointer(e);
      canvas.setPointerCapture(e.pointerId);
      canvas.style.cursor = "grabbing";
    };
    const onUp = (e: PointerEvent) => {
      isDragging = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      canvas.style.cursor = "grab";
    };
    const onLeave = () => {
      if (hovered) {
        hovered = null;
        requestDraw();
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      hasUserView = true;
      const before = toWorld(e.offsetX, e.offsetY);
      zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * Math.exp(-e.deltaY * 0.0015)));
      panX = e.offsetX - before.x * zoom;
      panY = e.offsetY - before.y * zoom;
      requestDraw();
    };
    const onDouble = () => {
      hasUserView = false;
      fit();
      requestDraw();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDouble);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      requestDrawRef.current = () => undefined;
      observer.disconnect();
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDouble);
    };
  }, [corpus]);

  return (
    <canvas
      ref={canvasRef}
      className="block w-full cursor-grab touch-none"
      style={{ height: HEIGHT }}
      role="img"
      aria-label="Mapa da base de conhecimento: arraste para mover, role para dar zoom, duplo clique para recentralizar"
    />
  );
}
