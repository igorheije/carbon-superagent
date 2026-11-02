import path from "node:path";

/**
 * Static, dependency-free code scanner. Regex-based on purpose: it runs on any repo in
 * seconds, without compilers or language servers, and is good enough to build a map
 * (who imports whom, what each file exports) that saves the agent its exploration time.
 */

export type FileKind = "code" | "test" | "doc" | "config";

export interface ScannedFile {
  readonly path: string;
  readonly lang: string;
  readonly kind: FileKind;
  readonly imports: readonly string[];
  readonly symbols: readonly string[];
  readonly summary: string;
}

export const MAX_FILE_BYTES = 256 * 1024;
const MAX_SYMBOLS = 40;
const MAX_SUMMARY = 240;

const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ".ts": "typescript", ".tsx": "typescript", ".mts": "typescript", ".cts": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin", ".rb": "ruby",
  ".php": "php", ".cs": "csharp", ".swift": "swift", ".dart": "dart", ".vue": "vue", ".svelte": "svelte",
  ".sql": "sql", ".prisma": "prisma", ".graphql": "graphql", ".proto": "protobuf",
  ".md": "markdown", ".mdx": "markdown",
  ".json": "json", ".yml": "yaml", ".yaml": "yaml", ".toml": "toml",
};

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|out|coverage|vendor|target|\.next|\.git|\.turbo|\.cache|__pycache__|\.venv|venv|\.carbon-data|\.forge-data)\//;
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.map$|\.snap$/;
const CONFIG_FILES = /(^|\/)(package\.json|tsconfig[^/]*\.json|go\.mod|pyproject\.toml|Cargo\.toml|requirements[^/]*\.txt|Dockerfile|docker-compose[^/]*\.ya?ml|\.github\/workflows\/[^/]+\.ya?ml|[^/]*\.config\.(ts|js|mjs|cjs))$/;
const TEST_FILES = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)(tests?|__tests__|e2e)\//;

export function languageOf(filePath: string): string | null {
  return LANG_BY_EXT[path.extname(filePath).toLowerCase()] ?? (CONFIG_FILES.test(filePath) ? "config" : null);
}

export function shouldIndex(filePath: string, size: number): boolean {
  if (size > MAX_FILE_BYTES || SKIP_DIRS.test(`${filePath}`) || SKIP_FILES.test(filePath)) return false;
  return languageOf(filePath) !== null;
}

function kindOf(filePath: string, lang: string): FileKind {
  if (lang === "markdown") return "doc";
  if (TEST_FILES.test(filePath)) return "test";
  if (CONFIG_FILES.test(filePath) || lang === "json" || lang === "yaml" || lang === "toml" || lang === "config") return "config";
  return "code";
}

const uniq = (items: readonly string[]): readonly string[] => [...new Set(items.filter(Boolean))];

function allMatches(content: string, re: RegExp, group = 1): readonly string[] {
  return [...content.matchAll(re)].map((m) => m[group] ?? "");
}

function extractImports(lang: string, content: string): readonly string[] {
  switch (lang) {
    case "typescript":
    case "javascript":
    case "vue":
    case "svelte":
      return uniq([
        ...allMatches(content, /\bimport\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g),
        ...allMatches(content, /\bexport\s+[\s\S]*?\s+from\s+["']([^"']+)["']/g),
        ...allMatches(content, /\brequire\(\s*["']([^"']+)["']\s*\)/g),
        ...allMatches(content, /\bimport\(\s*["']([^"']+)["']\s*\)/g),
      ]);
    case "python":
      return uniq([...allMatches(content, /^\s*from\s+([.\w]+)\s+import\b/gm), ...allMatches(content, /^\s*import\s+([.\w]+)/gm)]);
    case "go":
      return uniq([...allMatches(content, /^\s*import\s+"([^"]+)"/gm), ...allMatches(content, /^\s+(?:\w+\s+)?"([^"]+)"$/gm)]);
    case "rust":
      return uniq(allMatches(content, /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm));
    default:
      return [];
  }
}

