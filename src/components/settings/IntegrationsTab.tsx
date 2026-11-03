"use client";

import { useState } from "react";
import { CheckCircle2, CircleDashed, PlugZap } from "lucide-react";
import { useSession } from "@/components/session/SessionProvider";
import { Button, CopyCommand, Field } from "@/components/ui/Form";
import { Panel } from "@/components/ui/Panel";
import { api, type PublicSettings } from "@/lib/client/api";

type Target = "tunnel" | "jira" | "slack" | "telegram";
type Feedback = { readonly ok: boolean; readonly text: string } | null;

const SLACK_SCOPES = ["app_mentions:read", "chat:write", "channels:history"];

const slackManifest = (base: string) =>
  JSON.stringify(
    {
      display_information: { name: "Carbon" },
      features: { bot_user: { display_name: "carbon", always_online: true } },
      oauth_config: { scopes: { bot: SLACK_SCOPES } },
      settings: {
        event_subscriptions: { request_url: `${base}/api/webhooks/slack`, bot_events: ["app_mention"] },
        interactivity: { is_enabled: true, request_url: `${base}/api/webhooks/slack` },
      },
    },
    null,
    2,
  );

function Status({ isOn, label }: { isOn: boolean; label: string }) {
  return (
    <span className={`flex items-center gap-1.5 font-mono text-[11px] ${isOn ? "text-ok" : "text-subtle"}`}>
      {isOn ? <CheckCircle2 className="size-3.5" /> : <CircleDashed className="size-3.5" />} {label}
    </span>
  );
}

function Message({ feedback }: { feedback: Feedback }) {
  if (!feedback) return null;
  return <p role="status" className={`font-mono text-[12px] ${feedback.ok ? "text-ok" : "text-danger"}`}>{feedback.text}</p>;
}

function Steps({ items }: { items: readonly React.ReactNode[] }) {
  return (
    <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-[12.5px] leading-relaxed text-muted marker:font-mono marker:text-subtle">
      {items.map((item, i) => <li key={i}>{item}</li>)}
    </ol>
  );
}

