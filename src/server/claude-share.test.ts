import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const keychain = vi.hoisted(() => ({ read: vi.fn<() => Promise<string>>() }));

vi.mock("../../bin/claude-auth-proxy.mjs", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../bin/claude-auth-proxy.mjs")>();
  return { ...real, readKeychainCredentials: keychain.read, createClaudeLoginSource: () => async () => "tok" };
});

const LOGIN = JSON.stringify({ claudeAiOauth: { accessToken: "tok", expiresAt: Date.now() + 3_600_000 } });

async function load() {
  vi.resetModules();
  delete (globalThis as { carbonClaudeShare?: unknown }).carbonClaudeShare;
  process.env.CARBON_CLAUDE_SHARE_PORT = String(20_000 + Math.floor(Math.random() * 20_000));
  return import("./claude-share");
}

describe.skipIf(process.platform !== "darwin")("claude-share (macOS)", () => {
  let share: Awaited<ReturnType<typeof load>>;
  beforeEach(async () => {
    keychain.read.mockReset();
    share = await load();
  });
  afterEach(async () => {
    await share.stopClaudeShare();
  });

  it("starts the proxy on loopback after reading the login, and stops it", async () => {
    keychain.read.mockResolvedValue(LOGIN);

    const on = await share.startClaudeShare();

    expect(on).toMatchObject({ state: "on", error: null, requests: 0 });
    const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port: share.CLAUDE_SHARE_PORT, path: "/" }, (res) => resolve(res.statusCode ?? 0)).on("error", () => resolve(0)));
    expect(status).toBeGreaterThan(0); // something answers (upstream result is irrelevant here)

    expect((await share.stopClaudeShare()).state).toBe("off");
  });

  it("reports the Keychain problem instead of turning on", async () => {
    keychain.read.mockRejectedValue(new Error("login do Claude Code não encontrado neste Mac"));

    const status = await share.startClaudeShare();

    expect(status).toMatchObject({ state: "error", error: "login do Claude Code não encontrado neste Mac" });
  });

  it("explains a busy port", async () => {
    keychain.read.mockResolvedValue(LOGIN);
    const squatter = http.createServer();
    await new Promise<void>((r) => squatter.listen(share.CLAUDE_SHARE_PORT, "127.0.0.1", () => r()));
    try {
      const status = await share.startClaudeShare();
      expect(status.state).toBe("error");
      expect(status.error).toMatch(/já está em uso/);
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});
