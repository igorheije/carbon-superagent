import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "./middleware";

const call = (url: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
  middleware(new NextRequest(new URL(url, "http://127.0.0.1:3417"), { method: init.method ?? "GET", headers: { host: "127.0.0.1:3417", ...init.headers } }));

describe("middleware", () => {
  it("lets /api/worker/* through without cookie or same origin (handlers require a worker token)", () => {
    expect(call("/api/worker/claim", { method: "POST" }).status).toBe(200);
    expect(call("/api/worker/tasks/x/heartbeat", { method: "POST", headers: { origin: "https://elsewhere.example" } }).status).toBe(200);
  });

  it("keeps everything else behind the session cookie and origin check", () => {
    expect(call("/api/workers", { method: "POST" }).status).toBe(401);
    expect(call("/api/workerx/claim", { method: "POST" }).status).toBe(401);
    expect(call("/api/tasks").status).toBe(401);
    expect(call("/api/worker/../tasks", { method: "POST" }).status).toBe(401);
    expect(call("/api/tasks", { method: "POST", headers: { origin: "https://elsewhere.example", cookie: "carbon_session=x" } }).status).toBe(403);
    expect(call("/api/tasks", { headers: { cookie: "carbon_session=x" } }).status).toBe(200);
  });
});
