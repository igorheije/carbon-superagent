import { describe, expect, it } from "vitest";
import { renderCompose } from "@/server/setup-kit/compose";
import { renderK8s } from "@/server/setup-kit/k8s";
import { validateKitOptions } from "@/server/setup-kit/worker-kit";
import { kitOptionsOf, MISSING_PANEL_URL, NEEDS_ADDRESS, newMachineSchema, panelEndpointOf } from "./kit";

const FP = "5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01";
const DIRECT = { available: true, port: 3418, fingerprint: FP, addresses: ["192.168.0.12"] } as const;
const OFFLINE = { available: false, reason: "o listener de workers está desligado" } as const;
const TOKEN = `cwk_${"A".repeat(43)}`;

describe("panelEndpointOf", () => {
  it("direct: https on the listener port with the certificate pinned, no public URL needed", () => {
    expect(panelEndpointOf({ connection: "direct", address: "192.168.0.12" }, "", DIRECT)).toEqual({ panelUrl: "https://192.168.0.12:3418", fingerprint: FP });
  });

  it("direct: explains why it is not possible and asks for the address", () => {
    expect(panelEndpointOf({ connection: "direct", address: "192.168.0.12" }, "", OFFLINE)).toBe(OFFLINE.reason);
    expect(panelEndpointOf({ connection: "direct", address: "" }, "", DIRECT)).toBe(NEEDS_ADDRESS);
  });

  it("public: uses the configured URL, or points to the IP option when there is none", () => {
    expect(panelEndpointOf({ connection: "public" }, "https://painel.exemplo.com", DIRECT)).toEqual({ panelUrl: "https://painel.exemplo.com", fingerprint: null });
    expect(panelEndpointOf({ connection: "public" }, "", DIRECT)).toBe(MISSING_PANEL_URL);
    expect(MISSING_PANEL_URL).toMatch(/IP deste computador/);
  });
});

describe("newMachineSchema address", () => {
  const base = { name: "mac", target: "compose", connection: "direct" } as const;
  it("accepts an IPv4 or a host name and rejects ports, schemes and junk", () => {
    expect(newMachineSchema.safeParse({ ...base, address: "192.168.0.12" }).success).toBe(true);
    expect(newMachineSchema.safeParse({ ...base, address: "meu-mac.local" }).success).toBe(true);
    for (const bad of ["192.168.0.12:3418", "https://x", "1.2.3.999", "a b", "x;rm -rf"]) {
      expect(newMachineSchema.safeParse({ ...base, address: bad }).success, bad).toBe(false);
    }
  });

  it("defaults to the public connection (old clients keep working)", () => {
    expect(newMachineSchema.parse({ name: "x", target: "compose" }).connection).toBe("public");
  });
});

describe("kit with a pinned certificate", () => {
  const input = newMachineSchema.parse({ name: "notebook-escritorio", target: "compose", connection: "direct", address: "192.168.0.12" });
  const options = kitOptionsOf(input, { panelUrl: "https://192.168.0.12:3418", fingerprint: FP }, TOKEN);

  it("writes CARBON_PANEL_FINGERPRINT into Compose .env and the Kubernetes container env", () => {
    expect(validateKitOptions(options)).toEqual([]);
    expect(renderCompose(options)[".env"]).toContain(`CARBON_PANEL_URL=https://192.168.0.12:3418\n# Certificado do painel fixado`);
    expect(renderCompose(options)[".env"]).toContain(`CARBON_PANEL_FINGERPRINT=${FP}`);
    expect(Object.values(renderK8s(options)).join("\n")).toContain(FP);
  });

  it("rejects a malformed fingerprint or one without https", () => {
    expect(validateKitOptions({ ...options, panelFingerprint: "AB:CD" })).toContain("panelFingerprint precisa ser o SHA-256 canônico (64 hex minúsculos)");
    expect(validateKitOptions({ ...options, panelUrl: "http://127.0.0.1:3418" })).toContain("panelFingerprint exige panelUrl com https://");
  });
});
