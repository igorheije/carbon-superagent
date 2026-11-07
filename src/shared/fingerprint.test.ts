import { describe, expect, it } from "vitest";
import { formatFingerprint, normalizeFingerprint } from "./fingerprint";

const HEX = "5c187335c8e23c6b89194fd73306ed950cc3993d39abf29455224c5806122a01";

describe("normalizeFingerprint", () => {
  it.each([
    HEX,
    HEX.toUpperCase(),
    formatFingerprint(HEX),
    `sha256:${HEX}`,
    `SHA256 Fingerprint=${formatFingerprint(HEX)}`,
    `  ${HEX}  `,
  ])("accepts %s", (raw) => {
    expect(normalizeFingerprint(raw)).toBe(HEX);
  });

  it.each(["", "abc", HEX.slice(1), `${HEX}00`, HEX.replace("5", "g"), undefined, null])("rejects %s", (raw) => {
    expect(normalizeFingerprint(raw)).toBeNull();
  });

  it("formats as AB:CD:…", () => {
    expect(formatFingerprint(HEX).startsWith("5C:18:73")).toBe(true);
    expect(formatFingerprint(HEX).split(":")).toHaveLength(32);
  });
});
