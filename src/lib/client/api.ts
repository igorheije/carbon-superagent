/** Client-side fetch wrapper for the { success, data, error } envelope. Throws Error(message). */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: "same-origin",
    });
  } catch {
    throw new Error("sem conexão com o servidor Carbon");
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  const envelope = payload as { success?: boolean; data?: T; error?: string } | null;
  if (!response.ok || !envelope?.success) {
    if (response.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
    throw new Error(envelope?.error ?? `erro ${response.status}`);
  }
  return envelope.data as T;
}

export interface SessionUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly persona: import("@/lib/domain/personas").PersonaId;
  readonly role: "admin" | "member";
  readonly mustChangePassword: boolean;
}

export interface PublicSettings {
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly defaultExecutor: "claude" | "codex";
  readonly permissionProfile: "guarded" | "auto" | "unrestricted";
  readonly acceptMode: "observe" | "act";
  readonly autoPush: boolean;
  readonly claudeModel: string;
  readonly codexModel: string;
  readonly claudeEffort: string;
  readonly codexEffort: string;
  readonly maxRunMinutes: number;
  readonly aiProjectSummary: boolean;
  readonly isolateClaudeConfig: boolean;
  readonly useClaudeMemory: boolean;
  readonly permissionTimeoutMinutes: number;
  readonly approvalPolicy: "ask" | "smart" | "autonomous";
  readonly linearConfigured: boolean;
  readonly publicBaseUrl: string;
  readonly integrationProjectId: string;
  readonly jiraSite: string;
  readonly jiraEmail: string;
  readonly jiraTriggerLabel: string;
  readonly jiraStatusStarted: string;
  readonly jiraStatusReview: string;
  readonly jiraConfigured: boolean;
  readonly jiraWebhookSecretSet: boolean;
  readonly slackChannelId: string;
  readonly slackConfigured: boolean;
  readonly telegramChatId: string;
  readonly telegramConfigured: boolean;
}

export interface ExecutorAvailability {
  readonly claude: boolean;
  readonly codex: boolean;
}

/** A check counts as usable when installed (ok) or installed with a soft warning. */
export const isUsable = (check: SystemCheck | undefined): boolean => check?.status === "ok" || check?.status === "warn";

export interface ProjectInfo {
  readonly id: string;
  readonly name: string;
  readonly repoPath: string;
  readonly baseBranch: string;
  readonly createdAt: string;
}

export interface SystemCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "ok" | "warn" | "missing" | "optional";
  readonly detail: string;
  readonly fix: string | null;
}
