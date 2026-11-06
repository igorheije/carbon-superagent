// Fig 1 of the landing: computers of every kind joined to one Carbon panel, sharing its task queue.
// Built with the Anatomy kit (MIT, landing/figures/anatomy-kit). Run: node landing/figures/cluster/build.mjs
// It writes landing/assets/cluster.css and landing/assets/cluster.js, and replaces the markup between
// <!-- cluster-figure:start --> and <!-- cluster-figure:end --> in landing/index.html.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as k from "../anatomy-kit/iso-kit.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING = join(HERE, "..", "..");

const WIDTH = 960;
const HEIGHT = 560;
const Z0 = 0.6; // cables lie on the plate top

// ------------------------------------------------------------------ world (x, y on the bench, z up)

const PLATE = { x: -236, y: -226, w: 462, d: 446, r: 14 };
const PLATE_H = 10;
const FOOT_H = 6;

const HUB = { x: -38, y: -30, w: 76, d: 60, r: 5 };
const HUB_H = 30;
const ROUTER = { x: 24, y: 58, w: 32, d: 22, r: 3 };
const ROUTER_H = 8;

const RACK = { x: -184, y: -186, w: 64, d: 56, r: 2 };
const RACK_H = 128;
const BLADE_Z = [14, 40, 66, 92];
const BLADE_H = 20;

const CAB = { x: 112, y: -182, w: 54, d: 62, r: 3 };
const CAB_H = 132;

const TOWER = { x: -112, y: 100, w: 26, d: 56, r: 2.5 };
const TOWER_H = 62;
const MONITOR = { x: -192, y: 112, w: 74, d: 5, r: 1.6 };
const MON_Z = 26;
const MON_H = 50;
const DESK_KB = { x: -184, y: 146, w: 58, d: 20, r: 2.2 };

const LAP = { x: 96, y: 112, w: 76, d: 50, r: 3.5 };
const LAP_H = 4.5;
const LID = { x: 96, y: 107.5, w: 76, d: 4, r: 1.6 };
const LID_H = 50;

const P = k.fitProjection(
  [
    ...k.boxCorners(PLATE, -PLATE_H - FOOT_H, 0),
    ...k.boxCorners(RACK, 0, RACK_H + 6),
    ...k.boxCorners(CAB, 0, CAB_H + 26),
  ],
  WIDTH,
  HEIGHT,
  { pad: 18, azimuth: 45 },
);

