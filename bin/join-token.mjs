// `carbon join-token`: shows or rotates the cluster join token on the panel host (Docker Swarm's
// `docker swarm join-token worker`). Writes straight to the panel database, like `worker init`.
// Same format as src/server/auth/join-tokens.ts: `cjt_` + base64url(32 bytes); only the sha256 is stored,
// so the plain token is printed once, on rotation.
import { createHash, randomBytes, randomUUID } from "node:crypto";

export const JOIN_TOKEN_USAGE = `uso: carbon join-token [--rotate] [--ttl <horas>h] [--max-uses <N>] [--disable]
  (sem opções)       mostra o estado do token de join (o token em si só aparece ao girar)
  --rotate           gera um token novo e invalida o anterior (nós já no cluster seguem rodando)
  --ttl 24h          validade do token novo (padrão: sem validade)
  --max-uses 3       quantos servidores podem entrar com ele (padrão: ilimitado)
  --disable          desliga o join até gerar outro token`;

const MAX_TTL_HOURS = 24 * 365;
const MAX_USES = 10_000;

export class JoinTokenError extends Error {
  constructor(message) {
    super(message);
    this.name = "JoinTokenError";
  }
}

export function parseJoinTokenArgs(argv) {
  const opts = { rotate: false, disable: false, ttlHours: null, maxUses: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--rotate") opts.rotate = true;
    else if (arg === "--disable") opts.disable = true;
    else if (arg === "--ttl" || arg === "--max-uses") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new JoinTokenError(`${arg} precisa de um valor`);
      i += 1;
      if (arg === "--ttl") {
        const match = /^(\d+)h?$/.exec(value);
        if (!match || Number(match[1]) < 1 || Number(match[1]) > MAX_TTL_HOURS) throw new JoinTokenError(`--ttl em horas, de 1h a ${MAX_TTL_HOURS}h`);
        opts.ttlHours = Number(match[1]);
      } else {
        if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > MAX_USES) throw new JoinTokenError(`--max-uses entre 1 e ${MAX_USES}`);
        opts.maxUses = Number(value);
      }
    } else throw new JoinTokenError(`opção desconhecida: ${arg}`);
  }
  if (opts.disable && opts.rotate) throw new JoinTokenError("use --rotate ou --disable, não os dois");
  if ((opts.ttlHours || opts.maxUses) && !opts.rotate) throw new JoinTokenError("--ttl e --max-uses valem só com --rotate");
  return opts;
}

function requireTable(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'join_tokens'").get();
  if (!table) throw new JoinTokenError("o banco ainda não tem a tabela join_tokens: inicie o painel uma vez (carbon start) para migrar");
}

function panelUrlOf(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get();
  try {
    return row ? (JSON.parse(row.value).panelPublicUrl ?? "") : "";
  } catch {
    return "";
  }
}

export function activeJoinToken(db, now = Date.now()) {
  return (
    db
      .prepare(
        `SELECT id, created_at, expires_at, max_uses, uses FROM join_tokens
         WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(now) ?? null
  );
}

export function rotateJoinTokenInDb(db, { ttlHours, maxUses }, now = Date.now()) {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (!admin) throw new JoinTokenError("nenhum admin no painel ainda: abra /setup primeiro");
  const token = `cjt_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE join_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now);
    db.prepare("INSERT INTO join_tokens (id, token_hash, created_by, created_at, expires_at, max_uses) VALUES (?, ?, ?, ?, ?, ?)").run(
      randomUUID(),
      hash,
      admin.id,
      now,
      ttlHours ? now + ttlHours * 3_600_000 : null,
      maxUses ?? null,
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return token;
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/** Same commands as src/server/setup-kit/join-command.ts (kept in sync by bin/join-token.test.mjs). */
export function joinCommandLines(panelUrl, token, image) {
  const url = panelUrl || "https://<url-pública-do-painel>";
  return {
    cli: `npx carbon join ${quote(url)} --token ${quote(token)}`,
    docker: [
      "docker run -d --name carbon-worker --restart unless-stopped \\",
      `  -e CARBON_PANEL_URL=${quote(url)} \\`,
      `  -e CARBON_JOIN_TOKEN=${quote(token)} \\`,
      "  -e ANTHROPIC_API_KEY='<sua-chave>' \\",
      "  -v carbon-worker-state:/home/carbon/state \\",
      `  ${image}`,
    ].join("\n"),
  };
}

/** Runs the command against an open panel database; returns lines to print. */
export function runJoinToken(db, opts, { version, now = Date.now() }) {
  requireTable(db);
  if (opts.disable) {
    const changes = Number(db.prepare("UPDATE join_tokens SET revoked_at = ? WHERE revoked_at IS NULL").run(now).changes);
    return { lines: [changes > 0 ? "join desligado: nenhum servidor novo entra até gerar outro token (--rotate)" : "o join já estava desligado"], token: null };
  }
  if (!opts.rotate) {
    const active = activeJoinToken(db, now);
    if (!active) return { lines: ["nenhum token de join ativo. Gere um com: carbon join-token --rotate"], token: null };
    const expires = active.expires_at ? new Date(active.expires_at).toISOString() : "sem validade";
    const uses = active.max_uses ? `${active.uses}/${active.max_uses}` : `${active.uses} (ilimitado)`;
    return {
      lines: [`token de join ativo desde ${new Date(active.created_at).toISOString()} · expira: ${expires} · usos: ${uses}`, "o token só é mostrado ao gerar; para ver de novo, gire: carbon join-token --rotate"],
      token: null,
    };
  }
  const token = rotateJoinTokenInDb(db, opts, now);
  const panelUrl = panelUrlOf(db);
  const commands = joinCommandLines(panelUrl, token, `carbon-worker:${version}`);
  const lines = [
    "Token de join gerado (mostrado só agora; o anterior deixou de valer):",
    token,
    "",
    "Em cada servidor novo, rode:",
    commands.cli,
    "",
    "ou com Docker:",
    commands.docker,
  ];
  if (!panelUrl) lines.push("", "Atenção: o painel não tem URL pública configurada (Configurações → Execução). Troque o placeholder pela URL https do painel.");
  return { lines, token };
}
