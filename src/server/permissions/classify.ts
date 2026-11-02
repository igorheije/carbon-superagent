import path from "node:path";

/**
 * Decides what to do with a Claude Code permission prompt without bothering a human.
 * Pure and conservative: anything it cannot parse confidently is "ask", never "safe".
 */
export type ApprovalPolicy = "ask" | "smart" | "autonomous";
export type Verdict = "safe" | "ask" | "block";

export interface Classification {
  readonly verdict: Verdict;
  readonly reason: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Always denied, whatever the policy: irreversible, privilege escalation or exfiltration-shaped. */
const BLOCK_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/(^|[\s;&|(])sudo\s/, "sudo"],
  [/(^|[\s;&|(])git\s+push\b/, "git push (o Carbon faz o push)"],
  [/(^|[\s;&|(])git\s+reset\s+--hard\b/, "git reset --hard"],
  [/(^|[\s;&|(])git\s+(clean\s+-[a-z]*f|filter-branch|update-ref)\b/, "reescrita/limpeza do git"],
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\$HOME|\.\.)(\s|\/|$)/, "rm -rf fora do projeto"],
  [/\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh|python|node)\b/, "baixar e executar script"],
  [/\b(mkfs|fdisk|diskutil\s+erase|dd\s+if=)/, "operação de disco"],
  [/:\(\)\s*\{\s*:\|:&\s*\};:/, "fork bomb"],
  [/(^|[\s;&|(])(shutdown|reboot|halt)\b/, "desligar a máquina"],
  [/(~|\$HOME)\/\.(ssh|aws|gnupg|config\/gh|netrc)\b/, "credenciais do usuário"],
  [/\bchmod\s+(-R\s+)?777\b/, "chmod 777"],
];

/** First word(s) of a command segment considered low-risk inside the worktree. */
const SAFE_COMMANDS = new Set([
  "ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "echo", "printf", "which", "sort", "uniq", "diff", "jq",
  "true", "false", "test", "basename", "dirname", "realpath", "date", "env", "mkdir", "touch", "cp", "mv", "tee", "cut", "tr", "awk", "xargs",
]);
const SAFE_PREFIXES: readonly RegExp[] = [
  /^git\s+(status|diff|log|show|branch|rev-parse|ls-files|add|stash|restore|checkout\s+--|blame|grep)\b/,
  /^(npm|pnpm|yarn|bun)\s+(test|run|exec)\b/,
  /^npx\s+(vitest|jest|tsc|eslint|prettier|playwright\s+test|next\s+lint|biome)\b/,
  /^(node|deno|bun)\s+(--version|-v|--test|-e|--eval|-p|--print|[\w./-]+\.(m?js|cjs|ts))\b/,
  /^(python3?|py)\s+(-m\s+(pytest|unittest)|--version|[\w./-]+\.py)\b/,
  /^(pytest|ruff|mypy|black\s+--check|flake8)\b/,
  /^go\s+(test|build|vet|fmt|run)\b/,
  /^cargo\s+(test|build|check|clippy|fmt|run)\b/,
  /^make\s+(test|lint|build|check)\b/,
  /^sed\s+-n\b/,
  /^find\s+(?!.*-(exec|delete|ok)\b)/,
];

/** Needs network / runs third-party code: a human should know. */
const ASK_PREFIXES: readonly (readonly [RegExp, string])[] = [
  [/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci|update|upgrade|remove|uninstall)\b/, "instala/remove dependências (rede + scripts de terceiros)"],
  [/^(pip3?|poetry|uv|gem|bundle|cargo\s+add|go\s+get|brew|apt|apt-get)\b/, "instala pacotes"],
  [/^(curl|wget|http|ssh|scp|rsync|nc)\b/, "acesso à rede"],
  [/^docker\b|^docker-compose\b|^kubectl\b|^terraform\b/, "infraestrutura"],
  [/^git\s+(commit|merge|rebase|cherry-pick|tag|remote)\b/, "altera o histórico do git"],
];

/** Splits on ;, &&, ||, | — good enough for policy; quoted operators make it "ask" via the path checks. */
function segments(command: string): readonly string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^\(+|\)+$/g, "").trim())
    .filter(Boolean);
}