const at = (p) => k.iso(p, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const flat = (x0, z0, x1, z1, r, steps = 6) =>
  k.pathOf(k.roundedPlan({ x: x0, y: z0, w: x1 - x0, d: z1 - z0, r }, steps).map(([u, z]) => [u, -z]), true);
const front = (y) => k.sideMatrix([0, y], 0, P, "left"); // plane y = const, local (x, -z)
const side = (x) => k.sideMatrix([x, 0], 0, P, "right"); // plane x = const, local (-y, -z)
const onFront = (y, inner) => `<g transform="${front(y)}">${inner}</g>`;
const onSide = (x, inner) => `<g transform="${side(x)}">${inner}</g>`;
const faceLine = (d, tone = "lo", extra = "") => `<path class="iso-line" data-tone="${tone}"${extra} d="${d}"/>`;
const rows = (n, from, step) => Array.from({ length: n }, (_, i) => from + i * step);

/** Screen set into a vertical face: a dark well, code rule lines and a status bar, lit while the machine works. */
function screen(x0, z0, x1, z1, { lines = 7, id }) {
  const well = flat(x0, z0, x1, z1, 1.6);
  const pad = Math.max(2.4, (x1 - x0) * 0.07);
  const step = (z1 - z0 - pad * 2 - 3) / lines;
  const widths = [0.72, 0.5, 0.86, 0.38, 0.64, 0.8, 0.46, 0.7, 0.56];
  const code = rows(lines, z1 - pad - 1, -step)
    .map((z, i) => {
      const indent = i % 3 === 1 ? 4 : i % 3 === 2 ? 8 : 0;
      const w = (x1 - x0 - pad * 2 - indent) * widths[i % widths.length];
      return `M${(x0 + pad + indent).toFixed(1)} ${(-z).toFixed(1)}h${w.toFixed(1)}`;
    })
    .join("");
  const bar = `M${(x0 + pad).toFixed(1)} ${(-(z0 + pad)).toFixed(1)}H${(x1 - pad).toFixed(1)}`;
  return [
    `<path class="cl-well" d="${well}"/>`,
    `<g class="cl-screen" data-screen="${id}">`,
    `<path class="cl-glow" d="${flat(x0 + 1, z0 + 1, x1 - 1, z1 - 1, 1.2)}"/>`,
    `<path class="cl-code" data-free d="${code}"/>`,
    `<path class="cl-bar-track" d="${bar}"/>`,
    `<path class="cl-bar" data-bar="${id}" pathLength="1" d="${bar}"/>`,
    `</g>`,
    faceLine(well, "lo"),
  ].join("");
}

function feet(plan, inset, z, h, r) {
  const sorted = [...k.corners(plan, inset)].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  return sorted.map(([x, y]) => S(k.cylinder(x, y, r, z, h, P, 18), { tone: "lo" })).join("");
}

function screws(plan, inset, z) {
  const pts = k.corners(plan, inset);
  return L(pts.map(([x, y]) => k.ring(x, y, 1.6, z, P, 14)).join(""), { tone: "lo" }) + D(pts.map(([x, y]) => at([x, y, z])), { size: 0.45 });
}

// ------------------------------------------------------------------ bench plate

function plate() {
  const out = [`<path class="iso-halo" d="${k.haloOf(PLATE, -PLATE_H - FOOT_H, PLATE_H, P)}"/>`];
  out.push(feet(PLATE, 26, -PLATE_H - FOOT_H, FOOT_H, 8));
  out.push(S(k.slabOf(PLATE, -PLATE_H, PLATE_H, P, 10, 1.6), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATE, 6), 0, P, 10), { tone: "lo" }));
  out.push(screws(PLATE, 13, 0));
  // ruler strip along the near-left edge, ticks every 5 units
  const strip = { x: PLATE.x + 30, y: PLATE.y + PLATE.d - 15, w: 170, d: 7, r: 1 };
  out.push(S(k.slabOf(strip, 0, 0.6, P, 3), { tone: "lo", crease: "none" }));
  const ticks = k.topTicks(strip.x + 3, strip.x + strip.w - 3, 5, 5, strip.y, 0.6, [2.2, 4.2], P, "x");
  out.push(L(ticks.minor, { tone: "lo" }), L(ticks.major, { tone: "mid" }));
  // label plate with three rule lines
  const label = { x: PLATE.x + PLATE.w - 66, y: PLATE.y + PLATE.d - 22, w: 48, d: 12, r: 1.2 };
  out.push(S(k.slabOf(label, 0, 0.8, P, 3), { tone: "lo", crease: "none" }));
  out.push(L([34, 26, 18].map((w, i) => k.lineOnTop([label.x + 4, label.y + 3 + i * 3], [label.x + 4 + w, label.y + 3 + i * 3], 0.8, P)).join(""), { tone: "lo", free: true }));
  return out.join("");
}

// ------------------------------------------------------------------ cables (on the plate) and packets

const ROUTES = {
  rack: [[-38, -12], [-92, -12], [-92, -104], [-152, -104], [-152, -128]],
  desktop: [[-20, 30], [-20, 132], [-85, 132]],
  cloud: [[30, 30], [30, 57], null, [57, 68], [140, 68], [140, -118]],
  laptop: [[30, 30], [30, 57], null, [40, 81], [40, 136], [95, 136]],
};

/** World route without the `null` marker (the router), as 3D points on the plate. */
const routePoints = (name) => ROUTES[name].filter(Boolean).map(([x, y]) => [x, y, Z0]);

