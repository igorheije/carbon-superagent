"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useState } from "react";
import { usePathname } from "next/navigation";
import { api } from "@/lib/client/api";
import { pickFocusTicket } from "./focus";
import { subscribeLive } from "./sharedLive";
import { useSession } from "@/components/session/SessionProvider";
import type { EngineState, Ticket } from "@/lib/domain/types";
import { createEngine, type EngineAction } from "@/lib/sim/engine";
import { DEMO_SPECS } from "@/lib/sim/scenarios";

export type EngineMode = "live" | "demo";

interface EngineContextValue {
  readonly state: EngineState;
  readonly dispatch: (action: EngineAction) => void;
  readonly activeTicket: Ticket | null;
  /** Ticket the user picked in the queue to watch in the grid (null = follow automatically). */
  readonly focusedTicketId: string | null;
  readonly setFocusedTicketId: (id: string | null) => void;
  readonly mode: EngineMode;
  readonly setMode: (mode: EngineMode) => void;
  readonly isConnected: boolean;
  readonly isReady: boolean;
  readonly lastError: string | null;
}

const EngineContext = createContext<EngineContextValue | null>(null);
const engine = createEngine(DEMO_SPECS);
const MODE_KEY = "carbon-mode";
const PUBLIC_PATHS = ["/login", "/setup"];
const EMPTY_LIVE: EngineState = { ...engine.initial, tickets: [], lessons: [], running: false };

function readMode(): EngineMode {
  try {
    return window.localStorage.getItem(MODE_KEY) === "demo" ? "demo" : "live";
  } catch {
    return "live";
  }
}

/** Live snapshot of the active project, over one SSE connection shared by all tabs. */
function useLiveSnapshot(isEnabled: boolean, projectId: string | null) {
  const [snapshot, setSnapshot] = useState<EngineState | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!isEnabled || !projectId) return undefined;
    // New project: drop the previous project's state instead of showing it until the first frame.
    setSnapshot(null);
    return subscribeLive(projectId, { onSnapshot: setSnapshot, onStatus: setIsConnected });
  }, [isEnabled, projectId]);

  return { snapshot, isConnected };
}

export function EngineProvider({ children }: { readonly children: React.ReactNode }) {
  const pathname = usePathname();
  const [mode, setModeState] = useState<EngineMode>("live");
  const [demoState, demoDispatch] = useReducer(engine.reduce, engine.initial);
  const [lastError, setLastError] = useState<string | null>(null);
  const [focusedTicketId, setFocusedTicketId] = useState<string | null>(null);
  const isPublic = PUBLIC_PATHS.includes(pathname);
  const { activeProject } = useSession();
  const live = useLiveSnapshot(mode === "live" && !isPublic, activeProject?.id ?? null);

  useEffect(() => setModeState(readMode()), []);

  useEffect(() => {
    if (mode !== "demo" || !demoState.running) return undefined;
    const id = window.setInterval(() => demoDispatch({ type: "tick" }), demoState.speedMs);
    return () => window.clearInterval(id);
  }, [mode, demoState.running, demoState.speedMs]);

  const setMode = useCallback((next: EngineMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(MODE_KEY, next);
    } catch {
      // storage unavailable: mode still applies for this tab
    }
  }, []);

  const liveDispatch = useCallback((action: EngineAction) => {
    const call = (path: string, body: unknown, method = "POST") =>
      api(path, { method, body }).then(() => setLastError(null)).catch((error: unknown) => setLastError(error instanceof Error ? error.message : "falha"));
    switch (action.type) {
      case "toggle":
        return void call("/api/runner", { action: "toggle" });
      case "prioritize":
        return void call(`/api/tasks/${action.ticketId}`, { action: "prioritize" });
      case "promote":
        return void call(`/api/lessons/${action.lessonId}`, { status: "promoted" });
      case "discard":
        return void call(`/api/lessons/${action.lessonId}`, { status: "discarded" });
      case "setAcceptMode":
        return void call("/api/settings", { acceptMode: action.mode }, "PUT");
      default:
        return undefined;
    }
  }, []);

  const state = useMemo(
    () => (mode === "demo" ? demoState : (live.snapshot ?? EMPTY_LIVE)),
    [mode, demoState, live.snapshot],
  );
  const value = useMemo<EngineContextValue>(
    () => ({
      state,
      dispatch: mode === "demo" ? demoDispatch : liveDispatch,
      activeTicket: state.tickets.find((t) => t.id === state.activeTicketId) ?? null,
      focusedTicketId,
      setFocusedTicketId,
      mode,
      setMode,
      isConnected: mode === "demo" || live.isConnected,
      isReady: mode === "demo" || live.snapshot !== null,
      lastError,
    }),
    [state, mode, liveDispatch, setMode, live.isConnected, live.snapshot, lastError, focusedTicketId],
  );

  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (!ctx) throw new Error("useEngine must be used inside <EngineProvider>");
  return ctx;
}

export function useFocusTicket(): Ticket | null {
  const { state, activeTicket, focusedTicketId } = useEngine();
  return pickFocusTicket(state.tickets, activeTicket, focusedTicketId);
}
