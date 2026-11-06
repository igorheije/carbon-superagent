(() => {
const ARCS = {"friend":[[221.3,412.3],[230.3,402.5],[239.4,392.6],[248.5,382.8],[257.5,373.1],[266.6,363.6],[275.7,354.1],[284.7,344.9],[293.8,335.8],[302.8,327],[311.9,318.4],[321,310],[330,302],[339.1,294.3],[348.1,287],[357.2,280],[366.3,273.4],[375.3,267.2],[384.4,261.4],[393.5,256.1],[402.5,251.2],[411.6,246.8],[420.6,242.8],[429.7,239.4],[438.8,236.4],[447.8,233.9],[456.9,232],[466,230.6],[475,229.6],[484.1,229.2],[493.1,229.3],[502.2,230],[511.3,231.1],[520.3,232.7],[529.4,234.9],[538.5,237.5],[547.5,240.6],[556.6,244.1],[565.6,248.2],[574.7,252.6],[583.8,257.5],[592.8,262.8],[601.9,268.4],[610.9,274.5],[620,280.8],[629.1,287.5],[638.1,294.5],[647.2,301.8],[656.3,309.3],[665.3,317],[674.4,325],[683.4,333.1],[692.5,341.3],[701.6,349.7],[710.6,358.2],[719.7,366.7],[728.8,375.2]],"linux":[[221.3,412.3],[225.7,401.3],[230.2,390.3],[234.6,379.4],[239.1,368.5],[243.5,357.7],[248,347],[252.4,336.5],[256.9,326.1],[261.3,315.9],[265.8,305.9],[270.2,296.1],[274.7,286.6],[279.1,277.3],[283.6,268.3],[288,259.6],[292.5,251.2],[297,243.1],[301.4,235.4],[305.9,228],[310.3,220.9],[314.8,214.3],[319.2,208],[323.7,202.1],[328.1,196.6],[332.6,191.5],[337,186.8],[341.5,182.6],[345.9,178.7],[350.4,175.2],[354.8,172.2],[359.3,169.6],[363.7,167.4],[368.2,165.6],[372.6,164.1],[377.1,163.1],[381.5,162.5],[386,162.2],[390.4,162.3],[394.9,162.7],[399.3,163.5],[403.8,164.6],[408.2,166],[412.7,167.7],[417.1,169.7],[421.6,171.9],[426,174.4],[430.5,177.1],[434.9,180],[439.4,183],[443.8,186.2],[448.3,189.6],[452.7,193.1],[457.2,196.7],[461.6,200.3],[466.1,204],[470.5,207.7]],"cloud":[[221.3,412.3],[225.2,410.4],[229.2,408.6],[233.1,406.7],[237,404.9],[241,403.2],[244.9,401.5],[248.9,399.9],[252.8,398.4],[256.7,396.9],[260.7,395.7],[264.6,394.5],[268.6,393.5],[272.5,392.6],[276.4,391.9],[280.4,391.3],[284.3,391],[288.3,390.8],[292.2,390.8],[296.2,391],[300.1,391.5],[304,392.1],[308,393],[311.9,394.1],[315.9,395.4],[319.8,397],[323.7,398.8],[327.7,400.9],[331.6,403.2],[335.6,405.7],[339.5,408.5],[343.4,411.5],[347.4,414.7],[351.3,418.2],[355.3,421.9],[359.2,425.9],[363.1,430],[367.1,434.4],[371,439],[375,443.8],[378.9,448.8],[382.8,454],[386.8,459.3],[390.7,464.8],[394.7,470.5],[398.6,476.4],[402.6,482.4],[406.5,488.5],[410.4,494.7],[414.4,501],[418.3,507.5],[422.3,514],[426.2,520.5],[430.1,527.1],[434.1,533.8],[438,540.5],[442,547.2]]};
const VIEWS = [[-11.9,205.9,409.1,290.9],[-4,28.5,908,645.7],[0,1.1,900,640],[0,1.1,900,640]];
const root = document.querySelector("[data-story]");
if (!root) return;
const svg = root.querySelector("svg");
const NS = "http://www.w3.org/2000/svg";
const still = matchMedia("(prefers-reduced-motion: reduce)");
const $ = (s) => svg.querySelector(s);
const $$ = (s) => [...svg.querySelectorAll(s)];
const needle = $("[data-needle]"), fan = $("[data-fan]"), mem = $("[data-mem]"), layer = $("[data-packets]");
const cards = $$("[data-card]"), done = $$("[data-done]"), typeEls = $$("[data-type]");
const readout = root.querySelector("[data-story-readout]");
const steps = [...root.querySelectorAll("[data-step]")];
const NCX = +needle.dataset.cx, NCY = +needle.dataset.cy;
const fanBox = fan.getAttribute("transform").match(/rotate\(0 ([^ ]+) ([^)]+)\)/);
const FX = fanBox[1], FY = fanBox[2];
const MEM_H = +mem.getAttribute("height"), MEM_Y = +mem.getAttribute("y");
const LINES = ["$ carbon join https://painel", "    --token cjt_…"];
const CMD = LINES.join("");
const lengths = Object.fromEntries(Object.entries(ARCS).map(([k, p]) => [k, p.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - p[i][0], q[1] - p[i][1]), 0)]));
const pointAt = (pts, d) => { for (let i = 1; i < pts.length; i++) { const s = Math.hypot(pts[i][0] - pts[i-1][0], pts[i][1] - pts[i-1][1]); if (d <= s) { const t = s ? d / s : 0; return [pts[i-1][0] + (pts[i][0] - pts[i-1][0]) * t, pts[i-1][1] + (pts[i][1] - pts[i-1][1]) * t]; } d -= s; } return pts[pts.length - 1]; };

