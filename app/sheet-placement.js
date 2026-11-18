// The light sheet's Placement tab (spec 3.3): where the light sits on the bike (path points in inches), the placing tool,
// mirroring, the LEDs of each drawn segment, LED spacing, for a matrix its shape and frame, and for a strip its shape by
// size (barshape.js).
// Bike axes in mm: x back from the front axle, y left (-) / right (+), z up from the ground.
import { S, op, send } from "./store.js";
import { el, clear, button, armed, chips, seg, selectRow, toggleRow, note, toast, toIn, toMm, fmtIn, perFoot, clamp } from "./ui.js";
import { lightsOf, allLights, geomOf, ptsRoom, LIMITS } from "./lights.js";
import { segmentsOf, setPointLed, setSegmentCount, followsDrawing, spreadPx } from "./bikeview-math.js";
import { seams } from "./wizard.js";
import { bikeView } from "./main.js";
import { openLight } from "./sheet.js";
import * as BAR from "./barshape.js";

const rd = (v, d = 0) => { const m = 10 ** d; return Math.round(v * m) / m; };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const UP = [0, 0, 1];
// The way a matrix faces: its outward normal in bike axes (front faces forward, which is -x).
const FACING = { front: [-1, 0, 0], rear: [1, 0, 0], left: [0, -1, 0], right: [0, 1, 0] };
const FACING_NAMES = [["front", "Front"], ["rear", "Rear"], ["left", "Left"], ["right", "Right"]];

// The frame of spec 4.8 from typed fields: o = lower-left corner seen from the front, u = unit vector across (to the viewer's
// right), v = unit vector up. Lean tilts the top away from the viewer (positive = leans back), about u.
// f: { x, y, z (center, mm), facing, lean (degrees) }; size: { width, height } mm.
export function frameFromFields(f, size) {
  const n = FACING[f.facing] || FACING.front, away = n.map(c => -c);
  const u = cross(away, UP), a = (Number(f.lean) || 0) * Math.PI / 180;
  const v = [0, 1, 2].map(i => Math.cos(a) * UP[i] + Math.sin(a) * away[i]);
  const c = [f.x, f.y, f.z];
  const o = [0, 1, 2].map(i => c[i] - u[i] * size.width / 2 - v[i] * size.height / 2);
  return { o: o.map(x => Math.round(x)), u: u.map(x => rd(x, 4)), v: v.map(x => rd(x, 4)) };
}
export function fieldsFromFrame(frame, size) {
  const { o, u, v } = frame;
  let facing = "front", best = -2;
  for (const [name, n] of Object.entries(FACING)) { const d = dot(cross(n.map(c => -c), UP), u); if (d > best) { best = d; facing = name; } }
  const away = FACING[facing].map(c => -c);
  const c = [0, 1, 2].map(i => o[i] + u[i] * size.width / 2 + v[i] * size.height / 2);
  return { x: Math.round(c[0]), y: Math.round(c[1]), z: Math.round(c[2]), facing, lean: rd(Math.atan2(dot(v, away), v[2]) * 180 / Math.PI, 1) };
}
// short on screen, the full words for screen readers
const AXES = [["x", "Back", "Back from the front axle, in inches"], ["y", "Left − / right +", "Left (negative) or right (positive) of the center line, in inches"], ["z", "Height", "Height above the ground, in inches"]];

