"use client";

import { useEffect, useRef } from "react";
import { animate, useReducedMotion } from "motion/react";

interface AnimatedNumberProps {
  readonly value: number;
  readonly format?: (n: number) => string;
  readonly className?: string;
}

const defaultFormat = (n: number): string => Math.round(n).toLocaleString("pt-BR");

/** Counts from the previous value to the new one; jumps when reduced motion is on. */
export function AnimatedNumber({ value, format = defaultFormat, className }: AnimatedNumberProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef(value);
  const shouldReduce = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    if (shouldReduce) {
      node.textContent = format(value);
      previous.current = value;
      return undefined;
    }
    const controls = animate(previous.current, value, {
      duration: 0.8,
      ease: [0.2, 0, 0.2, 1],
      onUpdate: (n) => {
        node.textContent = format(n);
      },
    });
    previous.current = value;
    return () => controls.stop();
  }, [value, format, shouldReduce]);

  return (
    <span ref={ref} className={className}>
      {format(value)}
    </span>
  );
}
