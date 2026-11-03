// Harness scene: as a task walks the eight stages, the skills the agent leans on light up.
// Uses the helpers from flows.js.
(() => {
  "use strict";
  const flows = window.carbonFlows;
  if (!flows) return;
  const { scene, el, $ } = flows;

  const GROUPS = [
    ["Contexto", ["search-first", "iterative-retrieval", "context-budget"]],
    ["Agente", ["agent-self-debug", "decision-ledger", "docs-sync"]],
    ["Qualidade", ["bugfix-regression", "verification-loop", "self-review", "silent-failure-hunt", "refactor-safely", "performance-loop", "test-plan"]],
    ["Segurança e dados", ["security-review", "lgpd-data-guard", "dependency-hygiene"]],
    ["Backend", ["api-contract", "db-migration-safety", "error-handling", "observability", "production-audit"]],
    ["Interface e E2E", ["frontend-quality", "e2e-critical-flow", "design-review"]],
    ["Personas", ["pr-description", "product-spec", "qa-acceptance", "data-analysis"]],
  ];
  const STAGES = [
    ["intake", ["context-budget", "lgpd-data-guard"]],
    ["plan", ["decision-ledger", "test-plan", "product-spec", "qa-acceptance"]],
    ["research", ["search-first", "iterative-retrieval", "context-budget"]],
    ["code", ["api-contract", "db-migration-safety", "error-handling", "observability", "frontend-quality", "refactor-safely", "dependency-hygiene", "data-analysis"]],
    ["test", ["bugfix-regression", "e2e-critical-flow", "test-plan", "performance-loop"]],
    ["review", ["self-review", "security-review", "silent-failure-hunt", "lgpd-data-guard", "production-audit", "design-review"]],
    ["deliver", ["verification-loop", "docs-sync", "pr-description"]],
    ["reflect", ["decision-ledger", "agent-self-debug"]],
  ];
  const STAGE_MS = 1400;

  const root = document.getElementById("harness-scene");
  if (!root) return;
  const stageRow = $(root, "[data-h-stages]");
  const groupGrid = $(root, "[data-h-groups]");
  const pills = STAGES.map(([name], i) => {
    const pill = el("span", "h-stage", `${String(i + 1).padStart(2, "0")} ${name}`);
    stageRow.append(pill);
    return pill;
  });
  const chips = new Map();
  for (const [title, skills] of GROUPS) {
    const group = el("div", "h-group");
    group.append(el("span", "h-title", title));
    const list = el("div", "h-chips");
    for (const skill of skills) {
      const chip = el("span", "h-chip", skill);
      chips.set(skill, chip);
      list.append(chip);
    }
    group.append(list);
    groupGrid.append(group);
  }
  const counter = el("span", "h-count", "0/28 skills usadas");
  stageRow.append(counter);

  const light = (index, used) => {
    pills.forEach((p, i) => {
      p.classList.toggle("on", i === index);
      p.classList.toggle("done", i < index);
    });
    const active = new Set(index >= 0 ? STAGES[index][1] : []);
    for (const [skill, chip] of chips) {
      chip.classList.toggle("on", active.has(skill));
      chip.classList.toggle("used", used.has(skill) && !active.has(skill));
    }
    counter.textContent = `${used.size}/${chips.size} skills usadas`;
  };

  scene(root, async ({ wait }) => {
    const used = new Set();
    light(-1, used);
    await wait(700);
    for (let i = 0; i < STAGES.length; i += 1) {
      STAGES[i][1].forEach((s) => used.add(s));
      light(i, used);
      await wait(STAGE_MS);
    }
    light(STAGES.length, used);
    await wait(2600);
  }, () => {
    const used = new Set(chips.keys());
    light(STAGES.length, used);
  });
})();
