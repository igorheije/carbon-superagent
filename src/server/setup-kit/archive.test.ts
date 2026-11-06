import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { renderKitArchive, renderTar } from "./archive";
import { renderCompose } from "./compose";
import { KIT_OPTIONS } from "./kit-test-utils";

const MTIME = 1_767_225_600; // 2026-01-01T00:00:00Z
const dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "carbon-kit-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extract(archive: Buffer): string {
  const dir = tempDir();
  const file = path.join(dir, "kit.tar.gz");
  writeFileSync(file, archive);
  const out = path.join(dir, "out");
  mkdirSync(out);
  const result = spawnSync("tar", ["-xzf", file, "-C", out], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return out;
}

describe("renderKitArchive", () => {
  it("produces a .tar.gz that system tar extracts byte-for-byte", () => {
    const files = { ...renderCompose(KIT_OPTIONS), "nested/dir/notas.txt": "olá\n".repeat(300) };
    const out = extract(renderKitArchive(files, { mtimeSeconds: MTIME }));
    for (const [name, content] of Object.entries(files)) {
      expect(readFileSync(path.join(out, name), "utf8")).toBe(content);
    }
    expect(statSync(path.join(out, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(out, "README.md")).mode & 0o777).toBe(0o644);
    expect(Math.floor(statSync(path.join(out, "README.md")).mtimeMs / 1000)).toBe(MTIME);
  });

  it("handles paths longer than 100 bytes via the ustar prefix", () => {
    const longPath = `${"a".repeat(60)}/${"b".repeat(60)}/kit.yaml`;
    const out = extract(renderKitArchive({ [longPath]: "x: 1\n" }, { mtimeSeconds: MTIME }));
    expect(readFileSync(path.join(out, longPath), "utf8")).toBe("x: 1\n");
  });

  it("is deterministic and gunzips to 512-byte blocks", () => {
    const files = renderCompose(KIT_OPTIONS);
    const a = renderKitArchive(files, { mtimeSeconds: MTIME });
    expect(renderKitArchive(files, { mtimeSeconds: MTIME }).equals(a)).toBe(true);
    expect(gunzipSync(a).length % 512).toBe(0);
    expect(gunzipSync(a).equals(renderTar(files, { mtimeSeconds: MTIME }))).toBe(true);
  });

  it.each(["../escape", "/abs/path", "a//b", "a/./b", "dir/", "with space", "quebra\nlinha", "c:\\win"])("rejects unsafe path %j", (bad) => {
    expect(() => renderKitArchive({ [bad]: "x" })).toThrow(/caminho inválido/);
  });
});
