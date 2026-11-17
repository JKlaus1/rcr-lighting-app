// The shape builder for a matrix made of LED strips (spec 4.8) and the pure helpers on its result, the "design":
//   { den, width, thick, strips: [{ n, x0, y0, x1, y1, face: "front" | "back", order }] }   (strips in wiring order; mm)
// x across, y up, origin at the lower-left corner of the box the strips fill (seen from the front); (x0, y0) and (x1, y1)
// are the centers of a strip's first and last LED. A back-face strip keeps the same x, so it sits behind its place on the front.
// The builder itself keeps a grid model (quarter steps of the LED pitch, y down, explicit wires) ported from the 0.4.9 app and
// converts to a design on Done. The helpers are pure; nothing touches the DOM at module level.
import { S } from "./store.js";
import { el, clear, button, armed, seg, chips, panel, note, numRow, slider, toast, sheet, toIn } from "./ui.js";
import { ORDERS } from "./fxdata.js";
import { saveFile } from "./system-backup.js";

// ---- pure helpers on a design ----------------------------------------------------------------------------------------
export const MAX_STRIPS = 24, MAX_LEDS = 800;
const r2 = v => Math.round(v * 100) / 100;
export const designLeds = d => ((d && d.strips) || []).reduce((a, s) => a + (s.n | 0), 0);
// The box the strips fill: half an LED pitch past each end, half the strip width to each side.
function boxOf(d) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const pitch = 1000 / (d.den || 60), w = (d.width || 10) / 2, h = pitch / 2;
  for (const s of d.strips || []) {
    const horiz = Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0), ax = horiz ? h : w, ay = horiz ? w : h;
    x0 = Math.min(x0, s.x0 - ax, s.x1 - ax); x1 = Math.max(x1, s.x0 + ax, s.x1 + ax);
    y0 = Math.min(y0, s.y0 - ay, s.y1 - ay); y1 = Math.max(y1, s.y0 + ay, s.y1 + ay);
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}
export function designSize(d) { const b = boxOf(d); return b ? { width: r2(b.x1 - b.x0), height: r2(b.y1 - b.y0) } : { width: 0, height: 0 }; }
// One [start, count, ORDER] per run of consecutive LEDs whose strip order differs from the output's (within the light).
export function designZones(d, outputOrder) {
  const z = []; let first = 0;
  for (const s of d.strips || []) {
    if (s.order && s.order !== outputOrder) {
      const last = z[z.length - 1];
      if (last && last[2] === s.order && last[0] + last[1] === first) last[1] += s.n; else z.push([first, s.n, s.order]);
    }
    first += s.n;
  }
  return z;
}
// frame = { o, u, v }: o the lower-left corner (seen from the front) in bike mm, u the unit vector across, v the unit vector up.
// A back-face strip sits `thick` behind the front face: away from the viewer of the front face, i.e. against u × v.
export function designPoints(d, frame) {
  const { o, u, v } = frame;
  let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
  const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
  const pts = []; let first = 0;
  for (const s of d.strips || []) {
    const back = s.face === "back" ? (d.thick || 0) : 0;
    const at = (px, x, y) => pts.push({ px, x: Math.round(o[0] + u[0] * x + v[0] * y - nx * back), y: Math.round(o[1] + u[1] * x + v[1] * y - ny * back), z: Math.round(o[2] + u[2] * x + v[2] * y - nz * back) });
    at(first, s.x0, s.y0);
    if (s.n > 1) at(first + s.n - 1, s.x1, s.y1);
    first += s.n;
  }
  return pts;
}
export function validDesign(d) {
  const num = (v, lo, hi) => Number.isFinite(Number(v)) && Number(v) >= lo && Number(v) <= hi;
  if (!d || typeof d !== "object" || !num(d.den, 10, 300) || !num(d.width, 3, 40) || !num(d.thick, 0, 40) || !Array.isArray(d.strips) || !d.strips.length || d.strips.length > MAX_STRIPS) return false;
  return d.strips.every(s => s && Number.isInteger(s.n) && s.n >= 1 && s.n <= MAX_LEDS && ["x0", "y0", "x1", "y1"].every(k => Number.isFinite(s[k]))
    && (s.face === "front" || s.face === "back") && (!s.order || ORDERS.includes(s.order))) && designLeds(d) <= MAX_LEDS;
}
// ---- storage on this device -------------------------------------------------------------------------------------------
const KEY = id => "rcr.shape." + id;
export function loadShape(lightId) {
  try { const t = localStorage.getItem(KEY(lightId)); if (!t) return null; const j = JSON.parse(t); return j && validDesign(j.design) ? { design: j.design, frame: j.frame || null } : null; } catch (e) { return null; }
}
export function saveShape(lightId, data) { try { localStorage.setItem(KEY(lightId), JSON.stringify({ design: data.design, frame: data.frame || null })); } catch (e) { /* storage full or off */ } }

