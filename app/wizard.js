// Add a light (spec 3.5): a full-screen flow in the sheet area. Also home of the LED finder, which the Wiring tab reuses.
//
// The finder works by growing the output: `px` is raised past the last light, one test LED is lit with `find`, and
// leaving the flow in any way puts `px` (and, on a free output, the LED type) back. The lights already on the output
// are never touched by it.
import { S, on, op, send } from "./store.js";
import { el, clear, button, chips, selectRow, numRow, slider, panel, note, toast, sheet, sheetChanged, icon, clamp } from "./ui.js";
import { lightsOf, allLights, usedOf, canAdd, templateSections, newLightId, isLampOut, LIMITS } from "./lights.js";
import { KINDS, KIND_BY, CHIPS, CHIP_BY, chipLabel, kindDefaults, WIZARD_TILES, JACKS, ORDERS, OUT_MODES } from "./fxdata.js";
import * as MATRIX from "./matrix.js";
import { openLight } from "./sheet.js";

// The matrix builder is another module's work: tests swap it here for a fake.
export const seams = { matrix: MATRIX };

const wrapStrip = (i, o) => ({ strips: [...Array(i).fill(null), o] });
const stripOf = i => (S.settings && S.settings.strips ? S.settings.strips[i] : null);
const usedOn = st => (lightsOf(st).length ? usedOf(st) : st.px | 0);

// ---- the finder -------------------------------------------------------------------------------------------
// start: the output's LED where the run being measured begins (0-based); n: where to begin counting.
// open / close: strip fields to set while it runs and to put back when it stops (px is added to both).
// grow false: the run is already inside the output (the "middle" finder): nothing is patched.
export function createFinder({ out, start, n = 1, open = {}, close = {}, grow = true, max }) {
  const limit = LIMITS.px - start;
  const F = { out, start, limit, active: false, subs: new Set() };
  F.test = grow ? Math.min(limit, Math.max(300, n)) : max;
  F.n = clamp(Math.round(n), 1, Math.max(1, F.test));
  let timer = 0;
  const line = () => `find ${out + 1} ${start + F.n - 1}`;
  const tell = () => F.subs.forEach(f => f());
  F.begin = () => {
    if (F.active) return;
    F.active = true;
    if (grow) op.set(wrapStrip(out, { ...open, px: start + F.test }));
    send(line());
    tell();
  };
  F.resume = () => { if (F.active) send(line()); };
  F.set = v => {
    F.n = clamp(Math.round(v), 1, F.test);
    tell();
    clearTimeout(timer);
    timer = setTimeout(() => { if (F.active) send(line()); }, 100);   // a slider drag is many moves: one `find` per pause
  };
  F.more = () => {
    if (!grow || F.test >= limit) return;
    F.test = limit;
    op.set(wrapStrip(out, { px: start + F.test }));
    tell();
  };
  F.stop = () => {
    if (!F.active) return;
    F.active = false;
    clearTimeout(timer);
    send("find off");
    if (grow && S.settings) op.set(wrapStrip(out, { ...close }));
    tell();
  };
  return F;
}
// The slider, Back one / Forward one and the "more than 300" button for a finder.
export function finderPanel(F, { lastLabel = "That's the last one", onLast, what = "of this light", extra } = {}) {
  const big = el("div", { class: "wz-big", id: "wzFindN" });
  const abs = el("div", { class: "note", id: "wzFindAbs" });
  const sl = slider("Lit LED", F.n, { min: 1, max: F.test, step: 1, id: "wzFindSlider", onInput: v => F.set(v) });
  const back = button("Back one", { id: "wzBack1", onClick: () => F.set(F.n - 1) });
  const fwd = button("Forward one", { id: "wzFwd1", onClick: () => F.set(F.n + 1) });
  const more = button("", { id: "wzMore", onClick: () => F.more() });
  const paint = () => {
    big.textContent = `LED ${F.n} ${what}`;
    abs.textContent = `LED ${F.start + F.n} on output ${F.out + 1}`;
    sl.input.max = F.test; sl.set(F.n);
    more.hidden = !(F.test < F.limit && F.limit > 0);
    more.textContent = `My light has more than ${F.test} LEDs`;
  };
  F.subs.add(paint);
  paint();
  const last = button(lastLabel, { kind: "primary", id: "wzLast", onClick: () => onLast && onLast(F.n) });
  const box = el("div", { class: "wz-card wz-find" }, big, abs, sl.el, el("div", { class: "btns two" }, back, fwd), more);
  return { el: el("div", { class: "wz-col" }, box, last, extra || null), destroy: () => F.subs.delete(paint) };
}

