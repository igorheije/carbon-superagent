import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const sandbox = mkdtempSync(path.join(tmpdir(), "carbon-availability-"));
process.env.CARBON_DATA_DIR = path.join(sandbox, "data");

type Modules = {
  settings: typeof import("../repo/settings");
  availability: typeof import("./availability");
};
let m: Modules;

beforeAll(async () => {
  m = { settings: await import("../repo/settings"), availability: await import("./availability") };
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const ARN = "arn:aws:bedrock-agentcore:sa-east-1:123456789012:runtime/carbon_worker-AbC123";

describe("settings: agentcore + panelPublicUrl", () => {
  it("defaults keep AgentCore off and runtime local-only", () => {
    const s = m.settings.settingsSchema.parse({});
    expect(s.agentcore).toEqual({ enabled: false, region: "sa-east-1", runtimeArn: "", qualifier: "DEFAULT", maxConcurrent: 3 });
    expect(s.panelPublicUrl).toBe("");
  });

  it("validates the ARN format", () => {
    const parse = (runtimeArn: string) => m.settings.settingsSchema.safeParse({ agentcore: { runtimeArn } }).success;
    expect(parse(ARN)).toBe(true);
    expect(parse("arn:aws:bedrock-agentcore:sa-east-1:123:runtime/x")).toBe(false);
    expect(parse("arn:aws:lambda:sa-east-1:123456789012:function/x")).toBe(false);
    expect(parse("not-an-arn")).toBe(false);
  });

  it("validates region, qualifier and maxConcurrent bounds", () => {
    const ok = (agentcore: Record<string, unknown>) => m.settings.settingsSchema.safeParse({ agentcore }).success;
    expect(ok({ region: "us-east-1" })).toBe(true);
    expect(ok({ region: "Sao Paulo" })).toBe(false);
    expect(ok({ qualifier: "prod endpoint" })).toBe(false);
    expect(ok({ maxConcurrent: 0 })).toBe(false);
    expect(ok({ maxConcurrent: 21 })).toBe(false);
  });

  it("panelPublicUrl must be https and loses its trailing slash", () => {
    expect(m.settings.settingsSchema.parse({ panelPublicUrl: "https://p.exemplo.dev/" }).panelPublicUrl).toBe("https://p.exemplo.dev");
    expect(m.settings.settingsSchema.safeParse({ panelPublicUrl: "http://p.exemplo.dev" }).success).toBe(false);
  });

  it("public settings expose runtime availability and no AWS secret", () => {
    const pub = m.settings.toPublicSettings(m.settings.settingsSchema.parse({}));
    expect(pub.runtimes.local).toEqual({ available: true, reason: null });
    expect(pub.runtimes.agentcore.available).toBe(false);
    expect(pub.runtimes.pool.available).toBe(false);
  });
});

describe("agentcoreAvailability", () => {
  const base = { panelPublicUrl: "https://p.exemplo.dev", agentcore: { enabled: true, region: "sa-east-1", runtimeArn: ARN, qualifier: "DEFAULT", maxConcurrent: 3 } };
  const yes = (): boolean => true;

  it("available when everything is configured", () => {
    expect(m.availability.agentcoreAvailability(base, yes)).toEqual({ available: true, reason: null });
  });

  it.each([
    ["disabled", { ...base, agentcore: { ...base.agentcore, enabled: false } }, yes, /desativado/],
    ["no ARN", { ...base, agentcore: { ...base.agentcore, runtimeArn: "" } }, yes, /ARN/],
    ["no panel URL", { ...base, panelPublicUrl: "" }, yes, /URL pública/],
    ["no AWS credentials", base, (): boolean => false, /credenciais AWS/],
  ] as const)("unavailable with reason: %s", (_label, settings, creds, reason) => {
    const result = m.availability.agentcoreAvailability(settings, creds);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(reason);
  });
});

describe("hasAwsCredentialSource (offline)", () => {
  const none = () => false;
  it("accepts static keys, web identity, container creds or shared files", () => {
    expect(m.availability.hasAwsCredentialSource({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b" }, none, "/h")).toBe(true);
    expect(m.availability.hasAwsCredentialSource({ AWS_WEB_IDENTITY_TOKEN_FILE: "/t", AWS_ROLE_ARN: "r" }, none, "/h")).toBe(true);
    expect(m.availability.hasAwsCredentialSource({ AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: "/v2" }, none, "/h")).toBe(true);
    expect(m.availability.hasAwsCredentialSource({}, (f) => f === "/h/.aws/config", "/h")).toBe(true);
    expect(m.availability.hasAwsCredentialSource({ AWS_CONFIG_FILE: "/c" }, (f) => f === "/c", "/h")).toBe(true);
  });
  it("rejects when nothing is there (only one of the static keys counts as nothing)", () => {
    expect(m.availability.hasAwsCredentialSource({}, none, "/h")).toBe(false);
    expect(m.availability.hasAwsCredentialSource({ AWS_ACCESS_KEY_ID: "a" }, none, "/h")).toBe(false);
  });
});

describe("poolAvailability", () => {
  it("needs a non-revoked pool worker", () => {
    expect(m.availability.poolAvailability([]).available).toBe(false);
    expect(m.availability.poolAvailability([{ kind: "pool", revokedAt: 1 }]).available).toBe(false);
    expect(m.availability.poolAvailability([{ kind: "agentcore", revokedAt: null }]).available).toBe(false);
    expect(m.availability.poolAvailability([{ kind: "pool", revokedAt: null }])).toEqual({ available: true, reason: null });
    expect(m.availability.poolAvailability([]).reason).toMatch(/nenhuma máquina/);
  });
});
