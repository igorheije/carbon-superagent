// The landing's scroll story: one isometric scene that changes as the reader scrolls through four steps.
//   0 · your computer runs 10 agents and freezes
//   1 · a friend's machine (next door or across the world) joins with one command
//   2 · tasks spread over the cluster, your computer breathes again
//   3 · results come back to your panel as branches and a PR
// Built with the Anatomy kit (MIT, landing/figures/anatomy-kit). Run: node landing/figures/story/build.mjs
// Writes landing/assets/story.css, landing/assets/story.js and the markup between
// <!-- story:start --> and <!-- story:end --> in landing/index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../anatomy-kit/iso-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING = join(HERE, "..", "..");
const WIDTH = 900;
const HEIGHT = 640;

// ------------------------------------------------------------------ world

const PH = 8; // plate thickness
const PLATES = {
  you: { x: -236, y: 30, w: 214, d: 186, r: 12 },
  friend: { x: 104, y: -270, w: 150, d: 124, r: 10 },
  linux: { x: -214, y: -292, w: 112, d: 96, r: 9 },
  cloud: { x: 150, y: 96, w: 112, d: 104, r: 9 },
};

const MON = { x: -214, y: 66, w: 88, d: 5, r: 1.6 };
const MON_Z = 26;
const MON_H = 58;
const TOWER = { x: -114, y: 58, w: 28, d: 62, r: 2.5 };
const TOWER_H = 70;
const KB = { x: -208, y: 98, w: 64, d: 20, r: 2.2 };
const GAUGE = { x: -216, y: 150, w: 50, d: 16, r: 2 };
const GAUGE_H = 46;
const TRAY = { x: -154, y: 138, w: 74, d: 46, r: 3 };
const HUB = { x: -76, y: 70, w: 44, d: 38, r: 4 };
const HUB_H = 20;
const ROUTER = { x: -76, y: 150, w: 34, d: 22, r: 3 };
const ROUTER_H = 8;

const LAP = { x: 150, y: -226, w: 70, d: 46, r: 3.5 };
const LID = { x: 150, y: -230.5, w: 70, d: 4, r: 1.6 };
const LID_H = 46;
const MUG = [126, -168];
const POT = [228, -170];

const RACK = { x: -192, y: -276, w: 58, d: 52, r: 2 };
const RACK_H = 112;
const CAB = { x: 176, y: 112, w: 52, d: 60, r: 3 };
const CAB_H = 120;

const ARC_FROM = [ROUTER.x + ROUTER.w / 2, ROUTER.y + ROUTER.d / 2, ROUTER_H + 4];
const ARCS = {
  friend: { to: [LAP.x + 20, LAP.y + LAP.d + 2, 1], peak: 150 },
  linux: { to: [RACK.x + 30, RACK.y + RACK.d + 3, 1], peak: 120 },
  cloud: { to: [CAB.x + 26, CAB.y + CAB.d + 3, 1], peak: 70 },
};

const P = k.fitProjection(
  [
    ...Object.values(PLATES).flatMap((p) => k.boxCorners(p, -PH - 5, 0)),
    ...k.boxCorners(RACK, 0, RACK_H + 8),
    ...k.boxCorners(CAB, 0, CAB_H + 28),
    [ARC_FROM[0], ARC_FROM[1], 160],
  ],
  WIDTH,
  HEIGHT,
  { pad: 14, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const r1 = (n) => +n.toFixed(1);
const flat = (x0, z0, x1, z1, r, steps = 6) =>
  k.pathOf(k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, steps).map(([u, z]) => [u, -z]), true);
const front = (y) => k.sideMatrix([0, y], 0, P, "left");
const side = (x) => k.sideMatrix([x, 0], 0, P, "right");
const onFront = (y, inner) => `<g transform="${front(y)}">${inner}</g>`;
const onSide = (x, inner) => `<g transform="${side(x)}">${inner}</g>`;
const faceLine = (d, tone = "lo", extra = "") => `<path class="iso-line" data-tone="${tone}"${extra} d="${d}"/>`;
const rows = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);
const byDepth = (pts) => [...pts].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const topPoly = (plan, z, steps = 4) => k.pathOf(k.roundedPlan(plan, steps).map(([x, y]) => at([x, y, z])), true);

function feet(plan, inset, z, h, r) {
  return byDepth(k.corners(plan, inset)).map(([x, y]) => S(k.cylinder(x, y, r, z, h, P, 18), { tone: "lo" })).join("");
}
function screws(plan, inset, z) {
  const pts = k.corners(plan, inset);
  return L(pts.map(([x, y]) => k.ring(x, y, 1.6, z, P, 14)).join(""), { tone: "lo" }) + D(pts.map(([x, y]) => at([x, y, z])), { size: 0.45 });
}