// ---- the flow -----------------------------------------------------------------------------------------------
let W = null;   // the open flow, or null
// The output a flow is currently growing with test LEDs (-1: none), so the Bike screen does not call it "set up before".
export const addingOn = () => (W && W.F && W.F.active ? W.out : -1);

const STEP_LABEL = { kind: "What it is", where: "Where it is plugged in", count: "How many LEDs", mid: "Find the middle", what: "What it does", job: "What the lamp does", summary: "Summary" };
const stepsOf = w => (w.tile === "bar" ? ["kind", "where", "count", "mid", "what", "summary"] : w.tile === "lamp" ? ["kind", "where", "job", "summary"]
  : ["kind", "where", "count", "what", "summary"]);
const FINDER_TILES = ["bar", "strip", "ring"];
const LAMP_JOBS = [["turn_l", "Left turn"], ["turn_r", "Right turn"], ["brake", "Brake"], ["running", "Running light"], ["always", "Always on"]];
const TILE_TEXT = { bar: "Front or rear: turn signals at the ends, DRL or tail and brake between" };
const kindName = w => (w.tile === "bar" ? w.barKind : w.tile === "strip" ? "glow" : w.tile);
const BASE_NAME = { front: "Front bar", rear: "Rear bar", glow: "Strip", ring: "Ring", matrix: "Matrix", string: "Light string" };
const DEN_DEFAULT = { front: 144, rear: 144, string: 10, glow: 144, ring: 0, matrix: 0 };

