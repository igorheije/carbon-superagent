import { describe, expect, it } from "vitest";
import { resolveImport, scanFile, shouldIndex } from "./scan";

describe("shouldIndex", () => {
  it("indexes source and docs, skips vendored, lockfiles, minified and huge files", () => {
    expect(shouldIndex("src/app.ts", 100)).toBe(true);
    expect(shouldIndex("README.md", 100)).toBe(true);
    expect(shouldIndex("node_modules/x/index.js", 100)).toBe(false);
    expect(shouldIndex("package-lock.json", 100)).toBe(false);
    expect(shouldIndex("public/app.min.js", 100)).toBe(false);
    expect(shouldIndex("src/big.ts", 10_000_000)).toBe(false);
    expect(shouldIndex("assets/logo.png", 100)).toBe(false);
  });
});

describe("scanFile", () => {
  it("extracts TS imports, exported symbols and the leading doc comment", () => {
    const content = `/** Rate limiting for auth routes. */\nimport { z } from "zod";\nimport { db } from "../db";\nexport const loginLimiter = 1;\nexport async function check() {}\nexport type Opts = {};`;
    const file = scanFile("src/middleware/rate-limit.ts", content);
    expect(file).toMatchObject({ lang: "typescript", kind: "code", summary: "Rate limiting for auth routes." });
    expect(file.imports).toEqual(["zod", "../db"]);
    expect(file.symbols).toEqual(["loginLimiter", "check", "Opts"]);
  });

  it("classifies tests, docs and config", () => {
    expect(scanFile("src/a.test.ts", "").kind).toBe("test");
    expect(scanFile("docs/adr.md", "# ADR 1\n\nUsamos Redis.").kind).toBe("doc");
    expect(scanFile("package.json", "{}").kind).toBe("config");
  });

  it("extracts Python and Go symbols", () => {
    expect(scanFile("app/service.py", "from .db import x\nclass Billing:\n  pass\ndef charge():\n  pass").symbols).toEqual(["charge", "Billing"]);
    expect(scanFile("pkg/api.go", 'package api\nimport "net/http"\nfunc Handler() {}\nfunc private() {}\ntype Server struct{}').symbols).toEqual(["Handler", "Server"]);
  });

  it("uses markdown headings as symbols and first paragraph as summary", () => {
    const file = scanFile("README.md", "# Projeto\n\nAPI de agendamentos.\n\n## Rodar");
    expect(file.symbols).toEqual(["Projeto", "Rodar"]);
    expect(file.summary).toBe("API de agendamentos.");
  });
});

describe("resolveImport", () => {
  const files = new Set(["src/db.ts", "src/lib/index.ts", "src/middleware/rate-limit.ts", "app/db.py", "app/models/__init__.py"]);

  it("resolves relative, index and @/ alias imports", () => {
    expect(resolveImport("src/middleware/rate-limit.ts", "../db", files, "typescript")).toBe("src/db.ts");
    expect(resolveImport("src/middleware/rate-limit.ts", "../lib", files, "typescript")).toBe("src/lib/index.ts");
    expect(resolveImport("src/app.ts", "@/db", files, "typescript")).toBe("src/db.ts");
    expect(resolveImport("src/db.ts", "./middleware/rate-limit.js", files, "typescript")).toBe("src/middleware/rate-limit.ts");
  });

  it("returns null for packages and paths outside the repo", () => {
    expect(resolveImport("src/a.ts", "zod", files, "typescript")).toBeNull();
    expect(resolveImport("a.ts", "../../etc/passwd", files, "typescript")).toBeNull();
  });

  it("resolves python relative and absolute modules", () => {
    expect(resolveImport("app/service.py", ".db", files, "python")).toBe("app/db.py");
    expect(resolveImport("app/service.py", "app.models", files, "python")).toBe("app/models/__init__.py");
  });
});
