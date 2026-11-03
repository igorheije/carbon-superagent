import { describe, expect, it } from "vitest";
import { BRANCH_RE, orderTargets } from "./pull-request";

describe("orderTargets", () => {
  const remote = ["feature/x", "main", "develop", "agent/frg-1-abc", "HEAD", "staging", "bugfix/y"];

  it("puts the suggestion first, then long-lived branches, then the rest alphabetically", () => {
    expect(orderTargets(remote, "develop", "main", "agent/frg-1-abc")).toEqual({
      branches: ["develop", "main", "staging", "bugfix/y", "feature/x"],
      suggested: "develop",
      hasRemote: true,
    });
  });

  it("falls back to the remote default when the suggestion does not exist", () => {
    expect(orderTargets(remote, "release", "main", "agent/z").suggested).toBe("main");
  });

  it("never offers Carbon task branches and reports repos without a remote", () => {
    expect(orderTargets(["agent/a", "agent/b"], null, null, "agent/a")).toEqual({ branches: [], suggested: null, hasRemote: false });
  });
});

describe("BRANCH_RE", () => {
  it("accepts normal names and rejects option injection and ranges", () => {
    for (const ok of ["main", "release/2026.11", "feat_x-1"]) expect(BRANCH_RE.test(ok), ok).toBe(true);
    for (const bad of ["--upload-pack=x", "main..dev", "a b", "", "x;rm"]) expect(BRANCH_RE.test(bad), bad).toBe(false);
  });
});