function uniqueName(base) {
  const taken = new Set(allLights(S.settings).map(l => String(l.name).toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const suffix = " " + i, cand = base.slice(0, LIMITS.name - suffix.length) + suffix;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
  return base;
}
function svgPath(d, size = 26) {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 1.8, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) s.setAttribute(k, v);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path"); p.setAttribute("d", d); s.append(p);
  return s;
}

// Can this output take the thing being added? -> { ok, why }
function outputOk(w, i) {
  const st = stripOf(i);
  if (!st) return { ok: false, why: "Not available" };
  if (w.tile === "lamp") {
    if (isLampOut(st)) return { ok: false, why: "Already drives a 12 V lamp" };
    if (lightsOf(st).length || (st.px | 0) > 0 || (st.seg || []).length) return { ok: false, why: "Already has LEDs on it" };
    return { ok: true, why: "" };
  }
  return canAdd(st, { n: 1, sections: w.tile === "bar" ? 3 : 1 });
}
// LED types this output can take: any on a free output, else the ones that share its data speed and bytes per LED.
function chipOptions(i) {
  const st = stripOf(i);
  if (!st || !lightsOf(st).length) return CHIPS;
  return CHIPS.filter(c => c.timing === st.timing && !!c.rgbw === !!st.rgbw);
}
function defaultChip(w, i) {
  const opts = chipOptions(i), st = stripOf(i);
  if (w.tile === "string" && opts.some(c => c.key === "ws2811_12v")) return "ws2811_12v";
  return opts.some(c => c.key === st.chip) ? st.chip : opts[0].key;
}

export function startAddLight({ out = 0 } = {}) {
  if (!S.settings) return null;
  if (W) endFlow(W);
  const me = W = { out, tile: null, chip: null, chipTouched: false, n: 0, den: 0, denTouched: false, mid: null, feed: "right", barKind: "front",
    name: "", nameTouched: false, order: null, design: null, job: "turn_l", step: "kind", sh: null, F: null, M: null, finished: false, shapeOpen: false, offs: [] };
  me.offs.push(on("phase", () => { if (S.phase !== "ready" && W === me) cancel(me); }));
  ensureSheet(me);
  render(me);
  return me.sh;
}

function ensureSheet(w) {
  if (w.sh && w.sh.el.isConnected) return;
  w.sh = sheet({ title: "Add a light", sub: "", depth: () => Math.max(0, stepsOf(w).indexOf(w.step)) + 1, onClose: replaced => {
    if (replaced && w.shapeOpen) { w.sh = null; return; }   // the shape builder took the place: come back when it is done
    endFlow(w);
  } });
  // The header's back arrow steps back through the flow (and leaves it from the first step).
  const old = w.sh.el.querySelector("#sheetClose");
  const nb = old.cloneNode(true);
  old.replaceWith(nb);
  nb.addEventListener("click", () => back(w));
  w.body = w.sh.body;
}
function cancel(w) { if (w.sh && w.sh.el.isConnected) w.sh.close(); else endFlow(w); }
// Whatever way the flow ends, the output goes back to what it was.
function endFlow(w) {
  stopFinders(w);
  w.offs.forEach(f => f()); w.offs = [];
  if (W === w) W = null;
}
function stopFinders(w) {
  if (w.M) { w.M.stop(); w.M = null; }
  if (w.F) { w.F.stop(); w.F = null; }
}
function goStep(w, id) {
  if (id !== "count" && id !== "mid") stopFinders(w);
  else if (id === "count" && w.M) { w.M.stop(); w.M = null; }
  w.step = id;
  render(w);
}
function back(w) {
  const steps = stepsOf(w), i = steps.indexOf(w.step);
  if (i <= 0) cancel(w); else goStep(w, steps[i - 1]);
}
const next = w => { const s = stepsOf(w); goStep(w, s[s.indexOf(w.step) + 1]); };

function render(w) {
  if (W !== w) return;
  ensureSheet(w);
  const steps = stepsOf(w), i = steps.indexOf(w.step);
  w.sh.setSub(`Step ${i + 1} of ${steps.length} · ${STEP_LABEL[w.step]}`);
  w.sh.el.dataset.step = w.step;
  clear(w.body);
  const draw = { kind: stepKind, where: stepWhere, count: stepCount, mid: stepMid, what: stepWhat, job: stepJob, summary: stepSummary }[w.step];
  if (w.panelPart) { w.panelPart.destroy(); w.panelPart = null; }
  draw(w, w.body);
  w.body.scrollTop = 0;
  sheetChanged();   // the step may have changed: the back button's depth follows it
}
const h = text => el("h3", { class: "wz-h" }, text);
function footer(w, { nextLabel = "Next", nextOk = true, onNext, nextId = "wzNext" } = {}) {
  return el("div", { class: "wz-foot" }, button(nextLabel, { kind: "primary", id: nextId, disabled: !nextOk, onClick: onNext || (() => next(w)) }),
    button("Cancel", { kind: "ghost", id: "wzCancel", onClick: () => cancel(w) }));
}

// ---- 1. what is it ---------------------------------------------------------------------------------------------
function stepKind(w, body) {
  body.append(h("What are you adding?"));
  const grid = el("div", { class: "wz-tiles" });
  for (const [tile, label] of WIZARD_TILES) {
    const k = KINDS.find(x => x.tile === tile);
    grid.append(el("button", { type: "button", class: "tile wz-tile", id: `wzTile-${tile}`, "data-tile": tile, "aria-pressed": String(w.tile === tile),
      onclick: () => { if (w.tile !== tile) { w.tile = tile; w.n = 0; w.design = null; w.mid = null; w.nameTouched = false; w.denTouched = false; w.chipTouched = false; } render(w); } },
      svgPath(k.icon), el("b", {}, label), el("small", {}, TILE_TEXT[tile] || k.description)));
  }
  body.append(grid, footer(w, { nextOk: !!w.tile }));
}

// ---- 2. where it is plugged in ---------------------------------------------------------------------------------
function stepWhere(w, body) {
  body.append(h("Where is it plugged in?"));
  body.append(note(w.tile === "lamp" ? "A 12 V lamp needs an output of its own." : "Pick any output. On one that is already in use, the new light goes on the end of the chain: its data wire comes from the last light there."));
  const list = el("div", { class: "wz-outs" });
  const sts = S.settings.strips;
  if (!outputOk(w, w.out).ok) { const hit = sts.findIndex((_, i) => outputOk(w, i).ok); if (hit >= 0) w.out = hit; }
  sts.forEach((st, i) => {
    const v = outputOk(w, i), L = lightsOf(st), used = usedOn(st);
    const chain = L.length ? [...L.map(l => l.name || "Light"), "new light"].join(" → ") : isLampOut(st) ? (OUT_MODES.find(m => m[0] === st.out) || [0, "12 V lamp"])[1] : "Nothing yet → new light";
    const start = L.length ? `Starts at LED ${used + 1}, after ${L[L.length - 1].name || "the last light"}` : "Starts at LED 1";
    list.append(el("button", { type: "button", class: "tile wz-out", id: `wzOut-${i}`, "data-out": i, disabled: !v.ok, "aria-pressed": String(w.out === i && v.ok),
      onclick: () => { w.out = i; w.chipTouched = false; render(w); } },
      el("span", { class: "r1" }, el("b", {}, `Output ${i + 1} · plug ${JACKS[i]}`), el("small", {}, isLampOut(st) ? "" : `${LIMITS.px - used} LEDs free`)),
      el("span", { class: "r2" }, chain), el("small", { class: v.ok ? "" : "why" }, v.ok ? (isLampOut(st) ? "" : start) : v.why)));
  });
  body.append(list);
  const ok = outputOk(w, w.out).ok;
  if (w.tile !== "lamp" && ok) {
    const opts = chipOptions(w.out);
    if (!w.chipTouched || !opts.some(c => c.key === w.chip)) { w.chip = defaultChip(w, w.out); w.chipTouched = false; }
    const sel = selectRow("LED type", opts.map(c => [c.key, c.label]), w.chip, v => { w.chip = v; w.chipTouched = true; render(w); }, { id: "wzChip" });
    const used = lightsOf(stripOf(w.out)).length;
    body.append(el("div", { class: "wz-card" }, sel.el, note(used ? "Only LED types with the same data speed and bytes per LED as the lights already on this output are listed. Its color order and current are kept separately." : "The first light on a free output sets the output's LED type.")));
  }
  body.append(footer(w, { nextOk: ok }));
}

// ---- 3. how many LEDs ------------------------------------------------------------------------------------------
// -> true when it was started now (its first `find` line is already sent)
function ensureFinder(w) {
  if (w.F && w.F.active) return false;
  const st = stripOf(w.out), start = usedOn(st), open = {}, close = {};
  if (!lightsOf(st).length && w.chip && w.chip !== st.chip) { open.chip = w.chip; close.chip = st.chip; }
  close.px = st.px | 0;
  w.F = createFinder({ out: w.out, start, n: w.n || 1, open, close });
  w.F.begin();
  return true;
}
function stepCount(w, body) {
  const kind = kindName(w);
  if (FINDER_TILES.includes(w.tile)) return countFinder(w, body);
  if (w.tile === "string") return countString(w, body);
  return countMatrix(w, body, kind);
}
function countFinder(w, body) {
  if (!ensureFinder(w)) w.F.resume();
  body.append(h("Find the last LED"));
  body.append(note("One LED of the new light is lit white on the bike and the other lights go dark while you look for it (brake and turn signals keep working). Slide until the very last LED is the one that is lit."));
  let extra = null;
  if (w.tile === "strip") {
    if (!w.denTouched) w.den = DEN_DEFAULT.glow;
    const c = chips([144, 96, 60, 30].map(v => [v, String(v)]), w.den, v => { w.den = v; w.denTouched = true; perf.textContent = `${Math.round(v * 0.3048)} LEDs per foot`; }, { id: "wzDen" });
    const perf = el("span", { class: "note" }, `${Math.round(w.den * 0.3048)} LEDs per foot`);
    extra = el("div", { class: "wz-card" }, el("div", { class: "label" }, "LEDs per meter"), c.el, perf);
  }
  const fp = finderPanel(w.F, { extra, onLast: n => { w.n = n; if (!w.denTouched && w.tile === "ring") w.den = 0; next(w); } });
  w.panelPart = fp;
  body.append(fp.el, el("div", { class: "wz-foot" }, button("Cancel", { kind: "ghost", id: "wzCancel", onClick: () => cancel(w) })));
}
function countString(w, body) {
  const st = stripOf(w.out), limit = LIMITS.px - usedOn(st);
  if (!w.n) w.n = Math.min(50, limit);
  body.append(h("How many LEDs?"));
  body.append(note("Light strings come in strings of 50. Use the stepper, or type the exact count if yours is cut or longer."));
  const total = el("div", { class: "wz-big", id: "wzStringTotal" });
  const num = numRow("LED count", w.n, { min: 1, max: limit, id: "wzCount", onCommit: v => { w.n = v; paint(); } });
  const paint = () => {
    const k = Math.round(w.n / 50);
    total.textContent = `${w.n} LEDs` + (w.n % 50 === 0 ? ` · ${k} ${k === 1 ? "string" : "strings"} of 50` : "");
    num.set(w.n); less.disabled = w.n <= 1; more.disabled = w.n >= limit;
  };
  const step = d => { w.n = clamp((Math.max(1, Math.round(w.n / 50)) + d) * 50, 1, limit); paint(); };
  const less = button("Fewer strings", { id: "wzStrLess", onClick: () => step(-1) });
  const more = button("More strings", { id: "wzStrMore", onClick: () => step(1) });
  body.append(el("div", { class: "wz-card" }, total, el("div", { class: "btns two" }, less, more), num.el));
  if (!w.denTouched) w.den = DEN_DEFAULT.string;
  body.append(el("div", { class: "wz-card" }, el("div", { class: "label" }, "Bulbs per meter"), chips([10, 16, 20, 30].map(v => [v, String(v)]), w.den, v => { w.den = v; w.denTouched = true; }, { id: "wzDen" }).el));
  paint();
  body.append(footer(w, { nextOk: true }));
}
function countMatrix(w, body) {
  const mx = seams.matrix;
  body.append(h("Shape of the matrix"));
  body.append(note("A matrix is several strips wired as one panel. The shape builder lays them out; the LED count comes from it."));
  const d = w.design;
  const box = el("div", { class: "wz-card" }, el("div", { class: "wz-big", id: "wzShapeInfo" }, d ? `${d.strips.length} strips, ${w.n} LEDs` : "No shape yet"));
  const wait = el("p", { class: "note", id: "wzShapeWait", hidden: true });
  box.append(button(d ? "Edit shape" : "Build the shape", { id: "wzShape", kind: d ? "plain" : "primary", onClick: () => {
    w.shapeOpen = true; let heard = false;
    wait.hidden = false; wait.textContent = "Opening the shape builder…";
    const returned = () => { heard = true; w.shapeOpen = false; if (W === w) { ensureSheet(w); render(w); } };
    // two path points for each strip, out of the 96 the output's lights share
    const st0 = stripOf(w.out), free = LIMITS.pts - (((st0 && st0.geom && st0.geom.pt) || []).length);
    seams.matrix.openShape(null, { design: w.design || undefined, maxStrips: Math.floor(free / 2),
      onDone: design => { if (design) { w.design = design; w.n = mx.designLeds(design); w.den = design.den || 0; w.mid = null; } returned(); },
      onCancel: returned });
    setTimeout(() => { if (!heard && w.sh && w.sh.el.isConnected) wait.textContent = "If nothing opened, the shape builder is not available in this version."; }, 2000);
  } }), wait);
  const limit = LIMITS.px - usedOn(stripOf(w.out));
  if (d && w.n > limit) box.append(note(`This shape has more LEDs than the ${limit} left on the output.`, "bad"));
  body.append(box, footer(w, { nextOk: !!d && w.n > 0 && w.n <= limit }));
}

// ---- 3b. the middle of a bar -----------------------------------------------------------------------------------
function stepMid(w, body) {
  ensureFinder(w);
  if (w.M) w.M.stop();
  w.M = createFinder({ out: w.out, start: w.F.start, n: (w.mid == null ? Math.floor(w.n / 2) : w.mid) + 1, grow: false, max: w.n });
  w.M.begin();
  body.append(h("Find the middle of the bar"));
  body.append(note("One LED of the bar is lit. Slide to the LED at the middle of the bar, where the two halves meet; the turn signals and the DRL are split around it."));
  const fp = finderPanel(w.M, { lastLabel: "That's the middle", what: "of the bar", onLast: n => { w.mid = n - 1; next(w); },
    extra: button("Use the exact middle", { id: "wzExactMid", onClick: () => { w.mid = Math.floor(w.n / 2); next(w); } }) });
  w.panelPart = fp;
  body.append(fp.el, el("div", { class: "wz-foot" }, button("Cancel", { kind: "ghost", id: "wzCancel", onClick: () => cancel(w) })));
}

// ---- 4. what it does + name ------------------------------------------------------------------------------------
function nameField(w) {
  if (!w.nameTouched) w.name = uniqueName(BASE_NAME[kindName(w)] || "Light");
  const inp = el("input", { type: "text", class: "text", id: "wzName", maxLength: LIMITS.name, value: w.name, "aria-label": "Name" });
  inp.addEventListener("input", () => { w.name = inp.value.replace(/[^\x20-\x7e]/g, "").slice(0, LIMITS.name); w.nameTouched = true; });
  return el("label", { class: "field inline wz-name" }, el("span", { class: "lbl" }, el("b", {}, "Name")), inp);
}
function stepWhat(w, body) {
  body.append(h("What it does"));
  if (w.tile === "bar") {
    const pick = chips([["front", "Front bar"], ["rear", "Rear bar"]], w.barKind, v => { w.barKind = v; w.nameTouched = false; render(w); }, { id: "wzBarKind" });
    body.append(el("div", { class: "wz-card" }, pick.el, note(w.barKind === "front" ? "Turn signal at each end, DRL in the middle." : "Turn signal at each end, tail light, and a brake light in the middle.")));
    const feed = chips([["left", "The bike's left end"], ["right", "The bike's right end"]], w.feed, v => { w.feed = v; }, { id: "wzFeed" });
    body.append(el("div", { class: "wz-card" }, el("div", { class: "label" }, "Which end does the wire from the controller go to?"), feed.el,
      note("The turn signals run outward from the middle whichever end the wire comes in at.")));
  } else body.append(note(w.tile === "matrix" ? "The matrix shows one look across the whole panel." : "It shows one look along its whole length. Choose the look, and split it into sections if you want, once it is on the bike."));
  if (w.tile === "string") {
    const st = stripOf(w.out);
    if (!w.order) w.order = /^ws2811/.test(w.chip) ? "RGB" : st.order;
    body.append(el("div", { class: "wz-card" }, selectRow("Color order", ORDERS.map(o => [o, o]), w.order, v => { w.order = v; }, { id: "wzOrder" }).el,
      note("Most 12 V bullet strings are RGB. If the colors come out wrong, test it on the Wiring tab.")));
  }
  body.append(el("div", { class: "wz-card" }, nameField(w)), footer(w, { nextOk: true, onNext: () => { if (!w.name.trim()) w.name = uniqueName(BASE_NAME[kindName(w)] || "Light"); next(w); } }));
}
function stepJob(w, body) {
  body.append(h("What does the lamp do?"));
  body.append(note("A plain 12 V lamp on this output is switched on and off by the controller."));
  body.append(chips(LAMP_JOBS, w.job, v => { w.job = v; }, { id: "wzJob" }).el, footer(w));
}

// ---- 5. summary + add --------------------------------------------------------------------------------------------
function sectionsFor(w) {
  const kind = kindName(w);
  if (w.tile === "bar") return templateSections(kind, w.n, { mid: w.mid == null ? undefined : w.mid, feed: w.feed });
  return templateSections(kind, w.n);
}
function orderFor(w) {
  const st = stripOf(w.out);
  if (w.tile === "matrix" && w.design) return seams.matrix.designZones(w.design, st.order);
  return w.tile === "string" && w.order && w.order !== st.order ? w.order : undefined;
}
function stepSummary(w, body) {
  const st = stripOf(w.out), jack = JACKS[w.out];
  const rows = [];
  if (w.tile === "lamp") {
    rows.push(["Light", "12 V lamp"], ["Output and plug", `Output ${w.out + 1} · plug ${jack}`], ["What it does", LAMP_JOBS.find(j => j[0] === w.job)[1]]);
  } else {
    const L = lightsOf(st), kind = kindName(w);
    rows.push(["Light", `${w.name} · ${KIND_BY[kind].name}`], ["Output and plug", `Output ${w.out + 1} · plug ${jack}`], ["LED type", chipLabel(w.chip)], ["LEDs", String(w.n)],
      ["Starts at", L.length ? `LED ${usedOn(st) + 1}, after ${L[L.length - 1].name || "the last light"}` : "LED 1"],
      ["What it does", w.tile === "bar" ? (kind === "front" ? "Turn · DRL · turn" : "Turn · tail · brake · tail · turn") + `, wire at the bike's ${w.feed} end` : "One look along the whole light"]);
  }
  body.append(h("Ready to add"));
  body.append(panel(null, ...rows.map(([k, v]) => el("div", { class: "row wz-sum" }, el("span", { class: "k" }, k), el("span", { class: "v" }, v)))));
  let why = "";
  if (w.tile !== "lamp") { const v = canAdd(st, { chip: w.chip, n: w.n, sections: sectionsFor(w) }); if (!v.ok) why = v.why; }
  else if (!outputOk(w, w.out).ok) why = outputOk(w, w.out).why;
  if (why) body.append(note(why, "bad"));
  body.append(footer(w, { nextLabel: w.tile === "lamp" ? "Add the lamp" : "Add to the bike", nextOk: !why, nextId: "wzAdd", onNext: () => commit(w) }));
}
function commit(w) {
  const out = w.out;
  if (w.tile === "lamp") {
    w.finished = true; w.sh.close();
    op.strip(out, s => ({ ...s, out: w.job }));
    toast(`Added: ${LAMP_JOBS.find(j => j[0] === w.job)[1].toLowerCase()} lamp on output ${out + 1}.`);
    return;
  }
  const st = stripOf(out), kind = kindName(w);
  const sections = sectionsFor(w);
  if (!canAdd(st, { chip: w.chip, n: w.n, sections }).ok) return;
  const id = newLightId(S.settings);
  const light = { n: w.n, kind, name: w.name.trim() || BASE_NAME[kind], id, den: w.tile === "matrix" || w.denTouched ? w.den || 0 : DEN_DEFAULT[kind] || 0, chip: w.chip && w.chip !== st.chip ? w.chip : "same", ...kindDefaults(kind) };
  w.finished = true;
  stopFinders(w);
  const k = op.light.add(out, light, sections, { order: orderFor(w) });
  if (w.tile === "matrix" && w.design) seams.matrix.saveShape(id, { design: w.design, frame: null });
  send("find off");
  w.sh.close();
  openLight({ out, k }, "look");
  toast("Added. Place it on the bike from the Placement tab.");
}
