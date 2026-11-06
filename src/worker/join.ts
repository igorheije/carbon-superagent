import { JOIN_PATH, joinResponseSchema, LEAVE_PATH, PROTOCOL_VERSION, type JoinRequest } from "../shared/worker-protocol";
import { createWorkerClient, USER_AGENT, WorkerClientError, type FetchLike } from "./client";
import { readNodeState, writeNodeState, type NodeState } from "./node-state";

/**
 * Cluster join (Docker Swarm-like). Decides which credential the worker runs with:
 *
 *  1. CARBON_WORKER_TOKEN (machine created by hand in the panel) — unchanged behaviour;
 *  2. the node credential saved by an earlier join (restart → same node, no duplicate);
 *  3. a fresh join with the cluster token (cjt_…), saving the new credential.
 *
 * `carbon join` (explicit) re-validates a saved credential and joins again if the panel refused it.
 * Auto-join from the environment (Docker/K8s) never re-adds a node the admin removed: it stops with
 * EXIT_REMOVED instead, so a restart policy cannot undo a removal.
 */
export const EXIT_REMOVED = 3;

export type CredentialSource = "env" | "saved" | "joined";

export interface ResolvedCredential {
  readonly token: string;
  readonly source: CredentialSource;
  readonly nodeId: string | null;
  readonly state: NodeState | null;
}

export class JoinError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "JoinError";
  }
}

export interface JoinCaps {
  readonly executors: readonly JoinRequest["executors"][number][];
  readonly git: boolean;
  readonly maxParallel: number;
  readonly workerVersion?: string;
}

export interface ResolveOptions {
  readonly panelUrl: string;
  readonly envToken?: string;
  readonly joinToken?: string;
  readonly stateDir: string;
  readonly hostname: string;
  readonly name: string;
  /** true for `carbon join`: re-check the saved credential and join again when refused. */
  readonly explicitJoin: boolean;
  readonly caps: JoinCaps;
  readonly fetchImpl?: FetchLike;
  readonly log?: (message: string) => void;
  readonly now?: () => Date;
}

const JOIN_REFUSED = "o painel recusou o token de join (inválido, expirado, girado ou já usado o máximo de vezes)";

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error.slice(0, 300) : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** POST /api/worker/join with the cluster token; returns the node id and its own credential. */
export async function requestJoin(
  panelUrl: string,
  joinToken: string,
  body: JoinRequest,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<{ nodeId: string; token: string; name: string; availability: string }> {
  if (!joinToken.startsWith("cjt_") || /\s/.test(joinToken)) throw new JoinError("token de join inválido (deve começar com cjt_)");
  let res: Response;
  try {
    res = await fetchImpl(`${panelUrl}${JOIN_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${joinToken}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new JoinError(`não consegui falar com o painel em ${panelUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (res.status === 401) throw new JoinError(JOIN_REFUSED);
  if (res.status === 429) throw new JoinError("muitas tentativas de join deste endereço; aguarde 15 minutos");
  if (res.status === 426) throw new JoinError(`o painel exige um worker mais novo: ${await errorText(res)}`, 2);
  if (res.status !== 201) throw new JoinError(`join falhou: ${await errorText(res)}`);
  const envelope = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const parsed = joinResponseSchema.safeParse(envelope?.data);
  if (!parsed.success) throw new JoinError("join falhou: resposta fora do protocolo");
  return parsed.data;
}

/** true when the panel still accepts the credential; false on 401/403; throws on anything else. */
async function credentialAccepted(opts: ResolveOptions, token: string): Promise<boolean> {
  const client = createWorkerClient({ panelUrl: opts.panelUrl, token, fetchImpl: opts.fetchImpl });
  try {
    await client.hello({ executors: [...opts.caps.executors], git: opts.caps.git, maxParallel: opts.caps.maxParallel, workerVersion: opts.caps.workerVersion });
    return true;
  } catch (error) {
    if (error instanceof WorkerClientError && (error.status === 401 || error.status === 403)) return false;
    throw error;
  }
}

async function joinFresh(opts: ResolveOptions): Promise<ResolvedCredential> {
  if (!opts.joinToken) {
    throw new JoinError("sem credencial: rode `carbon join <url-do-painel> --token cjt_…` (o comando aparece em Configurações → Máquinas)");
  }
  const joined = await requestJoin(
    opts.panelUrl,
    opts.joinToken,
    { name: opts.name, hostname: opts.hostname, version: PROTOCOL_VERSION, ...opts.caps, executors: [...opts.caps.executors] },
    opts.fetchImpl,
  );
  const state: NodeState = {
    panelUrl: opts.panelUrl,
    nodeId: joined.nodeId,
    token: joined.token,
    name: joined.name,
    joinedAt: (opts.now?.() ?? new Date()).toISOString(),
    removedAt: null,
  };
  const file = writeNodeState(opts.stateDir, opts.hostname, state);
  opts.log?.(`entrou no cluster como "${joined.name}" (nó ${joined.nodeId.slice(0, 8)}) · credencial salva em ${file}`);
  if (joined.availability === "pending") opts.log?.("aguardando aprovação do admin em Configurações → Máquinas");
  return { token: joined.token, source: "joined", nodeId: joined.nodeId, state };
}

export async function resolveCredential(opts: ResolveOptions): Promise<ResolvedCredential> {
  if (opts.envToken) return { token: opts.envToken, source: "env", nodeId: null, state: null };
  const saved = readNodeState(opts.stateDir, opts.hostname);
  if (saved && saved.panelUrl !== opts.panelUrl) {
    if (!opts.explicitJoin) {
      throw new JoinError(`a credencial salva é de outro painel (${saved.panelUrl}); rode carbon join para entrar em ${opts.panelUrl}`);
    }
    opts.log?.(`credencial salva era de ${saved.panelUrl}; entrando em ${opts.panelUrl}`);
    return joinFresh(opts);
  }
  if (saved?.removedAt && !opts.explicitJoin) {
    throw new JoinError("este nó foi removido do cluster; rode `carbon join <url> --token cjt_…` para entrar de novo", EXIT_REMOVED);
  }
  if (saved && !saved.removedAt) {
    if (!opts.explicitJoin || (await credentialAccepted(opts, saved.token))) {
      return { token: saved.token, source: "saved", nodeId: saved.nodeId, state: saved };
    }
    opts.log?.("a credencial salva foi recusada pelo painel; fazendo join de novo");
  }
  return joinFresh(opts);
}

/** `carbon leave`: tells the panel (best effort) and forgets the local credential. */
export async function leaveCluster(panelUrl: string, token: string, fetchImpl: FetchLike = (input, init) => fetch(input, init)): Promise<"left" | "already_removed"> {
  let res: Response;
  try {
    res = await fetchImpl(`${panelUrl}${LEAVE_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: "{}",
    });
  } catch (error) {
    throw new JoinError(`não consegui avisar o painel (${error instanceof Error ? error.message : String(error)}); a credencial local foi mantida`);
  }
  if (res.status === 401 || res.status === 403) return "already_removed";
  if (!res.ok) throw new JoinError(`leave falhou: ${await errorText(res)}`);
  return "left";
}
