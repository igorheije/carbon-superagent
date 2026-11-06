/**
 * Reads the Claude Code auto-memory a developer already built for a repository
 * (<config dir>/projects/<slug of repo path>/memory/*.md) so portal runs start with
 * the same context as a terminal session in that repo.
 *
 * The layout is not a public contract: anything missing or unexpected yields null.
 * Read-only; symlinks are skipped so the folder cannot pull in files from elsewhere.
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const INDEX_FILE = "MEMORY.md";
const DEFAULT_MAX_FILES = 300;
const DEFAULT_MAX_FILE_BYTES = 50_000;
const DEFAULT_INLINE_BUDGET = 24_000;

/** Where the copy lives inside the worktree (.carbon/ is never committed). */
export const MEMORY_WORKTREE_DIR = ".carbon/claude-memory";

export interface MemoryFile {
  readonly name: string;
  readonly content: string;
}

export interface RepoMemory {
  readonly dir: string;
  /** MEMORY.md first (when present), then the rest in name order. */
  readonly files: readonly MemoryFile[];
  /** True when a file was cut or the folder had more files than the limit. */
  readonly isTruncated: boolean;
}

export interface ReadMemoryOptions {
  readonly configDirs?: readonly string[];
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
}

/** Same folder name Claude Code uses: every non-alphanumeric character becomes "-". */
export function claudeProjectSlug(repoPath: string): string {
  return repoPath.replace(/[^a-zA-Z0-9]/g, "-");
}

/** CLAUDE_CONFIG_DIR (when set) wins, then ~/.claude. */
export function claudeConfigDirs(env: Readonly<Record<string, string | undefined>> = process.env, home: string = homedir()): readonly string[] {
  const candidates = [env.CLAUDE_CONFIG_DIR?.trim(), path.join(home, ".claude")].filter((d): d is string => Boolean(d));
  return [...new Set(candidates.map((d) => path.resolve(d)))];
}

function isDirectory(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isRegularFile(p: string): boolean {
  try {
    return lstatSync(p).isFile();
  } catch {
    return false;
  }
}

function markdownNames(dir: string): readonly string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const regular = names.filter((n) => n.toLowerCase().endsWith(".md") && isRegularFile(path.join(dir, n)));
  const rest = regular.filter((n) => n !== INDEX_FILE).sort((a, b) => a.localeCompare(b));
  return regular.includes(INDEX_FILE) ? [INDEX_FILE, ...rest] : rest;
}

function readFiles(dir: string, names: readonly string[], maxFileBytes: number): { files: MemoryFile[]; isCut: boolean } {
  const files: MemoryFile[] = [];
  let isCut = false;
  for (const name of names) {
    let content: string;
    try {
      content = readFileSync(path.join(dir, name), "utf8").trim();
    } catch {
      continue;
    }
    if (!content) continue;
    if (content.length > maxFileBytes) {
      content = content.slice(0, maxFileBytes);
      isCut = true;
    }
    files.push({ name, content });
  }
  return { files, isCut };
}

/** The repository's Claude Code memory, or null when there is none. */
export function readRepoMemory(repoPath: string, options: ReadMemoryOptions = {}): RepoMemory | null {
  const slug = claudeProjectSlug(path.resolve(repoPath));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  for (const configDir of options.configDirs ?? claudeConfigDirs()) {
    const dir = path.join(configDir, "projects", slug, "memory");
    if (!isDirectory(dir)) continue;
    const names = markdownNames(dir);
    const { files, isCut } = readFiles(dir, names.slice(0, maxFiles), options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    if (files.length > 0) return { dir, files, isTruncated: isCut || names.length > maxFiles };
  }
  return null;
}

/**
 * Prompt section: the index (and as many files as fit the budget) inline, the rest listed
 * by path inside the worktree so the agent opens them only when relevant.
 */
export function memoryPromptSection(memory: RepoMemory, inlineBudget: number = DEFAULT_INLINE_BUDGET): string {
  const inline: MemoryFile[] = [];
  let used = 0;
  for (const file of memory.files) {
    if (used + file.content.length > inlineBudget) break;
    inline.push(file);
    used += file.content.length;
  }
  const listed = memory.files.slice(inline.length);
  const body = inline.map((f) => `<memory-file name="${f.name}">\n${f.content}\n</memory-file>`).join("\n\n");
  const more = listed.length
    ? `\n\nMore memory files (copied to ${MEMORY_WORKTREE_DIR}/). Open the ones the index or the task points to:\n${listed.map((f) => `- ${MEMORY_WORKTREE_DIR}/${f.name}`).join("\n")}`
    : "";
  return `## Claude Code memory for this repository
The developer's own Claude Code memory for this repo (preferences, decisions, project context and feedback from earlier sessions). Apply it when relevant. If it conflicts with the task or the rules above, the task and the rules above take precedence. Do not edit these files.${memory.isTruncated ? "\n(Some memory was cut to fit the size limits.)" : ""}

${body || "(index too large to inline; see the files below)"}${more}`;
}