export function IntegrationsTab() {
  const { settings, projects, refresh } = useSession();
  const [draft, setDraft] = useState<PublicSettings | null>(settings);
  const [secrets, setSecrets] = useState({ jiraApiToken: "", slackBotToken: "", slackSigningSecret: "", telegramBotToken: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Partial<Record<Target, Feedback>>>({});
  const [jiraUrl, setJiraUrl] = useState<string | null>(null);
  if (!draft) return null;

  const set = (patch: Partial<PublicSettings>) => setDraft({ ...draft, ...patch });
  const setSecret = (patch: Partial<typeof secrets>) => setSecrets({ ...secrets, ...patch });
  const say = (target: Target, value: Feedback) => setFeedback((f) => ({ ...f, [target]: value }));
  const base = draft.publicBaseUrl;
  const hookUrl = (name: string) => (base ? `${base}/api/webhooks/${name}` : "defina a URL pública do túnel primeiro");

  const run = async (key: string, target: Target, work: () => Promise<string>) => {
    setBusy(key);
    say(target, null);
    try {
      say(target, { ok: true, text: await work() });
      await refresh();
    } catch (e) {
      say(target, { ok: false, text: e instanceof Error ? e.message : "falha" });
    } finally {
      setBusy(null);
    }
  };

  const save = (target: Target, body: Record<string, unknown>) =>
    run(`save-${target}`, target, async () => {
      const data = await api<{ settings: PublicSettings }>("/api/settings", { method: "PUT", body });
      setDraft(data.settings);
      setSecrets({ jiraApiToken: "", slackBotToken: "", slackSigningSecret: "", telegramBotToken: "" });
      return "salvo";
    });

  const test = (target: "jira" | "slack" | "telegram") =>
    run(`test-${target}`, target, async () => (await api<{ detail: string }>("/api/integrations/test", { body: { target } })).detail);

  const webhook = (target: "jira" | "telegram") =>
    run(`hook-${target}`, target, async () => {
      const data = await api<{ url: string; settings: PublicSettings }>("/api/integrations/webhooks", { body: { target } });
      setDraft(data.settings);
      if (target === "jira") {
        setJiraUrl(data.url);
        return "URL gerada. Copie agora: o segredo não aparece de novo.";
      }
      return `webhook registrado em ${data.url}`;
    });

  return (
    <div className="flex flex-col gap-5">
      <Panel eyebrow="Túnel" title="URL pública para webhooks" aside={<Status isOn={Boolean(base)} label={base ? "definida" : "pendente"} />}>
        <p className="mb-3 text-[13px] leading-relaxed text-muted">
          Jira, Slack e Telegram chamam o Carbon por webhook. Como ele roda só em 127.0.0.1, rode um túnel HTTPS e cole a URL aqui. Cada webhook só é aceito com a assinatura ou o segredo do serviço.
        </p>
        <CopyCommand command="cloudflared tunnel --url http://127.0.0.1:3417" />
        <p className="mt-2 text-[12px] text-warn">O túnel também expõe o painel (protegido por login). Use senhas fortes e desligue o túnel quando não precisar.</p>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="URL pública (https)" placeholder="https://abc-123.trycloudflare.com" value={draft.publicBaseUrl} onChange={(e) => set({ publicBaseUrl: e.target.value })} />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="integration-project" className="eyebrow">Projeto que recebe as tarefas</label>
            <select id="integration-project" value={draft.integrationProjectId} onChange={(e) => set({ integrationProjectId: e.target.value })} className="rounded-xl border border-line bg-surface-sunken px-3.5 py-2.5 text-[14px] outline-none focus:border-line-strong">
              <option value="">primeiro projeto</option>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button onClick={() => void save("tunnel", { publicBaseUrl: draft.publicBaseUrl, integrationProjectId: draft.integrationProjectId })} isLoading={busy === "save-tunnel"}>Salvar</Button>
          <Message feedback={feedback.tunnel ?? null} />
        </div>
      </Panel>

      <Panel eyebrow="Jira Cloud" title="Issues com label viram tarefas" aside={<Status isOn={draft.jiraConfigured} label={draft.jiraConfigured ? "configurado" : "não configurado"} />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Site" placeholder="https://suaempresa.atlassian.net" value={draft.jiraSite} onChange={(e) => set({ jiraSite: e.target.value })} />
          <Field label="E-mail da conta" type="email" value={draft.jiraEmail} onChange={(e) => set({ jiraEmail: e.target.value })} />
          <Field label="API token" type="password" placeholder={draft.jiraConfigured ? "•••••• (vazio mantém)" : "id.atlassian.com → API tokens"} value={secrets.jiraApiToken} onChange={(e) => setSecret({ jiraApiToken: e.target.value })} />
          <Field label="Label que dispara" value={draft.jiraTriggerLabel} onChange={(e) => set({ jiraTriggerLabel: e.target.value })} hint="ou comente /carbon <pedido> na issue" />
          <Field label="Status ao começar" value={draft.jiraStatusStarted} onChange={(e) => set({ jiraStatusStarted: e.target.value })} hint="vazio = não mover" />
          <Field label="Status com PR pronto" value={draft.jiraStatusReview} onChange={(e) => set({ jiraStatusReview: e.target.value })} hint="vazio = não mover" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => void save("jira", { jiraSite: draft.jiraSite, jiraEmail: draft.jiraEmail, jiraApiToken: secrets.jiraApiToken, jiraTriggerLabel: draft.jiraTriggerLabel, jiraStatusStarted: draft.jiraStatusStarted, jiraStatusReview: draft.jiraStatusReview })} isLoading={busy === "save-jira"}>Salvar</Button>
          <Button variant="ghost" onClick={() => void test("jira")} isLoading={busy === "test-jira"} disabled={!draft.jiraConfigured}><PlugZap className="size-4" /> Testar</Button>
          <Button variant="ghost" onClick={() => void webhook("jira")} isLoading={busy === "hook-jira"} disabled={!base || !draft.jiraConfigured}>{draft.jiraWebhookSecretSet ? "Gerar nova URL do webhook" : "Gerar URL do webhook"}</Button>
          <Message feedback={feedback.jira ?? null} />
        </div>
        {jiraUrl && <div className="mt-3"><CopyCommand command={jiraUrl} /></div>}
        <div className="mt-4">
          <Steps items={[
            "Gere a URL do webhook acima (exige túnel e credenciais salvas).",
            <>No Jira: <b>Configurações → Sistema → WebHooks → Criar</b>, cole a URL e marque <b>Issue criada</b>, <b>Issue atualizada</b> e <b>Comentário criado</b>. Também funciona com Automação → “Enviar requisição web”.</>,
            <>Ponha a label <code className="font-mono">{draft.jiraTriggerLabel || "carbon"}</code> numa issue ou comente <code className="font-mono">/carbon …</code>. O Carbon comenta o andamento, faz as perguntas com opções e move o status.</>,
          ]} />
        </div>
      </Panel>

      <Panel eyebrow="Slack" title="Mencione @carbon para criar tarefas" aside={<Status isOn={draft.slackConfigured} label={draft.slackConfigured ? "configurado" : "não configurado"} />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <Field label="Bot token" type="password" placeholder={draft.slackConfigured ? "•••••• (vazio mantém)" : "xoxb-…"} value={secrets.slackBotToken} onChange={(e) => setSecret({ slackBotToken: e.target.value })} />
          <Field label="Signing secret" type="password" placeholder={draft.slackConfigured ? "•••••• (vazio mantém)" : "Basic Information → Signing Secret"} value={secrets.slackSigningSecret} onChange={(e) => setSecret({ slackSigningSecret: e.target.value })} />
          <Field label="Canal (ID)" placeholder="C0123ABCD" value={draft.slackChannelId} onChange={(e) => set({ slackChannelId: e.target.value })} hint="recebe avisos; só ele cria/responde" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => void save("slack", { slackBotToken: secrets.slackBotToken, slackSigningSecret: secrets.slackSigningSecret, slackChannelId: draft.slackChannelId })} isLoading={busy === "save-slack"}>Salvar</Button>
          <Button variant="ghost" onClick={() => void test("slack")} isLoading={busy === "test-slack"} disabled={!draft.slackConfigured}><PlugZap className="size-4" /> Testar</Button>
          <Message feedback={feedback.slack ?? null} />
        </div>
        <div className="mt-4 flex flex-col gap-3">
          <Steps items={[
            <>Em <b>api.slack.com/apps → Create New App → From a manifest</b>, cole o manifest abaixo (já com a sua URL).</>,
            "Instale no workspace, copie o Bot User OAuth Token (xoxb-…) e o Signing Secret, e salve aqui.",
            "Convide o bot no canal (/invite @carbon) e cole o ID do canal. Mencione @carbon com a tarefa; as perguntas chegam com botões.",
          ]} />
          <CopyCommand command={base ? slackManifest(base) : hookUrl("slack")} />
        </div>
      </Panel>

      <Panel eyebrow="Telegram" title="/carbon <tarefa> no seu chat" aside={<Status isOn={draft.telegramConfigured} label={draft.telegramConfigured ? "configurado" : "não configurado"} />}>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Bot token" type="password" placeholder={draft.telegramConfigured ? "•••••• (vazio mantém)" : "123456:ABC… (do @BotFather)"} value={secrets.telegramBotToken} onChange={(e) => setSecret({ telegramBotToken: e.target.value })} />
          <Field label="Chat ID autorizado" placeholder="ex.: 123456789 ou -100…" value={draft.telegramChatId} onChange={(e) => set({ telegramChatId: e.target.value })} hint="mande /carbon oi ao bot: ele responde com o id do chat" />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button onClick={() => void save("telegram", { telegramBotToken: secrets.telegramBotToken, telegramChatId: draft.telegramChatId })} isLoading={busy === "save-telegram"}>Salvar</Button>
          <Button variant="ghost" onClick={() => void webhook("telegram")} isLoading={busy === "hook-telegram"} disabled={!base}>Registrar webhook</Button>
          <Button variant="ghost" onClick={() => void test("telegram")} isLoading={busy === "test-telegram"} disabled={!draft.telegramConfigured}><PlugZap className="size-4" /> Testar</Button>
          <Message feedback={feedback.telegram ?? null} />
        </div>
        <div className="mt-4">
          <Steps items={[
            "Crie o bot com o @BotFather (/newbot), cole o token e salve.",
            "Com o túnel definido, clique em Registrar webhook.",
            "Mande /carbon oi ao bot: ele responde com o chat id. Cole aqui, salve e use Testar. Num grupo, desative o privacy mode no BotFather ou use /carbon.",
          ]} />
        </div>
      </Panel>
    </div>
  );
}
