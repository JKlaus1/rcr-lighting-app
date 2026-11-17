// The light sheet's Placement tab (spec 3.3): where the light sits on the bike (path points in inches), the placing tool,
// mirroring, LED spacing, and for a matrix its shape and frame.
// Bike axes in mm: x back from the front axle, y left (-) / right (+), z up from the ground.
import { S, op } from "./store.js";
import { el, clear, button, armed, chips, seg, selectRow, note, toIn, toMm, fmtIn, perFoot, clamp } from "./ui.js";
import { lightsOf, allLights, geomOf, LIMITS } from "./lights.js";
import { seams } from "./wizard.js";
import { bikeView } from "./main.js";
import { openLight } from "./sheet.js";

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
  let placing = false, run = 0, status = "", shape = "bar", mirrorFrom = "", mf = null, shapeWait = false;
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
    list.forEach((p, i) => {
      const row = el("div", { class: "pl-pt", "data-pt": i }, el("b", { class: "pl-led" }, `LED ${p.px + 1}`));
      for (const [ax, label, full] of AXES) row.append(numField(label, p[ax], `pl-${i}-${ax}`, mm => setPts(list.map((q, j) => (j === i ? { ...q, [ax]: mm } : q))), full));
      row.append(button("Remove", { small: true, kind: "ghost", id: `plDel-${i}`, onClick: () => setPts(list.filter((_, j) => j !== i)) }));
      box.append(row);
    });
    if (list.length < LIMITS.pts) {
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
  function redraw() {
    clear(root);
    if (!S.settings || !light()) return;
    const L = light();
    root.append(pointsBox(), actionsBox(), denBox());
    if (L.kind === "matrix") root.append(matrixBox());
  }
  draw();
  return {
    update() {
      if (!S.settings) return;
      const a = document.activeElement;
      if (a && root.contains(a) && a.tagName === "INPUT") return;   // keep the field being typed in
      if (placing) return;
      draw();
    },
    destroy() { run++; if (placing) { const v = bikeView(); if (v && typeof v.cancelPlace === "function") v.cancelPlace(); } root.remove(); },
  };
}