function cables() {
  const out = [];
  const drawn = new Set();
  for (const [name, route] of Object.entries(ROUTES)) {
    const split = route.indexOf(null);
    const legs = split < 0 ? [route] : [route.slice(0, split), route.slice(split + 1)];
    legs.forEach((leg, index) => {
      const key = JSON.stringify(leg);
      if (drawn.has(key)) return; // hub → router is shared by cloud and laptop
      drawn.add(key);
      const pts = leg.map(([x, y]) => at([x, y, Z0]));
      out.push(`<g class="cl-cable" data-cable="${index === 0 && split >= 0 ? "uplink" : name}">${k.wireSvg(pts[0], pts.at(-1), { via: pts.slice(1, -1), tone: "mid", size: 1.6 })}</g>`);
    });
  }
  return out.join("");
}

// ------------------------------------------------------------------ the panel (manager)

function hub() {
  const out = [`<path class="iso-halo" d="${k.haloOf(HUB, 0, 8, P)}"/>`];
  out.push(feet(HUB, 7, 0, 3, 3.2));
  out.push(S(k.slabOf(HUB, 3, HUB_H, P, 6, 1.2), { tone: "mid" }));
  const top = 3 + HUB_H;
  // top display with the task queue: one chip per queued task
  const panel = { x: HUB.x + 8, y: HUB.y + 8, w: HUB.w - 16, d: 30, r: 2 };
  out.push(`<path class="cl-well" d="${k.pathOf(k.roundedPlan(panel, 4).map(([x, y]) => at([x, y, top])), true)}"/>`);
  out.push(L(k.planOutline(panel, top, P, 4), { tone: "lo" }));
  const chips = rows(6, panel.x + 4, 8.8).map(
    (x, i) => `<path class="cl-chip" data-chip="${i}" d="${k.pathOf(k.roundedPlan({ x, y: panel.y + 9, w: 6.6, d: 12, r: 1.2 }, 3).map(([cx, cy]) => at([cx, cy, top])), true)}"/>`,
  );
  out.push(`<g data-queue>${chips.join("")}</g>`);
  out.push(L(k.lineOnTop([panel.x + 4, panel.y + 25], [panel.x + 30, panel.y + 25], top, P), { tone: "lo", free: true }));
  // grille slots behind the display
  out.push(L(rows(9, HUB.x + 10, 6.2).map((x) => k.planOutline({ x, y: HUB.y + HUB.d - 15, w: 3, d: 9, r: 1.2 }, top, P, 3)).join(""), { tone: "faint" }));
  out.push(screws(HUB, 3.5, top));
  // front: status LEDs, power button, vents
  const fy = HUB.y + HUB.d;
  out.push(onFront(fy, faceLine(flat(HUB.x + 4, 7, HUB.x + HUB.w - 4, 3 + HUB_H - 4, 2.4), "faint")));
  out.push(onFront(fy, faceLine(rows(10, HUB.x + 30, 3.4).map((x) => flat(x, 10, x + 1.4, 24, 0.7, 3)).join(""), "lo")));
  out.push(`<g class="cl-led" data-led="hub">${D([at([HUB.x + 9, fy, 24]), at([HUB.x + 15, fy, 24]), at([HUB.x + 21, fy, 24])], { size: 0.9, tone: "hi" })}</g>`);
  out.push(S(k.cylinder(HUB.x + 12, fy + 0.2, 3.2, 10, 0.1, P, 18), { tone: "lo" }));
  out.push(onFront(fy, faceLine(k.pathOf(k.circleRing(HUB.x + 12, -12.5, 3.4, 20), true), "lo")));
  // side: two network ports
  const sx = HUB.x + HUB.w;
  out.push(onSide(sx, faceLine([0, 12].map((u) => flat(u - 4, 8, u + 4, 14, 1, 3)).join(""), "lo")));
  out.push(onSide(sx, faceLine(rows(6, -24, 3.2).map((u) => flat(u, 18, u + 1.4, 28, 0.7, 3)).join(""), "faint")));
  return `<g data-machine="hub">${out.join("")}</g>`;
}

