"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
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
const PARTICLES = 4;
const ORBIT_DASH = "10 14";
const ORBIT_PERIOD = 48; // sum of the dash pattern, so the loop is seamless
const EQ_BARS = 3;

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
        animate={{ pathLength: isDone || isFlowing ? 1 : 0, opacity: isDone ? 0.5 : 1 }}
        transition={{ duration: 0.5, ease: [0.2, 0, 0.2, 1] }}
      />
      {isFlowing &&
        !shouldReduce &&
        Array.from({ length: PARTICLES }, (_, p) => (
          <motion.g
            key={p}
            initial={{ x: x1, opacity: 0 }}
            animate={{ x: [x1, x2], opacity: [0, 1, 1, 0] }}
            transition={{ duration: 1, repeat: Infinity, delay: p / PARTICLES, ease: "easeInOut" }}
          >
            <line x1={-10} y1={y} x2={0} y2={y} stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" opacity={0.35} />
            <circle cx={0} cy={y} r={2.4} fill="var(--accent)" filter="url(#pipe-glow)" />
          </motion.g>
        ))}
      {isDone && !shouldReduce && (
        <motion.circle
          r={1.6}
          cy={y}
          fill="var(--accent)"
          initial={{ cx: x1, opacity: 0 }}
          animate={{ cx: [x1, x2], opacity: [0, 0.8, 0] }}
          transition={{ duration: 1.4, repeat: Infinity, repeatDelay: 2.2 + index * 0.25, ease: "linear" }}
        />
      )}
    </g>
  );
}

/** Behind the node while its agent works: a breathing glow and an orbiting dashed ring. */
function WorkingDecor({ x }: { x: number }) {
  const shouldReduce = useReducedMotion();
  if (shouldReduce) {
    return <rect x={x - 4} y={NODE_Y - 4} width={NODE_W + 8} height={NODE_H + 8} rx={18} fill="none" stroke="var(--accent)" opacity={0.5} />;
  }
  return (
    <>
      <motion.rect
        x={x - 6}
        y={NODE_Y - 6}
        width={NODE_W + 12}
        height={NODE_H + 12}
        rx={20}
        fill="var(--accent)"
        filter="url(#pipe-blur)"
        initial={{ opacity: 0.08 }}
        animate={{ opacity: [0.08, 0.22, 0.08] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.rect
        x={x - 5}
        y={NODE_Y - 5}
        width={NODE_W + 10}
        height={NODE_H + 10}
        rx={19}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.2}
        strokeDasharray={ORBIT_DASH}
        animate={{ strokeDashoffset: [0, -ORBIT_PERIOD] }}
        transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }}
      />
    </>
  );
}

/** On top of the node while its agent works: a light sweep and equalizer bars. */
function WorkingOverlay({ stage, x }: { stage: StageId; x: number }) {
  const shouldReduce = useReducedMotion();
  if (shouldReduce) return null;
  return (
    <g pointerEvents="none">
      <g clipPath={`url(#clip-${stage})`}>
        <motion.rect
          y={NODE_Y}
          width={38}
          height={NODE_H}
          fill="url(#pipe-sweep)"
          initial={{ x: x - 40 }}
          animate={{ x: [x - 40, x + NODE_W] }}
          transition={{ duration: 1.9, repeat: Infinity, ease: "easeInOut", repeatDelay: 0.4 }}
        />
      </g>
      {Array.from({ length: EQ_BARS }, (_, b) => (
        <motion.rect
          key={b}
          x={x + NODE_W - 30 + b * 5}
          y={NODE_Y + 37}
          width={3}
          height={12}
          rx={1}
          fill="var(--accent)"
          style={{ originY: 1, transformBox: "fill-box" }}
          animate={{ scaleY: [0.3, 1, 0.45, 0.85, 0.3] }}
          transition={{ duration: 0.9 + b * 0.15, repeat: Infinity, ease: "easeInOut", delay: b * 0.12 }}
        />
      ))}
    </g>
  );
}

