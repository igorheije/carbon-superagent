import "server-only";
import type { TaskRuntime } from "@/lib/domain/types";
import { listWorkers } from "../repo/workers";
import type { Settings } from "../repo/settings";

/** Whether a runtime can take new tasks right now, and why not (shown next to the disabled option). */
export interface RuntimeAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

const AVAILABLE: RuntimeAvailability = { available: true, reason: null };
const unavailable = (reason: string): RuntimeAvailability => ({ available: false, reason });

type Env = Readonly<Record<string, string | undefined>>;

// Builtins resolved at call time: repo/settings.ts imports this module, and Next also traces it for
// the Edge bundle of instrumentation, where static node:fs/node:os imports only produce warnings.
const fileExistsNode = (file: string): boolean => process.getBuiltinModule("node:fs").existsSync(file);
const homeDirNode = (): string => process.getBuiltinModule("node:os").homedir();
const join = (...parts: string[]): string => parts.join("/").replace(/\/{2,}/g, "/");

/**
 * Cheap, offline check that the AWS SDK default credential chain has something to work with:
 * static keys, a profile/SSO/role in the shared files, web identity (EKS) or container
 * credentials (ECS). It never resolves credentials (that may call STS/IMDS over the network), so
 * expired SSO sessions still pass here and fail later with a clear SDK error on Invoke.
 */
export function hasAwsCredentialSource(env: Env = process.env, fileExists: (file: string) => boolean = fileExistsNode, home: string = homeDirNode()): boolean {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return true;
  if (env.AWS_WEB_IDENTITY_TOKEN_FILE && env.AWS_ROLE_ARN) return true;
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
  const credentials = env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
  const config = env.AWS_CONFIG_FILE || join(home, ".aws", "config");
  return fileExists(credentials) || fileExists(config);
}

/** AgentCore needs: enabled, a runtime ARN, a public panel URL and an AWS credential source. */
export function agentcoreAvailability(settings: Pick<Settings, "agentcore" | "panelPublicUrl">, hasCredentials: () => boolean = hasAwsCredentialSource): RuntimeAvailability {
  if (!settings.agentcore.enabled) return unavailable("AgentCore desativado nas configurações");
  if (!settings.agentcore.runtimeArn) return unavailable("configure o ARN do runtime AgentCore");
  if (!settings.panelPublicUrl) return unavailable("configure a URL pública do painel (os containers precisam alcançá-lo)");
  if (!hasCredentials()) return unavailable("credenciais AWS não encontradas nesta máquina (AWS_PROFILE, ~/.aws ou variáveis de ambiente)");
  return AVAILABLE;
}

/** The pool needs at least one registered, non-revoked worker machine. */
export function poolAvailability(workers: readonly { readonly kind: string; readonly revokedAt: number | null }[] = listWorkers()): RuntimeAvailability {
  return workers.some((w) => w.kind === "pool" && w.revokedAt === null) ? AVAILABLE : unavailable("nenhuma máquina worker cadastrada (Admin → Máquinas)");
}

export type RuntimeAvailabilityMap = Readonly<Record<TaskRuntime, RuntimeAvailability>>;

export function runtimeAvailability(settings: Settings): RuntimeAvailabilityMap {
  return { local: AVAILABLE, pool: poolAvailability(), agentcore: agentcoreAvailability(settings) };
}