// ---- the grid model (builder) ---------------------------------------------------------------------------------------------
// Positions are integers in quarter steps of the LED pitch on one grid seen looking at the front face (x right, y down); the Back view is
// NOT mirrored. A strip: first LED at (x, y), n LEDs along (dx, dy), on the front ("f") or back ("b") face. A wire {a, b} runs from the
// last LED of strip a to the first of strip b. The LED order is found by following the wires from the feed strip.
export const newModel = (den = 60) => ({ den, width: 10, thick: 6.4, snap: 1, cols: 16, rows: 10, feed: null, nextId: 1, strips: [], wires: [] });
const pitchOf = M => 1000 / M.den, qOf = M => pitchOf(M) / 4;
const endOf = t => ({ x: t.x + t.dx * 4 * (t.n - 1), y: t.y + t.dy * 4 * (t.n - 1) });
const byId = (M, id) => M.strips.find(t => t.id === id) || null;
const totalOf = M => M.strips.reduce((a, t) => a + t.n, 0);
function rectOf(M, t) {   // footprint in mm (grid, y down)
  const e = endOf(t), q = qOf(M), w = M.width / 2, h = pitchOf(M) / 2, ax = t.dx !== 0 ? h : w, ay = t.dy !== 0 ? h : w;
  return [Math.min(t.x, e.x) * q - ax, Math.min(t.y, e.y) * q - ay, Math.max(t.x, e.x) * q + ax, Math.max(t.y, e.y) * q + ay];
}
function clashes(M, t, skipId) {
  const a = rectOf(M, t), eps = 0.3;
  return M.strips.some(o => o.id !== skipId && o.side === t.side && (b => a[0] < b[2] - eps && a[2] > b[0] + eps && a[1] < b[3] - eps && a[3] > b[1] + eps)(rectOf(M, o)));
}
function hitAt(M, xm, ym, view) {
  for (const f of view === "b" ? ["b", "f"] : ["f", "b"]) {
    const t = M.strips.find(o => o.side === f && (r => xm >= r[0] - 1.5 && xm <= r[2] + 1.5 && ym >= r[1] - 1.5 && ym <= r[3] + 1.5)(rectOf(M, o)));
    if (t) return t;
  }
  return null;
}
// Strips in LED order, following the wires from the feed, with the index of each one's first LED.
export function orderOf(M) {
  const out = [], seen = new Set(); let cur = byId(M, M.feed), first = 0;
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); out.push({ t: cur, first }); first += cur.n; const w = M.wires.find(x => x.a === cur.id); cur = w ? byId(M, w.b) : null; }
  return out;
}
// Lay n LEDs from grid point (x, y) along (dx, dy). -> { t } or { err }
export function layStrip(M, face, x, y, dx, dy, n) {
  if (!(n >= 2)) return { err: "A strip needs at least 2 LEDs." };
  if (x < 0 || y < 0) return { err: "That start is outside the grid." };
  if (M.strips.length >= MAX_STRIPS) return { err: `At most ${MAX_STRIPS} strips on one output. This matrix has ${M.strips.length}.` };
  if (totalOf(M) + n > MAX_LEDS) return { err: `At most ${MAX_LEDS} LEDs on one output: ${totalOf(M)} so far, this strip adds ${n}.` };
  const t = { id: M.nextId, x, y, dx, dy, n, side: face, order: "" };
  const e = endOf(t);
  if (e.x < 0 || e.y < 0) return { err: "No room that way: the strip would leave the grid." };
  if (clashes(M, t)) return { err: "That would overlap another strip on this face at this strip width." };
  M.strips.push(t); M.nextId++;
  M.cols = Math.max(M.cols, Math.ceil(Math.max(t.x, e.x) / 4) + 2); M.rows = Math.max(M.rows, Math.ceil(Math.max(t.y, e.y) / 4) + 2);
  if (M.feed == null) M.feed = t.id;
  return { t };
}
// Wire the data from the end of strip a to the start of strip b. -> the reason it is refused, or ""
export function wireStrips(M, a, b) {
  if (b === M.feed) return "The feed strip comes first, so nothing wires into it. Move the feed with Set feed.";
  const next = {}; M.wires.forEach(w => { if (w.a !== a && w.b !== b) next[w.a] = w.b; });
  for (let cur = b, i = 0; cur != null && i < 200; cur = next[cur], i++) if (cur === a) return "That would make a loop.";
  M.wires = M.wires.filter(w => w.a !== a && w.b !== b).concat([{ a, b }]);
  return "";
}
function eraseStrip(M, id) { M.strips = M.strips.filter(t => t.id !== id); M.wires = M.wires.filter(w => w.a !== id && w.b !== id); if (M.feed === id) M.feed = null; }
function flipStrip(t) { const e = endOf(t); Object.assign(t, { x: e.x, y: e.y, dx: -t.dx, dy: -t.dy }); }
function moveFace(M, t) {
  const to = t.side === "f" ? "b" : "f";
  if (clashes(M, { ...t, side: to }, t.id)) return `That would overlap a strip already on the ${to === "f" ? "front" : "back"} face.`;
  t.side = to; return "";
}
// Why the shape cannot be used yet, or "".
export function checkModel(M) {
  if (!M.strips.length) return "Lay at least one strip.";
  if (M.feed == null || !byId(M, M.feed)) return "Pick the feed: the strip end where the wire from the controller connects.";
  const loose = M.strips.length - orderOf(M).length;
  if (loose) return `${loose} ${loose === 1 ? "strip is" : "strips are"} not wired in yet. Use Wire: pick the strip the data leaves, then the strip it goes to.`;
  if (totalOf(M) > MAX_LEDS) return `Over the ${MAX_LEDS}-LED limit for one output.`;
  return "";
}
// The model -> a design (wired strips only, in wiring order).
export function toDesign(M) {
  const ord = orderOf(M).map(o => o.t);
  if (!ord.length) return { den: M.den, width: M.width, thick: M.thick, strips: [] };
  const q = qOf(M), rects = ord.map(t => rectOf(M, t));
  const minX = Math.min(...rects.map(r => r[0])), maxY = Math.max(...rects.map(r => r[3]));
  return { den: M.den, width: M.width, thick: M.thick, strips: ord.map(t => {
    const e = endOf(t);
    return { n: t.n, x0: r2(t.x * q - minX), y0: r2(maxY - t.y * q), x1: r2(e.x * q - minX), y1: r2(maxY - e.y * q), face: t.side === "b" ? "back" : "front", order: t.order || "" };
  }) };
}
// A design -> a model (strips wired one after the other, the first is the feed).
export function fromDesign(d) {
  const M = newModel(d.den); M.width = d.width; M.thick = d.thick;
  const q = qOf(M), xs = d.strips.flatMap(s => [s.x0, s.x1]), ys = d.strips.flatMap(s => [s.y0, s.y1]);
  const xMin = Math.min(...xs), yMax = Math.max(...ys);
  d.strips.forEach(s => {
    const gx = Math.round((s.x0 - xMin) / q) + 4, gy = Math.round((yMax - s.y0) / q) + 4;
    const horiz = Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0);
    const t = { id: M.nextId++, x: gx, y: gy, dx: horiz ? (s.x1 >= s.x0 ? 1 : -1) : 0, dy: horiz ? 0 : (s.y1 > s.y0 ? -1 : 1), n: s.n, side: s.face === "back" ? "b" : "f", order: s.order || "" };
    M.strips.push(t);
    const e = endOf(t);
    M.cols = Math.max(M.cols, Math.ceil(Math.max(t.x, e.x) / 4) + 2); M.rows = Math.max(M.rows, Math.ceil(Math.max(t.y, e.y) / 4) + 2);
  });
  M.feed = M.strips[0].id;
  for (let i = 1; i < M.strips.length; i++) M.wires.push({ a: M.strips[i - 1].id, b: M.strips[i].id });
  return M;
}

