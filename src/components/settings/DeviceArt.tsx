"use client";

import { motion, useReducedMotion } from "motion/react";
import type { DeviceKind } from "@/shared/host-telemetry";
import { cycleSeconds } from "./load-model";

/**
 * Animated illustration of a machine (Configurações → Máquinas → Carga). One drawing per device
 * kind; `activity` (0–1) sets the tempo (LEDs, fans, screen) and `isWorking` lights the accent.
 * Drawn with currentColor + theme tokens so it follows light/dark. Static when the user prefers
 * reduced motion.
 */
type Props = {
  readonly kind: DeviceKind;
  readonly activity: number;
  readonly isWorking: boolean;
  readonly isOffline?: boolean;
  readonly label: string;
};

type ArtProps = { readonly dur: number; readonly isWorking: boolean; readonly animate: boolean };

const STROKE = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinejoin: "round" as const };
const ACCENT = "var(--accent)";
const DIM = "var(--text-subtle)";

const loop = (dur: number, delay = 0) => ({ duration: dur, delay, repeat: Infinity, ease: "easeInOut" as const });

function Blink({ x, y, dur, delay, isOn, animate, r = 2.2 }: { x: number; y: number; dur: number; delay: number; isOn: boolean; animate: boolean; r?: number }) {
  return (
    <motion.circle
      cx={x}
      cy={y}
      r={r}
      fill={isOn ? ACCENT : DIM}
      animate={animate ? { opacity: [1, 0.15, 1] } : { opacity: 1 }}
      transition={animate ? loop(dur, delay) : undefined}
    />
  );
}

/** Rack server: three units with blinking LEDs (tempo follows the load). */
function ServerArt({ dur, isWorking, animate }: ArtProps) {
  return (
    <g>
      {[14, 38, 62].map((y, i) => (
        <g key={y}>
          <rect x={22} y={y} width={76} height={20} rx={3} {...STROKE} />
          <line x1={30} y1={y + 10} x2={58} y2={y + 10} stroke={DIM} strokeWidth={2} strokeLinecap="round" />
          <Blink x={74} y={y + 10} dur={dur} delay={i * dur * 0.3} isOn={isWorking} animate={animate} />
          <Blink x={82} y={y + 10} dur={dur * 0.7} delay={i * dur * 0.2 + 0.1} isOn animate={animate} />
        </g>
      ))}
      <line x1={22} y1={86} x2={98} y2={86} stroke={DIM} strokeWidth={2} strokeLinecap="round" />
    </g>
  );
}

/** Screen with an equalizer whose bars bounce with the load (used by Mac and Windows). */
function Equalizer({ x, y, w, h, dur, isWorking, animate, bars = 5 }: ArtProps & { x: number; y: number; w: number; h: number; bars?: number }) {
  const gap = w / bars;
  return (
    <g>
      {Array.from({ length: bars }, (_, i) => (
        <motion.rect
          key={i}
          x={x + i * gap + gap * 0.2}
          width={gap * 0.6}
          rx={1}
          fill={isWorking ? ACCENT : DIM}
          initial={{ y: y + h * 0.6, height: h * 0.4 }}
          animate={animate ? { y: [y + h * 0.7, y + h * 0.1, y + h * 0.5, y + h * 0.7], height: [h * 0.3, h * 0.9, h * 0.5, h * 0.3] } : { y: y + h * 0.6, height: h * 0.4 }}
          transition={animate ? loop(dur, (i * dur) / bars) : undefined}
        />
      ))}
    </g>
  );
}

/** Laptop (Mac): lid + base, equalizer on the screen. */
function MacArt(props: ArtProps) {
  return (
    <g>
      <rect x={24} y={14} width={72} height={48} rx={4} {...STROKE} />
      <circle cx={60} cy={18} r={1.2} fill="currentColor" />
      <Equalizer {...props} x={32} y={24} w={56} h={32} />
      <path d="M14 66 H106 L100 74 H20 Z" {...STROKE} />
    </g>
  );
}

/** Monitor (Windows): four tiles lighting up in sequence plus a taskbar. */
function WindowsArt({ dur, isWorking, animate }: ArtProps) {
  const tiles = [
    [38, 22],
    [62, 22],
    [38, 42],
    [62, 42],
  ] as const;
  return (
    <g>
      <rect x={18} y={12} width={84} height={56} rx={3} {...STROKE} />
      {tiles.map(([x, y], i) => (
        <motion.rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width={20}
          height={16}
          rx={1.5}
          fill={isWorking ? ACCENT : DIM}
          animate={animate ? { opacity: [0.25, 1, 0.25] } : { opacity: 0.6 }}
          transition={animate ? loop(dur, (i * dur) / 4) : undefined}
        />
      ))}
      <line x1={18} y1={62} x2={102} y2={62} stroke="currentColor" strokeWidth={2} />
      <path d="M52 68 L48 80 H72 L68 68" {...STROKE} />
    </g>
  );
}