function plate(plan, { ruler = false, label = false } = {}) {
  const out = [`<path class="iso-halo" d="${k.haloOf(plan, -PH - 5, PH, P)}"/>`];
  out.push(feet(plan, 18, -PH - 5, 5, 6));
  out.push(S(k.slabOf(plan, -PH, PH, P, 8, 1.4), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(plan, 5), 0, P, 8), { tone: "lo" }));
  out.push(screws(plan, 10, 0));
  if (ruler) {
    const strip = { x: plan.x + 22, y: plan.y + plan.d - 13, w: plan.w * 0.55, d: 6, r: 1 };
    out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
    const ticks = k.topTicks(strip.x + 3, strip.x + strip.w - 3, 5, 5, strip.y, 0.6, [2, 3.8], P, "x");
    out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  }
  if (label) {
    const l = { x: plan.x + plan.w - 52, y: plan.y + plan.d - 18, w: 38, d: 10, r: 1.2 };
    out.push(S(k.slabOf(l, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
    out.push(L([26, 20, 14].map((w, i) => k.lineOnTop([l.x + 4, l.y + 2.6 + i * 2.6], [l.x + 4 + w, l.y + 2.6 + i * 2.6], 0.8, P)).join(""), { tone: "lo", free: true }));
  }
  return out.join("");
}

// ------------------------------------------------------------------ your desk

/** Ten small agent windows on the monitor, a freeze overlay with a spinner, and a calm desktop. */
function monitorScreen() {
  const x0 = MON.x + 4;
  const x1 = MON.x + MON.w - 4;
  const z0 = MON_Z + 5;
  const z1 = MON_Z + MON_H - 4;
  const well = flat(x0, z0, x1, z1, 1.6);
  const cols = 5;
  const gap = 1.6;
  const ww = (x1 - x0 - 4 - gap * (cols - 1)) / cols;
  const wh = (z1 - z0 - 6 - gap) / 2;
  const wins = [];
  for (let i = 0; i < 10; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const wx = x0 + 2 + c * (ww + gap);
    const wz = z1 - 2 - wh - r * (wh + gap);
    const code = rows(4, wz + wh - 5, -3.4).map((z, j) => `M${r1(wx + 1.6 + (j % 2) * 1.6)} ${r1(-z)}h${r1((ww - 4) * [0.8, 0.55, 0.7, 0.4][j])}`).join("");
    wins.push(`<g class="st-win" data-win="${i}"><path class="st-win-bg" d="${flat(wx, wz, wx + ww, wz + wh, 0.8, 3)}"/><path class="st-win-bar" d="M${r1(wx + 0.8)} ${r1(-(wz + wh - 1.6))}H${r1(wx + ww - 0.8)}"/><path class="st-win-code" data-free d="${code}"/></g>`);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  return onFront(MON.y + MON.d, [
    `<path class="st-well" d="${well}"/>`,
    `<g class="st-wins">${wins.join("")}</g>`,
    `<g class="st-freeze"><path class="st-freeze-dim" d="${flat(x0 + 0.6, z0 + 0.6, x1 - 0.6, z1 - 0.6, 1.2)}"/>`,
    `<g class="st-spin" data-spin><circle class="st-spin-track" cx="${r1(cx)}" cy="${r1(-cz)}" r="7"/><circle class="st-spin-arc" cx="${r1(cx)}" cy="${r1(-cz)}" r="7" pathLength="1"/></g></g>`,
    faceLine(well, "lo"),
  ].join(""));
}

/** CPU dial on an instrument housing: ticks, a red zone above 80 %, and a needle rotated live. */
function gauge() {
  const out = [`<path class="iso-halo" d="${k.haloOf(GAUGE, 0, 6, P)}"/>`];
  out.push(feet(GAUGE, 4, 0, 2, 2.2));
  out.push(S(k.slabOf(GAUGE, 2, GAUGE_H, P, 3, 0.8), { tone: "mid" }));
  const fy = GAUGE.y + GAUGE.d;
  const cx = GAUGE.x + 19;
  const cz = 2 + GAUGE_H / 2 + 1;
  const R = 15;
  const ang = (pct) => ((-120 + pct * 2.4) * Math.PI) / 180;
  const pt = (pct, r) => [cx + Math.sin(ang(pct)) * r, -(cz + Math.cos(ang(pct)) * r)];
  const ticks = rows(21, 0, 5).map((p) => {
    const [ax, ay] = pt(p, R - (p % 25 === 0 ? 4.2 : 2.4));
    const [bx, by] = pt(p, R - 0.8);
    return `M${r1(ax)} ${r1(ay)}L${r1(bx)} ${r1(by)}`;
  });
  const arc = (from, to, r) => {
    const pts = rows(17, from, (to - from) / 16).map((p) => pt(p, r));
    return k.pathOf(pts);
  };
  const face = [
    `<circle class="st-dial" cx="${r1(cx)}" cy="${r1(-cz)}" r="${R}"/>`,
    `<path class="st-zone" d="${arc(80, 100, R - 1.6)}"/>`,
    faceLine(ticks.join(""), "mid"),
    `<circle class="iso-line" data-tone="lo" cx="${r1(cx)}" cy="${r1(-cz)}" r="${R}" fill="none"/>`,
    `<g data-needle data-cx="${r1(cx)}" data-cy="${r1(-cz)}" transform="rotate(-120 ${r1(cx)} ${r1(-cz)})"><path class="st-needle" d="M${r1(cx)} ${r1(-cz + 3)}L${r1(cx)} ${r1(-cz - R + 3)}"/></g>`,
    `<circle class="st-hub" cx="${r1(cx)}" cy="${r1(-cz)}" r="1.8"/>`,
    // the bar meter beside the dial: memory
    faceLine(flat(GAUGE.x + 38, 8, GAUGE.x + 45, 2 + GAUGE_H - 6, 1, 3), "lo"),
    `<rect class="st-mem" data-mem x="${GAUGE.x + 39}" y="${-(2 + GAUGE_H - 7)}" width="5" height="${GAUGE_H - 14}" transform="" />`,
  ];
  out.push(onFront(fy, face.join("")));
  out.push(screws(GAUGE, 3, 2 + GAUGE_H));
  return `<g data-part="gauge">${out.join("")}</g>`;
}

function desk() {
  const out = [];
  const sx = MON.x + MON.w / 2;
  out.push(`<path class="iso-halo" d="${k.haloOf({ x: -218, y: 56, w: 136, d: 66, r: 6 }, 0, 6, P)}"/>`);
  out.push(S(k.slabOf({ x: sx - 15, y: 70, w: 30, d: 16, r: 3 }, 0, 2, P, 4, 0.6), { tone: "lo" }));
  out.push(S(k.slabOf({ x: sx - 3, y: 62, w: 6, d: 4, r: 1 }, 2, MON_Z + 4, P, 2), { tone: "mid" }));
  out.push(S(k.slabOf(MON, MON_Z, MON_H, P, 3, 0.8), { tone: "mid" }));
  out.push(monitorScreen());
  out.push(S(k.slabOf(KB, 0, 3, P, 3, 0.6), { tone: "mid" }));
  const keys = [];
  rows(4, KB.y + 3, 3.8).forEach((y, r) => rows(14 - (r === 3 ? 5 : 0), KB.x + 3 + (r % 2) * 1.2, 4.3).forEach((x, c) => {
    keys.push(k.planOutline({ x, y, w: r === 3 && c === 4 ? 18 : 3.2, d: 2.8, r: 0.5 }, 3, P, 2));
  }));
  out.push(L(keys.join(""), { tone: "lo" }));
  // tower with the fan on its side
  out.push(S(k.slabOf(k.insetPlan(TOWER, 1.5), 0, 3, P, 3), { tone: "lo" }));
  out.push(S(k.slabOf(TOWER, 3, TOWER_H, P, 3, 0.8), { tone: "mid" }));
  const ty = TOWER.y + TOWER.d;
  out.push(onFront(ty, [
    faceLine(flat(TOWER.x + 3, 8, TOWER.x + TOWER.w - 3, TOWER_H - 2, 1.4), "faint"),
    faceLine(flat(TOWER.x + 5, TOWER_H - 12, TOWER.x + TOWER.w - 5, TOWER_H - 8, 0.8, 3), "lo"),
    faceLine(rows(5, TOWER.x + 6, 3.4).map((x) => flat(x, 12, x + 1.2, 34, 0.6, 3)).join(""), "faint"),
  ].join("")));
  out.push(`<g class="st-led" data-led="you">${D([at([TOWER.x + TOWER.w / 2, ty, TOWER_H - 22])], { size: 1, tone: "hi" })}</g>`);
  const tx = TOWER.x + TOWER.w;
  const fu = -(TOWER.y + TOWER.d / 2);
  const fz = 40;
  const blades = rows(7, 0, 360 / 7).map((a) => {
    const t = (a * Math.PI) / 180;
    const p = (rr, dt) => [fu + Math.cos(t + dt) * rr, -(fz + Math.sin(t + dt) * rr)];
    const [ax, ay] = p(3, 0);
    const [bx, by] = p(13, 0.5);
    const [cx2, cy2] = p(12.5, 0.95);
    return `M${r1(ax)} ${r1(ay)}Q${r1(bx)} ${r1(by)} ${r1(cx2)} ${r1(cy2)}`;
  });
  out.push(onSide(tx, [
    `<circle class="st-fan-well" cx="${r1(fu)}" cy="${-fz}" r="15"/>`,
    `<g data-fan transform="rotate(0 ${r1(fu)} ${-fz})">${faceLine(blades.join(""), "mid")}</g>`,
    `<circle class="st-hub" cx="${r1(fu)}" cy="${-fz}" r="3"/>`,
    faceLine(k.pathOf(rows(4, 0, 90).map((a) => [fu + Math.cos((a * Math.PI) / 180) * 17.5, -(fz + Math.sin((a * Math.PI) / 180) * 17.5)]), true), "faint"),
    `<circle class="iso-line" data-tone="lo" cx="${r1(fu)}" cy="${-fz}" r="15" fill="none"/>`,
    faceLine(rows(6, -(TOWER.y + TOWER.d) + 6, 8).map((u) => flat(u, TOWER_H - 14, u + 4, TOWER_H - 6, 1, 3)).join(""), "faint"),
  ].join("")));
  return `<g data-part="desk">${out.join("")}</g>`;
}

/** Ten task cards waiting in a tray: they pile up, then leave over the network. */
function tray() {
  const out = [`<path class="iso-halo" d="${k.haloOf(TRAY, 0, 3, P)}"/>`];
  out.push(S(k.slabOf(TRAY, 0, 3, P, 4, 0.6), { tone: "lo" }));
  out.push(L(k.planOutline(k.insetPlan(TRAY, 2.5), 3, P, 3), { tone: "faint" }));
  const cards = [];
  for (let i = 0; i < 10; i++) {
    const c = i % 5;
    const r = Math.floor(i / 5);
    const plan = { x: TRAY.x + 4 + c * 13.6, y: TRAY.y + 5 + r * 19, w: 11, d: 16, r: 1.2 };
    cards.push({ i, plan, depth: k.depthOf([plan.x, plan.y, 0], P) });
  }
  cards.sort((a, b) => a.depth - b.depth);
  for (const { i, plan } of cards) {
    const body = S(k.slabOf(plan, 3, 3.2, P, 3, 0.4), { tone: "hi" });
    const lines = L([7, 5, 6].map((w, j) => k.lineOnTop([plan.x + 2, plan.y + 4 + j * 3.6], [plan.x + 2 + w, plan.y + 4 + j * 3.6], 6.2, P)).join(""), { tone: "lo", free: true });
    out.push(`<g class="st-card" data-card="${i}">${body}${lines}</g>`);
  }
  return `<g data-part="tray">${out.join("")}</g>`;
}

function hub() {
  const out = [`<path class="iso-halo" d="${k.haloOf(HUB, 0, 6, P)}"/>`];
  out.push(feet(HUB, 5, 0, 2.5, 2.6));
  out.push(S(k.slabOf(HUB, 2.5, HUB_H, P, 5, 1), { tone: "mid" }));
  const top = 2.5 + HUB_H;
  const panel = { x: HUB.x + 5, y: HUB.y + 5, w: HUB.w - 10, d: 22, r: 2 };
  out.push(`<path class="st-well" d="${topPoly(panel, top)}"/>`);
  out.push(L(k.planOutline(panel, top, P, 4), { tone: "lo" }));
  const marks = rows(4, panel.x + 4, 7.6).map((x, i) => `<path class="st-done" data-done="${i}" d="${k.pathOf([at([x, panel.y + 12, top]), at([x + 2, panel.y + 15, top]), at([x + 5.4, panel.y + 8, top])])}"/>`);
  out.push(marks.join(""));
  out.push(`<path class="st-pr" data-pr d="${topPoly({ x: panel.x + 3, y: panel.y + 17, w: panel.w - 6, d: 3, r: 1.2 }, top, 3)}"/>`);
  out.push(screws(HUB, 2.6, top));
  const fy = HUB.y + HUB.d;
  out.push(onFront(fy, faceLine(rows(7, HUB.x + 14, 3.6).map((x) => flat(x, 7, x + 1.4, 18, 0.7, 3)).join(""), "faint")));
  out.push(`<g class="st-led" data-led="hub">${D([at([HUB.x + 6, fy, 15]), at([HUB.x + 10, fy, 15])], { size: 0.8, tone: "hi" })}</g>`);
  return `<g data-part="hub">${out.join("")}</g>`;
}

function router() {
  const out = [`<path class="iso-halo" d="${k.haloOf(ROUTER, 0, 4, P)}"/>`];
  out.push(feet(ROUTER, 4, 0, 2, 2));
  out.push(S(k.slabOf(ROUTER, 2, ROUTER_H, P, 4, 0.8), { tone: "mid" }));
  const top = 2 + ROUTER_H;
  out.push(L(rows(5, ROUTER.x + 8, 4).map((x) => k.planOutline({ x, y: ROUTER.y + 6, w: 1.6, d: 11, r: 0.8 }, top, P, 3)).join(""), { tone: "faint" }));
  for (const x of [ROUTER.x + 5, ROUTER.x + ROUTER.w - 5]) {
    out.push(S(k.cylinder(x, ROUTER.y + 3, 2, top, 2, P, 16), { tone: "lo" }));
    out.push(S(k.cylinder(x, ROUTER.y + 3, 1, top + 2, 24, P, 12), { tone: "mid" }));
    out.push(D([at([x, ROUTER.y + 3, top + 26.4])], { size: 1.1, tone: "hi" }));
  }
  const fy = ROUTER.y + ROUTER.d;
  out.push(`<g class="st-led" data-led="router">${D(rows(4, ROUTER.x + 7, 5.6).map((x) => at([x, fy, 6.5])), { size: 0.75, tone: "hi" })}</g>`);
  return `<g data-part="router">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ the friend's machine

function friend() {
  const out = [plate(PLATES.friend, { label: true })];
  // mug and plant: an office somewhere
  out.push(S(k.cylinder(MUG[0], MUG[1], 7, 0, 13, P, 28, 0.6), { tone: "mid" }));
  out.push(L(k.ring(MUG[0], MUG[1], 5.6, 13, P, 24), { tone: "lo" }));
  out.push(S(k.slabOf({ x: MUG[0] + 6, y: MUG[1] - 2, w: 4, d: 4, r: 1.6 }, 4, 6, P, 3), { tone: "mid" }));
  out.push(S(k.cylinder(POT[0], POT[1], 8, 0, 11, P, 28, 0.6), { tone: "lo" }));
  for (const [dx, dy, h, r] of [[0, 0, 16, 2.4], [-3, 2, 22, 2], [3, -2, 19, 2.2]]) {
    out.push(S(k.cylinder(POT[0] + dx, POT[1] + dy, 0.8, 11, h, P, 10), { tone: "mid" }));
    out.push(S(k.cylinder(POT[0] + dx, POT[1] + dy, r * 2.4, 11 + h, 1.4, P, 20), { tone: "hi" }));
  }
  // laptop
  const deck = { x: LAP.x, y: LAP.y, w: LAP.w, d: LAP.d, r: 3.5 };
  out.push(`<path class="iso-halo" d="${k.haloOf(deck, 0, 4, P)}"/>`);
  out.push(feet(deck, 6, 0, 1, 2));
  out.push(S(k.slabOf(LID, 3.5, LID_H, P, 3, 0.6), { tone: "mid" }));
  const ly = LID.y + LID.d;
  const x0 = LID.x + 4;
  const x1 = LID.x + LID.w - 4;
  const z0 = 7.5;
  const z1 = 3.5 + LID_H - 5;
  const well = flat(x0, z0, x1, z1, 1.4);
  out.push(onFront(ly, [
    `<path class="st-well" d="${well}"/>`,
    `<clipPath id="st-term-clip"><path d="${well}"/></clipPath>`,
    `<g class="st-term" clip-path="url(#st-term-clip)">`,
    `<text class="st-tx" data-type="0" x="${x0 + 3}" y="${-(z1 - 6)}" font-size="3.6"></text>`,
    `<text class="st-tx" data-type="1" x="${x0 + 3}" y="${-(z1 - 11)}" font-size="3.6"></text>`,
    `<text class="st-tx st-ok" data-joined x="${x0 + 3}" y="${-(z1 - 17)}" font-size="3.6">✓ entrou no cluster</text>`,
    `<path class="st-run" data-free d="${rows(3, z1 - 23, -4.2).map((z, i) => `M${x0 + 3} ${-z}h${[38, 26, 44][i]}`).join("")}"/>`,
    `</g>`,
    faceLine(well, "lo"),
  ].join("")));
  out.push(S(k.slabOf(deck, 1, 3.5, P, 4, 0.8), { tone: "mid" }));
  const keys = [];
  rows(4, deck.y + 6, 4.6).forEach((y) => rows(13, deck.x + 5, 4.8).forEach((x) => {
    if (x + 3.8 <= deck.x + deck.w - 4) keys.push(k.planOutline({ x, y, w: 3.8, d: 3.6, r: 0.6 }, 4.5, P, 2));
  }));
  out.push(L(keys.join(""), { tone: "lo" }));
  out.push(L(k.planOutline({ x: deck.x + 22, y: deck.y + 26, w: 26, d: 13, r: 1.6 }, 4.5, P, 3), { tone: "lo" }));
  out.push(`<g class="st-led" data-led="friend">${D([at([deck.x + deck.w - 6, deck.y + deck.d - 4, 4.5])], { size: 0.8, tone: "hi" })}</g>`);
  return `<g class="st-actor" data-actor="friend">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ Linux rack and AgentCore cabinet

function linux() {
  const out = [plate(PLATES.linux)];
  out.push(`<path class="iso-halo" d="${k.haloOf(RACK, 0, 10, P)}"/>`);
  out.push(feet(RACK, 5, 0, 4, 3));
  out.push(S(k.slabOf(RACK, 4, 6, P, 3, 0.8), { tone: "lo" }));
  const posts = byDepth(k.corners(RACK, 3));
  for (const [x, y] of posts.slice(0, 3)) out.push(S(k.slabOf({ x: x - 2.4, y: y - 2.4, w: 4.8, d: 4.8, r: 0.6 }, 10, RACK_H - 10, P, 2), { tone: "lo" }));
  const inner = k.insetPlan(RACK, 5);
  const fy = inner.y + inner.d;
  [14, 38, 62, 86].forEach((z, i) => {
    out.push(S(k.slabOf(inner, z, 19, P, 3, 0.6), { tone: "mid" }));
    out.push(onFront(fy, [
      faceLine(flat(inner.x + 3, z + 3, inner.x + 22, z + 16, 1), "lo"),
      faceLine(rows(3, inner.x + 4.6, 5.8).map((x) => flat(x, z + 5, x + 4, z + 14, 0.6, 3)).join(""), "faint"),
      faceLine(rows(5, inner.x + 26, 2.6).map((x) => flat(x, z + 5, x + 1.1, z + 14, 0.5, 3)).join(""), "faint"),
    ].join("")));
    out.push(`<g class="st-led" data-led="linux">${D([at([inner.x + inner.w - 5, fy, z + 12]), at([inner.x + inner.w - 5, fy, z + 7])], { size: 0.8, tone: "hi" })}</g>`);
    out.push(onSide(inner.x + inner.w, faceLine(rows(6, -fy + 6, 6.4).map((u) => flat(u, z + 5, u + 2.6, z + 14, 1, 3)).join(""), "faint")));
  });
  out.push(S(k.slabOf(RACK, RACK_H, 6, P, 3, 1), { tone: "mid" }));
  out.push(screws(RACK, 4, RACK_H + 6));
  const near = posts[3];
  out.push(S(k.slabOf({ x: near[0] - 2.4, y: near[1] - 2.4, w: 4.8, d: 4.8, r: 0.6 }, 10, RACK_H - 10, P, 2), { tone: "lo" }));
  return `<g class="st-actor" data-actor="linux">${out.join("")}</g>`;
}

function cloud() {
  const out = [plate(PLATES.cloud)];
  out.push(`<path class="iso-halo" d="${k.haloOf(CAB, 0, 10, P)}"/>`);
  out.push(S(k.slabOf(k.insetPlan(CAB, 3), 0, 6, P, 4), { tone: "lo" }));
  out.push(S(k.slabOf(CAB, 6, CAB_H - 6, P, 4, 1.2), { tone: "mid" }));
  const fy = CAB.y + CAB.d;
  const door = [CAB.x + 4, 12, CAB.x + CAB.w - 4, CAB_H - 6];
  out.push(onFront(fy, faceLine(flat(...door, 2), "lo")));
  const perf = [];
  for (let x = door[0] + 4; x < door[2] - 3; x += 3.6) for (let z = door[1] + 5; z < 60; z += 3.6) perf.push(at([x, fy, z]));
  out.push(D(perf, { size: 0.42, tone: "lo" }));
  out.push(onFront(fy, [
    `<path class="st-well" d="${flat(door[0] + 4, 68, door[2] - 4, door[3] - 8, 1.4)}"/>`,
    `<path class="st-run" data-free d="${rows(6, door[3] - 13, -5.4).map((z, i) => `M${door[0] + 7} ${-z}h${[30, 18, 26, 12, 22, 16][i]}`).join("")}"/>`,
    faceLine(flat(door[0] + 4, 68, door[2] - 4, door[3] - 8, 1.4), "lo"),
  ].join("")));
  out.push(S(k.slabOf({ x: CAB.x + CAB.w - 9, y: fy, w: 3, d: 2.2, r: 1 }, 32, 20, P, 3, 0.4), { tone: "hi" }));
  out.push(`<g class="st-led" data-led="cloud">${D(rows(3, CAB.x + 9, 5).map((x) => at([x, fy, CAB_H - 2])), { size: 0.8, tone: "hi" })}</g>`);
  out.push(onSide(CAB.x + CAB.w, faceLine(rows(9, -fy + 7, 5.4).map((u) => flat(u, CAB_H - 24, u + 2.2, CAB_H - 11, 1, 3)).join(""), "faint")));
  const top = CAB_H;
  out.push(screws(CAB, 4, top));
  const mx = CAB.x + CAB.w / 2;
  const my = CAB.y + 18;
  out.push(S(k.cylinder(mx, my, 4.2, top, 2, P, 20), { tone: "lo" }));
  out.push(S(k.cylinder(mx, my, 1.3, top + 2, 15, P, 12), { tone: "mid" }));
  out.push(S(k.cylinder(mx, my, 8.6, top + 17, 1.6, P, 32, 0.6), { tone: "hi" }));
  out.push(L(k.ring(mx, my, 5, top + 18.6, P, 28), { tone: "lo" }));
  out.push(D([at([mx, my, top + 20.6])], { size: 1, tone: "hi" }));
  return `<g class="st-actor" data-actor="cloud">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ internet arcs

function arcPoints({ to, peak }, n = 56) {
  const [ax, ay, az] = ARC_FROM;
  const [bx, by, bz] = to;
  return rows(n + 1, 0, 1 / n).map((t) => [ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t + Math.sin(Math.PI * t) * peak]);
}
const ARC_SCREEN = Object.fromEntries(Object.entries(ARCS).map(([name, a]) => [name, arcPoints(a).map((p) => at(p).map(r1))]));

function arcs() {
  return Object.entries(ARC_SCREEN)
    .map(([name, pts]) => {
      const d = k.pathOf(pts);
      const end = pts.at(-1);
      return `<g class="st-arc" data-arc="${name}"><path class="st-arc-shadow" d="${d}"/><path class="st-arc-line" pathLength="1" d="${d}"/><circle class="iso-wire-end st-arc-end" cx="${end[0]}" cy="${end[1]}" r="1.8"/></g>`;
    })
    .join("");
}

// ------------------------------------------------------------------ assemble

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "Cena isométrica em quatro passos: o seu computador com dez janelas de agentes e um mostrador de CPU no vermelho; o notebook de um amigo, numa bancada distante, entra no cluster por um arco de internet; um rack Linux e um gabinete AgentCore também se conectam e as tarefas viajam pelos arcos; os resultados voltam ao painel e o mostrador volta ao verde.",
  body: [
    linux(),
    friend(),
    plate(PLATES.you, { ruler: true, label: true }),
    desk(),
    hub(),
    gauge(),
    tray(),
    router(),
    cloud(),
    `<g data-arcs>${arcs()}</g>`,
    `<g data-packets></g>`,
  ],
});

// ------------------------------------------------------------------ camera per step (viewBox), same aspect as the figure

function view(points, pad = 24) {
  const flat = points.map(at);
  let x0 = Math.min(...flat.map((p) => p[0])) - pad;
  let x1 = Math.max(...flat.map((p) => p[0])) + pad;
  let y0 = Math.min(...flat.map((p) => p[1])) - pad;
  let y1 = Math.max(...flat.map((p) => p[1])) + pad;
  const aspect = WIDTH / HEIGHT;
  if ((x1 - x0) / (y1 - y0) > aspect) {
    const h = (x1 - x0) / aspect;
    const cy = (y0 + y1) / 2;
    y0 = cy - h / 2; y1 = cy + h / 2;
  } else {
    const w = (y1 - y0) * aspect;
    const cx = (x0 + x1) / 2;
    x0 = cx - w / 2; x1 = cx + w / 2;
  }
  return [x0, y0, x1 - x0, y1 - y0].map(r1);
}
const YOU = [...k.boxCorners(PLATES.you, -PH - 5, 0), ...k.boxCorners(MON, MON_Z, MON_Z + MON_H), [ROUTER.x, ROUTER.y, 34]];
const FRIEND = [...k.boxCorners(PLATES.friend, -PH - 5, 0), ...k.boxCorners(LID, 0, LID_H + 4), [POT[0], POT[1], 40]];
const PEAK = (a) => { const pts = arcPoints(ARCS[a]); return pts[Math.floor(pts.length / 2)]; };
const LINUX = [...k.boxCorners(PLATES.linux, -PH - 5, 0), ...k.boxCorners(RACK, 0, RACK_H + 6)];
const CLOUD = [...k.boxCorners(PLATES.cloud, -PH - 5, 0), ...k.boxCorners(CAB, 0, CAB_H + 22)];
const ALL = [...YOU, ...FRIEND, ...LINUX, ...CLOUD, PEAK("friend"), PEAK("linux"), PEAK("cloud")];
const VIEWS = [view(YOU, 16), view([...YOU, ...FRIEND, PEAK("friend")], 18), view(ALL, 14), view(ALL, 14)];

// ------------------------------------------------------------------ live behaviour

const live = `(() => {
const ARCS = ${JSON.stringify(ARC_SCREEN)};
const VIEWS = ${JSON.stringify(VIEWS)};
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
const fanBox = fan.getAttribute("transform").match(/rotate\\(0 ([^ ]+) ([^)]+)\\)/);
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
`;

// ------------------------------------------------------------------ styles

const LIGHT = k.ISO_CSS.match(/\.iso\[data-theme="light"\]\{([^}]*)\}/)?.[1];
if (!LIGHT) throw new Error("light theme block not found in ISO_CSS");
const css = `/* generated by landing/figures/story/build.mjs — Anatomy kit CSS (MIT) is loaded by cluster.css */
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) .st.iso{${LIGHT};--anatomy-card:transparent;--anatomy-lit:var(--accent,#16a34a)}}
html .st.iso.iso{--anatomy-card:transparent;--anatomy-lit:var(--accent,#22c55e);--st-hot:#ef4444}
.st{margin:24px 0 80px;position:relative}
.st-head{max-width:720px;margin:0 auto 12px;text-align:center}
.st-head h2{font-size:clamp(28px,4vw,48px);letter-spacing:-.03em;line-height:1.05;margin:10px 0 0}
.st-grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:40px;align-items:start}
.st-steps{padding:10vh 0 30vh}
.st-step{min-height:72vh;display:flex;flex-direction:column;justify-content:center;opacity:.28;transition:opacity .5s ease}
.st-step[data-active]{opacity:1}
.st-step .k{font-family:var(--mono);font-size:11px;letter-spacing:.14em;color:var(--accent)}
.st-step h3{font-size:clamp(24px,2.6vw,34px);letter-spacing:-.025em;line-height:1.1;margin:10px 0 12px}
.st-step p{color:var(--muted);font-size:16px;line-height:1.6;margin:0 0 10px;max-width:46ch}
.st-step p b{color:var(--ink);font-weight:500}
.st-step code{font-family:var(--mono);font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:2px 6px}
.st-stage{position:sticky;top:8vh;height:84vh;display:flex;flex-direction:column;justify-content:center}
.st-stage svg{display:block;width:100%;height:auto;max-height:76vh;overflow:hidden}
.st-readout{font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center;margin-top:8px;transition:color .4s}
.st[data-hot] .st-readout{color:var(--st-hot)}
/* actors enter as the story needs them */
.st-actor{opacity:0;transform:translateY(-26px);transition:opacity .9s var(--anatomy-ease),transform 1.1s cubic-bezier(.16,1,.3,1)}
.st[data-step="1"] [data-actor="friend"],.st[data-step="2"] .st-actor,.st[data-step="3"] .st-actor{opacity:1;transform:none}
.st-arc-line{fill:none;stroke:var(--anatomy-lit);stroke-width:1.5px;vector-effect:non-scaling-stroke;stroke-dasharray:1 1;stroke-dashoffset:1;transition:stroke-dashoffset 1.6s cubic-bezier(.65,0,.35,1)}
.st-arc-shadow{fill:none;stroke:var(--anatomy-lit);stroke-width:7px;vector-effect:non-scaling-stroke;opacity:0;transition:opacity 1.2s}
.st-arc-end{opacity:0;transition:opacity .4s 1.2s}
.st-arc{opacity:0;transition:opacity .3s}
.st-arc[data-on]{opacity:1}
.st-arc[data-on] .st-arc-line{stroke-dashoffset:0}
.st-arc[data-on] .st-arc-shadow{opacity:.07}
.st-arc[data-on] .st-arc-end{opacity:1}
.st-well{fill:var(--anatomy-shade-0)}
.st-win-bg{fill:var(--anatomy-face);stroke:var(--anatomy-lo);stroke-width:.5px;vector-effect:non-scaling-stroke}
.st-win-bar{stroke:var(--anatomy-lit);stroke-width:1.2px;vector-effect:non-scaling-stroke;stroke-linecap:round}
.st-win-code{fill:none;stroke:var(--anatomy-mid);stroke-width:.9px;vector-effect:non-scaling-stroke;stroke-linecap:round}
.st[data-hot] .st-win-bar{stroke:var(--st-hot)}
.st[data-hot] .st-win{animation:st-glitch 1.3s steps(2,end) infinite}
.st[data-hot] .st-win:nth-child(3n){animation-delay:-.4s}.st[data-hot] .st-win:nth-child(3n+1){animation-delay:-.9s}
.st-freeze{opacity:0;transition:opacity .6s}
.st[data-hot] .st-freeze{opacity:1}
.st-freeze-dim{fill:var(--anatomy-paper);opacity:.55}
.st-spin-track{fill:none;stroke:var(--anatomy-lo);stroke-width:2px;vector-effect:non-scaling-stroke}
.st-spin-arc{fill:none;stroke:var(--st-hot);stroke-width:2px;vector-effect:non-scaling-stroke;stroke-dasharray:.28 .72;stroke-linecap:round;transform-box:fill-box;transform-origin:center;animation:st-spin 1.1s linear infinite}
.st-dial{fill:var(--anatomy-face)}
.st-zone{fill:none;stroke:var(--st-hot);stroke-width:2.4px;vector-effect:non-scaling-stroke;opacity:.85}
.st-needle{stroke:var(--anatomy-strong);stroke-width:1.6px;vector-effect:non-scaling-stroke;stroke-linecap:round}
.st[data-hot] .st-needle{stroke:var(--st-hot)}
.st-hub{fill:var(--anatomy-hi)}
.st-mem{fill:var(--anatomy-lit);transition:fill .4s}
.st-mem[data-hot]{fill:var(--st-hot)}
.st-fan-well{fill:var(--anatomy-shade-0)}
.st-card{opacity:0;transform:translateY(-10px);transition:opacity .35s,transform .45s cubic-bezier(.16,1,.3,1)}
.st-card[data-on]{opacity:1;transform:none}
.st-done{fill:none;stroke:var(--anatomy-faint);stroke-width:1.6px;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-linejoin:round;transition:stroke .4s}
.st-done[data-on]{stroke:var(--anatomy-lit)}
.st-pr{fill:var(--anatomy-faint);transition:fill .5s .6s}
.st[data-step="3"] .st-pr{fill:var(--anatomy-lit)}
.st-tx{fill:var(--anatomy-lit);font-family:var(--anatomy-mono,ui-monospace,monospace)}
.st-ok{opacity:0;transition:opacity .4s}
.st[data-joined] .st-ok{opacity:1}
.st-run{fill:none;stroke:var(--anatomy-faint);stroke-width:1px;vector-effect:non-scaling-stroke;stroke-linecap:round;transition:stroke .5s}
.st[data-step="2"] .st-run,.st[data-step="3"] .st-run{stroke:var(--anatomy-lit);animation:st-blink 1.4s ease-in-out infinite}
.st-led circle{fill:var(--anatomy-lo);transition:fill .4s}
.st[data-hot] [data-led="you"] circle{fill:var(--st-hot);animation:st-blink .5s steps(2,end) infinite}
.st[data-step="2"] .st-led:not([data-led="you"]) circle,.st[data-step="3"] .st-led:not([data-led="you"]) circle{fill:var(--anatomy-lit)}
.st-pk-core{fill:var(--anatomy-lit)}.st-pk-halo{fill:var(--anatomy-lit);opacity:.18}
.st-back .st-pk-core{fill:var(--anatomy-strong)}.st-back .st-pk-halo{fill:var(--anatomy-strong);opacity:.12}
@keyframes st-spin{to{transform:rotate(360deg)}}
@keyframes st-glitch{0%{opacity:1}50%{opacity:.45}}
@keyframes st-blink{50%{opacity:.4}}
@media (max-width:900px){
  .st-grid{display:flex;flex-direction:column;align-items:stretch}
  .st-stage{order:-1;position:sticky;top:0;height:auto;margin:0 -16px;padding:6px 16px 4px;z-index:2;background:var(--bg);box-shadow:0 14px 18px -12px var(--bg)}
  .st-stage svg{max-height:40vh;margin:0 auto}
  .st-step code{display:inline-block;max-width:100%;white-space:normal;overflow-wrap:anywhere}
  .st-steps{padding:4vh 0 10vh}
  .st-step{min-height:62vh;justify-content:flex-start;padding-top:6vh}
}
@media (prefers-reduced-motion:reduce){
  .st-actor,.st-card,.st-arc-line,.st-arc-shadow,.st-arc-end,.st-step,.st-freeze{transition:none}
  .st-win,.st-spin-arc,.st-run,.st-led circle{animation:none!important}
}
`;

const markup = `<!-- story:start (gerado por landing/figures/story/build.mjs) -->
    <section class="st iso" id="historia" data-story aria-labelledby="st-title">
      <div class="st-head">
        <p class="eyebrow"><span class="dot"></span>uma história em quatro passos</p>
        <h2 id="st-title">Seu computador não precisa aguentar tudo sozinho.</h2>
      </div>
      <div class="st-grid">
        <div class="st-steps">
          <article class="st-step" data-step="0">
            <span class="k">01 · O GARGALO</span>
            <h3>Você roda 10 agentes. O computador trava.</h3>
            <p>Dez tarefas do <b>Claude Code</b> ou do <b>Codex</b> ao mesmo tempo: cada uma compila, roda testes e indexa o projeto. A CPU vai a 100%, a memória enche, a ventoinha dispara e a tela congela.</p>
            <p>Você para de trabalhar e espera tudo voltar ao normal.</p>
          </article>
          <article class="st-step" data-step="1">
            <span class="k">02 · UM AMIGO AJUDA</span>
            <h3>Um amigo tem uma máquina sobrando.</h3>
            <p>No escritório ao lado ou do outro lado do mundo, pela internet. Ele roda <b>um comando</b> e empresta <b>processamento</b>, CPU e memória, para as suas tarefas:</p>
            <p><code>carbon join https://seu-painel --token cjt_…</code></p>
            <p>Só entra quem tem o token de join que você gerou. Você pode pausar ou remover a máquina dele a qualquer momento.</p>
          </article>
          <article class="st-step" data-step="2">
            <span class="k">03 · A FILA SE ESPALHA</span>
            <h3>As tarefas se espalham. O seu computador respira.</h3>
            <p>O painel manda cada tarefa para um computador livre: o notebook do amigo, um servidor <b>Linux</b>, uma sessão do <b>AWS AgentCore</b>. Cada um roda o agente na própria CPU.</p>
            <p>A sua CPU volta para o verde, e você continua trabalhando.</p>
          </article>
          <article class="st-step" data-step="3">
            <span class="k">04 · TUDO VOLTA PARA VOCÊ</span>
            <h3>Os resultados voltam para o seu painel.</h3>
            <p>Cada computador devolve um <b>branch</b>. O painel mostra log, diff e testes como se tudo tivesse rodado aqui, e abre o <b>PR</b> para você revisar.</p>
            <p>Mais computadores, mais tarefas ao mesmo tempo, e você decide com um clique.</p>
          </article>
        </div>
        <div class="st-stage">
          <div class="iso-stage">${svg}</div>
          <p class="st-readout" data-story-readout aria-live="off">CPU 100% · 10 agentes · tudo travado</p>
        </div>
      </div>
    </section>
    <!-- story:end -->`;

writeFileSync(join(LANDING, "assets", "story.css"), css);
writeFileSync(join(LANDING, "assets", "story.js"), live);
const indexPath = join(LANDING, "index.html");
const html = readFileSync(indexPath, "utf8");
const re = /<!-- story:start[\s\S]*?<!-- story:end -->/;
if (!re.test(html)) throw new Error("markers <!-- story:start --> / <!-- story:end --> not found in landing/index.html");
writeFileSync(indexPath, html.replace(re, markup));
console.log(`story figure: ${(svg.length / 1024).toFixed(0)} KB svg, wrote assets/story.css, assets/story.js, index.html`);
