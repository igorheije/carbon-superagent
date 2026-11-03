import { handle, HttpError, ok, parseBody, requireAdmin, requireUser } from "@/server/http";
import { verifyJira } from "@/server/integrations/jira";
import { verifyKey } from "@/server/integrations/linear";
import { verifySlack } from "@/server/integrations/slack";
import { verifyTelegram } from "@/server/integrations/telegram";
import { getSettings, saveSettings, SECRET_KEYS, settingsSchema, toPublicSettings, type Settings } from "@/server/repo/settings";
import { notifyChange } from "@/server/runner/runner";
import { detectExecutors } from "@/server/system/detect";

export const dynamic = "force-dynamic";

export function GET() {
  return handle(async () => {
    await requireUser();
    return ok({ settings: toPublicSettings(getSettings()) });
  });
}

type Patch = Partial<Settings>;

/** Secrets: "" keeps the stored value, "-" clears it, anything else replaces it. */
function applySecretRules(patch: Patch): Patch {
  const next: Record<string, unknown> = { ...patch };
  for (const key of SECRET_KEYS) {
    if (next[key] === "") delete next[key];
    else if (next[key] === "-") next[key] = "";
  }
  return next as Patch;
}

/** True when the patch really changes one of these keys (forms send unchanged values too). */
const changed = (patch: Patch, current: Settings, keys: readonly (keyof Settings)[]): boolean =>
  keys.some((k) => patch[k] !== undefined && patch[k] !== "" && patch[k] !== current[k]);

async function check(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    throw new HttpError(400, `${label}: ${error instanceof Error ? error.message : "credencial inválida"}`);
  }
}

/** New credentials are tested before they are saved, so a typo never silently breaks a channel. */
async function verifyChangedCredentials(patch: Patch): Promise<void> {
  const current = getSettings();
  const merged = { ...current, ...patch };
  if (changed(patch, current, ["linearApiKey"])) await check("Linear", () => verifyKey(merged.linearApiKey));
  if (changed(patch, current, ["jiraSite", "jiraEmail", "jiraApiToken"]) && merged.jiraSite && merged.jiraEmail && merged.jiraApiToken) {
    await check("Jira", () => verifyJira({ site: merged.jiraSite, email: merged.jiraEmail, apiToken: merged.jiraApiToken }));
  }
  if (changed(patch, current, ["slackBotToken"])) await check("Slack", () => verifySlack(merged.slackBotToken));
  if (changed(patch, current, ["telegramBotToken"])) await check("Telegram", () => verifyTelegram(merged.telegramBotToken));
}

/** Admin-only. */
export function PUT(request: Request) {
  return handle(async () => {
    await requireAdmin();
    // Repository and base branch now live on each project (/api/projects).
    const body = await parseBody(request, settingsSchema.partial());
    const patch = applySecretRules(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "repoPath" && key !== "baseBranch")) as Patch);
    if (patch.defaultExecutor && !(await detectExecutors())[patch.defaultExecutor]) {
      throw new HttpError(400, `${patch.defaultExecutor === "claude" ? "Claude Code" : "Codex"} não está instalado nesta máquina`);
    }
    await verifyChangedCredentials(patch);
    const saved = saveSettings(patch);
    notifyChange();
    return ok({ settings: toPublicSettings(saved) });
  });
}