/** Monitor (Linux desktop): terminal lines being typed and a blinking cursor. */
function LinuxArt({ dur, isWorking, animate }: ArtProps) {
  return (
    <g>
      <rect x={18} y={12} width={84} height={56} rx={3} {...STROKE} />
      <text x={26} y={30} fontSize={11} fontFamily="ui-monospace, monospace" fill={isWorking ? ACCENT : "currentColor"}>{">_"}</text>
      {[40, 50].map((y, i) => (
        <motion.line
          key={y}
          x1={26}
          y1={y}
          y2={y}
          stroke={DIM}
          strokeWidth={3}
          strokeLinecap="round"
          initial={{ x2: 30 }}
          animate={animate ? { x2: [30, 92 - i * 20, 92 - i * 20, 30] } : { x2: 80 - i * 20 }}
          transition={animate ? { duration: dur * 1.6, delay: i * dur * 0.4, repeat: Infinity, times: [0, 0.6, 0.85, 1] } : undefined}
        />
      ))}
      <motion.rect x={44} y={22} width={6} height={10} fill={ACCENT} animate={animate ? { opacity: [1, 0, 1] } : { opacity: 1 }} transition={animate ? { duration: 1, repeat: Infinity, ease: "linear" } : undefined} />
      <path d="M52 68 L48 80 H72 L68 68" {...STROKE} />
    </g>
  );
}

/** Container: three stacked boxes bobbing. */
function ContainerArt({ dur, isWorking, animate }: ArtProps) {
  const boxes = [
    [26, 52],
    [62, 52],
    [44, 26],
  ] as const;
  return (
    <g>
      {boxes.map(([x, y], i) => (
        <motion.g key={`${x}-${y}`} animate={animate ? { y: [0, -4, 0] } : { y: 0 }} transition={animate ? loop(dur, (i * dur) / 3) : undefined}>
          <rect x={x} y={y} width={32} height={24} rx={2} {...STROKE} />
          <line x1={x + 8} y1={y + 6} x2={x + 8} y2={y + 18} stroke={isWorking ? ACCENT : DIM} strokeWidth={2} />
          <line x1={x + 16} y1={y + 6} x2={x + 16} y2={y + 18} stroke={isWorking ? ACCENT : DIM} strokeWidth={2} />
          <line x1={x + 24} y1={y + 6} x2={x + 24} y2={y + 18} stroke={isWorking ? ACCENT : DIM} strokeWidth={2} />
        </motion.g>
      ))}
    </g>
  );
}

/** Cloud (AgentCore): outline with rising sparks. */
function CloudArt({ dur, isWorking, animate }: ArtProps) {
  return (
    <g>
      <path d="M36 66 H86 A16 16 0 0 0 84 34 A22 22 0 0 0 42 38 A14 14 0 0 0 36 66 Z" {...STROKE} />
      {[48, 60, 72].map((x, i) => (
        <motion.circle key={x} cx={x} r={2.2} fill={isWorking ? ACCENT : DIM} initial={{ cy: 58 }} animate={animate ? { cy: [58, 42, 58], opacity: [0, 1, 0] } : { cy: 52 }} transition={animate ? loop(dur, (i * dur) / 3) : undefined} />
      ))}
    </g>
  );
}

function UnknownArt(props: ArtProps) {
  return (
    <g>
      <rect x={30} y={16} width={60} height={56} rx={6} {...STROKE} />
      <Blink x={60} y={44} dur={props.dur} delay={0} isOn={props.isWorking} animate={props.animate} r={4} />
    </g>
  );
}

const ART: Readonly<Record<DeviceKind, (p: ArtProps) => React.JSX.Element>> = {
  server: ServerArt,
  mac: MacArt,
  windows: WindowsArt,
  linux: LinuxArt,
  container: ContainerArt,
  cloud: CloudArt,
  unknown: UnknownArt,
};

export function DeviceArt({ kind, activity, isWorking, isOffline = false, label }: Props) {
  const prefersReduced = useReducedMotion();
  const animate = !prefersReduced && !isOffline;
  const Art = ART[kind];
  return (
    <svg viewBox="0 0 120 92" role="img" aria-label={label} className={`h-24 w-32 ${isOffline ? "text-subtle opacity-50" : "text-muted"}`}>
      {isWorking && animate && (
        <motion.ellipse cx={60} cy={46} rx={56} ry={42} fill={ACCENT} initial={{ opacity: 0.04 }} animate={{ opacity: [0.04, 0.14, 0.04] }} transition={loop(cycleSeconds(activity) * 1.5)} />
      )}
      <Art dur={cycleSeconds(activity)} isWorking={isWorking} animate={animate} />
    </svg>
  );
}