function router() {
  const out = [`<path class="iso-halo" d="${k.haloOf(ROUTER, 0, 4, P)}"/>`];
  out.push(feet(ROUTER, 4, 0, 2, 2));
  out.push(S(k.slabOf(ROUTER, 2, ROUTER_H, P, 4, 0.8), { tone: "mid" }));
  const top = 2 + ROUTER_H;
  out.push(L(rows(5, ROUTER.x + 7, 4).map((x) => k.planOutline({ x, y: ROUTER.y + 5, w: 1.6, d: 12, r: 0.8 }, top, P, 3)).join(""), { tone: "faint" }));
  // two antennas on the back edge
  for (const x of [ROUTER.x + 5, ROUTER.x + ROUTER.w - 5]) {
    out.push(S(k.cylinder(x, ROUTER.y + 3, 2, top, 2, P, 16), { tone: "lo" }));
    out.push(S(k.cylinder(x, ROUTER.y + 3, 1, top + 2, 26, P, 12), { tone: "mid" }));
    out.push(D([at([x, ROUTER.y + 3, top + 28.4])], { size: 1.1, tone: "hi" }));
  }
  const fy = ROUTER.y + ROUTER.d;
  out.push(`<g class="cl-led" data-led="router">${D(rows(4, ROUTER.x + 6, 5.5).map((x) => at([x, fy, 6.5])), { size: 0.75, tone: "hi" })}</g>`);
  return `<g data-machine="router">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ Linux rack

function rack() {
  const out = [`<path class="iso-halo" d="${k.haloOf(RACK, 0, 10, P)}"/>`];
  out.push(feet(RACK, 5, 0, 4, 3.2));
  out.push(S(k.slabOf(RACK, 4, 6, P, 3, 0.8), { tone: "lo" }));
  const posts = k.corners(RACK, 3).sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
  const back = posts.slice(0, 3);
  const nearPost = posts[3];
  for (const [x, y] of back) out.push(S(k.slabOf({ x: x - 2.5, y: y - 2.5, w: 5, d: 5, r: 0.6 }, 10, RACK_H - 10, P, 2), { tone: "lo" }));
  const inner = k.insetPlan(RACK, 5);
  BLADE_Z.forEach((z, i) => {
    out.push(S(k.slabOf(inner, z, BLADE_H, P, 3, 0.6), { tone: "mid" }));
    const fy = inner.y + inner.d;
    out.push(onFront(fy, [
      faceLine(flat(inner.x + 3, z + 3, inner.x + 26, z + BLADE_H - 3, 1), "lo"),
      faceLine(rows(3, inner.x + 5, 7).map((x) => flat(x, z + 5, x + 5, z + BLADE_H - 5, 0.6, 3)).join(""), "faint"),
      faceLine(rows(6, inner.x + 31, 2.6).map((x) => flat(x, z + 5, x + 1.1, z + BLADE_H - 5, 0.5, 3)).join(""), "faint"),
    ].join("")));
    out.push(`<g class="cl-led" data-led="rack" data-blade="${i}">${D([at([inner.x + inner.w - 6, fy, z + 13]), at([inner.x + inner.w - 6, fy, z + 7])], { size: 0.8, tone: "hi" })}</g>`);
    out.push(onSide(inner.x + inner.w, faceLine(rows(7, -(inner.y + inner.d) + 6, 6.2).map((u) => flat(u, z + 5, u + 2.6, z + BLADE_H - 5, 1, 3)).join(""), "faint")));
  });
  // the screen of the top blade is the rack's "console"
  out.push(onFront(inner.y + inner.d, screen(inner.x + 3, BLADE_Z[3] + 3, inner.x + 26, BLADE_Z[3] + BLADE_H - 3, { lines: 3, id: "rack" })));
  out.push(S(k.slabOf(RACK, RACK_H, 6, P, 3, 1), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(RACK, 6), RACK_H + 6, P, 3), { tone: "faint" }));
  out.push(screws(RACK, 4, RACK_H + 6));
  out.push(S(k.slabOf({ x: nearPost[0] - 2.5, y: nearPost[1] - 2.5, w: 5, d: 5, r: 0.6 }, 10, RACK_H - 10, P, 2), { tone: "lo" }));
  out.push(onFront(nearPost[1] + 2.5, faceLine(rows(22, 14, 5.2).map((z) => `M${nearPost[0] - 1.2} ${-z}h2.4`).join(""), "faint", " data-free")));
  return `<g class="cl-machine" data-machine="rack" tabindex="-1">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ AgentCore cabinet (cloud)

function cabinet() {
  const out = [`<path class="iso-halo" d="${k.haloOf(CAB, 0, 10, P)}"/>`];
  out.push(S(k.slabOf(k.insetPlan(CAB, 3), 0, 6, P, 4), { tone: "lo" }));
  out.push(S(k.slabOf(CAB, 6, CAB_H - 6, P, 4, 1.2), { tone: "mid" }));
  const fy = CAB.y + CAB.d;
  const door = [CAB.x + 4, 12, CAB.x + CAB.w - 4, CAB_H - 6];
  out.push(onFront(fy, faceLine(flat(...door, 2), "lo")));
  // perforated door: a dot field around the console window
  const perf = [];
  for (let x = door[0] + 4; x < door[2] - 3; x += 3.6) for (let z = door[1] + 5; z < 62; z += 3.6) perf.push(at([x, fy, z]));
  out.push(D(perf, { size: 0.42, tone: "lo" }));
  out.push(onFront(fy, screen(door[0] + 4, 70, door[2] - 4, door[3] - 8, { lines: 8, id: "cloud" })));
  out.push(S(k.slabOf({ x: CAB.x + CAB.w - 9, y: fy, w: 3, d: 2.2, r: 1 }, 34, 22, P, 3, 0.4), { tone: "hi" }));
  out.push(`<g class="cl-led" data-led="cloud">${D(rows(3, CAB.x + 9, 5).map((x) => at([x, fy, CAB_H - 2])), { size: 0.8, tone: "hi" })}</g>`);
  out.push(onSide(CAB.x + CAB.w, faceLine(rows(3, 30, 34).map((z) => `M${-(CAB.y + CAB.d) + 3} ${-z}H${-CAB.y - 3}`).join(""), "faint")));
  out.push(onSide(CAB.x + CAB.w, faceLine(rows(9, -(CAB.y + CAB.d) + 8, 5.2).map((u) => flat(u, CAB_H - 26, u + 2.2, CAB_H - 12, 1, 3)).join(""), "faint")));
  // uplink mast and dish on the roof: the cabinet lives in someone's cloud account
  const top = CAB_H;
  out.push(screws(CAB, 4, top));
  const mx = CAB.x + CAB.w / 2;
  const my = CAB.y + 18;
  out.push(S(k.cylinder(mx, my, 4.4, top, 2, P, 20), { tone: "lo" }));
  out.push(S(k.cylinder(mx, my, 1.4, top + 2, 16, P, 12), { tone: "mid" }));
  out.push(S(k.cylinder(mx, my, 9, top + 18, 1.6, P, 32, 0.6), { tone: "hi" }));
  out.push(L(k.ring(mx, my, 5.2, top + 19.6, P, 28), { tone: "lo" }));
  out.push(D([at([mx, my, top + 21.6])], { size: 1, tone: "hi" }));
  return `<g class="cl-machine" data-machine="cloud" tabindex="-1">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ desktop: tower, monitor, keyboard

function desktop() {
  const out = [];
  out.push(`<path class="iso-halo" d="${k.haloOf({ x: -196, y: 98, w: 112, d: 70, r: 6 }, 0, 6, P)}"/>`);
  // monitor stand and panel
  const sx = MONITOR.x + MONITOR.w / 2;
  out.push(S(k.slabOf({ x: sx - 14, y: 114, w: 28, d: 16, r: 3 }, 0, 2, P, 4, 0.6), { tone: "lo" }));
  out.push(S(k.slabOf({ x: sx - 3, y: 108, w: 6, d: 4, r: 1 }, 2, MON_Z + 4, P, 2), { tone: "mid" }));
  out.push(S(k.slabOf(MONITOR, MON_Z, MON_H, P, 3, 0.8), { tone: "mid" }));
  const fy = MONITOR.y + MONITOR.d;
  out.push(onFront(fy, screen(MONITOR.x + 4, MON_Z + 5, MONITOR.x + MONITOR.w - 4, MON_Z + MON_H - 4, { lines: 9, id: "desktop" })));
  out.push(D([at([sx, fy, MON_Z + 2.4])], { size: 0.6, tone: "mid" }));
  // keyboard
  out.push(S(k.slabOf(DESK_KB, 0, 3, P, 3, 0.6), { tone: "mid" }));
  const keys = [];
  rows(4, DESK_KB.y + 3, 3.8).forEach((y, r) => rows(13 - (r === 3 ? 4 : 0), DESK_KB.x + 3 + (r % 2) * 1.2, 4).forEach((x, c) => {
    const w = r === 3 && c === 4 ? 16 : 3;
    keys.push(k.planOutline({ x, y, w, d: 2.8, r: 0.5 }, 3, P, 2));
  }));
  out.push(L(keys.join(""), { tone: "lo" }));
  // tower
  out.push(S(k.slabOf(k.insetPlan(TOWER, 1.5), 0, 3, P, 3), { tone: "lo" }));
  out.push(S(k.slabOf(TOWER, 3, TOWER_H, P, 3, 0.8), { tone: "mid" }));
  const ty = TOWER.y + TOWER.d;
  out.push(onFront(ty, [
    faceLine(flat(TOWER.x + 3, 8, TOWER.x + TOWER.w - 3, TOWER_H - 2, 1.4), "faint"),
    faceLine(flat(TOWER.x + 5, TOWER_H - 12, TOWER.x + TOWER.w - 5, TOWER_H - 8, 0.8, 3), "lo"),
    faceLine(rows(5, TOWER.x + 6, 3.2).map((x) => flat(x, 12, x + 1.2, 34, 0.6, 3)).join(""), "faint"),
    faceLine(k.pathOf(k.circleRing(TOWER.x + TOWER.w / 2, -(TOWER_H - 22), 3, 18), true), "lo"),
  ].join("")));
  out.push(`<g class="cl-led" data-led="desktop">${D([at([TOWER.x + TOWER.w / 2, ty, TOWER_H - 29])], { size: 0.9, tone: "hi" })}</g>`);
  const tx = TOWER.x + TOWER.w;
  out.push(onSide(tx, faceLine(rows(8, -ty + 8, 5.4).map((u) => flat(u, TOWER_H - 22, u + 2.4, TOWER_H - 6, 1, 3)).join(""), "faint")));
  out.push(onSide(tx, faceLine(flat(-ty + 6, 8, -TOWER.y - 6, 20, 2), "faint")));
  return `<g class="cl-machine" data-machine="desktop" tabindex="-1">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ laptop (a friend's machine, over the internet)

function laptop() {
  const out = [`<path class="iso-halo" d="${k.haloOf(LAP, 0, 4, P)}"/>`];
  out.push(feet(LAP, 6, 0, 1, 2));
  // lid first (it stands behind the deck)
  out.push(S(k.slabOf(LID, LAP_H - 1, LID_H, P, 3, 0.6), { tone: "mid" }));
  const ly = LID.y + LID.d;
  out.push(onFront(ly, screen(LID.x + 4, LAP_H + 4, LID.x + LID.w - 4, LAP_H + LID_H - 6, { lines: 8, id: "laptop" })));
  out.push(D([at([LID.x + LID.w / 2, ly, LAP_H + LID_H - 3.2])], { size: 0.55, tone: "mid" }));
  out.push(S(k.slabOf(LAP, 1, LAP_H - 1, P, 4, 0.8), { tone: "mid" }));
  const top = LAP_H;
  const keys = [];
  rows(5, LAP.y + 6, 4.6).forEach((y, r) => rows(r === 4 ? 9 : 14, LAP.x + 5 + (r % 2) * 1.4, 4.7).forEach((x, c) => {
    const w = r === 4 && c === 4 ? 22 : 3.8;
    if (r === 4 && c > 4) x += 18.2;
    if (x + w > LAP.x + LAP.w - 4) return;
    keys.push(k.planOutline({ x, y, w, d: 3.6, r: 0.6 }, top, P, 2));
  }));
  out.push(L(keys.join(""), { tone: "lo" }));
  out.push(L(k.planOutline({ x: LAP.x + 24, y: LAP.y + 31, w: 28, d: 14, r: 1.6 }, top, P, 3), { tone: "lo" }));
  out.push(`<g class="cl-led" data-led="laptop">${D([at([LAP.x + LAP.w - 6, LAP.y + LAP.d - 4, top])], { size: 0.7, tone: "hi" })}</g>`);
  return `<g class="cl-machine" data-machine="laptop" tabindex="-1">${out.join("")}</g>`;
}

// ------------------------------------------------------------------ assemble

const machines = [
  { id: "rack", draw: rack },
  { id: "cloud", draw: cabinet },
  { id: "desktop", draw: desktop },
  { id: "hub", draw: hub },
  { id: "router", draw: router },
  { id: "laptop", draw: laptop },
];
const centre = { rack: RACK, cloud: CAB, desktop: TOWER, hub: HUB, router: ROUTER, laptop: LAP };
machines.sort((a, b) => k.depthOf([centre[a.id].x + centre[a.id].w / 2, centre[a.id].y + centre[a.id].d / 2, 0], P) - k.depthOf([centre[b.id].x + centre[b.id].w / 2, centre[b.id].y + centre[b.id].d / 2, 0], P));

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  label:
    "Ilustração isométrica: uma bancada com o painel do Carbon no centro e, ligados a ele por cabos, um rack de servidores Linux, um desktop com monitor, um gabinete de nuvem (AgentCore) e um notebook que chega pela internet através de um roteador. Tarefas saem do painel pelos cabos até um computador livre, que acende a tela enquanto trabalha, e o resultado volta ao painel.",
  body: [plate(), cables(), `<g data-packets></g>`, ...machines.map((m) => m.draw())],
});

// screen-space polylines the packets follow, from the panel to each worker
const paths = Object.fromEntries(Object.keys(ROUTES).map((name) => [name, routePoints(name).map((p) => at(p).map((n) => +n.toFixed(1)))]));

// ------------------------------------------------------------------ live behaviour

const live = `(() => {
const PATHS = ${JSON.stringify(paths)};
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
`;

// ------------------------------------------------------------------ styles: kit CSS + site theme + figure parts

const LIGHT = k.ISO_CSS.match(/\.iso\[data-theme="light"\]\{([^}]*)\}/)?.[1];
if (!LIGHT) throw new Error("light theme block not found in ISO_CSS");
const css = `/* generated by landing/figures/cluster/build.mjs — Anatomy kit CSS (MIT) + Carbon figure */
${k.ISO_CSS}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]) .iso{${LIGHT}}}
html .cl.iso.iso{--anatomy-card:transparent;--anatomy-lit:var(--accent,#22c55e)}
.cl .iso-plate{background:transparent;box-shadow:none;padding:0}
.cl svg{display:block;width:100%;height:auto;overflow:visible}
.cl-well{fill:var(--anatomy-shade-0)}
.cl-glow{fill:var(--anatomy-lit);opacity:0;transition:opacity .5s var(--anatomy-ease)}
.cl-code{fill:none;stroke:var(--anatomy-faint);stroke-width:1.1px;stroke-linecap:round;vector-effect:non-scaling-stroke;transition:stroke .4s var(--anatomy-ease)}
.cl-bar-track{fill:none;stroke:var(--anatomy-faint);stroke-width:1.6px;vector-effect:non-scaling-stroke;stroke-linecap:round}
.cl-bar{fill:none;stroke:var(--anatomy-lit);stroke-width:1.6px;vector-effect:non-scaling-stroke;stroke-linecap:round;stroke-dasharray:1 1;stroke-dashoffset:1;opacity:0;transition:opacity .3s}
[data-busy] .cl-glow{opacity:.12}
[data-busy] .cl-code{stroke:var(--anatomy-lit)}
[data-busy] .cl-bar{opacity:1}
[data-busy] .cl-led circle{fill:var(--anatomy-lit);animation:cl-blink .5s steps(2,end) infinite}
.cl-chip{fill:var(--anatomy-faint);transition:fill .35s var(--anatomy-ease)}
.cl-chip[data-on]{fill:var(--anatomy-lit)}
.cl-machine{cursor:pointer}
.cl-machine:hover .iso-edge{stroke:var(--anatomy-hi)}
.cl-machine[data-paused]{opacity:.42;transition:opacity .4s var(--anatomy-ease)}
.cl-packet-core{fill:var(--anatomy-lit)}
.cl-packet-halo{fill:var(--anatomy-lit);opacity:.18}
.cl-packet[data-kind="branch"] .cl-packet-core{fill:var(--anatomy-strong)}
.cl-packet[data-kind="branch"] .cl-packet-halo{fill:var(--anatomy-strong);opacity:.12}
.cl-cable .iso-line{stroke-width:1.4px}
.cl-toggles{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:14px}
.cl-toggles button{font:500 12px/1 var(--mono,ui-monospace,monospace);color:var(--muted,#9b9ba3);background:transparent;border:1px solid var(--line,#26262b);border-radius:999px;padding:7px 12px;cursor:pointer}
.cl-toggles button[aria-pressed="true"]{color:var(--subtle,#6b6b73);text-decoration:line-through}
.cl-toggles button:hover{color:var(--ink,#f4f4f5);border-color:var(--muted,#9b9ba3)}
.cl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@keyframes cl-blink{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){[data-busy] .cl-led circle{animation:none}.cl-machine[data-paused]{transition:none}}
`;

