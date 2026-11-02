import { handle, HttpError, ok, parseBody, requireUser } from "@/server/http";
import { createSkill, skillNameTaken } from "@/server/repo/skills";
import { importSkillSchema } from "@/server/schemas";
import { MAX_SKILL_BYTES, normalizeSkillUrl, parseSkillMarkdown } from "@/server/skills/parse";

export const dynamic = "force-dynamic";

const FETCH_TIMEOUT_MS = 10_000;

async function fetchSkill(rawUrl: string): Promise<{ content: string; url: string }> {
  const url = normalizeSkillUrl(rawUrl);
  if (!url) throw new HttpError(400, "só aceitamos links https do GitHub (github.com/…/blob/… ou raw.githubusercontent.com)");
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!response?.ok) throw new HttpError(400, `não foi possível baixar a skill (${response?.status ?? "rede"})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_SKILL_BYTES) throw new HttpError(400, "arquivo maior que 200 KB");
  const content = await response.text();
  return { content, url };
}

/**
 * Imported skills are third-party instructions for the agent: they are created DISABLED
 * so someone reviews them before they reach a run.
 */
export function POST(request: Request) {
  return handle(async () => {
    const user = await requireUser();
    const input = await parseBody(request, importSkillSchema);
    const source = "url" in input ? await fetchSkill(input.url) : { content: input.content, url: null };
    const parsed = parseSkillMarkdown(source.content);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    if (skillNameTaken(parsed.skill.name)) throw new HttpError(409, `já existe a skill "${parsed.skill.name}"`);
    const skill = createSkill({ ...parsed.skill, personas: input.personas, source: "imported", sourceUrl: source.url, enabled: false, authorId: user.id });
    return ok({ skill }, 201);
  });
}
