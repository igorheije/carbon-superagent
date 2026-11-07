import type { networkInterfaces } from "node:os";
import { describe, expect, it } from "vitest";
import { directJoinInfo, lanAddresses } from "./direct-join";

const FP = "cd".repeat(32);
const IFACES = {
  lo0: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
  en0: [
    { address: "192.168.0.12", netmask: "255.255.255.0", family: "IPv4", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "192.168.0.12/24" },
    { address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", mac: "aa:bb:cc:dd:ee:ff", internal: false, cidr: "fe80::1/64", scopeid: 4 },
  ],
  utun3: [{ address: "100.101.102.103", netmask: "255.255.255.255", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "100.101.102.103/32" }],
  bridge: [{ address: "169.254.3.4", netmask: "255.255.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: "169.254.3.4/16" }],
} as unknown as ReturnType<typeof networkInterfaces>;

describe("lanAddresses", () => {
  it("keeps non-internal IPv4 (LAN, VPN) and drops loopback, IPv6 and link-local", () => {
    expect(lanAddresses(IFACES)).toEqual(["192.168.0.12", "100.101.102.103"]);
  });
});

describe("directJoinInfo", () => {
  const base = { CARBON_WORKER_JOIN_PORT: "3418", CARBON_WORKER_JOIN_HOST: "0.0.0.0", CARBON_WORKER_JOIN_TLS: "self-signed", CARBON_WORKER_JOIN_FINGERPRINT: FP };

  it("listener on every interface: LAN addresses + fingerprint", () => {
    expect(directJoinInfo(base, IFACES)).toEqual({ available: true, port: 3418, fingerprint: FP, addresses: ["192.168.0.12", "100.101.102.103"] });
  });

  it("listener on one IP: only that IP", () => {
    const info = directJoinInfo({ ...base, CARBON_WORKER_JOIN_HOST: "192.168.0.12" }, IFACES);
    expect(info.available && info.addresses).toEqual(["192.168.0.12"]);
  });

  it("loopback with a forced self-signed certificate (CARBON_WORKER_TLS=on) stays available", () => {
    const info = directJoinInfo({ ...base, CARBON_WORKER_JOIN_HOST: "127.0.0.1" }, IFACES);
    expect(info.available && info.addresses).toEqual(["127.0.0.1"]);
  });

  it("CA certificate: available without a fingerprint", () => {
    const info = directJoinInfo({ ...base, CARBON_WORKER_JOIN_TLS: "custom", CARBON_WORKER_JOIN_FINGERPRINT: undefined }, IFACES);
    expect(info.available && info.fingerprint).toBeNull();
  });

  it.each([
    [{}, /CARBON_WORKER_LISTEN/],
    [{ ...base, CARBON_WORKER_JOIN_HOST: "127.0.0.1", CARBON_WORKER_JOIN_TLS: "off" }, /127\.0\.0\.1/],
    [{ ...base, CARBON_WORKER_JOIN_TLS: "off" }, /CARBON_WORKER_TLS=off/],
    [{ ...base, CARBON_WORKER_JOIN_FINGERPRINT: "zz" }, /CARBON_WORKER_LISTEN/],
  ])("unavailable %#", (env, reason) => {
    const info = directJoinInfo(env, IFACES);
    expect(info.available).toBe(false);
    if (!info.available) expect(info.reason).toMatch(reason);
  });
});
