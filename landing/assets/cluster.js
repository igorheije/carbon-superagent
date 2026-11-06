(() => {
const PATHS = {"rack":[[458.7,304.4],[410.9,280.5],[492.4,239.7],[439.3,213.2],[460.5,202.5]],"desktop":[[437.5,330.9],[347.2,376.1],[289.6,347.3]],"cloud":[[481.8,353.1],[457.9,365],[472,381.9],[545.5,418.6],[710.2,336.3]],"laptop":[[481.8,353.1],[457.9,365],[445.5,380.1],[396.8,404.4],[445.5,428.8]]};
const WORKERS = ["rack", "desktop", "cloud", "laptop"];
const NAMES = { rack: "rack Linux", desktop: "desktop", cloud: "AgentCore", laptop: "notebook" };
const root = document.querySelector("[data-cluster]");
if (!root) return;
const svg = root.querySelector("svg");
const layer = svg.querySelector("[data-packets]");
const readout = root.querySelector("[data-readout]");
const status = root.querySelector("[data-cluster-status]");
const chips = [...svg.querySelectorAll("[data-chip]")];
const still = matchMedia("(prefers-reduced-motion: reduce)");
const NS = "http://www.w3.org/2000/svg";

const lengthOf = (pts) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const pointAt = (pts, d) => {
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (d <= seg) { const t = seg ? d / seg : 0; return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t]; }
    d -= seg;
  }
  return pts[pts.length - 1];
};
const LEN = Object.fromEntries(WORKERS.map((w) => [w, lengthOf(PATHS[w])]));
const SPEED = 150; // screen px per second
const state = Object.fromEntries(WORKERS.map((w) => [w, { phase: "idle", t: 0, work: 0, paused: false }]));
const el = (w) => svg.querySelector('[data-machine="' + w + '"]');
let queue = 4, delivered = 0, refill = 2.2, frame = 0, previous = 0, visible = false;

function packet(kind) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "cl-packet");
  g.dataset.kind = kind;
  g.innerHTML = '<circle class="cl-packet-halo" r="7"/><circle class="cl-packet-core" r="2.8"/>';
  layer.appendChild(g);
  return g;
}
function place(g, xy) { g.setAttribute("transform", "translate(" + xy[0].toFixed(1) + " " + xy[1].toFixed(1) + ")"); }
function setScreen(w, on, progress) {
  const m = el(w);
  m.toggleAttribute("data-busy", on);
  const bar = svg.querySelector('[data-bar="' + w + '"]');
  if (bar) bar.style.strokeDashoffset = String(1 - (progress || 0));
}
function render() {
  chips.forEach((c, i) => c.toggleAttribute("data-on", i < queue));
  const running = WORKERS.filter((w) => state[w].phase !== "idle").length;
  const active = WORKERS.filter((w) => !state[w].paused).length;
  const text = active + " computadores · " + running + " rodando · " + delivered + " entregues";
  if (readout && readout.textContent !== text) readout.textContent = text;
}
function dispatch() {
  if (queue <= 0) return;
  const free = WORKERS.filter((w) => state[w].phase === "idle" && !state[w].paused);
  if (!free.length) return;
  const w = free[Math.floor(Math.random() * free.length)];
  const s = state[w];
  queue--;
  s.phase = "out"; s.t = 0; s.work = 2.6 + Math.random() * 2.4;
  s.node = packet("task");
  place(s.node, PATHS[w][0]);
}
function step(dt) {
  refill -= dt;
  if (refill <= 0) { if (queue < 6) queue++; refill = 1.6 + Math.random() * 1.6; }
  dispatch();
  for (const w of WORKERS) {
    const s = state[w];
    s.t += dt;
    if (s.phase === "out") {
      const d = s.t * SPEED;
      place(s.node, pointAt(PATHS[w], Math.min(d, LEN[w])));
      if (d >= LEN[w]) { s.node.remove(); s.phase = "work"; s.t = 0; }
    } else if (s.phase === "work") {
      setScreen(w, true, s.t / s.work);
      if (s.t >= s.work) { setScreen(w, false, 0); s.phase = "back"; s.t = 0; s.node = packet("branch"); }
    } else if (s.phase === "back") {
      const d = LEN[w] - s.t * SPEED;
      place(s.node, pointAt(PATHS[w], Math.max(d, 0)));
      if (d <= 0) { s.node.remove(); s.phase = "idle"; delivered++; }
    }
  }
  render();
}
function tick(now) {
  const dt = previous ? Math.min((now - previous) / 1000, 1 / 20) : 1 / 60;
  previous = now;
  step(dt);
  frame = visible && !still.matches ? requestAnimationFrame(tick) : 0;
}
function run() { if (!frame && visible && !still.matches) { previous = 0; frame = requestAnimationFrame(tick); } }
function stillFrame() {
  // reduced motion: a calm snapshot, three machines working, nothing moves
  ["rack", "cloud", "laptop"].forEach((w, i) => { state[w].phase = "work"; setScreen(w, true, 0.35 + i * 0.2); });
  queue = 3; delivered = 12; render();
}
function toggle(w) {
  const s = state[w];
  s.paused = !s.paused;
  el(w).toggleAttribute("data-paused", s.paused);
  const button = root.querySelector('[data-toggle="' + w + '"]');
  if (button) { button.setAttribute("aria-pressed", String(s.paused)); button.dataset.state = s.paused ? "pausado" : "ativo"; }
  if (status) status.textContent = NAMES[w] + (s.paused ? " pausado: termina o que está rodando e não pega tarefa nova." : " de volta ao cluster.");
  render();
}
svg.addEventListener("click", (e) => { const m = e.target.closest(".cl-machine"); if (m) toggle(m.dataset.machine); });
root.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", () => toggle(b.dataset.toggle)));
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }, { rootMargin: "80px 0px" }).observe(root);
still.addEventListener("change", () => { if (still.matches) stillFrame(); else run(); });
if (still.matches) stillFrame(); else render();
})();
