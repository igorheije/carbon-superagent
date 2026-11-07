import { describe, expect, it } from "vitest";
import type { Ticket } from "@/lib/domain/types";
import { pickFocusTicket } from "./focus";

const t = (id: string, status: Ticket["status"], runtime: Ticket["runtime"] = "local") => ({ id, status, runtime }) as Ticket;

describe("pickFocusTicket", () => {
  const done = t("done", "done");
  const remote = t("remote", "running", "pool");
  const queued = t("queued", "queued");

  it("shows a task running on a worker even though it is never the local active ticket", () => {
    expect(pickFocusTicket([done, remote, queued], null, null)?.id).toBe("remote");
  });

  it("the ticket picked in the queue wins, then the local active one", () => {
    const local = t("local", "running");
    expect(pickFocusTicket([done, remote, local], local, "done")?.id).toBe("done");
    expect(pickFocusTicket([done, remote, local], local, null)?.id).toBe("local");
  });

  it("falls back to the latest non-queued ticket, and ignores a pick that no longer exists", () => {
    expect(pickFocusTicket([done, queued], null, "gone")?.id).toBe("done");
    expect(pickFocusTicket([queued], null, null)).toBeNull();
  });
});
