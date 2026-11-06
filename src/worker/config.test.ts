import { describe, expect, it } from "vitest";
import { checkPanelUrl, gitTokenFor, isLoopbackHost, isPrivateHost, readWorkerConfig } from "./config";

const TOKEN = "cwk_segredo-muito-secreto";
const detect = () => ["claude"] as const;

describe("worker config: panel URL (L5)", () => {
  it("requires https for a non-loopback panel", () => {
    const result = readWorkerConfig({ CARBON_PANEL_URL: "http://carbon.minha-rede.local", CARBON_WORKER_TOKEN: TOKEN }, detect);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toMatch(/https/);
  });

  it("accepts http on loopback and https anywhere (private networks allowed for pool workers)", () => {
    for (const url of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "https://10.0.0.5", "https://carbon.exemplo.test"]) {
      expect(readWorkerConfig({ CARBON_PANEL_URL: url, CARBON_WORKER_TOKEN: TOKEN }, detect).ok, url).toBe(true);
    }
  });

  it("reads CARBON_GIT_HOSTS (lowercase, deduplicated) and rejects junk", () => {
    const ok = readWorkerConfig({ CARBON_PANEL_URL: "https://p.test", CARBON_WORKER_TOKEN: TOKEN, CARBON_GIT_HOSTS: "GitHub.com,github.com, git.example.com:8443" }, detect);
    expect(ok.ok && ok.config.gitHosts).toEqual(["github.com", "git.example.com:8443"]);
    const bad = readWorkerConfig({ CARBON_PANEL_URL: "https://p.test", CARBON_WORKER_TOKEN: TOKEN, CARBON_GIT_HOSTS: "https://github.com/x" }, detect);
    expect(bad.ok).toBe(false);
  });
});

describe("checkPanelUrl / host classification", () => {
  it.each(["127.0.0.1", "127.8.9.1", "localhost", "a.localhost", "[::1]", "::ffff:7f00:1"])("%s is loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  it.each(["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "fd12::1", "fe80::1", "::ffff:a9fe:a9fe"])("%s is private", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(["8.8.8.8", "172.32.0.1", "github.com", "2001:db8::1"])("%s is public", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it("rejectPrivate refuses IP literals in private ranges even in hex/decimal shorthand", () => {
    expect(checkPanelUrl("https://0xa9fea9fe", { rejectPrivate: true }).ok).toBe(false);
    expect(checkPanelUrl("https://2852039166", { rejectPrivate: true }).ok).toBe(false);
    expect(checkPanelUrl("https://user:pw@p.test").ok).toBe(false);
    expect(checkPanelUrl("https://p.test/", { rejectPrivate: true })).toEqual({ ok: true, url: "https://p.test" });
  });
});

describe("gitTokenFor (H2)", () => {
  it("never sends the token when CARBON_GIT_HOSTS is empty", () => {
    expect(gitTokenFor("https://github.com/o/r.git", "ghp_x", [])).toBeUndefined();
  });

  it("sends it only to allowlisted https hosts", () => {
    const hosts = ["github.com", "git.example.com:8443"];
    expect(gitTokenFor("https://github.com/o/r.git", "ghp_x", hosts)).toBe("ghp_x");
    expect(gitTokenFor("https://GitHub.com/o/r.git", "ghp_x", hosts)).toBe("ghp_x");
    expect(gitTokenFor("https://git.example.com:8443/o/r.git", "ghp_x", hosts)).toBe("ghp_x");
    expect(gitTokenFor("https://git.example.com/o/r.git", "ghp_x", hosts)).toBeUndefined();
    expect(gitTokenFor("https://evil.test/o/r.git", "ghp_x", hosts)).toBeUndefined();
    expect(gitTokenFor("https://github.com.evil.test/o/r.git", "ghp_x", hosts)).toBeUndefined();
    expect(gitTokenFor("http://github.com/o/r.git", "ghp_x", hosts)).toBeUndefined();
    expect(gitTokenFor("git@github.com:o/r.git", "ghp_x", hosts)).toBeUndefined();
  });
});
