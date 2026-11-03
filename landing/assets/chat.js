// Integrations scene: a mention in Slack, Telegram or Jira becomes a task, the agent asks
// with options, one click answers and the PR is ready. Uses the helpers from flows.js.
(() => {
  "use strict";
  const flows = window.carbonFlows;
  if (!flows) return;
  const { scene, el, $ } = flows;

  const CHATS = [
    {
      channel: "#eng · Slack", color: "#e01e5a", user: "ana", ask: "@carbon corrige o rate limit do login", key: "FRG-56",
      question: "Limitar por IP ou por IP + conta?", options: [["IP + conta", true], ["Só por IP", false]], pr: 131,
    },
    {
      channel: "Telegram · time-core", color: "#2aabee", user: "bruno", ask: "/carbon paginação por cursor nos pedidos", key: "FRG-57",
      question: "Manter a API v1 com offset em paralelo?", options: [["Manter v1 por 30 dias", true], ["Trocar direto", false]], pr: 132,
    },
    {
      channel: "OPS-163 · Jira", color: "#2684ff", user: "carla", ask: "/carbon corrige o fuso do relatório semanal", key: "OPS-163",
      question: "Qual fuso usar no relatório?", options: [["America/Sao_Paulo", true], ["UTC", false]], pr: 133,
    },
  ];
  const MAX_CHAT_MESSAGES = 6;
  const chatRoot = document.getElementById("chat");
  if (chatRoot) {
    const body = $(chatRoot, "[data-chat-body]");
    const channelLabel = $(chatRoot, "[data-chat-channel]");
    const channelDot = $(chatRoot, "[data-chat-dot]");
    const push = (node) => {
      body.append(node);
      while (body.children.length > MAX_CHAT_MESSAGES) body.firstElementChild.remove();
      return node;
    };
    const message = (who, isBot, meta) => {
      const row = el("div", isBot ? "msg bot" : "msg");
      const content = el("div");
      const name = el("div", "who", who);
      name.append(el("small", null, meta));
      const text = el("div", "txt");
      content.append(name, text);
      row.append(el("span", "av", isBot ? "C" : who[0].toUpperCase()), content);
      push(row);
      return { content, text };
    };
    const questionCard = (content, chat) => {
      const card = el("div", "card-q");
      card.append(el("div", "txt", chat.question));
      const opts = el("div", "opts");
      const buttons = chat.options.map(([label, isRec]) => {
        const b = el("span", isRec ? "opt rec" : "opt", label);
        opts.append(b);
        return b;
      });
      card.append(opts);
      content.append(card);
      return { opts, buttons };
    };
    const setChannel = (chat) => {
      channelLabel.textContent = chat.channel;
      channelDot.style.background = chat.color;
    };
    let turn = 0;
    scene(chatRoot, async ({ wait, type }) => {
      const chat = CHATS[turn++ % CHATS.length];
      body.replaceChildren();
      setChannel(chat);
      await wait(500);
      const ask = message(chat.user, false, "agora");
      await type(ask.text, chat.ask, 34);
      await wait(500);
      const typing = push(el("div", "typing"));
      typing.append(el("i"), el("i"), el("i"));
      await wait(800);
      typing.remove();
      message("carbon", true, "bot").text.textContent = `📥 ${chat.key} na fila do Carbon`;
      await wait(900);
      message("carbon", true, "bot").text.textContent = "▶️ começou · sonnet · high";
      await wait(1100);
      const q = message("carbon", true, "bot");
      q.text.textContent = `❓ ${chat.key} precisa de uma decisão`;
      const { opts, buttons } = questionCard(q.content, chat);
      await wait(1700);
      buttons[0].classList.add("press");
      opts.classList.add("done");
      await wait(500);
      message("carbon", true, "bot").text.textContent = `✅ ${chat.user} escolheu “${chat.options[0][0]}”. Continuando a tarefa.`;
      await wait(1300);
      message("carbon", true, "bot").text.textContent = `✅ PR #${chat.pr} pronto para revisão`;
      await wait(2800);
    }, () => {
      const chat = CHATS[0];
      setChannel(chat);
      message(chat.user, false, "agora").text.textContent = chat.ask;
      message("carbon", true, "bot").text.textContent = `📥 ${chat.key} na fila do Carbon`;
      const q = message("carbon", true, "bot");
      q.text.textContent = `❓ ${chat.key} precisa de uma decisão`;
      const { opts, buttons } = questionCard(q.content, chat);
      buttons[0].classList.add("press");
      opts.classList.add("done");
      message("carbon", true, "bot").text.textContent = `✅ PR #${chat.pr} pronto para revisão`;
    });
  }
})();
