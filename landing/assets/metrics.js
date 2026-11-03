// Effectiveness scene (demo numbers): each cycle another task finishes and the same formulas
// the product uses recompute the bar. Uses the helpers from flows.js.
(() => {
  "use strict";
  const flows = window.carbonFlows;
  if (!flows) return;
  const { scene, el, $ } = flows;

  // Cumulative demo history: one entry per finished task.
  const HISTORY = [
    { done: 6, failed: 1, delivered: 5, autonomous: 5, steps: [27, 30], tests: [161, 164], review: [4, 5], time: "4 min 05 s", cost: "US$ 0.36", tokens: "39.8k", interventions: "0.4" },
    { done: 7, failed: 1, delivered: 6, autonomous: 6, steps: [32, 35], tests: [178, 180], review: [5, 6], time: "4 min 12 s", cost: "US$ 0.37", tokens: "40.6k", interventions: "0.4" },
    { done: 8, failed: 1, delivered: 7, autonomous: 6, steps: [37, 40], tests: [203, 205], review: [6, 6], time: "4 min 18 s", cost: "US$ 0.38", tokens: "41.2k", interventions: "0.5" },
    { done: 9, failed: 1, delivered: 8, autonomous: 7, steps: [43, 46], tests: [226, 228], review: [7, 7], time: "4 min 09 s", cost: "US$ 0.37", tokens: "40.9k", interventions: "0.4" },
  ];
  const GOOD = 0.8;
  const FAIR = 0.5;
  const RING_C = 2 * Math.PI * 42;

  const root = document.getElementById("metrics-scene");
  if (!root) return;
  const arc = $(root, "[data-m-arc]");
  const indexEl = $(root, "[data-m-index]");
  const metaEl = $(root, "[data-m-meta]");
  const tilesEl = $(root, "[data-m-tiles]");
  const effEl = $(root, "[data-m-eff]");

  const TILES = [
    ["Sucesso", (h) => [h.done, h.done + h.failed], "concluídas"],
    ["Entrega", (h) => [h.delivered, h.done], "viraram commit/PR"],
    ["Autonomia", (h) => [h.autonomous, h.done + h.failed], "sem intervenção"],
    ["Plano cumprido", (h) => h.steps, "passos"],
    ["Testes verdes", (h) => h.tests, "testes"],
    ["Revisão limpa", (h) => h.review, "críticos/altos resolvidos"],
  ];
  const tiles = TILES.map(([label]) => {
    const tile = el("div", "m-tile");
    const value = el("dd", "m-value", "0%");
    const bar = el("div", "m-bar");
    const fill = el("i");
    bar.append(fill);
    const detail = el("span", "m-detail", "—");
    tile.append(el("dt", "m-label", label), value, bar, detail);
    tilesEl.append(tile);
    return { tile, value, fill, detail };
  });
  const EFF = [["tempo médio", "time"], ["custo médio", "cost"], ["tokens médios", "tokens"], ["intervenções/tarefa", "interventions"]];
  effEl.append(el("span", "m-eyebrow", "eficiência"));
  const effRows = EFF.map(([label]) => {
    const row = el("div", "m-eff-row");
    const value = el("dd", null, "—");
    row.append(el("dt", null, label), value);
    effEl.append(row);
    return value;
  });

  const toneOf = (v) => (v >= GOOD ? "good" : v >= FAIR ? "fair" : "bad");
  const pct = (v) => `${Math.round(v * 100)}%`;

  const render = (h) => {
    const rates = TILES.map(([, pick]) => {
      const [part, whole] = pick(h);
      return { part, whole, value: whole ? part / whole : 0 };
    });
    rates.forEach((r, i) => {
      const t = tiles[i];
      t.value.textContent = pct(r.value);
      t.tile.dataset.tone = toneOf(r.value);
      t.fill.style.transform = `scaleX(${r.value})`;
      t.detail.textContent = `${r.part} de ${r.whole} ${TILES[i][2]}`;
    });
    const index = rates.reduce((a, r) => a + r.value, 0) / rates.length;
    indexEl.textContent = pct(index);
    root.dataset.tone = toneOf(index);
    arc.style.strokeDashoffset = String(RING_C * (1 - index));
    metaEl.textContent = `demo · média de 6 métricas · ${h.done + h.failed} tarefas`;
    EFF.forEach(([, key], i) => { effRows[i].textContent = h[key]; });
  };

  arc.style.strokeDasharray = String(RING_C);
  arc.style.strokeDashoffset = String(RING_C);
  let turn = 0;
  scene(root, async ({ wait }) => {
    const h = HISTORY[turn % HISTORY.length];
    turn += 1;
    root.classList.remove("bump");
    void root.offsetWidth;
    root.classList.add("bump");
    render(h);
    await wait(3200);
  }, () => render(HISTORY[HISTORY.length - 1]));
})();