// ---- the builder screen ----------------------------------------------------------------------------------------------------
const TOOLS = [
  ["lay", "Lay strip", "Pick a start cell (click the grid or type it below), a direction and a length. It snaps to whole LEDs."],
  ["flip", "Flip direction", "Pick a strip (on the grid or in the list) to swap its data-in end to the other side."],
  ["feed", "Set feed", "Pick the strip the controller wire goes to. Its arrow end becomes LED 0."],
  ["wire", "Wire", "Pick the strip the data leaves (from its far end), then the strip it enters (at its arrow end). Any strip to any strip, in the order you will solder them."],
  ["erase", "Erase", "Pick a strip to remove it and its jumpers."],
  ["face", "Front / back", "Pick a strip to move it between the front face and the back face of the plate."],
  ["order", "Color order", "Pick a strip to set the color order of its LEDs. Strips from different vendors can differ."],
];
const DIRS = [["right", "Right", 1, 0], ["left", "Left", -1, 0], ["down", "Down", 0, 1], ["up", "Up", 0, -1]];
const DENS = [30, 60, 96, 144];
const dirText = t => (t.dx > 0 ? "across, left to right" : t.dx < 0 ? "across, right to left" : t.dy > 0 ? "down" : "up");
const inch = mm => toIn(mm).toFixed(1) + " in";

