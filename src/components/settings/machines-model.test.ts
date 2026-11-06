import { describe, expect, it } from "vitest";
import { nextCommands, relativeTime } from "./machines-model";

describe("relativeTime", () => {
  const now = 10 * 24 * 3_600_000;
  it.each([
    [null, "nunca"],
    [now - 30_000, "agora"],
    [now - 5 * 60_000, "há 5 min"],
    [now - 3 * 3_600_000, "há 3 h"],
    [now - 24 * 3_600_000, "há 1 dia"],
    [now - 3 * 24 * 3_600_000, "há 3 dias"],
    [now + 60_000, "agora"],
  ])("%s → %s", (at, expected) => {
    expect(relativeTime(at, now)).toBe(expected);
  });
});

describe("nextCommands", () => {
  it("compose and kubernetes", () => {
    const base = { filename: "carbon-worker-sp.tar.gz", folder: "carbon-worker-sp" };
    expect(nextCommands({ ...base, target: "compose" })).toEqual(["tar xzf carbon-worker-sp.tar.gz", "cd carbon-worker-sp", "docker compose up -d"]);
    expect(nextCommands({ ...base, target: "k8s" }).at(-1)).toBe("kubectl apply -k .");
  });
});
