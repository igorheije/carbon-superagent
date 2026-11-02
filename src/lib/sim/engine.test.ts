import { describe, expect, it } from "vitest";
import type { EngineState } from "@/lib/domain/types";
import { createEngine, MAX_SPEED_MS, MIN_SPEED_MS } from "./engine";
import { DEMO_SPECS } from "./scenarios";

const engine = createEngine(DEMO_SPECS);

function tickN(state: EngineState, n: number): EngineState {
  let current = state;
  for (let i = 0; i < n; i += 1) current = engine.reduce(current, { type: "tick" });
  return current;
}

function runUntilIdle(state: EngineState, limit = 5000): EngineState {
  let current = engine.reduce(state, { type: "tick" });
  let guard = 0;
  while (current.activeTicketId !== null && guard < limit) {
    current = engine.reduce(current, { type: "tick" });
    guard += 1;
  }
  return current;
}

describe("simulation engine", () => {
  it("starts the first queued ticket on the first tick", () => {
    const state = tickN(engine.initial, 1);
    expect(state.activeTicketId).toBe("t1");
    expect(state.tickets[0]?.status).toBe("running");
    expect(state.agents.intake).toBe("working");
  });

  it("does not mutate the previous state", () => {
    const before = engine.initial;
    const snapshot = JSON.stringify(before);
    tickN(before, 10);
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("runs a ticket end to end: plan done, PR opened, lesson proposed", () => {
    const state = runUntilIdle(engine.initial);
    const ticket = state.tickets.find((t) => t.id === "t1");
    expect(ticket?.status).toBe("done");
    expect(ticket?.plan.every((step) => step.done)).toBe(true);
    expect(ticket?.pr?.number).toBe(482);
    expect(ticket?.tests?.passing).toBe(ticket?.tests?.total);
    expect(state.metrics.completed).toBe(1);
    expect(state.lessons.find((l) => l.id === "L-ENG-142")?.status).toBe("candidate");
  });

  it("resolves every CRITICAL and HIGH finding before delivery", () => {
    const state = runUntilIdle(engine.initial);
    const blocking = state.tickets[0]?.findings.filter(
      (f) => (f.severity === "CRITICAL" || f.severity === "HIGH") && !f.resolved,
    );
    expect(blocking).toEqual([]);
  });

  it("opens PRs as draft in observe mode and ready in act mode", () => {
    const observed = runUntilIdle(engine.initial);
    expect(observed.tickets[0]?.pr?.draft).toBe(true);

    const acting = runUntilIdle(engine.reduce(engine.initial, { type: "setAcceptMode", mode: "act" }));
    expect(acting.tickets[0]?.pr?.draft).toBe(false);
  });

  it("pauses without advancing when toggled off", () => {
    const paused = engine.reduce(engine.initial, { type: "toggle" });
    expect(tickN(paused, 5).tick).toBe(0);
  });

  it("moves a queued ticket to the front of the queue", () => {
    const state = engine.reduce(engine.initial, { type: "prioritize", ticketId: "t3" });
    expect(state.tickets.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
    expect(tickN(state, 1).activeTicketId).toBe("t3");
  });

  it("only promotes or discards candidate lessons", () => {
    const done = runUntilIdle(engine.initial);
    const promoted = engine.reduce(done, { type: "promote", lessonId: "L-ENG-142" });
    expect(promoted.lessons.find((l) => l.id === "L-ENG-142")?.status).toBe("promoted");

    const discardPromoted = engine.reduce(promoted, { type: "discard", lessonId: "L-ENG-142" });
    expect(discardPromoted.lessons.find((l) => l.id === "L-ENG-142")?.status).toBe("promoted");
  });

  it("clamps speed into the allowed range", () => {
    expect(engine.reduce(engine.initial, { type: "setSpeed", speedMs: 1 }).speedMs).toBe(MIN_SPEED_MS);
    expect(engine.reduce(engine.initial, { type: "setSpeed", speedMs: 99999 }).speedMs).toBe(MAX_SPEED_MS);
  });

  it("goes idle after every ticket is done", () => {
    let state = engine.initial;
    for (let i = 0; i < DEMO_SPECS.length; i += 1) state = runUntilIdle(state);
    const idle = tickN(state, 3);
    expect(idle.activeTicketId).toBeNull();
    expect(idle.metrics.completed).toBe(DEMO_SPECS.length);
    expect(Object.values(idle.agents).every((a) => a === "idle")).toBe(true);
  });
});