const markup = `<!-- cluster-figure:start (gerado por landing/figures/cluster/build.mjs) -->
    <figure class="cl iso" data-cluster>
      <div class="iso-plate">
        <div class="iso-stage">${svg}</div>
      </div>
      <figcaption class="cl-cap">
        <div class="cl-toggles" role="group" aria-label="Pausar ou retomar um computador do cluster">
          <button type="button" data-toggle="rack" aria-pressed="false">rack Linux</button>
          <button type="button" data-toggle="desktop" aria-pressed="false">desktop</button>
          <button type="button" data-toggle="cloud" aria-pressed="false">AgentCore</button>
          <button type="button" data-toggle="laptop" aria-pressed="false">notebook de um amigo</button>
        </div>
        <p class="cl-readout mono" data-readout aria-live="off">4 computadores · 0 rodando · 0 entregues</p>
        <span class="cl-sr" role="status" aria-live="polite" data-cluster-status></span>
      </figcaption>
    </figure>
    <!-- cluster-figure:end -->`;

writeFileSync(join(LANDING, "assets", "cluster.css"), css);
writeFileSync(join(LANDING, "assets", "cluster.js"), live);
const indexPath = join(LANDING, "index.html");
const html = readFileSync(indexPath, "utf8");
const re = /<!-- cluster-figure:start[\s\S]*?<!-- cluster-figure:end -->/;
if (!re.test(html)) throw new Error("markers <!-- cluster-figure:start --> / <!-- cluster-figure:end --> not found in landing/index.html");
writeFileSync(indexPath, html.replace(re, markup));
console.log(`cluster figure: ${(svg.length / 1024).toFixed(0)} KB svg, wrote assets/cluster.css, assets/cluster.js, index.html`);