function isInside(root: string, target: string): boolean {
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

/** Absolute paths, ~ and ../ that leave the worktree. */
function leavesWorktree(command: string, root: string): boolean {
  const tokens = command.match(/(?:^|[\s=>'"])((?:\/|~|\.\.\/)[^\s'";|&)]*)/g) ?? [];
  return tokens.some((t) => {
    const p = t.replace(/^[\s=>'"]/, "");
    if (p === "/dev/null" || p.startsWith("/dev/null")) return false;
    if (p.startsWith("~")) return true;
    return !isInside(root, p);
  });
}

const SENSITIVE_FILE = /(^|\/)(\.env(\.[\w.-]+)?|id_rsa[\w.]*|.*\.pem|.*\.key|credentials(\.json)?|secrets?\.(json|ya?ml))$/i;
const GIT_INTERNALS = /(^|\/)\.git(\/|$)/;

function classifyBash(command: string, root: string): Classification {
  for (const [re, why] of BLOCK_PATTERNS) if (re.test(command)) return { verdict: "block", reason: why };
  if (/[`]|\$\(/.test(command)) return { verdict: "ask", reason: "usa substituição de comando" };
  if (leavesWorktree(command, root)) return { verdict: "ask", reason: "mexe em caminhos fora do projeto" };
  if (SENSITIVE_FILE.test(command.replace(/\s+/g, "/"))) return { verdict: "ask", reason: "toca arquivo sensível (.env, chaves)" };
  for (const seg of segments(command)) {
    const ask = ASK_PREFIXES.find(([re]) => re.test(seg));
    if (ask) return { verdict: "ask", reason: ask[1] };
    const first = seg.split(/\s+/)[0] ?? "";
    const isSafe = SAFE_COMMANDS.has(first) || SAFE_PREFIXES.some((re) => re.test(seg));
    if (!isSafe) return { verdict: "ask", reason: `comando não reconhecido como seguro: ${first}` };
  }
  return { verdict: "safe", reason: "comando de leitura/teste/build dentro do projeto" };
}

function classifyFile(tool: string, filePath: string, root: string, isWrite: boolean): Classification {
  if (!filePath) return { verdict: "ask", reason: `${tool} sem caminho` };
  const resolved = path.resolve(root, filePath);
  if (isWrite && GIT_INTERNALS.test(path.relative(root, resolved))) return { verdict: "block", reason: "escrever dentro de .git" };
  if (!isInside(root, resolved)) return { verdict: "ask", reason: `${isWrite ? "escreve" : "lê"} fora do projeto` };
  if (SENSITIVE_FILE.test(resolved)) return { verdict: "ask", reason: "arquivo sensível (.env, chaves)" };
  return { verdict: "safe", reason: `${isWrite ? "edita" : "lê"} arquivo do projeto` };
}

/** Raw classification of the requested action (before applying the policy). */
export function classifyAction(tool: string, input: unknown, worktree: string): Classification {
  const data = isRecord(input) ? input : {};
  const root = path.resolve(worktree);
  switch (tool) {
    case "Bash":
      return classifyBash(str(data.command), root);
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return classifyFile(tool, str(data.file_path) || str(data.notebook_path), root, true);
    case "Read":
    case "Glob":
    case "Grep":
    case "LS":
      return classifyFile(tool, str(data.file_path) || str(data.path) || ".", root, false);
    case "TodoWrite":
    case "Task":
    case "Agent":
    case "Skill":
      return { verdict: "safe", reason: "ferramenta interna do agente" };
    case "WebFetch":
    case "WebSearch":
      return { verdict: "ask", reason: "acesso à internet" };
    default:
      return { verdict: "ask", reason: `ferramenta externa: ${tool}` };
  }
}

/** Applies the chosen policy on top of the raw classification. Blocks always win. */
export function decide(policy: ApprovalPolicy, c: Classification): Verdict {
  if (c.verdict === "block") return "block";
  if (policy === "autonomous") return "safe";
  if (policy === "ask") return "ask";
  return c.verdict;
}

/** The reusable pattern a "always allow in this repo" rule stores for a request. */
export function rulePatternFor(tool: string, input: unknown): string {
  const data = isRecord(input) ? input : {};
  if (tool === "Bash") {
    const first = segments(str(data.command))[0] ?? "";
    const words = first.split(/\s+/).filter(Boolean);
    const takesSubcommand = /^(npm|pnpm|yarn|bun|npx|git|go|cargo|docker|kubectl|pip3?|poetry|uv|make|python3?|node)$/.test(words[0] ?? "");
    return words.slice(0, takesSubcommand ? 2 : 1).join(" ");
  }
  if (tool === "WebFetch") {
    try {
      return new URL(str(data.url)).hostname;
    } catch {
      return "";
    }
  }
  if (["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"].includes(tool)) {
    const file = str(data.file_path) || str(data.notebook_path);
    return file ? path.dirname(file) : "";
  }
  return "";
}

/** Whether a stored rule covers this request. Bash rules must match every command segment. */
export function ruleMatches(rule: { readonly tool: string; readonly pattern: string }, tool: string, input: unknown): boolean {
  if (rule.tool !== tool) return false;
  const data = isRecord(input) ? input : {};
  if (rule.pattern === "") return true;
  if (tool === "Bash") {
    const parts = segments(str(data.command));
    return parts.length > 0 && parts.every((s) => s === rule.pattern || s.startsWith(`${rule.pattern} `));
  }
  if (tool === "WebFetch") {
    try {
      return new URL(str(data.url)).hostname === rule.pattern;
    } catch {
      return false;
    }
  }
  const file = str(data.file_path) || str(data.notebook_path);
  return file !== "" && (file === rule.pattern || file.startsWith(`${rule.pattern}${path.sep}`));
}