function extractSymbols(lang: string, content: string): readonly string[] {
  const patterns: Readonly<Record<string, readonly RegExp[]>> = {
    typescript: [
      /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum|const|let)\s+([A-Za-z_$][\w$]*)/g,
    ],
    javascript: [/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/g, /module\.exports\.(\w+)\s*=/g],
    python: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^class\s+([A-Za-z_]\w*)/gm],
    go: [/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm, /^type\s+([A-Z]\w*)/gm],
    rust: [/^\s*pub\s+(?:async\s+)?(?:fn|struct|enum|trait)\s+(\w+)/gm],
    java: [/\bpublic\s+(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record|[\w<>[\]]+)\s+(\w+)\s*[({<]/g],
    kotlin: [/^\s*(?:fun|class|object|interface)\s+(\w+)/gm],
    ruby: [/^\s*(?:def|class|module)\s+([\w.]+)/gm],
    php: [/^\s*(?:final\s+|abstract\s+)?(?:class|function|interface|trait)\s+(\w+)/gm],
    csharp: [/\bpublic\s+(?:static\s+|sealed\s+|abstract\s+)*(?:class|interface|record|enum|[\w<>[\]]+)\s+(\w+)\s*[({<]/g],
    sql: [/\bcreate\s+(?:table|view|function|index)\s+(?:if\s+not\s+exists\s+)?["`]?([\w.]+)/gi],
    prisma: [/^model\s+(\w+)/gm],
    markdown: [/^#{1,3}\s+(.+)$/gm],
  };
  const list = patterns[lang] ?? [];
  return uniq(list.flatMap((re) => allMatches(content, re))).slice(0, MAX_SYMBOLS);
}

function extractSummary(lang: string, content: string): string {
  const doc =
    /^\s*\/\*\*([\s\S]*?)\*\//.exec(content)?.[1] ??
    /^\s*(?:"""|''')([\s\S]*?)(?:"""|''')/.exec(content)?.[1] ??
    /^((?:\s*\/\/[^\n]*\n){1,4})/.exec(content)?.[1] ??
    (lang === "markdown" ? content.split(/\n\s*\n/).find((p) => p.trim() && !p.trim().startsWith("#")) : undefined) ??
    "";
  return doc
    .replace(/^\s*(\*|\/\/|#)\s?/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SUMMARY);
}

export function scanFile(filePath: string, content: string): ScannedFile {
  const lang = languageOf(filePath) ?? "text";
  return {
    path: filePath,
    lang,
    kind: kindOf(filePath, lang),
    imports: extractImports(lang, content),
    symbols: extractSymbols(lang, content),
    summary: extractSummary(lang, content),
  };
}

const JS_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".vue", ".svelte", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

/**
 * Resolves an import specifier to a repo file (or null for packages/externals).
 * Handles relative paths, the common "@/" → "src/" alias and Python relative modules.
 */
export function resolveImport(fromPath: string, spec: string, files: ReadonlySet<string>, lang: string): string | null {
  if (lang === "python") {
    if (!spec.startsWith(".")) {
      const asPath = spec.replace(/\./g, "/");
      return [`${asPath}.py`, `${asPath}/__init__.py`, `src/${asPath}.py`].find((c) => files.has(c)) ?? null;
    }
    const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
    let base = path.posix.dirname(fromPath);
    for (let i = 1; i < dots; i += 1) base = path.posix.dirname(base);
    const rest = spec.slice(dots).replace(/\./g, "/");
    const candidate = path.posix.normalize(rest ? `${base}/${rest}` : base);
    return [`${candidate}.py`, `${candidate}/__init__.py`].find((c) => files.has(c)) ?? null;
  }
  let base: string;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), spec));
  else if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith("~/")) base = spec.slice(2);
  else return null;
  if (base.startsWith("..")) return null;
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  for (const candidate of [base, stripped]) {
    for (const ext of JS_EXTENSIONS) {
      if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
    }
  }
  return null;
}
