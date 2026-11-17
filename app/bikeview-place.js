// The placing tools of the bike view (bar, curve, matrix): their state, their bar of controls, their handles and
// the shapes they draw. Renderer-agnostic: the host (bikeview.js) passes taps and handle drags in screen px and asks
// back for the tentative LED positions, the handles and the overlay drawing. Nothing is written to the bike here.
import { el, button, chips, slider } from "./ui.js";
import {
  barLength, barEnds, dragBarEnd, barAxisOf, barResult, spreadPx, matrixFrame, matrixCorners, matrixCenter, gridPoints,
  facingOf, tidyPt, add, sub, mul, len, FACINGS,
} from "./bikeview-math.js";

const PROMPT = {
  bar: "Tap where the middle of the bar is.",
  curve: "Tap along the light from its first LED to its last.",
  matrix: "Tap where the middle of the panel is.",
};
const ADJUST = "Drag a handle to adjust, or start over.";
const P3 = p => [p.x, p.y, p.z];

// ctx: { tool, light: { n, den, kind, id, pts }, opts, flat, halfWidth, pick(sx, sy, o), camDir(), changed(), finish(value), shape }
export function createTool(ctx) {
  const { tool, light } = ctx;
  const n = Math.max(1, light.n | 0);
  const maxPts = Math.max(2, Math.min(96, (ctx.opts && ctx.opts.maxPts) || 12));
  const realLen = barLength(n, light.den);
  let st = initial(true);
  const undo = [];
  let side = "center";

  function initial(useExisting) {
    const ex = useExisting ? (light.pts || []) : [];
    if (tool === "bar") {
      // across the bike, LED 1 starts on the side its sections say (a right-turn section first = the bike's right, y +)
      const s = { ends: null, axis: "y", flip: light.firstSide === "right", centered: true, real: light.den > 0 };
      if (ex.length >= 2) {
        const a = P3(ex[0]), b = P3(ex[ex.length - 1]), o = barAxisOf(a, b);
        Object.assign(s, { ends: [a, b], axis: o.axis, flip: o.flip, centered: o.axis === "y" && Math.abs(a[1] + b[1]) < 2,
          real: light.den > 0 && Math.abs(len(sub(b, a)) - realLen) < 2 });
      }
      return s;
    }
    if (tool === "curve") {
      const pts = ex.map(P3);
      let loop = false;
      if (pts.length > 2 && len(sub(pts[0], pts[pts.length - 1])) < 1) { pts.pop(); loop = true; }
      return { pts, loop, whole: pts.length > maxPts };
    }
    // matrix
    const s = { center: null, facing: "front", centered: true, lean: 0 };
    const fr = ctx.shape && ctx.shape.frame;
    if (fr && fr.o && fr.u && fr.v) {
      const nrm = [fr.u[1] * fr.v[2] - fr.u[2] * fr.v[1], fr.u[2] * fr.v[0] - fr.u[0] * fr.v[2], fr.u[0] * fr.v[1] - fr.u[1] * fr.v[0]];
      Object.assign(s, { center: matrixCenter(fr, W(), Hh()), facing: facingOf(nrm) });
      s.centered = Math.abs(s.center[1]) < 1;
    } else if (ex.length) {
      const c = ex.reduce((a, p) => add(a, P3(p)), [0, 0, 0]);
      s.center = mul(c, 1 / ex.length); s.centered = Math.abs(s.center[1]) < 1;
    }
    return s;
  }
  const W = () => Math.max(1, Number(ctx.opts && ctx.opts.width) || 200);
  const Hh = () => Math.max(1, Number(ctx.opts && ctx.opts.height) || 100);
  const snap = () => JSON.parse(JSON.stringify(st));
  function change(fn) { undo.push(snap()); if (undo.length > 60) undo.shift(); fn(); sync(); ctx.changed(); }
  const sideY = () => (side === "left" ? -ctx.halfWidth : side === "right" ? ctx.halfWidth : 0);
  const barLen = () => (st.real ? realLen : st.ends ? Math.max(1, len(sub(st.ends[1], st.ends[0]))) : realLen);
  const hasShape = () => (tool === "bar" ? !!st.ends : tool === "curve" ? st.pts.length > 0 : !!st.center);

  // ---- picking a point for a tap --------------------------------------------------------------------
  function pickFor(sx, sy, prev) {
    if (ctx.flat) return ctx.pick(sx, sy, { y: sideY() });
    const plane = prev ? { p: prev, n: ctx.camDir() } : { p: [0, 0, 0], n: [0, 1, 0] };
    return ctx.pick(sx, sy, { plane });
  }

  // ---- results ------------------------------------------------------------------------------------------
  function frame() {
    if (!st.center) return null;
    return matrixFrame({ center: st.center, facing: st.facing, lean: st.lean, width: W(), height: Hh(), centered: st.centered });
  }
  function result() {
    if (tool === "bar") return st.ends && len(sub(st.ends[1], st.ends[0])) >= 1 ? barResult(st.ends[0], st.ends[1], n) : null;
    if (tool === "curve") return spreadPx(st.loop && st.pts.length > 1 ? [...st.pts, st.pts[0]] : st.pts, n);
    const f = frame();
    return f ? { frame: { o: f.o, u: f.u, v: f.v } } : null;
  }
  // The light's LEDs where the tool would put them: path points for interpolation ({ px, x, y, z }).
  function ledPts() {
    if (tool === "bar") return st.ends ? barResult(st.ends[0], st.ends[1], n) : null;
    if (tool === "curve") {
      if (st.pts.length === 1) return [tidyPt({ px: 0, x: st.pts[0][0], y: st.pts[0][1], z: st.pts[0][2] })];
      return result();
    }
    const f = frame();
    if (!f) return null;
    let pts = null;
    try { if (ctx.shape && ctx.shape.design && ctx.shape.points) pts = ctx.shape.points(ctx.shape.design, { o: f.o, u: f.u, v: f.v }); } catch (e) { pts = null; }
    if (pts && pts.length >= 2) return pts;
    return gridPoints(f, W(), Hh(), n).map((p, i) => ({ px: i, x: p[0], y: p[1], z: p[2] }));
  }

  // ---- taps and handles --------------------------------------------------------------------------------
  function tap(sx, sy) {
    if (tool === "bar") {
      const h = pickFor(sx, sy, null);
      if (!h) return;
      change(() => {
        st.ends = barEnds({ mid: h.p.slice(), axis: st.axis, length: barLen(), flip: st.flip, centered: st.centered });
      });
    } else if (tool === "curve") {
      if (st.whole || st.pts.length >= maxPts) return;
      const h = pickFor(sx, sy, st.pts.length ? st.pts[st.pts.length - 1] : null);
      if (!h) return;
      change(() => st.pts.push(h.p.slice()));
    } else {
      const h = pickFor(sx, sy, null);
      if (!h) return;
      change(() => {
        const first = !st.center;
        st.center = h.p.slice();
        if (first && h.n) { st.facing = facingOf(h.n); st.centered = st.facing === "front" || st.facing === "rear"; }
      });
    }
  }
  // [{ id, p, label }]: "1" marks LED 1 (the wiring direction); "all" moves the whole shape
  function handles() {
    if (tool === "bar") {
      if (!st.ends) return [];
      return [{ id: "e0", p: st.ends[0], label: "1" }, { id: "e1", p: st.ends[1], label: "" }, { id: "mid", p: mul(add(st.ends[0], st.ends[1]), 0.5), label: "", kind: "move" }];
    }
    if (tool === "curve") {
      if (st.whole) { const c = st.pts.reduce((a, p) => add(a, p), [0, 0, 0]); return st.pts.length ? [{ id: "all", p: mul(c, 1 / st.pts.length), label: "", kind: "move" }] : []; }
      return st.pts.map((p, i) => ({ id: "p" + i, p, label: i === 0 ? "1" : "" }));
    }
    return st.center ? [{ id: "c", p: st.centered ? [st.center[0], 0, st.center[2]] : st.center, label: "", kind: "move" }] : [];
  }
  let dragBase = null;
  function dragStart() { dragBase = snap(); }
  // to: the handle's new point (bike mm), worked out by the host from the pointer
  function drag(id, to) {
    if (!dragBase) dragStart();
    const b = dragBase;
    if (tool === "bar") {
      if (id === "mid") {
        const m0 = mul(add(b.ends[0], b.ends[1]), 0.5), d = sub(to, m0);
        if (st.centered) d[1] = 0;
        st.ends = [add(b.ends[0], d), add(b.ends[1], d)];
      } else {
        const w = id === "e0" ? 0 : 1;
        st.ends = dragBarEnd(b.ends, w, to, { length: realLen, real: st.real, centered: st.centered });
      }
    } else if (tool === "curve") {
      if (id === "all") {
        const c = mul(b.pts.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / b.pts.length), d = sub(to, c);
        st.pts = b.pts.map(p => add(p, d));
      } else st.pts[+id.slice(1)] = to.slice();
    } else {
      st.center = to.slice();
    }
    ctx.changed();
  }
  function dragEnd() { if (dragBase) { undo.push(dragBase); dragBase = null; } sync(); }

  // ---- the overlay: the drawn path, the panel's outline and its arrow ---------------------------------------
  function decor(g, project) {
    if (tool === "curve" && st.pts.length > 1) {
      const pts = st.loop ? [...st.pts, st.pts[0]] : st.pts;
      g.save(); g.strokeStyle = "rgba(255,164,27,0.75)"; g.lineWidth = 1.5; g.setLineDash([5, 4]);
      g.beginPath(); let started = false;
      for (const p of pts) { const s = project(p); if (!s) { started = false; continue; } if (started) g.lineTo(s[0], s[1]); else { g.moveTo(s[0], s[1]); started = true; } }
      g.stroke(); g.restore();
    }
    if (tool === "matrix") {
      const f = frame(); if (!f) return;
      const cs = matrixCorners(f, W(), Hh()).map(project);
      if (cs.some(c => !c)) return;
      g.save(); g.strokeStyle = "#ffa41b"; g.lineWidth = 2;
      g.beginPath(); cs.forEach((c, i) => (i ? g.lineTo(c[0], c[1]) : g.moveTo(c[0], c[1]))); g.closePath(); g.stroke();
      const c = matrixCenter(f, W(), Hh()), tip = add(c, mul(f.n, Math.max(80, Math.min(W(), Hh()) * 0.7)));
      const a = project(c), b = project(tip);
      if (a && b) {
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (L > 6) {
          g.beginPath(); g.moveTo(b[0], b[1]);
          g.lineTo(b[0] - 9 * Math.cos(ang - 0.45), b[1] - 9 * Math.sin(ang - 0.45));
          g.lineTo(b[0] - 9 * Math.cos(ang + 0.45), b[1] - 9 * Math.sin(ang + 0.45)); g.closePath();
          g.fillStyle = "#ffa41b"; g.fill();
        }
      }
      g.restore();
    }
  }

  // ---- the bar of controls -----------------------------------------------------------------------------
  const msg = el("p", { class: "bv-tool-msg", id: "bvToolMsg" });
  const opts = el("div", { class: "bv-tool-opts" });
  const bUndo = button("Undo", { small: true, id: "bvUndo", onClick: () => { if (!undo.length) return; st = undo.pop(); sync(); ctx.changed(); } });
  const bRestart = button("Start over", { small: true, id: "bvRestart", onClick: () => change(() => { st = initial(false); }) });
  const bCancel = button("Cancel", { small: true, id: "bvCancel", onClick: () => ctx.finish(null) });
  const bDone = button("Done", { small: true, kind: "primary", id: "bvDone", onClick: () => { const r = result(); if (r) ctx.finish(r); } });
  const bar = el("div", { class: "bv-tool", id: "bvTool", "data-tool": tool }, msg, opts, el("div", { class: "bv-tool-btns" }, bUndo, bRestart, bCancel, bDone));
  const toggle = (label, id, get, set) => {
    const b = el("button", { type: "button", class: "chip", id, "aria-pressed": String(!!get()), onclick: () => change(() => set(!get())) }, label);
    b.sync = () => b.setAttribute("aria-pressed", String(!!get()));
    return b;
  };
  const parts = [];
  if (ctx.flat) {
    const sc = chips([["left", "Left side"], ["center", "Center"], ["right", "Right side"]], side, v => { side = v; }, { id: "bvSide" });
    opts.append(sc.el);
  }
  if (tool === "bar") {
    const ax = chips([["y", "Across the bike"], ["x", "Along the bike"], ["z", "Upright"]], st.axis, v => change(() => {
      st.axis = v; st.centered = v === "y";
      if (st.ends) st.ends = barEnds({ mid: mul(add(st.ends[0], st.ends[1]), 0.5), axis: v, length: barLen(), flip: st.flip, centered: st.centered });
    }), { id: "bvAxis" });
    const flip = el("button", { type: "button", class: "chip", id: "bvFlip", onclick: () => change(() => { st.flip = !st.flip; if (st.ends) st.ends = [st.ends[1], st.ends[0]]; }) }, "Flip ends");
    const cen = toggle("Centered", "bvCentered", () => st.centered, v => {
      st.centered = v;
      if (v && st.ends) { const off = (st.ends[0][1] + st.ends[1][1]) / 2; st.ends = st.ends.map(p => [p[0], p[1] - off, p[2]]); }
    });
    const real = toggle("Real length", "bvReal", () => st.real, v => {
      st.real = v;
      if (v && st.ends) st.ends = dragBarEnd(st.ends, 0, st.ends[0], { length: realLen, real: true, centered: st.centered });
    });
    if (!(light.den > 0)) { real.disabled = true; real.title = "The LED spacing is not known"; }
    const row2 = el("div", { class: "chips" }, flip, cen, real);
    opts.append(ax.el, row2);
    parts.push(() => ax.set(st.axis), cen.sync, real.sync);
  } else if (tool === "curve") {
    const loop = toggle("Close the loop", "bvLoop", () => st.loop, v => { st.loop = v; });
    opts.append(el("div", { class: "chips" }, loop));
    parts.push(loop.sync);
  } else {
    const fc = chips(Object.keys(FACINGS).map(k => [k, k[0].toUpperCase() + k.slice(1)]), st.facing, v => change(() => { st.facing = v; st.centered = v === "front" || v === "rear"; }), { id: "bvFacing" });
    const cen = toggle("Centered", "bvCentered", () => st.centered, v => { st.centered = v; });
    let leanBase = null;
    const lean = slider("Lean back", st.lean, { min: -45, max: 45, step: 1, unit: "°", id: "bvLean",
      onInput: v => { if (!leanBase) leanBase = snap(); st.lean = v; ctx.changed(); },
      onCommit: v => { st.lean = v; if (leanBase) { undo.push(leanBase); leanBase = null; } sync(); ctx.changed(); } });
    fc.el.append(cen);
    opts.append(fc.el, lean.el);
    parts.push(() => fc.set(st.facing), cen.sync, () => lean.set(st.lean));
  }
  function sync() {
    parts.forEach(f => f());
    bUndo.disabled = !undo.length;
    bDone.disabled = !result();
    let t = hasShape() ? ADJUST : PROMPT[tool];
    if (tool === "curve" && !st.whole) {
      const k = st.pts.length;
      t = k === 0 ? PROMPT.curve : k >= maxPts ? `${k} points, the most for this light. Drag a handle to adjust, or Done.`
        : k === 1 ? "Tap the next point along the light." : `Tap the next point (${k} of up to ${maxPts}), drag a handle, or Done.`;
    }
    msg.textContent = t;
  }
  sync();

  return {
    tool, bar, tap, handles, drag, dragStart, dragEnd, ledPts, decor, result,
    valid: () => !!result(),
    // for the tests and the debug view
    state: () => snap(),
  };
}
