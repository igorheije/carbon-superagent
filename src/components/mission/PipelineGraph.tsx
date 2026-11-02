"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";
import { useEngine } from "@/components/engine/EngineProvider";
import { STAGE_META } from "@/lib/domain/stages";
import { STAGES, type AgentStatus, type StageId } from "@/lib/domain/types";

const NODE_W = 112;
const NODE_H = 70;
const GAP = 26;
const PAD_X = 16;
const NODE_Y = 56;
const VIEW_W = PAD_X * 2 + STAGES.length * NODE_W + (STAGES.length - 1) * GAP;
const VIEW_H = 178;
const PARTICLES = 3;

const nodeX = (i: number): number => PAD_X + i * (NODE_W + GAP);

function Edge({ index, isFlowing, isDone }: { index: number; isFlowing: boolean; isDone: boolean }) {
  const shouldReduce = useReducedMotion();
  const x1 = nodeX(index) + NODE_W;
  const x2 = nodeX(index + 1);
  const y = NODE_Y + NODE_H / 2;
  return (
    <g>
      <line x1={x1} y1={y} x2={x2} y2={y} stroke="var(--border-strong)" strokeWidth={1} />
      <motion.line
        x1={x1}
        y1={y}
        x2={x2}
        y2={y}
        stroke="var(--accent)"
        strokeWidth={1.5}
        initial={false}
        animate={{ pathLength: isDone || isFlowing ? 1 : 0, opacity: isDone ? 0.45 : 1 }}
        transition={{ duration: 0.5, ease: [0.2, 0, 0.2, 1] }}
      />
      {isFlowing &&
        !shouldReduce &&
        Array.from({ length: PARTICLES }, (_, p) => (
          <motion.circle
            key={p}
            r={2.2}
            cy={y}
            fill="var(--accent)"
            initial={{ cx: x1, opacity: 0 }}
            animate={{ cx: [x1, x2], opacity: [0, 1, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: (p * 0.9) / PARTICLES, ease: "linear" }}
          />
        ))}
    </g>
  );
}

function Node({ stage, index, status }: { stage: StageId; index: number; status: AgentStatus }) {
  const meta = STAGE_META[stage];
  const x = nodeX(index);
  const isWorking = status === "working";
  const isDone = status === "done";
  return (
    <motion.g initial={false} animate={{ y: isWorking ? -3 : 0 }} transition={{ type: "spring", stiffness: 300, damping: 22 }}>
      {isWorking && (
        <motion.rect
          x={x - 4}
          y={NODE_Y - 4}
          width={NODE_W + 8}
          height={NODE_H + 8}
          rx={18}
          fill="none"
          stroke="var(--accent)"
          initial={{ opacity: 0.7 }}
          animate={{ opacity: [0.7, 0.1, 0.7] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
      <rect
        x={x}
        y={NODE_Y}
        width={NODE_W}
        height={NODE_H}
        rx={14}
        fill={isWorking ? "var(--accent-weak)" : "var(--surface)"}
        stroke={isWorking ? "var(--accent)" : isDone ? "var(--border-strong)" : "var(--border)"}
        strokeWidth={1}
        style={{ transition: "fill 180ms, stroke 180ms" }}
      />
      <text x={x + 12} y={NODE_Y + 22} className="fill-[var(--text-subtle)] font-mono text-[9px] uppercase tracking-[0.06em]">
        {String(index + 1).padStart(2, "0")} {meta.agent}
      </text>
      <text
        x={x + 12}
        y={NODE_Y + 48}
        className={`text-[15px] font-medium tracking-[-0.01em] ${isWorking || isDone ? "fill-[var(--text)]" : "fill-[var(--text-muted)]"}`}
      >
        {meta.label}
      </text>
      {isDone ? (
        <foreignObject x={x + NODE_W - 26} y={NODE_Y + 35} width={16} height={16}>
          <Check className="size-4 text-[var(--text-muted)]" strokeWidth={2} />
        </foreignObject>
      ) : (
        <circle cx={x + NODE_W - 18} cy={NODE_Y + 43} r={3.5} fill={isWorking ? "var(--accent)" : "var(--border-strong)"} />
      )}
      <text x={x + NODE_W / 2} y={NODE_Y + NODE_H + 22} textAnchor="middle" className="fill-[var(--text-subtle)] font-mono text-[9px]">
        {meta.caption}
      </text>
    </motion.g>
  );
}

/** Feedback arc: lessons from Reflect flow back into Research (RAG). */
function LearningArc({ isActive }: { isActive: boolean }) {
  const startX = nodeX(STAGES.indexOf("reflect")) + NODE_W / 2;
  const endX = nodeX(STAGES.indexOf("research")) + NODE_W / 2;
  const y = NODE_Y;
  const path = `M ${startX} ${y} C ${startX} ${y - 44}, ${endX} ${y - 44}, ${endX} ${y}`;
  return (
    <g>
      <path d={path} fill="none" stroke="var(--border-strong)" strokeDasharray="3 5" />
      <motion.path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        initial={false}
        animate={{ pathLength: isActive ? 1 : 0 }}
        transition={{ duration: 1.2, ease: [0.2, 0, 0.2, 1] }}
      />
      <text x={(startX + endX) / 2} y={y - 38} textAnchor="middle" className="fill-[var(--text-subtle)] font-mono text-[9px] uppercase tracking-[0.08em]">
        lições → base de conhecimento
      </text>
    </g>
  );
}

export function PipelineGraph() {
  const { state } = useEngine();
  const { agents } = state;
  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="block h-auto w-full min-w-[860px]" role="img" aria-label="Pipeline de agentes">
        <LearningArc isActive={agents.reflect === "working"} />
        {STAGES.slice(0, -1).map((stage, i) => {
          const nextStage = STAGES[i + 1] as StageId;
          return (
            <Edge
              key={stage}
              index={i}
              isFlowing={agents[nextStage] === "working" && state.running}
              isDone={agents[nextStage] === "done"}
            />
          );
        })}
        {STAGES.map((stage, i) => (
          <Node key={stage} stage={stage} index={i} status={agents[stage]} />
        ))}
      </svg>
    </div>
  );
}
