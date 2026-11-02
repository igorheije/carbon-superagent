import { z } from "zod";

/**
 * SKILL.md format shared with Claude Code (and Codex skills):
 * YAML-ish frontmatter with `name` + `description`, then a markdown body.
 */
export const MAX_SKILL_BYTES = 200_000;

export const skillNameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "use kebab-case: letras minúsculas, números e hífen (até 64)");

export const skillInputSchema = z.object({
  name: skillNameSchema,
  description: z.string().trim().min(10, "descreva quando usar (mín. 10 caracteres)").max(1024),
  body: z.string().trim().min(20, "corpo muito curto").max(MAX_SKILL_BYTES),
});

export type SkillInput = z.infer<typeof skillInputSchema>;

export type ParseResult =
  | { readonly ok: true; readonly skill: SkillInput }
  | { readonly ok: false; readonly error: string };

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(value: string): string {
  const v = value.trim();
  return (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")) ? v.slice(1, -1) : v;
}

/** Minimal frontmatter reader: top-level `key: value` pairs, plus `>`/`|` folded blocks. */
function readFrontmatter(raw: string): Record<string, string> {
  const lines = raw.split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i] ?? "");
    if (!match) continue;
    const key = match[1] as string;
    const value = match[2] ?? "";
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1] ?? "")) {
        i += 1;
        block.push((lines[i] ?? "").trim());
      }
      out[key] = block.join(value.startsWith(">") ? " " : "\n");
    } else {
      out[key] = unquote(value);
    }
  }
  return out;
}

export function parseSkillMarkdown(markdown: string): ParseResult {
  if (Buffer.byteLength(markdown, "utf8") > MAX_SKILL_BYTES) return { ok: false, error: "arquivo maior que 200 KB" };
  const match = FRONTMATTER_RE.exec(markdown.replace(/^﻿/, ""));
  if (!match) return { ok: false, error: "SKILL.md precisa de frontmatter (--- name/description ---)" };
  const meta = readFrontmatter(match[1] ?? "");
  const parsed = skillInputSchema.safeParse({ name: meta.name ?? "", description: meta.description ?? "", body: match[2] ?? "" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") ?? "skill"}: ${issue?.message ?? "inválido"}` };
  }
  return { ok: true, skill: parsed.data };
}

/** Serializes back to SKILL.md (used when materializing into a worktree). */
export function toSkillMarkdown(skill: SkillInput): string {
  const description = skill.description.replace(/\r?\n/g, " ").replace(/"/g, '\\"');
  return `---\nname: ${skill.name}\ndescription: "${description}"\n---\n\n${skill.body.trim()}\n`;
}

const ALLOWED_HOSTS = new Set(["raw.githubusercontent.com", "gist.githubusercontent.com", "github.com"]);

/**
 * Normalizes a GitHub URL to its raw form. Only GitHub hosts are accepted
 * (server-side fetch → SSRF guard). Returns null when the URL is not allowed.
 */
export function normalizeSkillUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port) return null;
  if (url.hostname === "github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
    if (!m) return null;
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
  }
  return url.toString();
}