// openShape(ref, { design, onDone, onCancel, outputOrder }): the builder opens in the sheet area (wide on a PC).
// ref ({ out, k }) is only used to read the output's color order; a new light passes null.
export function openShape(ref, { design, onDone, onCancel, outputOrder } = {}) {
  const M = design && validDesign(design) ? fromDesign(design) : newModel(60);
  const U = { tool: "lay", pend: null, view: "f", msg: "", bad: false, sel: null, cell: 0 };
  let finished = false;
  const outOrder = () => outputOrder || (ref && S.settings && S.settings.strips[ref.out] && S.settings.strips[ref.out].order) || "GRB";
  const sh = sheet({ title: "Matrix shape", sub: "", onClose: replaced => { if (!finished && !replaced && onCancel) onCancel(); } });
  sh.el.classList.add("matrix-sheet");
  const body = sh.body; body.classList.add("mx"); body.id = "mxRoot";

  // -- grid settings --
  const densChips = chips(DENS.map(d => [d, String(d)]), M.den, v => { M.den = v; paint(); }, { id: "mx-dens" });
  const densNum = numRow("LEDs per meter", M.den, { min: 10, max: 300, step: 1, id: "mx-dens-num", onCommit: v => { M.den = v; paint(); } });
  const widthS = slider("Strip width", M.width, { min: 5, max: 15, step: 1, unit: "mm", id: "mx-width", onInput: v => { M.width = v; paint(); } });
  const thickN = numRow("Plate thickness", M.thick, { min: 0, max: 40, step: 0.1, unit: "mm", id: "mx-thick", onCommit: v => { M.thick = v; paint(); } });
  const snapSeg = seg([[1, "Whole LED"], [2, "Half"], [4, "Quarter"]], M.snap, v => { M.snap = v; U.pend = null; paint(); }, { id: "mx-snap" });
  const gridCard = panel("Grid",
    el("div", { class: "pad" }, note("LEDs per meter sets the grid spacing, both ways. For a strip with several LEDs per pixel, count pixels per meter."), densChips.el),
    densNum.el, widthS.el, thickN.el,
    el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Placement step")), snapSeg.el));

  // -- tools, views, zoom --
  const toolChips = chips(TOOLS.map(t => [t[0], t[1]]), U.tool, v => { U.tool = v; U.pend = null; U.msg = ""; paint(); }, { id: "mx-tools" });
  const viewSeg = seg([["f", "Front"], ["b", "Back"], ["both", "Both"]], U.view, v => { U.view = v; U.pend = null; paint(); }, { id: "mx-view" });
  const zoomTxt = el("span", { class: "note", id: "mx-zoom-txt" });
  const zoomBy = f => () => { U.cell = Math.min(90, Math.max(12, Math.round(cellNow() * f))); paint(); };
  const hintT = el("b", {}), hintX = el("span", { class: "note" });

  // -- the grid --
  const svgBox = el("div", { class: "mx-svg" }), lbls = el("div", { class: "mx-lbls" });
  const over = el("button", { type: "button", class: "mx-over", id: "mxGrid", "aria-label": "Matrix grid. Click grid points to use the selected tool." });
  const gbox = el("div", { class: "mx-grid", id: "mx-gridbox" }, svgBox, lbls, over);
  const scroll = el("div", { class: "mx-scroll", id: "mxScroll" }, gbox);
  const vbOf = () => { const p = pitchOf(M), m = Math.max(16, p * 1.4); return { p, x: -m, y: -m, w: (M.cols - 1) * p + 2 * m, h: (M.rows - 1) * p + 2 * m }; };
  function cellNow() { const g = vbOf(); return U.cell || Math.max(24, scroll.clientWidth ? Math.floor(scroll.clientWidth / (g.w / g.p)) : 24); }
  over.addEventListener("click", e => {
    const g = vbOf(), r = over.getBoundingClientRect(); if (!r.width || !r.height) return;
    gridAct(g.x + (e.clientX - r.left) / r.width * g.w, g.y + (e.clientY - r.top) / r.height * g.h);
    paint();
  });
  function say(m, bad = true) { U.msg = m; U.bad = bad; }
  function gridAct(xm, ym) {
    const q = qOf(M), step = 4 / M.snap, ux = Math.round(xm / q / step) * step, uy = Math.round(ym / q / step) * step;
    U.msg = ""; U.bad = false;
    if (U.tool === "lay") {
      const face = U.view === "b" ? "b" : "f";
      if (!U.pend) { if (ux < 0 || uy < 0) return; U.pend = { x: ux, y: uy }; return; }
      const ddx = xm - U.pend.x * q, ddy = ym - U.pend.y * q, horiz = Math.abs(ddx) >= Math.abs(ddy), d = horiz ? ddx : ddy;
      const n = Math.round(Math.abs(d) / pitchOf(M)) + 1;
      if (n < 2) { U.pend = null; return; }
      const r = layStrip(M, face, U.pend.x, U.pend.y, horiz ? (d > 0 ? 1 : -1) : 0, horiz ? 0 : (d > 0 ? 1 : -1), n);
      if (r.err) say(r.err); else U.pend = null;
      return;
    }
    const hit = hitAt(M, xm, ym, U.view); if (hit) useTool(hit);
  }
  // One tool applied to one strip (from the grid or from the list).
  function useTool(t) {
    U.msg = ""; U.bad = false;
    if (U.tool === "flip") flipStrip(t);
    else if (U.tool === "feed") { M.feed = t.id; M.wires = M.wires.filter(w => w.b !== t.id); }
    else if (U.tool === "order") U.sel = t.id;
    else if (U.tool === "erase") { eraseStrip(M, t.id); U.pend = null; if (U.sel === t.id) U.sel = null; }
    else if (U.tool === "face") { const e = moveFace(M, t); say(e || `Strip moved to the ${t.side === "f" ? "front" : "back"} face.`, !!e); }
    else if (U.tool === "wire") {
      if (!U.pend) { U.pend = { id: t.id }; }
      else if (U.pend.id === t.id) U.pend = null;
      else { const e = wireStrips(M, U.pend.id, t.id); if (e) say(e); U.pend = null; }
    }
    else if (U.tool === "lay") U.sel = t.id;
    paint();
  }

  // -- the typed way to lay a strip --
  const fCol = numRow("Start column", 1, { min: 0, max: 63, step: 1, id: "mx-lay-col" }), fRow = numRow("Start row", 1, { min: 0, max: 63, step: 1, id: "mx-lay-row" });
  let dirNow = "right";
  const fDir = chips(DIRS.map(d => [d[0], d[1]]), "right", v => { dirNow = v; }, { id: "mx-lay-dir" });
  const fLen = numRow("LEDs", 12, { min: 2, max: MAX_LEDS, step: 1, id: "mx-lay-n" });
  const layBtn = button("Lay strip", { kind: "primary", id: "mx-lay-go", onClick: () => {
    const d = DIRS.find(x => x[0] === dirNow), face = U.view === "b" ? "b" : "f";
    const r = layStrip(M, face, Math.round(Number(fCol.input.value) || 0) * 4, Math.round(Number(fRow.input.value) || 0) * 4, d[2], d[3], Math.round(Number(fLen.input.value) || 0));
    U.msg = ""; if (r.err) say(r.err); else say(`Strip ${M.strips.length} laid on the ${face === "b" ? "back" : "front"} face.`, false);
    paint();
  } });
  const layCard = el("div", { class: "panel mx-lay", id: "mx-lay-card" }, el("div", { class: "ptitle" }, "Lay a strip by numbers"),
    fCol.el, fRow.el, el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Direction")), fDir.el), fLen.el,
    el("div", { class: "field" }, layBtn, el("div", { class: "hint" }, "Column and row count LEDs from the top left of the grid. New strips go on the face shown.")));

  // -- color order of the picked strip --
  const ordCard = el("div", { class: "panel", id: "mx-ord-card", hidden: true });
  function paintOrder() {
    ordCard.hidden = U.tool !== "order"; if (ordCard.hidden) return;
    clear(ordCard); ordCard.append(el("div", { class: "ptitle" }, "Color order"));
    const t = byId(M, U.sel);
    if (!t) { ordCard.append(el("div", { class: "pad" }, note("Pick a strip on the grid or in the list."))); return; }
    const sel = el("select", { id: "mx-ord-sel", "aria-label": "Color order of this strip", onchange: () => { t.order = sel.value; paint(); } },
      el("option", { value: "" }, `Same as the output (${outOrder()})`), ORDERS.map(o => el("option", { value: o }, o)));
    sel.value = t.order || "";
    ordCard.append(el("div", { class: "field inline" }, el("span", { class: "lbl" }, el("b", {}, `Strip ${M.strips.indexOf(t) + 1}`)), sel),
      el("div", { class: "field" }, el("div", { class: "btns two" }, [["f", "front"], ["b", "back"]].map(([f, n]) => button(`Use for every ${n} strip`, { small: true, data: { all: f },
        onClick: () => { M.strips.forEach(x => { if (x.side === f) x.order = t.order; }); paint(); } })))));
  }

  // -- the strip list (LED order), files, status --
  const list = el("ul", { class: "mx-list", id: "mxOrder" });
  const status = el("p", { id: "mxStatus", class: "mx-status", role: "status" }), msg = el("p", { id: "mxMsg", class: "mx-msg", role: "status" });
  const stats = el("div", { class: "mx-stats", id: "mxStats" });
  const fileIn = el("input", { type: "file", id: "mx-load", accept: ".json,application/json", "aria-label": "Load a shape file",
    onchange: () => {
      const f = fileIn.files && fileIn.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => {
        let j = null; try { j = JSON.parse(String(rd.result)); } catch (e) { /* below */ }
        const d = j && (j.design || j);
        if (!validDesign(d)) { say("That file is not a matrix shape."); paint(); return; }
        const m2 = fromDesign(d); for (const k of Object.keys(M)) delete M[k]; Object.assign(M, m2);
        densChips.set(M.den); densNum.set(M.den); widthS.set(M.width); thickN.set(M.thick); snapSeg.set(M.snap);
        U.pend = null; say("Shape loaded.", false); paint();
      };
      rd.onerror = () => { say("That file could not be read."); paint(); };
      rd.readAsText(f); fileIn.value = "";
    } });
  const saveBtn = button("Save shape to a file", { id: "mx-save", onClick: () => {
    const why = checkModel(M); if (why) { toast(why, "warn"); return; }
    saveFile("matrix-shape.json", JSON.stringify({ app: "rcr-lighting-matrix", version: 2, design: toDesign(M) }, null, 1));
  } });
  const clearW = button("Clear the wiring", { small: true, id: "mx-clear-wires", onClick: () => { M.wires = []; U.pend = null; paint(); } });
  const clearA = armed(button("Clear everything", { small: true, kind: "danger", id: "mx-clear-all" }), "Tap again to clear", () => { M.strips = []; M.wires = []; M.feed = null; U.pend = null; U.msg = ""; paint(); });
  const doneBtn = button("Done", { kind: "primary", id: "mx-done", onClick: () => {
    const why = checkModel(M); if (why) { toast(why, "warn"); return; }
    const d = toDesign(M); finished = true; sh.close(); if (onDone) onDone(d);
  } });
  const cancelBtn = button("Cancel", { id: "mx-cancel", onClick: () => sh.close() });
  const loadLabel = el("label", { class: "btn", id: "mx-load-label" }, "Load a shape file", fileIn);
  const colsN = numRow("Grid columns", M.cols, { min: 4, max: 64, step: 1, id: "mx-cols", onCommit: v => { M.cols = v; paint(); } });
  const rowsN = numRow("Grid rows", M.rows, { min: 2, max: 64, step: 1, id: "mx-rows", onCommit: v => { M.rows = v; paint(); } });

  const mainCol = el("div", { class: "mx-main" },
    el("div", { class: "mx-hint", role: "status", id: "mxHint" }, hintT, hintX),
    toolChips.el,
    el("div", { class: "mx-row" }, viewSeg.el, el("div", { class: "mx-zoom" }, button("Zoom −", { small: true, id: "mx-zoom-out", onClick: zoomBy(1 / 1.25) }), button("Zoom +", { small: true, id: "mx-zoom-in", onClick: zoomBy(1.25) }), zoomTxt)),
    scroll,
    note("Green arrow: data-in end and direction. Green ring: the feed. Blue line: a wire between strips. Dashed outline with ring LEDs: a strip on the back face. Orange: not wired in yet. The number on a strip is the index of its first LED. The back face is drawn as seen from the front: the grid is not mirrored."));
  const sideCol = el("div", { class: "mx-side" },
    panel("LED order", list),
    status, msg, stats,
    layCard, ordCard, gridCard,
    panel("Grid size", colsN.el, rowsN.el),
    el("div", { class: "btns two" }, saveBtn, loadLabel),
    el("div", { class: "btns two" }, clearW, clearA),
    el("div", { class: "btns two mx-final" }, cancelBtn, doneBtn));
  body.append(mainCol, sideCol);

  // -- drawing --
  function drawGrid() {
    const g = vbOf(), q = qOf(M), u = g.p, f = v => v.toFixed(1), rad = Math.max(1.3, Math.min(3.4, u * 0.24));
    const dot = (x, y, r) => `M${f(x - r)} ${f(y)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0`;
    const reached = new Map(orderOf(M).map(o => [o.t.id, o]));
    let gridD = ""; for (let r = 0; r < M.rows; r++) for (let c = 0; c < M.cols; c++) gridD += dot(c * u, r * u, Math.max(0.7, u * 0.06));
    const G = {};
    const grp = t => { const k = t.side + (U.view === "both" || t.side === U.view ? "" : "g"); return G[k] || (G[k] = { tape: "", bad: "", led: "", arrow: "" }); };
    M.strips.forEach(t => {
      const e = endOf(t), x0 = t.x * q, y0 = t.y * q, x1 = e.x * q, y1 = e.y * q, h = u / 2, S2 = grp(t);
      const segD = `M${f(x0 - t.dx * h)} ${f(y0 - t.dy * h)}L${f(x1 + t.dx * h)} ${f(y1 + t.dy * h)}`;
      if (reached.has(t.id)) S2.tape += segD; else S2.bad += segD;
      for (let i = 1; i < t.n; i++) S2.led += dot(x0 + t.dx * u * i, y0 + t.dy * u * i, rad);
      const a = Math.min(u * 0.4, M.width * 0.55);
      S2.arrow += `M${f(x0 + t.dx * a)} ${f(y0 + t.dy * a)}L${f(x0 - t.dx * a * 0.7 - t.dy * a * 0.8)} ${f(y0 - t.dy * a * 0.7 + t.dx * a * 0.8)}L${f(x0 - t.dx * a * 0.7 + t.dy * a * 0.8)} ${f(y0 - t.dy * a * 0.7 - t.dx * a * 0.8)}Z`;
    });
    let svg = `<path d="${gridD}" fill="currentColor" opacity=".35"/>`;
    ["bg", "fg", "b", "f"].forEach(k => {
      const G2 = G[k]; if (!G2) return;
      const back = k[0] === "b", dash = back ? ' stroke-dasharray="5 4"' : "";
      svg += `<g${k.length > 1 ? ' opacity=".3"' : ""}>`
        + (G2.tape ? `<path d="${G2.tape}" fill="none" stroke="${back ? "#2f6fb0" : "#59636e"}" stroke-width="${M.width}"${dash}/>` : "")
        + (G2.bad ? `<path d="${G2.bad}" fill="none" stroke="#b9770e" stroke-width="${M.width}"${dash}/>` : "")
        + (back ? `<path d="${G2.led}" fill="none" stroke="#9fd4ff" stroke-width="${f(Math.max(0.5, rad * 0.45))}"/>` : `<path d="${G2.led}" fill="#ffffff"/>`)
        + `<path d="${G2.arrow}" fill="#2fbf68"/></g>`;
    });
    let wires = "";
    M.wires.forEach(w => { const a = byId(M, w.a), b = byId(M, w.b); if (!a || !b) return; const e = endOf(a); wires += `M${f(e.x * q)} ${f(e.y * q)}L${f(b.x * q)} ${f(b.y * q)}`; });
    svg += `<path d="${wires}" fill="none" stroke="#3d8bff" stroke-width="${f(Math.max(0.9, u * 0.1))}" stroke-linecap="round"/>`;
    const ring = (x, y, r, c) => `<path d="${dot(x * q, y * q, r)}" fill="none" stroke="${c}" stroke-width="${f(Math.max(0.9, u * 0.1))}"/>`;
    const feed = byId(M, M.feed);
    if (feed) svg += ring(feed.x, feed.y, u * 0.5, "#2fbf68");
    if (U.pend && U.tool === "lay") svg += ring(U.pend.x, U.pend.y, u * 0.42, "#ffa41b");
    if (U.pend && U.tool === "wire") { const p = byId(M, U.pend.id); if (p) { const e = endOf(p); svg += ring(e.x, e.y, u * 0.42, "#ffa41b"); } }
    svgBox.innerHTML = `<svg id="mxSvg" aria-hidden="true" viewBox="${f(g.x)} ${f(g.y)} ${f(g.w)} ${f(g.h)}" preserveAspectRatio="none">${svg}</svg>`;
    gbox.style.aspectRatio = `${g.w.toFixed(1)} / ${g.h.toFixed(1)}`;
    const cell = cellNow(); gbox.style.width = (g.w / g.p * cell).toFixed(0) + "px"; zoomTxt.textContent = `${cell} px per LED`;
    const pct = (v, o, s) => ((v - o) / s * 100).toFixed(2) + "%";
    clear(lbls);
    M.strips.filter(t => U.view === "both" || t.side === U.view).forEach(t => {
      const o = reached.get(t.id), isFeed = t.id === M.feed;
      lbls.append(el("span", { class: "mx-lbl" + (o ? (isFeed ? " feed" : "") : " loose"), "data-mx-label": t.id, style: `left:${pct(t.x * q, g.x, g.w)};top:${pct(t.y * q, g.y, g.h)}` },
        (o ? (isFeed ? "Feed · 0" : String(o.first)) : "not wired") + (t.side === "b" ? " · back" : "") + (t.order && t.order !== outOrder() ? " · " + t.order : "")));
    });
  }
  function paintList() {
    clear(list);
    const ord = orderOf(M), reached = new Set(ord.map(o => o.t.id)), loose = M.strips.filter(t => !reached.has(t.id));
    const rowFor = (t, first, i) => {
      const picked = (U.pend && U.pend.id === t.id) || U.sel === t.id;
      return el("li", {}, el("button", { type: "button", class: "mx-order-row" + (first == null ? " loose" : ""), "aria-pressed": String(!!picked), "data-strip": t.id, onclick: () => useTool(t) },
        el("span", { class: "n" }, first == null ? "–" : String(i + 1)),
        el("span", {}, `${t.n} LEDs ${dirText(t)}${t.side === "b" ? " · back" : ""}` + (first == null ? " · not wired in" : ` · LEDs ${first} to ${first + t.n - 1}`))));
    };
    ord.forEach((o, i) => list.append(rowFor(o.t, o.first, i)));
    loose.forEach(t => list.append(rowFor(t, null)));
    if (!M.strips.length) list.append(el("li", { class: "note pad" }, "No strips yet."));
  }
  function paint() {
    const cur = TOOLS.find(t => t[0] === U.tool);
    toolChips.set(U.tool); viewSeg.set(U.view);
    hintT.textContent = cur[1] + ". ";
    hintX.textContent = U.tool === "lay" && U.pend ? "Start point set (orange ring). Now click toward the end: left, right, up or down. Click the start again to cancel."
      : U.tool === "wire" && U.pend ? "The wire starts at the far end of the picked strip. Now pick the strip it goes to. Pick the same strip again to cancel." : cur[2];
    layCard.hidden = U.tool !== "lay";
    drawGrid(); paintList(); paintOrder();
    const why = checkModel(M), total = totalOf(M), wired = orderOf(M).reduce((a, o) => a + o.t.n, 0);
    status.textContent = !M.strips.length ? "Empty grid. Lay a strip: click where it starts and where it ends, or type it below." : why || `All wired. The LEDs count 0 to ${total - 1} in the order listed.`;
    status.className = "mx-status" + (!M.strips.length ? "" : why ? " bad" : " good");
    msg.textContent = U.msg; msg.className = "mx-msg" + (U.msg ? (U.bad ? " bad" : " good") : "");
    const nf = M.strips.filter(t => t.side === "f").length;
    const sz = designSize(toDesignLoose(M));
    clear(stats);
    [["Strips", `${M.strips.length} (${nf} front, ${M.strips.length - nf} back)`], [`LEDs (limit ${MAX_LEDS})`, `${total}` + (wired !== total ? `, ${wired} wired` : "")],
      ["Lit area", M.strips.length ? `${inch(sz.width)} × ${inch(sz.height)}` : "0.0 in × 0.0 in"]].forEach(([k, v]) => stats.append(el("div", {}, el("span", { class: "note" }, k), el("b", {}, v))));
    sh.setSub(`${M.strips.length} ${M.strips.length === 1 ? "strip" : "strips"} · ${total} LEDs`);
    doneBtn.disabled = !!why;
    densChips.set(M.den); densNum.set(M.den); colsN.set(M.cols); rowsN.set(M.rows);
  }
  paint();
  return { close() { sh.close(); }, model: M };
}
// The size card also counts strips that are not wired yet: a design of every strip, in laying order.
function toDesignLoose(M) {
  const q = qOf(M), rects = M.strips.map(t => rectOf(M, t));
  if (!rects.length) return { den: M.den, width: M.width, thick: M.thick, strips: [] };
  const minX = Math.min(...rects.map(r => r[0])), maxY = Math.max(...rects.map(r => r[3]));
  return { den: M.den, width: M.width, thick: M.thick, strips: M.strips.map(t => { const e = endOf(t); return { n: t.n, x0: t.x * q - minX, y0: maxY - t.y * q, x1: e.x * q - minX, y1: maxY - e.y * q, face: t.side === "b" ? "back" : "front", order: t.order || "" }; }) };
}
