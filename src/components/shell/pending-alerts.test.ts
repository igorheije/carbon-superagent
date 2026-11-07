import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { hasNewAlert, pendingAlertsOf } from "./pending-alerts";

const permission = (id: string, askedAt: string, status: "pending" | "allowed" = "pending") => ({ id, tool: "Bash", summary: "docker images", detail: "", canRemember: true, status, decidedBy: null, askedAt });
const question = (id: string, askedAt: string, answer: string | null = null) => ({ id, stage: "plan", text: "A ou B?", askedAt, answer, answeredBy: null, answeredAt: null });
const ticket = (id: string, extra: Partial<Ticket>) => ({ id, key: id.toUpperCase(), title: "t", runtime: "local", ...extra }) as unknown as Ticket;

describe("pendingAlertsOf", () => {
  it("lists pending permissions first (they expire), then open questions, oldest first, from every task", () => {
    const tickets = [
      ticket("a", { questions: [question("q1", "2026-11-07T10:00:00Z"), question("q0", "2026-11-07T09:00:00Z", "B")] as Ticket["questions"] }),
      ticket("b", { runtime: "pool", permissions: [permission("p2", "2026-11-07T12:00:00Z"), permission("p1", "2026-11-07T11:00:00Z", "allowed")] as Ticket["permissions"] }),
      ticket("c", { permissions: [permission("p3", "2026-11-07T11:30:00Z")] as Ticket["permissions"] }),
    ];

    expect(pendingAlertsOf(tickets).map((a) => a.id)).toEqual(["p:c:p3", "p:b:p2", "q:a:q1"]);
  });

  it("is empty when nothing waits for a human", () => {
    expect(pendingAlertsOf([ticket("a", {})])).toEqual([]);
  });
});

describe("hasNewAlert", () => {
  it("detects a request that was not there before", () => {
    const alerts = pendingAlertsOf([ticket("c", { permissions: [permission("p3", "2026-11-07T11:30:00Z")] as Ticket["permissions"] })]);
    expect(hasNewAlert(new Set(), alerts)).toBe(true);
    expect(hasNewAlert(new Set(["p:c:p3"]), alerts)).toBe(false);
  });
});