// Each step has targets; a single loop eases the live values toward them.
const TARGET = [
  { cpu: 100, memv: 0.97, fan: 2.6, cards: 10, arcs: [], done: 0 },
  { cpu: 100, memv: 0.95, fan: 2.4, cards: 10, arcs: ["friend"], done: 0 },
  { cpu: 32, memv: 0.42, fan: 0.45, cards: 0, arcs: ["friend", "linux", "cloud"], done: 0 },
  { cpu: 18, memv: 0.3, fan: 0.3, cards: 0, arcs: ["friend", "linux", "cloud"], done: 4 },
];
const READOUT = [
  "CPU 100% · 10 agentes · tudo travado",
  "CPU 100% · um amigo entrou no cluster",
  "CPU 32% · 10 tarefas em 4 computadores",
  "CPU 18% · 10 entregues · PR aberto",
];
let cam = VIEWS[0].slice();
let step = -1, cpu = 0, memv = 0.1, fanSpeed = 0.2, fanAngle = 0, typed = 0, shownCards = 0, cardClock = 0, frame = 0, prev = 0, visible = false, spawn = 0, returned = 0;
const packets = [];

function setActors(s) {
  root.dataset.step = String(s);
  svg.querySelectorAll("[data-arc]").forEach((a) => a.toggleAttribute("data-on", TARGET[s].arcs.includes(a.dataset.arc)));
  if (readout) readout.textContent = READOUT[s];
  steps.forEach((el, i) => el.toggleAttribute("data-active", i === s));
}
function packet(arc, back) {
  const g = document.createElementNS(NS, "g");
  g.setAttribute("class", "st-packet" + (back ? " st-back" : ""));
  g.innerHTML = '<circle class="st-pk-halo" r="7"/><circle class="st-pk-core" r="2.6"/>';
  layer.appendChild(g);
  packets.push({ g, arc, back, d: 0 });
}
function applyStatic() {
  needle.setAttribute("transform", "rotate(" + (-120 + cpu * 2.4).toFixed(1) + " " + NCX + " " + NCY + ")");
  const h = MEM_H * memv;
  mem.setAttribute("height", h.toFixed(1));
  mem.setAttribute("y", (MEM_Y + MEM_H - h).toFixed(1));
  mem.toggleAttribute("data-hot", memv > 0.8);
  root.toggleAttribute("data-hot", cpu > 80);
  cards.forEach((c, i) => c.toggleAttribute("data-on", i < shownCards));
  done.forEach((c, i) => c.toggleAttribute("data-on", i < (step >= 3 ? TARGET[3].done : 0)));
  const n = Math.floor(typed);
  typeEls[0].textContent = LINES[0].slice(0, n);
  typeEls[1].textContent = LINES[1].slice(0, Math.max(0, n - LINES[0].length));
  root.toggleAttribute("data-joined", typed >= CMD.length);
}
function tick(now) {
  const dt = prev ? Math.min((now - prev) / 1000, 1 / 20) : 1 / 60;
  prev = now;
  const T = TARGET[Math.max(step, 0)];
  const ease = (v, t, s) => v + (t - v) * (1 - Math.exp(-dt / s));
  cpu = ease(cpu, T.cpu + (T.cpu > 90 ? Math.sin(now / 90) * 2 : 0), 0.6);
  memv = ease(memv, T.memv, 0.9);
  fanSpeed = ease(fanSpeed, T.fan, 0.8);
  fanAngle = (fanAngle + fanSpeed * 360 * dt) % 360;
  fan.setAttribute("transform", "rotate(" + fanAngle.toFixed(1) + " " + FX + " " + FY + ")");
  // tray fills one card at a time, then empties as tasks leave
  cardClock += dt;
  if (cardClock > 0.22) { cardClock = 0; if (shownCards < T.cards) shownCards++; else if (step >= 3 && shownCards > T.cards) shownCards--; }
  if (step >= 1 && typed < CMD.length) { typed = Math.min(CMD.length, typed + dt * 22); typed = Math.floor(typed * 10) / 10; }
  // tasks over the arcs (step 2+), results back (step 3)
  spawn -= dt;
  if (step >= 2 && spawn <= 0) {
    const names = T.arcs;
    const arc = names[Math.floor(Math.random() * names.length)];
    packet(arc, step >= 3 ? Math.random() < 0.75 : Math.random() < 0.35);
    if (step === 2 && shownCards > 0) shownCards--;
    spawn = 0.42 + Math.random() * 0.4;
  }
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i];
    p.d += dt * 210;
    const L = lengths[p.arc];
    const pts = ARCS[p.arc];
    const pos = pointAt(pts, p.back ? L - p.d : p.d);
    p.g.setAttribute("transform", "translate(" + pos[0].toFixed(1) + " " + pos[1].toFixed(1) + ")");
    if (p.d >= L) { p.g.remove(); packets.splice(i, 1); if (p.back) returned++; }
  }
  const V = VIEWS[Math.max(step, 0)];
  cam = cam.map((v, i) => ease(v, V[i], 0.55));
  svg.setAttribute("viewBox", cam.map((v) => v.toFixed(1)).join(" "));
  applyStatic();
  frame = visible ? requestAnimationFrame(tick) : 0;
}
function run() { if (!frame && visible && !still.matches) { prev = 0; frame = requestAnimationFrame(tick); } }
function stillFrame() {
  const T = TARGET[Math.max(step, 0)];
  cpu = T.cpu; memv = T.memv; shownCards = T.cards; typed = step >= 1 ? CMD.length : 0;
  packets.splice(0).forEach((p) => p.g.remove());
  cam = VIEWS[Math.max(step, 0)].slice();
  svg.setAttribute("viewBox", cam.join(" "));
  applyStatic();
}
function go(s) {
  if (s === step) return;
  step = s;
  if (s < 1) typed = 0;
  setActors(s);
  if (still.matches) stillFrame(); else run();
}
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) go(Number(e.target.dataset.step));
}, { rootMargin: "-45% 0px -45% 0px" });
steps.forEach((el) => io.observe(el));
new IntersectionObserver((entries) => { visible = entries[entries.length - 1].isIntersecting; if (visible) run(); }).observe(root);
still.addEventListener("change", () => { if (still.matches) stillFrame(); else run(); });
svg.setAttribute("viewBox", cam.join(" "));
go(0);
if (still.matches) stillFrame();
})();