function Node({ stage, index, status, onSelect }: { stage: StageId; index: number; status: AgentStatus; onSelect?: (stage: StageId) => void }) {
  const meta = STAGE_META[stage];
  const x = nodeX(index);
  const isWorking = status === "working";
  const isDone = status === "done";
  const select = () => onSelect?.(stage);
  return (
    <motion.g
      initial={false}
      animate={{ y: isWorking ? -4 : 0 }}
      whileHover={onSelect ? { y: isWorking ? -6 : -2 } : undefined}
      transition={{ type: "spring", stiffness: 300, damping: 22 }}
      className={onSelect ? "cursor-pointer outline-none" : undefined}
      onClick={select}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select())}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-label={onSelect ? `Abrir detalhes de ${meta.label}` : undefined}
    >
      <title>{`${meta.label} — ${meta.description}`}</title>
      <clipPath id={`clip-${stage}`}>
        <rect x={x} y={NODE_Y} width={NODE_W} height={NODE_H} rx={14} />
      </clipPath>
      {isWorking && <WorkingDecor x={x} />}
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
      {isWorking && <WorkingOverlay stage={stage} x={x} />}
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
      <AnimatePresence initial={false}>
        {isDone && (
          <motion.g
            key="done"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 520, damping: 18 }}
            style={{ originX: `${x + NODE_W - 18}px`, originY: `${NODE_Y + 43}px` }}
          >
            <circle cx={x + NODE_W - 18} cy={NODE_Y + 43} r={9} fill="var(--accent-weak)" />
            <foreignObject x={x + NODE_W - 26} y={NODE_Y + 35} width={16} height={16}>
              <Check className="size-4 text-[var(--accent)]" strokeWidth={2.4} />
            </foreignObject>
          </motion.g>
        )}
      </AnimatePresence>
      {!isDone && !isWorking && <circle cx={x + NODE_W - 18} cy={NODE_Y + 43} r={3.5} fill="var(--border-strong)" />}
      <text x={x + NODE_W / 2} y={NODE_Y + NODE_H + 22} textAnchor="middle" className="fill-[var(--text-subtle)] font-mono text-[9px]">
        {meta.caption}
      </text>
    </motion.g>
  );
}

/** Feedback arc: lessons from Reflect flow back into Research (RAG). */
function LearningArc({ isActive }: { isActive: boolean }) {
  const shouldReduce = useReducedMotion();
  const startX = nodeX(STAGES.indexOf("reflect")) + NODE_W / 2;
  const endX = nodeX(STAGES.indexOf("research")) + NODE_W / 2;
  const y = NODE_Y;
  const path = `M ${startX} ${y} C ${startX} ${y - 44}, ${endX} ${y - 44}, ${endX} ${y}`;
  return (
    <g>
      <motion.path
        d={path}
        fill="none"
        stroke="var(--border-strong)"
        strokeDasharray="3 5"
        animate={shouldReduce ? undefined : { strokeDashoffset: [0, -16] }}
        transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }}
      />
      <motion.path
        d={path}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        initial={false}
        animate={{ pathLength: isActive ? 1 : 0 }}
        transition={{ duration: 1.2, ease: [0.2, 0, 0.2, 1] }}
      />
      {isActive && !shouldReduce && (
        <circle r={3} fill="var(--accent)" filter="url(#pipe-glow)">
          <animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
        </circle>
      )}
      <text x={(startX + endX) / 2} y={y - 38} textAnchor="middle" className="fill-[var(--text-subtle)] font-mono text-[9px] uppercase tracking-[0.08em]">
        lições → base de conhecimento
      </text>
    </g>
  );
}

function Defs() {
  return (
    <defs>
      <filter id="pipe-glow" x="-200%" y="-200%" width="500%" height="500%">
        <feGaussianBlur stdDeviation="2.2" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      <filter id="pipe-blur" x="-30%" y="-60%" width="160%" height="220%">
        <feGaussianBlur stdDeviation="9" />
      </filter>
      <linearGradient id="pipe-sweep" x1="0" x2="1" y1="0" y2="0">
        <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
        <stop offset="0.5" stopColor="var(--accent)" stopOpacity="0.28" />
        <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

export function PipelineGraph({ onSelect }: { readonly onSelect?: (stage: StageId) => void }) {
  const { state } = useEngine();
  const { agents } = state;
  return (
    <div className="scroll-thin -mx-1 overflow-x-auto px-1">
      <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className="block h-auto w-full min-w-[860px]" role="img" aria-label="Pipeline de agentes">
        <Defs />
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
          <Node key={stage} stage={stage} index={i} status={agents[stage]} onSelect={onSelect} />
        ))}
      </svg>
    </div>
  );
}