export function renderPlacement(body, ref) {
  const root = el("div", { class: "pl-root", id: "tab-placement" });
  body.append(root);
  let placing = false, run = 0, status = "", shape = "bar", mirrorFrom = "", mf = null, shapeWait = false, listOpen = false;
  // the segment list: the one being worked on (-1 none), whether it is lit on the bike, what `find` shows now, its note
  let segSel = -1, segLit = true, segShown = "", segTimer = 0, segOpen = false, segMsg = "", segFocus = "", segBusy = false, rebuilding = false;
  const strip = () => S.settings.strips[ref.out];
  const light = () => lightsOf(strip())[ref.k];
  const pts = () => geomOf(strip(), ref.k);
  const setPts = list => op.light.setGeom(ref.out, ref.k, list);
  const mx = () => seams.matrix;

  // ---- the points ----
  function numField(label, valMm, id, onCommit, full) {
    const inp = el("input", { type: "number", step: 0.1, value: toIn(valMm), id, inputMode: "decimal", "aria-label": full || label });
    inp.addEventListener("change", () => { const v = Number(inp.value); if (Number.isFinite(v)) { inp.blur(); onCommit(toMm(v)); } else inp.value = toIn(valMm); });
    return el("label", { class: "pl-f" }, el("span", {}, label), inp);
  }
  function pointsBox() {
    const L = light(), list = pts();
    const box = el("div", { class: "wr-sec" }, el("div", { class: "label" }, "Where it sits"));
    if (!list.length) {
      box.append(el("p", { class: "pl-none", id: "plNone" }, "Not placed yet"),
        note("Where a light sits is what lets one effect flow across the whole bike, front to rear or side to side."));
    }
    if (list.length) box.append(note("Inches. Back is measured from the front axle, left is negative and right positive, height from the ground."));
    // A drawn string can have dozens of points: past 8 the rows fold away behind one line, so the buttons below stay in reach.
    // Under a shape drawn by size the points are its output, not what is edited: they fold away as well.
    let rows = box;
    if (list.length > 8 || (list.length && barLive())) {
      rows = el("details", { class: "pl-all", id: "plAll" }, el("summary", {}, `${list.length} points along the light. Show them`));
      rows.open = listOpen;
      rows.addEventListener("toggle", () => { listOpen = rows.open; });
      box.append(rows);
    }
    list.forEach((p, i) => {
      const row = el("div", { class: "pl-pt", "data-pt": i }, el("b", { class: "pl-led" }, `LED ${p.px + 1}`));
      for (const [ax, label, full] of AXES) row.append(numField(label, p[ax], `pl-${i}-${ax}`, mm => setPts(list.map((q, j) => (j === i ? { ...q, [ax]: mm } : q))), full));
      row.append(button("Remove", { small: true, kind: "ghost", id: `plDel-${i}`, onClick: () => setPts(list.filter((_, j) => j !== i)) }));
      rows.append(row);
    });
    const room = ptsRoom(strip(), ref.k);
    if (list.length && list.length >= room) box.append(note(room >= L.n ? "Every LED has a point." : `This output's ${LIMITS.pts} path points are all in use (its lights share them).`));
    if (list.length < room && !(list.length && barLive())) {   // a point added by hand would take the light off its drawn shape
      const used = new Set(list.map(p => p.px));
      const first = [0, L.n - 1, Math.floor(L.n / 2)].find(v => !used.has(v) && v >= 0 && v < L.n);
      const inp = el("input", { type: "number", min: 1, max: L.n, step: 1, value: first == null ? "" : first + 1, id: "plAddLed", inputMode: "numeric", "aria-label": "LED number" });
      const add = () => {
        const px = clamp(Math.round(Number(inp.value)) - 1, 0, L.n - 1);
        if (!Number.isFinite(px) || used.has(px)) { status = "That LED already has a point."; draw(); return; }
        const near = list.slice().sort((a, b) => Math.abs(a.px - px) - Math.abs(b.px - px))[0] || { x: 0, y: 0, z: 0 };
        setPts([...list, { px, x: near.x, y: near.y, z: near.z }]);
      };
      box.append(el("div", { class: "pl-add" }, el("label", { class: "pl-f" }, el("span", {}, "Add a point at LED"), inp), button("Add a point", { small: true, id: "plAdd", onClick: add })));
    }
    return box;
  }

  // ---- placing, mirroring, clearing ----
  const toolFor = L => (L.kind === "matrix" ? "matrix" : L.kind === "front" || L.kind === "rear" || (L.kind === "glow" && shape === "bar") ? "bar" : "curve");
  async function place() {
    const L = light(), v = bikeView();
    if (!v) { status = "The bike view is not available on this screen."; draw(); return; }
    const tool = toolFor(L), me = { out: ref.out, k: ref.k };
    let size = null, design = null;
    if (tool === "matrix") {
      const saved = mx().loadShape(L.id);
      design = saved && saved.design;
      if (!design) { status = "This matrix has no saved shape on this device. Build the shape first."; draw(); return; }
      size = mx().designSize(design);
    }
    const mine = ++run;
    segHide(); segMsg = "";
    placing = true; status = ""; draw();
    let res = null;
    try { res = tool === "matrix" ? await v.place(me, "matrix", size) : await v.place(me, tool); } catch (e) { res = null; }
    if (mine !== run) return;   // cancelled, or the tab was left
    placing = false;
    if (tool === "matrix" && res && res.frame) {
      setPts(mx().designPoints(design, res.frame));
      mx().saveShape(L.id, { design, frame: res.frame });
      mf = null; status = "";
    } else if (Array.isArray(res) && res.length) {
      setPts(res.map(p => ({ px: p.px, x: p.x, y: p.y, z: p.z })).filter(p => [p.px, p.x, p.y, p.z].every(Number.isFinite)));
      status = "";
    } else status = "Nothing was placed.";
    draw();
  }
  function cancelPlace() {
    run++; placing = false; status = "";
    const v = bikeView(); if (v && typeof v.cancelPlace === "function") v.cancelPlace();
    draw();
  }
  function mirror() {
    const L = light(), src = allLights(S.settings).find(x => `${x.out}:${x.k}` === mirrorFrom);
    if (!src) return;
    const sp = geomOf(S.settings.strips[src.out], src.k);
    if (!sp.length) return;
    // y negated, spread over this light's LEDs
    setPts(sp.map(p => ({ px: src.n > 1 ? Math.round(p.px * (L.n - 1) / (src.n - 1)) : 0, x: p.x, y: -p.y, z: p.z })));
    status = "";
  }
  function actionsBox() {
    const L = light(), list = pts(), box = el("div", { class: "wr-sec" });
    if (placing) {
      box.append(el("p", { class: "pl-busy", id: "plBusy" }, "Click on the bike…"), button("Cancel", { kind: "ghost", id: "plCancel", onClick: cancelPlace }));
      return box;
    }
    if (L.kind === "glow") box.append(seg([["bar", "Straight strip"], ["curve", "Curved strip"]], shape, v => { shape = v; }, { id: "plShape" }).el);
    box.append(button("Place it on the bike", { kind: "primary", id: "plPlace", onClick: place }));
    const others = allLights(S.settings).filter(x => !(x.out === ref.out && x.k === ref.k) && geomOf(S.settings.strips[x.out], x.k).length);
    if (others.length) {
      if (!others.some(x => `${x.out}:${x.k}` === mirrorFrom)) mirrorFrom = `${others[0].out}:${others[0].k}`;
      box.append(el("div", { class: "pl-mirror" },
        selectRow("Mirror from", others.map(x => [`${x.out}:${x.k}`, x.name || "Light"]), mirrorFrom, v => { mirrorFrom = v; }, { id: "plMirrorFrom" }).el,
        button("Mirror from another light", { id: "plMirror", onClick: mirror })));
    } else box.append(note("Mirror from another light is offered once another light is placed."));
    if (list.length) { const c = button("Clear placement", { kind: "danger", id: "plClear" }); armed(c, "Tap again to clear", () => { setPts([]); status = ""; }); box.append(c); }
    if (status) box.append(el("p", { class: "note", id: "plStatus" }, status));
    return box;
  }

  // ---- segments: the LEDs between one drawn point and the next ------------------------------------------------
  // Drawing a light spreads its LEDs along the line by the drawn lengths, and the model is never exactly the bike. Here
  // each segment's first LED or LED count is set to what the bike really has; only the points' LED numbers change.
  // The segment being worked on is ringed on the model and lit white on the bike (`find`), for SEG_MS after a touch.
  const SEG_MS = 60000, SEG_FOLD = 8;
  const segsOn = () => { const L = light(); return !!L && L.kind !== "matrix" && pts().length >= 3 && !barLive(); };
  const segOf = j => segmentsOf(pts(), light().n)[j] || null;
  function segDark() { clearTimeout(segTimer); segTimer = 0; if (segShown) { segShown = ""; send("find off"); } }
  // on the model the ring runs the whole drawn stretch, from the segment's point to the next one
  function segMark(j) { const v = bikeView(), list = S.settings && S.settings.strips[ref.out] ? pts() : [], on = j >= 0 && j + 1 < list.length; if (v && typeof v.mark === "function") v.mark(on ? { out: ref.out, k: ref.k } : null, on ? list[j].px : 0, on ? list[j + 1].px : 0); }
  // touched: a tap, a step or a typed number (the bike is lit anew); otherwise only a change of range sends anything
  function segShow(j, touched) {
    const L = light(), g = L && segsOn() ? segOf(j) : null;
    if (!g) { segHide(); return; }
    segSel = j; segMark(j);
    if (!segLit) { segDark(); return; }
    const key = `${ref.out + 1} ${L.s + g.a} ${g.count}`;
    if (touched || key !== segShown) { segShown = key; send(`find ${key} 255 255 255`); }
    clearTimeout(segTimer); segTimer = setTimeout(segDark, SEG_MS);
  }
  function segHide() { segSel = -1; segMark(-1); segDark(); }
  // next: the points with their new LED numbers. focus: the field to stand in afterwards.
  function segCommit(next, j, { focus = "", msg = "", later = false } = {}) {
    const cur = pts(), changed = next.length !== cur.length || next.some((q, i) => q.px !== cur[i].px);
    segMsg = msg; segFocus = focus;
    // The list is rebuilt here, once, not by the store's update on the way. A typed number commits while the focus is
    // moving on to the next field (Tab, a tap elsewhere): a rebuild at that moment would take the field it is headed
    // for away, so that one waits until the focus has arrived and then puts it back where it is.
    segBusy = true;
    try { if (changed) op.light.setGeom(ref.out, ref.k, next, { key: "seg" + ref.k }); segShow(j, true); }
    finally { if (!later) segBusy = false; }
    if (later) setTimeout(() => { segBusy = false; if (root.isConnected) redraw(); }, 0); else redraw();
  }
  const typed = v => (String(v).trim() === "" ? NaN : Math.round(Number(v)));   // an emptied field changes nothing
  function segFirst(j, value, opts) {
    const L = light(), list = pts(), want = typed(value) - 1;
    if (!Number.isFinite(want)) { segCommit(list, j, opts); return; }
    const next = setPointLed(list, L.n, j, want), got = next[j].px;
    const lo = j > 0 ? list[j - 1].px + 2 : 1, hi = list[j + 1].px;
    segCommit(next, j, { ...opts, msg: got !== want ? `Segment ${j + 1} can start at LED ${lo}${hi > lo ? ` to ${hi}` : ""}: the segments on both sides keep at least one LED.` : "" });
  }
  function segCount(j, value, opts) {
    const L = light(), list = pts(), want = typed(value);
    if (!Number.isFinite(want)) { segCommit(list, j, opts); return; }
    const next = setSegmentCount(list, L.n, j, want), got = segmentsOf(next, L.n)[j].count;
    segCommit(next, j, { ...opts, msg: got !== want ? `Segment ${j + 1} can hold ${got} LEDs at ${want > got ? "most" : "least"}: every other segment keeps at least one.` : "" });
  }
  function segRow(g, total) {
    const j = g.i, on = j === segSel, fId = `plSegF-${j}`, nId = `plSegN-${j}`;
    const head = el("button", { type: "button", class: "pl-seg-h", id: `plSeg-${j}`, "aria-pressed": String(on),
      onclick: () => { segMsg = ""; if (segSel === j) segHide(); else segShow(j, true); redraw(); } },
      el("b", {}, `Segment ${j + 1}`), el("span", {}, `LEDs ${g.a + 1} to ${g.a + g.count}`));
    head.tabIndex = -1;   // Tab goes from field to field down the list; a field that takes the focus points its segment out too
    const field = (id, label, value, min, max, commit) => {
      const inp = el("input", { type: "number", min, max, step: 1, value, id, inputMode: "numeric", "aria-label": `Segment ${j + 1}, ${label}` });
      inp.addEventListener("focus", () => { try { inp.select(); } catch (e) { /* not selectable */ } if (segSel !== j) { segShow(j, false); marks(); } });
      // (a field that is taken away while it holds the focus fires change as well: not a commit)
      inp.addEventListener("change", () => { if (!rebuilding) commit(inp.value, { later: true }); });
      // Enter goes down the list: the same field of the next segment
      inp.addEventListener("keydown", ev => { if (ev.key !== "Enter") return; ev.preventDefault(); const nx = id.replace(/\d+$/, String(j + 1)); commit(inp.value, { focus: j + 1 < total ? nx : id }); });
      return inp;
    };
    const first = field(fId, "first LED", g.a + 1, 1, light().n, (v, o) => segFirst(j, v, o));
    const count = field(nId, "number of LEDs", g.count, 1, light().n, (v, o) => segCount(j, v, o));
    const step = (d, id, label) => { const b = button(d < 0 ? "−" : "+", { small: true, id, title: label, onClick: () => segCount(j, segOf(j).count + d, { focus: id }) }); b.setAttribute("aria-label", `Segment ${j + 1}, ${label}`); b.tabIndex = -1; return b; };
    const per = g.count > 0 ? g.len / g.count : 0;
    return el("div", { class: ["pl-seg", on && "on"], "data-seg": j }, head,
      el("label", { class: "pl-f" }, el("span", {}, "First LED"), first),
      el("div", { class: "pl-f" }, el("span", {}, g.last ? "LEDs (to the end)" : "LEDs"), el("span", { class: "pl-step" }, step(-1, `plSegM-${j}`, "one LED fewer"), count, step(1, `plSegP-${j}`, "one LED more"))),
      el("small", { class: "pl-seg-d" }, `Drawn ${fmtIn(g.len)} long · ${(per / 25.4).toFixed(2)} in per LED`));
  }
  // the selected row's look without a rebuild (a field took the focus)
  function marks() { root.querySelectorAll(".pl-seg").forEach(r => { const on = Number(r.dataset.seg) === segSel; r.classList.toggle("on", on); const h = r.querySelector(".pl-seg-h"); if (h) h.setAttribute("aria-pressed", String(on)); }); }
  function segBox() {
    const L = light(), list = pts(), segs = segmentsOf(list, L.n);
    if (segSel >= segs.length) segSel = -1;
    const box = el("div", { class: "wr-sec", id: "plSegs" }, el("div", { class: "label" }, "LEDs in each segment"));
    box.append(note("A segment runs from one drawn point to the next. Where the model and the bike differ, set a segment's first LED or its number of LEDs. A new count moves the later segments along the light; the last one takes what is left."));
    box.append(toggleRow("Light it on the bike", segLit, v => { segLit = v; if (segSel >= 0) segShow(segSel, true); else segDark(); },
      { id: "plSegLit", hint: "The segment you are on lights up white on the bike and is ringed on the model" }).el);
    // Numbers other than the drawing's own stay with their points when the light is drawn again or a point is moved.
    if (!followsDrawing(list, L.n)) {
      const back = button("Spread them by the drawing again", { small: true, id: "plSegReset" });
      armed(back, "Tap again: the numbers set here go", () => { const s2 = spreadPx(list, L.n); if (s2) { segMsg = ""; segHide(); setPts(s2); redraw(); } });
      box.append(el("p", { class: "note", id: "plSegState" }, "Some LED numbers are not the ones the drawn lengths give. They stay with their points when a point is moved."),
        el("div", { class: "pl-bar-row" }, back));
    }
    if (list[0].px > 0) box.append(note(`LEDs 1 to ${list[0].px} come before the first point. They are drawn on it.`, "warn"));
    if (list[list.length - 1].px < L.n - 1) box.append(note(`LEDs ${list[list.length - 1].px + 2} to ${L.n} come after the last point. They are drawn on it.`, "warn"));
    if (segMsg) box.append(el("p", { class: "note warn", id: "plSegMsg" }, segMsg));
    let rows = box;
    if (segs.length > SEG_FOLD) {
      rows = el("details", { class: "pl-all", id: "plSegAll" }, el("summary", {}, `${segs.length} segments. Show them`));
      rows.open = segOpen || segSel >= 0;
      rows.addEventListener("toggle", () => { segOpen = rows.open; });
      box.append(rows);
    }
    for (const g of segs) rows.append(segRow(g, segs.length));
    return box;
  }

  // ---- spacing ----
  function denBox() {
    const L = light();
    const inp = el("input", { type: "number", min: 0, max: 1000, step: 1, value: L.den || "", placeholder: "unknown", id: "plDen", inputMode: "numeric", "aria-label": "LEDs per meter" });
    const send = v => { v = clamp(Math.round(v) || 0, 0, 1000); if (v !== L.den) op.light.patch(ref.out, ref.k, { den: v }); };
    inp.addEventListener("change", () => send(Number(inp.value)));
    const kids = [el("div", { class: "label" }, "LEDs per meter"),
      chips([144, 96, 60, 30].map(v => [v, String(v)]), L.den, v => send(v), { id: "plDenChips" }).el,
      el("label", { class: "field inline pl-den" }, el("span", { class: "lbl" }, el("b", {}, "Other"), el("small", {}, "0 = unknown")), el("span", {}, inp, el("span", { class: "unit" }, "per m")))];
    kids.push(el("p", { class: "note", id: "plDenInfo" }, L.den
      ? `${perFoot(L.den)} LEDs per foot · about ${fmtIn(L.n / L.den * 1000)} long for ${L.n} LEDs`
      : "Unknown. With the spacing set, the bike view draws the light at its real length."));
    return el("div", { class: "wr-sec" }, ...kids);
  }

  // ---- a strip: its shape by size (barshape.js) ----
  // The drawn shape is kept on this device. It counts as what the bike has only while the light's path points still
  // sit on it: a light placed another way since, or resized, shows the shape as a suggestion to use again.
  const barKey = () => BAR.barKey(light(), ref);
  function barLive() {
    const L = light(); if (!L || L.kind === "matrix") return false;
    const saved = BAR.loadBar(barKey());
    return !!saved && BAR.matches(saved.design, L.n, saved.frame, pts());
  }
  // Lays the LEDs out on the shape and sends the path points. Returns "" or why it could not.
  function applyBar(design, frame) {
    const L = light();
    BAR.saveBar(barKey(), { design, frame });
    if (L.n < 2) return "A shape needs a light of at least 2 LEDs.";
    const list = BAR.designPoints(design, L.n, frame, ptsRoom(strip(), ref.k));
    if (list.length < 2) return `This output's ${LIMITS.pts} path points are all in use (its lights share them). The shape is saved but not on the bike.`;
    setPts(list);
    return "";
  }
  function editBar(design) {
    const key = barKey(), L = light();
    const back = () => { if (root.isConnected) redraw(); else if (S.settings && light()) openLight({ out: ref.out, k: ref.k }, "placement"); };
    const was = BAR.loadBar(key);
    // An edited shape stays where it was put. A first shape takes the spot the light is placed at now, or, for a light
    // that is not placed yet, a usual spot for its kind (the fork for a front bar, the tail for a rear one).
    const usual = { front: [95, 603], rear: [1404, 719] }[L.kind] || [700, 600];
    const spot = pts().length ? BAR.spotFor(pts()) : { x: usual[0], y: 0, z: usual[1], plane: "flat", first: "right" };
    BAR.openBarShape({ name: L.name || "this light", n: L.n, maxLeds: LIMITS.px - ((strip().px | 0) - L.n), den: L.den, design: design || undefined,
      frame: was ? was.frame : undefined, spot,
      onDone: (d, count, rot) => {
        if (S.settings && light()) {
          const saved = BAR.loadBar(key), frame = BAR.normFrame({ ...(saved ? saved.frame : spot), rot });
          if (count >= 2 && count !== light().n) op.light.resize(ref.out, ref.k, count);
          const why = applyBar(d, frame);
          if (why) toast(why, "warn");
        }
        back();
      },
      onCancel: back });
  }
  function barBox() {
    const L = light(), saved = BAR.loadBar(barKey()), list = pts();
    const box = el("div", { class: "wr-sec", id: "plBar" }, el("div", { class: "label" }, "Shape"));
    if (!saved) {
      box.append(note("Draw the light by its real sizes: straight runs and bends, and where the first and last LED sit. Every LED then lands where it really is, so an effect travels along a curved bar instead of meeting all of it at once. The drawing is kept on this phone or PC; the bike keeps where the LEDs are."),
        button("Draw the shape by size", { id: "plBarNew", onClick: () => editBar(null) }));
      return box;
    }
    const { design, frame } = saved, live = BAR.matches(design, L.n, frame, list), P = BAR.PLANES[frame.plane], T = BAR.turned(design, L.n, frame);
    const side = BAR.sideOf(design, L.n, frame);   // where the first LED is now, and how far off square the shape is turned
    const forget = button("Forget the shape", { kind: "ghost", id: "plBarForget" });
    armed(forget, "Tap again: the light stays where it is", () => { BAR.clearBar(barKey()); status = ""; draw(); });
    box.append(el("div", { class: "pl-bar-pic", id: "plBarPic" }, BAR.picture(T, { edges: P.edges, title: `${L.name || "The light"}, ${P.seen.toLowerCase()}` })),
      el("p", { class: "pl-shape", id: "plBarInfo" }, `${P.seen} · ${design.pieces.length} ${design.pieces.length === 1 ? "piece" : "pieces"}, ${BAR.sized(T.len, "in")} long` + (live ? ` · ${list.length} path points` : "")));
    const use = (d, f) => { status = applyBar(d, f); draw(); };
    if (!live) {
      box.append(note(list.length ? "The light was placed another way after this shape was drawn, or its LED count changed. The picture shows the shape, not what the bike has now." : "This shape is not on the bike.", "warn"),
        el("div", { class: "pl-bar-row" }, button("Use the shape", { kind: "primary", id: "plBarUse", onClick: () => use(design, frame) }),
          button("Edit shape", { id: "plBarEdit", onClick: () => editBar(design) }), forget));
      return box;
    }
    const set = patch => use(design, BAR.normFrame({ ...frame, ...patch }));
    const inches = (label, key, id) => {
      const inp = el("input", { type: "number", step: 0.1, value: toIn(frame[key]), id, inputMode: "decimal", "aria-label": label });
      inp.addEventListener("change", () => { const v = Number(inp.value); if (inp.value !== "" && Number.isFinite(v)) set({ [key]: toMm(v) }); else inp.value = toIn(frame[key]); });
      return el("label", { class: "pl-f" }, el("span", {}, label), inp);
    };
    const degrees = (label, value, id, lim, onSet) => {
      const inp = el("input", { type: "number", step: 1, min: -lim, max: lim, value, id, inputMode: "decimal", "aria-label": label });
      inp.addEventListener("change", () => { const v = Number(inp.value); if (inp.value !== "" && Number.isFinite(v)) onSet(clamp(v, -lim, lim)); else inp.value = value; });
      return el("label", { class: "pl-f" }, el("span", {}, label), inp);
    };
    const rotTo = (plane, first, turn, d = design) => BAR.rotFor(d, L.n, plane, first, turn);
    // another plane keeps the first LED's side when the plane has it, and the fine turn
    const toPlane = v => set({ plane: v, rot: rotTo(v, BAR.PLANES[v].firsts.some(q => q[0] === side.first) ? side.first : BAR.PLANES[v].firsts[0][0], side.turn) });
    box.append(el("div", { class: "pl-bar-row" }, button("Edit shape", { id: "plBarEdit", onClick: () => editBar(design) })),
      el("div", { class: "label" }, "Where its middle is"),
      el("div", { class: "pl-pt" }, inches("Back from the front axle (in)", "x", "plBx"), inches("Left (−) / right (+) (in)", "y", "plBy"), inches("Height (in)", "z", "plBz")),
      el("div", { class: "label" }, "How it lies"),
      seg(Object.entries(BAR.PLANES).map(([k, q]) => [k, q.name]), frame.plane, toPlane, { id: "plBarPlane" }).el,
      el("div", { class: "label" }, "The first LED is at the"),
      seg(P.firsts.map(q => [q[0], q[1]]), side.first, v => set({ rot: rotTo(frame.plane, v, 0) }), { id: "plBarFirst" }).el,
      el("div", { class: "pl-pt" }, degrees("Fine turn (degrees)", side.turn, "plBarTurn", 44, v => set({ rot: rotTo(frame.plane, side.first, v) })),
        degrees(P.lean, frame.lean, "plBarLean", 89, v => set({ lean: v }))),
      el("div", { class: "pl-bar-row" }, button("Mirror it", { id: "plBarMirror", title: "Turns the shape over, so its bends go the other way",
        onClick: () => { const m = BAR.mirrored(design); use(m, BAR.normFrame({ ...frame, rot: rotTo(frame.plane, side.first, side.turn, m) })); } }), forget),
      note("The middle is the center of the whole shape. The side buttons turn it by quarters; the fine turn is how far the line from the first LED to the last is off square, up to 44°. Mirror turns the shape over: its bends go the other way and the first LED stays on its side."));
    return box;
  }

  // ---- a matrix: its shape and its frame ----
  function matrixBox() {
    const L = light(), saved = mx().loadShape(L.id), design = saved && saved.design;
    const box = el("div", { class: "wr-sec", id: "plMatrix" }, el("div", { class: "label" }, "Matrix"));
    const info = design ? `Shape: ${design.strips.length} strips, ${mx().designLeds(design)} LEDs` : "No shape is saved for this light on this device.";
    box.append(el("p", { class: "pl-shape", id: "plShapeInfo" }, info),
      button(design ? "Edit shape" : "Build the shape", { id: "plEditShape", onClick: () => editShape(design) }));
    if (shapeWait) box.append(note("If nothing opened, the shape builder is not available in this version."));
    if (!design) return box;
    const size = mx().designSize(design);
    if (!mf) mf = saved.frame ? fieldsFromFrame(saved.frame, size) : { x: 0, y: 0, z: 600, facing: "front", lean: 0 };
    const apply = () => {
      const frame = frameFromFields(mf, size);
      setPts(mx().designPoints(design, frame));
      mx().saveShape(L.id, { design, frame });
    };
    const field = (label, key, id) => {
      const inp = el("input", { type: "number", step: 0.1, value: toIn(mf[key]), id, inputMode: "decimal", "aria-label": label });
      inp.addEventListener("change", () => { const v = Number(inp.value); if (Number.isFinite(v)) { mf[key] = toMm(v); apply(); } else inp.value = toIn(mf[key]); });
      return el("label", { class: "pl-f" }, el("span", {}, label), inp);
    };
    const lean = el("input", { type: "number", min: -85, max: 85, step: 1, value: mf.lean, id: "plLean", inputMode: "decimal", "aria-label": "Lean in degrees" });
    lean.addEventListener("change", () => { mf.lean = clamp(Number(lean.value) || 0, -85, 85); lean.value = mf.lean; apply(); });
    box.append(el("div", { class: "pl-pt" }, field("Center, back from the front axle (in)", "x", "plMx"), field("Center, left (−) / right (+) (in)", "y", "plMy"), field("Center height (in)", "z", "plMz")),
      el("div", { class: "label" }, "Which way it faces"),
      seg(FACING_NAMES, mf.facing, v => { mf.facing = v; apply(); }, { id: "plFacing" }).el,
      el("div", { class: "pl-pt" }, el("label", { class: "pl-f" }, el("span", {}, "Lean back (degrees)"), lean)),
      note(`The panel is ${fmtIn(size.width)} wide and ${fmtIn(size.height)} high. Lean tilts the top away from whoever looks at it.`));
    return box;
  }
  function editShape(design) {
    const L = light();
    let heard = false; shapeWait = false;
    const done = () => { heard = true; shapeWait = false; };
    // The shape builder takes the sheet's place, which closes this tab: afterwards the light's sheet comes back on Placement.
    const draw = () => { if (root.isConnected) redraw(); else if (S.settings && light()) openLight({ out: ref.out, k: ref.k }, "placement"); };
    mx().openShape({ out: ref.out, k: ref.k }, { design: design || undefined,
      onDone: d => {
        done();
        if (!d || !S.settings || !light()) { draw(); return; }
        const n = mx().designLeds(d), saved = mx().loadShape(L.id), frame = saved && saved.frame;
        if (n > 0 && n !== light().n) op.light.resize(ref.out, ref.k, n);
        const s0 = light().s, zones = mx().designZones(d, strip().order);
        op.strip(ref.out, st => {
          const keep = (st.ord || []).filter(z => z[0] < s0 || z[0] >= s0 + light().n);
          const next = [...keep, ...zones.map(z => [z[0] + s0, z[1], z[2]])].sort((a, b) => a[0] - b[0]);
          if (next.length) st.ord = next; else delete st.ord;
          return st;
        });
        mx().saveShape(L.id, { design: d, frame: frame || null });
        mf = null;
        if (frame) setPts(mx().designPoints(d, frame));
        draw();
      },
      onCancel: () => { done(); draw(); } });
    // nothing took the sheet's place after 2 s: the builder did not open
    setTimeout(() => { if (!heard && root.isConnected) { shapeWait = true; redraw(); } }, 2000);
  }

  function draw() { redraw(); }
  // The tab is rebuilt as a whole. Whoever is using it must not notice: the sheet stays scrolled where it was, and the
  // focus goes back to the control it was on when that control is still there.
  function redraw() {
    const sc = root.closest(".sheet-body"), top = sc ? sc.scrollTop : 0;
    const act = document.activeElement, id = act && root.contains(act) ? act.id : "";
    rebuilding = true;
    try { clear(root); } finally { rebuilding = false; }
    if (!S.settings || !light()) return;
    const L = light();
    // A strip's shape box sits above the placing buttons once a shape is drawn, below them as an offer until then.
    const strip1 = L.kind !== "matrix", drawn = strip1 && !!BAR.loadBar(barKey());
    root.append(pointsBox());
    if (drawn) root.append(barBox());
    root.append(actionsBox());
    if (segsOn()) root.append(segBox()); else if (segSel >= 0 || segShown) segHide();
    if (strip1 && !drawn) root.append(barBox());
    root.append(denBox());
    if (L.kind === "matrix") root.append(matrixBox());
    if (sc) sc.scrollTop = top;
    const want = segFocus || id; segFocus = "";
    const again = want ? document.getElementById(want) : null;
    if (again && root.contains(again) && !again.disabled) again.focus({ preventScroll: want === id });
  }
  draw();
  return {
    update() {
      if (!S.settings || segBusy) return;
      const a = document.activeElement;
      if (a && root.contains(a) && a.tagName === "INPUT") return;   // keep the field being typed in
      if (placing) return;
      draw();
    },
    destroy() { run++; if (placing) { const v = bikeView(); if (v && typeof v.cancelPlace === "function") v.cancelPlace(); } segHide(); root.remove(); },
  };
}
