// Animated product flows for the landing page.
// Each scene only advances while it is on screen; with reduced motion it renders a still frame.
(() => {
  "use strict";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const $ = (root, sel) => root.querySelector(sel);
  const $$ = (root, sel) => [...root.querySelectorAll(sel)];
  const restartAnim = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); };

  const scene = (root, run, still) => {
    if (!root) return;
    if (reduce) { still(); return; }
    let visible = false;
    const waiters = [];
    new IntersectionObserver((entries) => {
      visible = entries[0].isIntersecting;
      if (visible) waiters.splice(0).forEach((resume) => resume());
    }, { threshold: 0.15 }).observe(root);
    const gate = () => (visible ? Promise.resolve() : new Promise((r) => waiters.push(r)));
    const wait = async (ms) => { await new Promise((r) => setTimeout(r, ms)); await gate(); };
    const type = async (node, text, speed = 32) => {
      for (const ch of text) { node.textContent += ch; await wait(speed); }
    };
    (async () => {
      await gate();
      for (;;) await run({ wait, type });
    })().catch((err) => console.error("[carbon] animação interrompida", err));
  };

  /* ── mission control ─────────────────────────────────────────── */
  const STAGES = [
    ["triage", "Intake"], ["planner", "Plan"], ["researcher", "Research"], ["coder", "Code"],
    ["tester", "Test"], ["reviewer", "Review"], ["delivery", "Deliver"], ["learner", "Reflect"],
  ];
  const TICKETS = [
    {
      id: "ENG-142", src: "linear", title: "Rate limit no endpoint de login", repo: "demo/api-gateway", who: "@ana.dev",
      plan: ["Mapear middleware de auth e store", "Limiter por IP + conta (sliding window)", "Responder 429 com Retry-After", "Testes de janela e reset", "Revisão de segurança"],
      files: ["src/middleware/auth.ts", "src/routes/login.ts"], perm: "npm install rate-limiter-flexible",
      tests: "14 passed · cobertura 91%", pr: 128,
    },
    {
      id: "#57", src: "github", title: "Paginação por cursor na listagem de pedidos", repo: "demo/orders-api", who: "@bruno.pm",
      plan: ["Trocar offset por cursor opaco", "Índice composto (created_at, id)", "Manter contrato da API v1", "Testes de borda: vazio e última página", "Revisão de performance"],
      files: ["src/orders/list.ts", "src/db/cursor.ts"], perm: "npx prisma migrate dev --name orders_cursor",
      tests: "22 passed · cobertura 88%", pr: 131,
    },
    {
      id: "ENG-163", src: "linear", title: "Fuso horário errado no relatório semanal", repo: "demo/reports", who: "@carla.ops",
      plan: ["Reproduzir com data na virada do dia", "Normalizar datas para America/Sao_Paulo", "Teste de regressão no cron", "Revisão"],
      files: ["src/reports/weekly.ts", "src/lib/date.ts"], perm: null,
      tests: "9 passed · regressão ok", pr: 133,
    },
  ];
  const KIND_CLASS = { "✓": "ok", "!": "warn" };
  const MAX_LINES = 9;
  const fmtTokens = (n) => (n < 1000 ? String(n) : (n / 1000).toFixed(1).replace(".0", "") + "k");

  const buildMc = (root) => {
    const pipe = $(root, "[data-pipe]");
    const nodes = [];
    const links = [];
    STAGES.forEach(([role, name], i) => {
      if (i) { const link = el("span", "link"); pipe.append(link); links.push(link); }
      const node = el("div", "node");
      const title = el("b", null, name);
      title.append(el("i"));
      node.append(el("small", null, `0${i + 1} ${role}`), title);
      pipe.append(node);
      nodes.push(node);
    });
    const queue = $(root, "[data-queue]");
    const cards = TICKETS.map((t) => {
      const card = el("div", "tk");
      const head = el("div", "tk-h");
      const left = el("span", null, t.id);
      left.append(el("span", "tk-src", t.src));
      const status = el("span", "tk-st", "na fila");
      head.append(left, status);
      const prog = el("div", "prog");
      const fill = el("i");
      prog.append(fill);
      card.append(head, el("p", null, t.title), el("div", "tk-m", `${t.repo} · ${t.who}`), prog);
      queue.append(card);
      return { card, status, fill };
    });
    const stats = {};
    $$(root, "[data-stat]").forEach((b) => { stats[b.dataset.stat] = b; });
    return {
      nodes, links, cards, stats,
      log: $(root, "[data-log]"), plan: $(root, "[data-plan]"), perm: $(root, "[data-perm]"),
      toast: $(root, "[data-toast]"), crumbId: $(root, "[data-crumb-id]"), crumbStage: $(root, "[data-crumb-stage]"),
      queueCount: $(root, "[data-queue-count]"), planCount: $(root, "[data-plan-count]"),
    };
  };

  const setStage = (ui, idx) => {
    ui.nodes.forEach((n, j) => {
      n.classList.toggle("done", j < idx);
      n.classList.toggle("active", j === idx);
    });
    ui.links.forEach((l, j) => l.classList.toggle("done", j < idx));
    if (idx > 0 && ui.links[idx - 1]) restartAnim(ui.links[idx - 1], "flow");
    if (idx < 0) ui.crumbStage.textContent = "aguardando";
    else ui.crumbStage.textContent = idx < STAGES.length ? STAGES[idx][1].toLowerCase() : "entregue";
  };

  const addLine = (ui, stage, kind, text) => {
    const line = el("div", "ln");
    const body = el("span", null, text);
    line.append(el("span", "st", stage), el("span", KIND_CLASS[kind] || "", kind), body);
    ui.log.append(line);
    while (ui.log.children.length > MAX_LINES) ui.log.firstElementChild.remove();
    return body;
  };

  const fillPlan = (ui, items, checked = 0) => {
    ui.plan.replaceChildren(...items.map((text, i) => {
      const li = el("li", i < checked ? "ok" : "");
      li.append(el("i"), el("span", null, text));
      return li;
    }));
    ui.planCount.textContent = `${checked}/${items.length}`;
  };

  const runMc = (ui) => async ({ wait, type }) => {
    const s = { done: 0, prs: 0, tokens: 0, events: 0, lessons: 2 };
    const bump = (key, fmt = String) => {
      ui.stats[key].textContent = fmt(s[key]);
      restartAnim(ui.stats[key], "bump");
    };
    const reset = () => {
      ui.log.replaceChildren();
      ui.cards.forEach(({ card, status, fill }) => {
        card.classList.remove("run", "done");
        status.textContent = "na fila";
        fill.style.transform = "scaleX(0)";
      });
      Object.keys(s).forEach((k) => { ui.stats[k].textContent = k === "tokens" ? fmtTokens(s[k]) : String(s[k]); });
      ui.stats.done.textContent = `0/${TICKETS.length}`;
      setStage(ui, -1);
    };
    reset();
    await wait(600);

    for (const [idx, t] of TICKETS.entries()) {
      const { card, status, fill } = ui.cards[idx];
      let stage = 0;
      let checked = 0;
      const say = async (kind, text, pause = 360) => {
        const body = addLine(ui, STAGES[stage][1].toLowerCase(), kind, "");
        await type(body, text, 9);
        s.events += 1; s.tokens += 140 + Math.round(Math.random() * 320);
        bump("events"); bump("tokens", fmtTokens);
        await wait(pause);
      };
      const check = () => {
        const li = ui.plan.children[checked];
        if (!li) return;
        li.classList.add("ok");
        checked += 1;
        ui.planCount.textContent = `${checked}/${t.plan.length}`;
      };
      const goto = async (i) => {
        stage = i;
        setStage(ui, i);
        fill.style.transform = `scaleX(${(i + 1) / STAGES.length})`;
        await wait(380);
      };

      card.classList.add("run");
      status.textContent = "executando";
      ui.crumbId.textContent = t.id;
      ui.queueCount.textContent = `${TICKETS.length - idx} na fila`;
      ui.plan.replaceChildren(el("li", "empty", "aguardando o planner…"));
      ui.planCount.textContent = "0/0";

      await goto(0);
      await say("·", `trigger ${t.src}:${t.id} de ${t.who}`);
      await say("✓", "eval: accept · escopo local, sem decisão pendente");

      await goto(1);
      await say("∴", "decompondo tarefa em passos verificáveis…", 500);
      ui.plan.replaceChildren();
      for (const text of t.plan) {
        const li = el("li");
        li.append(el("i"), el("span", null, text));
        ui.plan.append(li);
        ui.planCount.textContent = `0/${t.plan.length}`;
        await wait(170);
      }
      await say("✓", `plano com ${t.plan.length} passos e critérios de aceite`);

      await goto(2);
      await say("$", "rag.search(hybrid: bm25 + vetor, k=8)");
      await say("✓", `${t.files.length} arquivos relevantes · 2 lições aplicadas`);

      await goto(3);
      await say("$", `git worktree add .carbon/wt/${t.id.replace("#", "gh-")}`);
      await say("✎", `edit ${t.files[0]}`);
      check();
      if (t.perm) {
        await say("!", "permissão necessária, aguardando humano", 200);
        $(ui.perm, "code").textContent = t.perm;
        const allow = $(ui.perm, "[data-allow]");
        allow.classList.remove("press");
        ui.perm.classList.add("show");
        await wait(1500);
        allow.classList.add("press");
        await wait(380);
        ui.perm.classList.remove("show");
        await say("✓", "permitido nesta tarefa");
      }
      await say("✎", `edit ${t.files[1]}`);
      check();

      await goto(4);
      await say("$", "npm test");
      await say("✓", t.tests);
      check();

      await goto(5);
      await say("∴", "revisão: qualidade + segurança");
      await say("✓", "0 bloqueantes · 1 sugestão aplicada");
      while (checked < t.plan.length - 1) check();

      await goto(6);
      await say("$", "gh pr create --draft");
      await say("✓", `PR #${t.pr} aberto como draft`);
      check();
      s.done += 1; s.prs += 1;
      ui.stats.done.textContent = `${s.done}/${TICKETS.length}`;
      restartAnim(ui.stats.done, "bump");
      bump("prs");
      ui.toast.textContent = `PR #${t.pr} pronto para revisão`;
      ui.toast.classList.add("show");

      await goto(7);
      await say("∴", "reflexão: 1 lição candidata para o projeto");
      s.lessons += idx === 1 ? 1 : 0;
      bump("lessons");
      ui.toast.classList.remove("show");

      setStage(ui, STAGES.length);
      card.classList.remove("run");
      card.classList.add("done");
      status.textContent = `PR #${t.pr}`;
      fill.style.transform = "scaleX(1)";
      await wait(1400);
    }
    ui.queueCount.textContent = "fila vazia";
    await wait(2600);
  };

  const stillMc = (ui) => () => {
    const t = TICKETS[0];
    setStage(ui, 3);
    ui.crumbId.textContent = t.id;
    ui.cards[0].card.classList.add("run");
    ui.cards[0].status.textContent = "executando";
    ui.cards[0].fill.style.transform = "scaleX(.5)";
    [["intake", "✓", "eval: accept · escopo local"], ["plan", "✓", "plano com 5 passos e critérios de aceite"],
      ["research", "✓", "2 arquivos relevantes · 2 lições aplicadas"], ["code", "✎", `edit ${t.files[0]}`]]
      .forEach(([st, k, txt]) => addLine(ui, st, k, txt));
    fillPlan(ui, t.plan, 1);
    Object.assign(ui.stats.done, { textContent: "0/3" });
    ui.stats.tokens.textContent = "3.1k";
    ui.stats.events.textContent = "8";
  };

  const mcRoot = document.getElementById("mc");
  if (mcRoot) {
    const ui = buildMc(mcRoot);
    scene(mcRoot, runMc(ui), stillMc(ui));
  }

  /* ── nova tarefa ─────────────────────────────────────────────── */
  const NT_EXAMPLES = [
    {
      title: "Adicionar rate limit no endpoint de login",
      ctx: ["## Contexto", "O login aceita tentativas ilimitadas.", "", "## Critérios de aceite",
        "- Dado 5 tentativas em 1 min, a 6ª responde 429 com Retry-After.", "- Após 1 min sem tentativas, volta a aceitar."],
      model: "Sonnet", effort: "high", hint: "equilíbrio · pensa mais antes de agir",
    },
    {
      title: "Corrigir comando de setup no README",
      ctx: ["## Contexto", "O README mostra `npm run stup`.", "", "## Critérios de aceite",
        "- README mostra `npm run setup`.", "- Nenhum outro arquivo alterado."],
      model: "Haiku", effort: "low", hint: "rápido · tarefa pequena e bem definida",
    },
  ];
  const ntRoot = document.getElementById("nt");
  if (ntRoot) {
    const title = $(ntRoot, "[data-nt-title]");
    const ctx = $(ntRoot, "[data-nt-ctx]");
    const ai = $(ntRoot, "[data-nt-ai]");
    const hint = $(ntRoot, "[data-nt-hint]");
    const go = $(ntRoot, "[data-nt-go]");
    const models = $$(ntRoot, "[data-model] .chip2");
    const efforts = $$(ntRoot, "[data-effort] .chip2");
    const select = (chips, label) => chips.forEach((c) => c.classList.toggle("on", c.textContent === label));
    const pick = async (chips, label, wait) => {
      for (const chip of chips) {
        chip.classList.add("hover");
        await wait(130);
        chip.classList.remove("hover");
        if (chip.textContent === label) break;
      }
      select(chips, label);
      await wait(260);
    };
    let turn = 0;
    scene(ntRoot, async ({ wait, type }) => {
      const ex = NT_EXAMPLES[turn++ % NT_EXAMPLES.length];
      title.textContent = ""; ctx.textContent = ""; hint.textContent = "";
      go.textContent = "Enfileirar"; go.classList.remove("press");
      select(models, "Automático"); select(efforts, "Automático");
      await wait(500);
      title.classList.add("caret");
      await type(title, ex.title, 38);
      title.classList.remove("caret");
      await wait(450);
      ai.classList.add("busy"); ctx.classList.add("drafting");
      await wait(1100);
      ctx.classList.remove("drafting");
      for (const line of ex.ctx) await type(ctx, line + "\n", 8);
      ai.classList.remove("busy");
      await wait(500);
      await pick(models, ex.model, wait);
      await pick(efforts, ex.effort, wait);
      hint.textContent = ex.hint;
      await wait(700);
      go.classList.add("press"); go.textContent = "na fila ✓";
      await wait(2200);
    }, () => {
      const ex = NT_EXAMPLES[0];
      title.textContent = ex.title; ctx.textContent = ex.ctx.join("\n"); hint.textContent = ex.hint;
      select(models, ex.model); select(efforts, ex.effort);
    });
  }

  /* ── base de conhecimento ───────────────────────────────────── */
  const KG_NODES = {
    "server.ts": [180, 28], "lib/logger.ts": [62, 26], "routes/login.ts": [72, 84], "orders/list.ts": [182, 92],
    "jobs/cron.ts": [298, 80], "middleware/auth.ts": [52, 146], "users/repo.ts": [136, 170], "lib/redis.ts": [40, 210],
    "db/cursor.ts": [222, 150], "db/client.ts": [196, 214], "reports/weekly.ts": [302, 148], "lib/date.ts": [318, 214],
    "config/env.ts": [114, 232],
  };
  const KG_EDGES = [
    ["server.ts", "routes/login.ts"], ["server.ts", "orders/list.ts"], ["server.ts", "jobs/cron.ts"], ["server.ts", "lib/logger.ts"],
    ["routes/login.ts", "lib/logger.ts"], ["routes/login.ts", "middleware/auth.ts"], ["middleware/auth.ts", "lib/redis.ts"],
    ["middleware/auth.ts", "users/repo.ts"], ["users/repo.ts", "db/client.ts"], ["orders/list.ts", "db/cursor.ts"],
    ["db/cursor.ts", "db/client.ts"], ["jobs/cron.ts", "reports/weekly.ts"], ["reports/weekly.ts", "lib/date.ts"],
    ["reports/weekly.ts", "db/client.ts"], ["lib/redis.ts", "config/env.ts"], ["db/client.ts", "config/env.ts"],
  ];
  const KG_QUERIES = [
    { q: "rate limit login", hits: [["routes/login.ts", 0.94], ["middleware/auth.ts", 0.81], ["lib/redis.ts", 0.62]] },
    { q: "paginação por cursor", hits: [["orders/list.ts", 0.91], ["db/cursor.ts", 0.87], ["db/client.ts", 0.55]] },
    { q: "fuso horário relatório", hits: [["reports/weekly.ts", 0.89], ["lib/date.ts", 0.84], ["jobs/cron.ts", 0.58]] },
  ];
  const kgRoot = document.getElementById("kg");
  if (kgRoot) {
    const NS = "http://www.w3.org/2000/svg";
    const svgEl = (tag, attrs) => {
      const node = document.createElementNS(NS, tag);
      Object.entries(attrs).forEach(([k, v]) => node.setAttribute(k, v));
      return node;
    };
    const graph = $(kgRoot, "[data-kg-graph]");
    const edges = KG_EDGES.map(([a, b]) => {
      const [x1, y1] = KG_NODES[a];
      const [x2, y2] = KG_NODES[b];
      const line = svgEl("line", { x1, y1, x2, y2, class: "e", pathLength: 1 });
      graph.append(line);
      return { a, b, line };
    });
    const nodes = Object.entries(KG_NODES).map(([name, [x, y]]) => {
      const g = svgEl("g", { class: "n" });
      g.append(svgEl("circle", { cx: x, cy: y, r: 5 }));
      const label = svgEl("text", { x, y: y + 15, "text-anchor": "middle" });
      label.textContent = name;
      g.append(label);
      graph.append(g);
      return { name, g };
    });
    const input = $(kgRoot, "[data-kg-q]");
    const results = $(kgRoot, "[data-kg-res]");
    const light = (hitNames) => {
      const set = new Set(hitNames);
      graph.classList.toggle("dim", set.size > 0);
      nodes.forEach(({ name, g }) => g.classList.toggle("hit", set.has(name)));
      edges.forEach(({ a, b, line }) => line.classList.toggle("hit", set.has(a) && set.has(b)));
    };
    const addResult = (name, score) => {
      const li = el("li");
      const row = el("div");
      row.append(el("span", null, name), el("span", null, score.toFixed(2)));
      const bar = el("div", "bar3");
      const fill = el("i");
      bar.append(fill);
      li.append(row, bar);
      results.append(li);
      requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.transform = `scaleX(${score})`; }));
    };
    let turn = 0;
    scene(kgRoot, async ({ wait, type }) => {
      const { q, hits } = KG_QUERIES[turn++ % KG_QUERIES.length];
      graph.classList.add("drawn");
      input.textContent = ""; results.replaceChildren(); light([]);
      await wait(700);
      input.classList.add("caret");
      await type(input, q, 45);
      input.classList.remove("caret");
      await wait(350);
      const lit = [];
      for (const [name, score] of hits) {
        lit.push(name);
        light(lit);
        addResult(name, score);
        await wait(320);
      }
      await wait(2600);
    }, () => {
      graph.classList.add("drawn");
      const { q, hits } = KG_QUERIES[0];
      input.textContent = q;
      hits.forEach(([name, score]) => addResult(name, score));
      light(hits.map(([name]) => name));
    });
  }

  /* ── mini widgets ───────────────────────────────────────────── */
  const row = (left, tagText, tagClass) => {
    const r = el("div", "row");
    const tag = el("span", `tag ${tagClass}`, tagText);
    r.append(el("span", null, left), tag);
    return { r, left: r.firstElementChild, tag };
  };

  const ROUTES = [["corrigir typo no README", "haiku · low"], ["refatorar módulo de auth", "opus · xhigh"], ["exportar relatório em CSV", "sonnet · high"]];
  const routerRoot = document.getElementById("mini-router");
  scene(routerRoot, async ({ wait, type }) => {
    routerRoot.replaceChildren(el("div", "mlabel", "roteador automático"));
    for (const [task, choice] of ROUTES) {
      const { r, left, tag } = row("", choice, "ok fade");
      left.textContent = "› ";
      routerRoot.append(r);
      await type(left, task, 30);
      await wait(300);
      tag.classList.remove("fade");
      await wait(900);
    }
    await wait(2200);
  }, () => {
    routerRoot.replaceChildren(el("div", "mlabel", "roteador automático"));
    ROUTES.forEach(([task, choice]) => routerRoot.append(row(`› ${task}`, choice, "ok").r));
  });

  const PERMS = [["npm test", "permitido", "ok"], ["git push --force", "bloqueado", "bad"], ["npm i zod", "pergunta", "ask", "permitido nesta tarefa"]];
  const permRoot = document.getElementById("mini-perm");
  scene(permRoot, async ({ wait, type }) => {
    permRoot.replaceChildren(el("div", "mlabel", "política do repositório"));
    for (const [cmd, verdict, cls, after] of PERMS) {
      const { r, left, tag } = row("", verdict, `${cls} fade`);
      left.textContent = "$ ";
      permRoot.append(r);
      await type(left, cmd, 40);
      await wait(250);
      tag.classList.remove("fade");
      if (after) {
        await wait(1200);
        tag.className = "tag ok";
        tag.textContent = after;
      }
      await wait(800);
    }
    await wait(2400);
  }, () => {
    permRoot.replaceChildren(el("div", "mlabel", "política do repositório"));
    PERMS.forEach(([cmd, verdict, cls, after]) => permRoot.append(row(`$ ${cmd}`, after || verdict, after ? "ok" : cls).r));
  });

  const LESSONS = ["Use withRetry nos clients HTTP", "Testes de data usam relógio fixo", "Migrations sempre reversíveis"];
  const lessonRoot = document.getElementById("mini-lesson");
  let lessonTurn = 0;
  scene(lessonRoot, async ({ wait }) => {
    const text = LESSONS[lessonTurn++ % LESSONS.length];
    lessonRoot.replaceChildren(el("div", "mlabel", "reflect · ENG-142"));
    const { r, tag } = row(text, "candidata", "ask");
    const btnRow = el("div", "row");
    const btn = el("span", "mbtn primary", "promover");
    btnRow.append(el("span", null, ""), btn);
    lessonRoot.append(r, btnRow);
    await wait(1400);
    btn.classList.add("press");
    await wait(300);
    tag.className = "tag ok"; tag.textContent = "promovida";
    btnRow.replaceChildren(el("span", null, "→ entra nos próximos prompts"));
    await wait(2600);
  }, () => {
    lessonRoot.replaceChildren(el("div", "mlabel", "reflect · ENG-142"), row(LESSONS[0], "promovida", "ok").r);
  });
})();
