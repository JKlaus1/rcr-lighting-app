// The bike view (spec 4.7 / 4.8): the live bike with every LED in its current color, picking, the dock of lights
// that are not placed yet, edit-mode labels / chain / handles, and the placing tools. One view, created once by
// main.js and kept across Ride and Bike. Drawing is done by a renderer: bikeview-3d.js (WebGL, the model) or
// bikeview-flat.js (the side picture). The tools live in bikeview-place.js, the math in bikeview-math.js.
import * as store from "./store.js";
import { S, on } from "./store.js";
import { el, clear, button, ledStrip, LED_GAIN, fmtIn } from "./ui.js";
import { allLights, geomOf, isLampOut, sectionsOf, ptsRoom, LIMITS } from "./lights.js";
import { dotSizes, interpLeds, nearestLed, labelsShown, isTap, tidyPt, add, sub, mul } from "./bikeview-math.js";
import { create3d } from "./bikeview-3d.js";
import { createFlat, setContextFactory, contextOf } from "./bikeview-flat.js";
import { createTool } from "./bikeview-place.js";

export { setContextFactory };
const PER = 800, OUTS = 4, N = PER * OUTS;
const MAX_HANDLES = LIMITS.pts;   // every path point of a light gets a handle (a matrix gets one for the whole panel)
const MANY_HANDLES = 12;         // more than this on screen: the handles are drawn small so neighbors stay apart
const VIEW_BTNS = [["3d", "3D"], ["side", "Side"], ["front", "Front"], ["rear", "Rear"], ["top", "Top"]];
const isJsdom = () => typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "");
const raf = f => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(f) : setTimeout(f, 16));
const pageHidden = () => typeof document !== "undefined" && !!document.hidden;
const unraf = h => (typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(h) : clearTimeout(h));

export function mountBikeView(stageEl, hooks = {}) {
  try { return mount(stageEl, hooks); }
  catch (e) {
    console.error("bike view:", e);
    return { mode: "hidden", setMode() {}, select() {}, mark() {}, place() { return Promise.resolve(null); }, cancelPlace() {}, destroy() {},
      debug: () => ({ kind: null, mode: "hidden", leds: 0, placed: 0, unplaced: 0, selected: null, placing: null, screen: () => null, ready: Promise.resolve() }) };
  }
}

function mount(stageEl, { onPick, onMove } = {}) {
  clear(stageEl);
  // ---- the shared dots data: one slot per LED of each output (out * 800 + px) -------------------------------
  const V = { N, pos: new Float32Array(N * 3).fill(NaN), col: new Uint8Array(N * 3), size: new Float32Array(N) };
  const base = new Float32Array(N * 3).fill(NaN);   // positions as the controller holds them (copied from the mirror)
  const sxy = new Float32Array(N * 2).fill(NaN);    // screen x,y of every drawn LED after the last render
  let lights = [];          // [{ out, k, s, n, name, kind, den, id, pts, placed }]
  let override = null;      // { out, k, pts }: a light drawn at a tentative place (a drag, a tool)
  let marked = null;        // { out, k, a, b }: a run of a light's LEDs (a to b, from 0) to point out, e.g. one drawn segment
  let mode = "ride", sel = null, R = null, T = null, dead = false, tall = false;
  let renderH = 0, frameOff = null, geomDirty = true;
  let readyRes; const ready = new Promise(r => { readyRes = r; });
  let readyDone = false;

  // ---- DOM ----------------------------------------------------------------------------------------------
  const host = el("div", { class: "bv-host" });
  const over = el("canvas", { class: "bv-over", "aria-hidden": "true" });
  const labelsEl = el("div", { class: "bv-labels", "aria-hidden": "true" });
  const handlesEl = el("div", { class: "bv-handles" });
  const readout = el("div", { class: "bv-readout", id: "bvReadout", hidden: true });
  const noteEl = el("div", { class: "bv-note", id: "bvNote" }, "Loading the bike…");
  const viewBtns = VIEW_BTNS.map(([k, label]) => button(label, { kind: "ghost", small: true, pressed: k === "3d", data: { view: k }, id: "bvView-" + k, onClick: () => setView(k) }));
  const expandBtn = button("Expand", { kind: "ghost", small: true, id: "bvExpand", pressed: false, onClick: () => setTall(!tall) });
  const viewsEl = el("div", { class: "bv-views", role: "group", "aria-label": "Views" }, el("div", { class: "bv-views-3d" }, viewBtns), expandBtn);
  const dockList = el("div", { class: "bv-dock-list" });
  const dock = el("div", { class: "bv-dock", id: "bvDock", hidden: true }, el("div", { class: "bv-dock-ttl" }, "Not placed yet"), dockList);
  const toolSlot = el("div", { class: "bv-toolslot" });
  const root = el("div", { class: "bv", id: "bikeView", "data-mode": mode, "data-kind": "loading" },
    host, over, labelsEl, handlesEl, viewsEl, readout, noteEl, dock, toolSlot);
  stageEl.append(root);
  const overCtx = contextOf(over);

  // ---- size --------------------------------------------------------------------------------------------
  let W = 390, H = 300;
  const insets = () => ({ top: (viewsEl.offsetHeight || 0) + (viewsEl.offsetHeight ? 8 : 0),
    bottom: T ? (toolSlot.offsetHeight || 0) : (!dock.hidden ? dock.offsetHeight || 0 : 0) });
  function measure() {
    W = root.clientWidth || 390; H = root.clientHeight || 300;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    over.width = Math.round(W * dpr); over.height = Math.round(H * dpr);
    over.style.width = W + "px"; over.style.height = H + "px";
    if (R) R.resize(W, H, insets());
    requestRender();
  }
  let ro = null;
  if (typeof ResizeObserver === "function") { ro = new ResizeObserver(() => measure()); ro.observe(root); ro.observe(viewsEl); ro.observe(dock); ro.observe(toolSlot); }
  const onWinResize = () => measure();
  window.addEventListener("resize", onWinResize);

  // ---- the renderer: 3D where it works, else the flat picture -------------------------------------------------
  const rhooks = { changed: () => requestRender(), lost: () => { if (R && R.kind === "3d") useFlat("lost"); } };
  function useRenderer(r) {
    if (R && R !== r) { try { R.destroy(); } catch (e) { /* gone */ } }
    R = r;
    root.dataset.kind = r.kind;
    host.append(r.el);
    noteEl.textContent = r.kind === "flat" ? "3D view is not available here." : "";
    noteEl.hidden = r.kind !== "flat";
    measure();
    geomDirty = true; refreshGeometry();
    if (r.kind === "3d" && sel && !T) focusSel();
  }
  function useFlat(why) {
    if (dead) return;
    if (why && why !== "jsdom") console.info("bike view: flat picture (" + why + ")");
    const f = createFlat(host, V, rhooks);
    useRenderer(f);
  }

  // ---- reading the controller's mirror ---------------------------------------------------------------------
  const mirror = () => store.mirror;
  function readLights() {
    const st = S.settings && S.settings.strips;
    lights = allLights(S.settings).filter(L => L.out < OUTS && !isLampOut(st[L.out])).map(L => {
      const pts = geomOf(st[L.out], L.k);
      return { out: L.out, k: L.k, s: L.s, n: L.n, name: L.name, kind: L.kind, den: L.den, id: L.id, pts, placed: pts.length > 0 };
    });
    base.fill(NaN);
    const m = mirror();
    if (!m) return;
    for (let o = 0; o < OUTS; o++) {
      const cnt = Math.min(PER, m.pxCount(o));
      if (!cnt) continue;
      base.set(m.pos(o).subarray(0, cnt * 3), o * PER * 3);   // a view into the core's memory: copied at once
    }
  }
  const lightOf = ref => ref && lights.find(L => L.out === ref.out && L.k === ref.k) || null;
  const slot = (L, px = 0) => L.out * PER + L.s + px;
  // Positions and sizes of every LED that is drawn: placed lights as the controller has them, the override on top.
  function compose() {
    V.pos.fill(NaN); V.size.fill(0);
    const ranges = [];
    for (const L of lights) {
      const ov = override && override.out === L.out && override.k === L.k;
      if (ov) {
        if (!override.pts || !override.pts.length) continue;
        V.pos.set(interpLeds(override.pts, L.n), slot(L) * 3);
      } else if (L.placed) V.pos.set(base.subarray(slot(L) * 3, slot(L, L.n) * 3), slot(L) * 3);
      else continue;
      ranges.push({ s: slot(L), n: L.n });
    }
    dotSizes(V.pos, ranges, V.size);
    if (R) R.posChanged();
    readColors();
    requestRender();
  }
  function refreshGeometry() {
    if (mode === "hidden" || !S.settings) { geomDirty = true; return; }
    geomDirty = false;
    readLights();
    if (sel && !lightOf(sel)) sel = null;
    compose();
    paintDock();
    paintHandles();
  }
  // Live colors: the display rule LED_GAIN[max(r, g, b)] on every LED, so the bike matches the preview strips.
  function readColors() {
    const m = mirror();
    if (!m || !S.settings) return;
    for (let o = 0; o < OUTS; o++) {
      const cnt = Math.min(PER, m.pxCount(o));
      if (!cnt) continue;
      const px = m.px(o), b = o * PER * 3;
      for (let i = 0; i < cnt; i++) {
        if (!(V.size[o * PER + i] > 0)) continue;
        const r = px[i * 3], g = px[i * 3 + 1], bl = px[i * 3 + 2], k = LED_GAIN[r > g ? (r > bl ? r : bl) : (g > bl ? g : bl)];
        V.col[b + i * 3] = r * k; V.col[b + i * 3 + 1] = g * k; V.col[b + i * 3 + 2] = bl * k;
      }
      for (const d of dockItems) if (d.L.out === o) d.strip.draw(px, d.L.s, d.L.n);
    }
    if (R) R.colChanged();
  }
  function onFrame() { readColors(); requestRender(); }
  function subscribe(want) {
    if (want && !frameOff) frameOff = on("frame", onFrame);
    if (!want && frameOff) { frameOff(); frameOff = null; }
  }
  const onVis = () => { subscribe(mode !== "hidden" && !pageHidden()); if (!pageHidden()) requestRender(); };
  document.addEventListener("visibilitychange", onVis);
  const offs = [on("settings", () => refreshGeometry())];

  // ---- rendering on demand ------------------------------------------------------------------------------------
  function requestRender() {
    if (renderH || dead || !R || mode === "hidden" || pageHidden()) return;
    renderH = raf(draw);
  }
  function draw() {
    renderH = 0;
    if (dead || !R || mode === "hidden") return;
    const more = R.render();
    R.projectAll(sxy);
    drawOverlay();
    paintLabels();
    placeHandles();
    if (!readyDone) { readyDone = true; readyRes(); }
    if (more) requestRender();
  }

  // ---- overlay: selection outline, LED 1 marker, the data chain, the tools' shapes ---------------------------
  function polylineOf(L) {
    const pts = [];
    for (let i = 0; i < L.n; i++) { const j = slot(L, i); pts.push(sxy[j * 2] === sxy[j * 2] ? [sxy[j * 2], sxy[j * 2 + 1]] : null); }
    return pts;
  }
  function strokePath(g, pts) {
    g.beginPath(); let on = false;
    for (const p of pts) { if (!p) { on = false; continue; } if (on) g.lineTo(p[0], p[1]); else { g.moveTo(p[0], p[1]); g.lineTo(p[0] + 0.01, p[1]); on = true; } }
    g.stroke();
  }
  function drawOverlay() {
    const g = overCtx;
    if (!g) return;
    const dpr = W ? over.width / W : 1;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.lineCap = "round"; g.lineJoin = "round";
    if (mode === "edit" && !T) {
      // the data chain: last LED of a light -> first LED of the next light on the same output
      g.save(); g.strokeStyle = "rgba(228,232,236,0.38)"; g.lineWidth = 1.2; g.setLineDash([4, 5]);
      for (let a = 0; a + 1 < lights.length; a++) {
        const A = lights[a], B = lights[a + 1];
        if (A.out !== B.out) continue;
        const i = slot(A, A.n - 1), j = slot(B, 0);
        if (!(sxy[i * 2] === sxy[i * 2]) || !(sxy[j * 2] === sxy[j * 2])) continue;
        g.beginPath(); g.moveTo(sxy[i * 2], sxy[i * 2 + 1]); g.lineTo(sxy[j * 2], sxy[j * 2 + 1]); g.stroke();
      }
      g.restore();
    }
    const L = !T && sel && lightOf(sel);
    if (L && V.size[slot(L)] > 0) {
      const pts = polylineOf(L);
      const w = outlineWidth(pts);
      g.save();
      g.strokeStyle = "#ffa41b"; g.lineWidth = w + 3.5; strokePath(g, pts);
      g.globalCompositeOperation = "destination-out"; g.strokeStyle = "#000"; g.lineWidth = w; strokePath(g, pts);
      g.restore();
      if (!(mode === "edit" && L.placed)) marker1(g, pts, w);
    }
    // a marked run of LEDs: the same ring in white, with a dot on its first LED
    const M = !T && marked && lightOf(marked);
    if (M && V.size[slot(M)] > 0) {
      const all = polylineOf(M), a = Math.max(0, Math.min(M.n - 1, marked.a)), b = Math.max(a, Math.min(M.n - 1, marked.b));
      const pts = all.slice(a, b + 1), w = outlineWidth(all);
      g.save();
      g.strokeStyle = "#ffffff"; g.lineWidth = w + 5; strokePath(g, pts);
      g.globalCompositeOperation = "destination-out"; g.strokeStyle = "#000"; g.lineWidth = w; strokePath(g, pts);
      g.restore();
      const p0 = pts.find(Boolean);
      if (p0) { g.save(); g.fillStyle = "#ffffff"; g.beginPath(); g.arc(p0[0], p0[1], Math.max(3, w / 2 - 3), 0, 7); g.fill(); g.restore(); }
    }
    if (T) T.tool.decor(g, p => R.project(p));
  }
  // the outline sits just outside the dots: about the dot size on screen plus a margin
  function outlineWidth(pts) {
    const d = [];
    for (let i = 1; i < pts.length; i++) if (pts[i] && pts[i - 1]) d.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    d.sort((a, b) => a - b);
    const med = d.length ? d[d.length >> 1] : 6;
    return Math.min(14, Math.max(6, med * 1.5)) + 6;
  }
  function marker1(g, pts, w) {
    const a = pts.find(Boolean); if (!a) return;
    const b = pts.slice(1).find(p => p && Math.hypot(p[0] - a[0], p[1] - a[1]) > 2);
    let dx = b ? a[0] - b[0] : 0, dy = b ? a[1] - b[1] : -1; const l = Math.hypot(dx, dy) || 1;
    const x = a[0] + dx / l * (w / 2 + 10), y = a[1] + dy / l * (w / 2 + 10);
    g.save();
    g.fillStyle = "#ffa41b"; g.beginPath(); g.arc(x, y, 8, 0, 7); g.fill();
    g.fillStyle = "#1b1300"; g.font = "700 11px Barlow, system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("1", x, y + 0.5);
    g.restore();
  }

  // ---- labels (edit mode) -------------------------------------------------------------------------------------
  const labelEls = new Map();
  function paintLabels() {
    const show = mode === "edit" && !T;
    labelsEl.hidden = !show;
    if (!show) return;
    const want = [];
    const order = [...lights].sort((a, b) => (refIs(b, sel) ? 1 : 0) - (refIs(a, sel) ? 1 : 0));
    for (const L of order) {
      if (!(V.size[slot(L)] > 0)) continue;
      const pts = polylineOf(L).filter(Boolean);
      if (!pts.length) continue;
      let x = 0, y = Infinity;
      for (const p of pts) { x += p[0]; y = Math.min(y, p[1]); }
      x /= pts.length;
      const w = Math.min(160, 14 + 7.2 * (L.name || "").length), h = 22;
      const r = { x: x - w / 2, y: y - h - 12, w, h };
      want.push({ L, r: r.x > -w / 2 && r.x + w < W + w / 2 && r.y > 0 && r.y < H ? r : null });
    }
    const vis = labelsShown(want.map(o => o.r));
    const keep = new Set();
    want.forEach((o, i) => {
      const id = o.L.out + ":" + o.L.k;
      keep.add(id);
      let e = labelEls.get(id);
      if (!e) { e = el("span", { class: "bv-label" }); labelEls.set(id, e); labelsEl.append(e); }
      e.textContent = o.L.name || "Light";
      e.classList.toggle("sel", refIs(o.L, sel));
      e.hidden = !vis[i];
      if (vis[i]) e.style.transform = `translate(${Math.round(o.r.x + o.r.w / 2)}px, ${Math.round(o.r.y)}px) translateX(-50%)`;
    });
    for (const [id, e] of labelEls) if (!keep.has(id)) { e.remove(); labelEls.delete(id); }
  }
  const refIs = (a, b) => !!a && !!b && a.out === b.out && a.k === b.k;

  // ---- handles: the selected light's points (edit mode) or the running tool's --------------------------------
  let handleList = [], drag = null;
  function editHandles() {
    const L = mode === "edit" && sel && lightOf(sel);
    if (!L || !L.placed) return [];
    const pts = override && refIs(override, L) ? override.pts : L.pts;
    if (pts.length > MAX_HANDLES || L.kind === "matrix") {
      const c = mul(pts.reduce((a, p) => add(a, [p.x, p.y, p.z]), [0, 0, 0]), 1 / pts.length);
      return [{ id: "all", p: c, label: "", kind: "move" }];
    }
    return pts.map((p, i) => ({ id: "p" + i, p: [p.x, p.y, p.z], label: i === 0 ? "1" : "" }));
  }
  function paintHandles() {
    handleList = T ? T.tool.handles() : editHandles();
    handlesEl.classList.toggle("many", handleList.length > MANY_HANDLES);
    while (handlesEl.children.length > handleList.length) handlesEl.lastChild.remove();
    handleList.forEach((h, i) => {
      let e = handlesEl.children[i];
      if (!e) {
        e = el("button", { type: "button", class: "bv-handle", "aria-label": "Drag to move this point" });
        e.addEventListener("pointerdown", ev => handleDown(ev, e));
        handlesEl.append(e);
      }
      e.dataset.id = h.id; e.textContent = h.label || "";
      e.classList.toggle("move", h.kind === "move");
    });
    placeHandles();
  }
  function placeHandles() {
    if (!R) return;
    handleList.forEach((h, i) => {
      const e = handlesEl.children[i]; if (!e) return;
      const s = R.project(h.p);
      e.hidden = !s;
      if (s) e.style.transform = `translate(${Math.round(s[0])}px, ${Math.round(s[1])}px) translate(-50%, -50%)`;
    });
  }
  function handleDown(ev, e) {
    if (!R) return;
    ev.preventDefault(); ev.stopPropagation();
    const h = handleList.find(x => x.id === e.dataset.id);
    if (!h) return;
    try { e.setPointerCapture(ev.pointerId); } catch (er) { /* jsdom */ }
    R.setOrbit(false);
    // Not a drag yet: a finger never sits perfectly still, so the handle only starts to move after 6 px of travel.
    drag = { id: h.id, last: h.p.slice(), el: e, start: h.p.slice(), x0: ev.clientX, y0: ev.clientY, t0: Date.now(), moved: false };
    const move = mv => dragMove(mv);
    const up = uv => {
      e.removeEventListener("pointermove", move); e.removeEventListener("pointerup", up); e.removeEventListener("pointercancel", up);
      dragEnd(uv);
    };
    e.addEventListener("pointermove", move); e.addEventListener("pointerup", up); e.addEventListener("pointercancel", up);
  }
  function localXY(ev) { const r = root.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }
  function dragMove(ev) {
    if (!drag || !R) return;
    if (!drag.moved) {
      if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) < 6) return;
      drag.moved = true;
      if (T) T.tool.dragStart();
      drag.el.classList.add("drag");
    }
    const [x, y] = localXY(ev);
    const hit = R.pick(x, y, { plane: { p: drag.last, n: R.camDir() }, y: R.kind === "flat" ? drag.last[1] : undefined });
    if (!hit) return;
    const p = tidy3(hit.p);
    drag.last = p;
    showReadout(p);
    if (T) { T.tool.drag(drag.id, p); return; }
    const L = lightOf(sel); if (!L) return;
    const pts0 = L.pts;
    let pts;
    if (drag.id === "all") { const d = sub(p, drag.start); pts = pts0.map(q => ({ px: q.px, ...xyz(add([q.x, q.y, q.z], d)) })); }
    else { const i = +drag.id.slice(1); pts = pts0.map((q, j) => (j === i ? { px: q.px, ...xyz(p) } : q)); }
    override = { out: L.out, k: L.k, pts };
    compose(); paintHandles();
  }
  function dragEnd(ev) {
    if (!drag) return;
    const d = drag;
    d.el.classList.remove("drag");
    drag = null;
    readout.hidden = true;
    if (R) R.setOrbit(true);
    if (!d.moved) {
      // A tap on a handle, not a drag. While a curve is being drawn a handle must not swallow the tap: points along
      // a string sit closer together than a fingertip, so the tap adds the next point (unless it is on the point itself).
      if (T && T.tool && T.tool.tool === "curve" && ev && ev.type === "pointerup" && Date.now() - d.t0 < 400) {
        const r = d.el.getBoundingClientRect();
        if (Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2)) > 5) tapAt(...localXY(ev));
      }
      return;
    }
    if (T) { T.tool.dragEnd(); paintHandles(); requestRender(); return; }
    if (override && sel) {
      const pts = override.pts.map(tidyPt), ref = { out: override.out, k: override.k };
      override = null;
      try { if (onMove) onMove(ref, pts); } catch (e) { console.error(e); }
      refreshGeometry();
    }
  }
  const xyz = a => ({ x: a[0], y: a[1], z: a[2] });
  const tidy3 = p => { const t = tidyPt(p); return [t.x, t.y, t.z]; };
  function showReadout(p) {
    const [x, y, z] = p;
    readout.textContent = `${fmtIn(Math.abs(x))} ${x < 0 ? "ahead" : "back"} · ${Math.abs(y) < 1 ? "centered" : fmtIn(Math.abs(y)) + (y < 0 ? " left" : " right")} · ${fmtIn(z)} up`;
    readout.hidden = false;
  }

  // ---- taps: pick a light, feed a tool, double tap = the default view ------------------------------------------
  let down = null, lastTap = null;
  host.addEventListener("pointerdown", ev => { down = { x: ev.clientX, y: ev.clientY, t: Date.now() }; });
  host.addEventListener("pointerup", ev => {
    if (!down) return;
    const d = down; down = null;
    if (!isTap(ev.clientX - d.x, ev.clientY - d.y, Date.now() - d.t)) return;
    const now = Date.now();
    if (lastTap && now - lastTap.t < 350 && Math.hypot(ev.clientX - lastTap.x, ev.clientY - lastTap.y) < 24 && !T) {
      lastTap = null; setView("3d"); return;
    }
    lastTap = { x: ev.clientX, y: ev.clientY, t: now };
    tapAt(...localXY(ev));
  });
  host.addEventListener("dblclick", ev => { if (!T) { ev.preventDefault(); setView("3d"); } });
  function tapAt(x, y) {
    if (!R || mode === "hidden") return;
    if (T) { T.tool.tap(x, y); return; }
    const i = nearestLed(sxy, x, y, 16);
    if (i < 0) return;
    const out = Math.floor(i / PER), px = i % PER;
    const m = mirror();
    let k = m ? m.lightAt(out, px) : -1;
    if (!(k >= 0)) { const L = lights.find(L2 => L2.out === out && px >= L2.s && px < L2.s + L2.n); k = L ? L.k : -1; }
    if (k >= 0 && onPick) onPick({ out, k });
  }

  // ---- views and the tall stage ----------------------------------------------------------------------------------
  function setView(k) {
    viewBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.view === k)));
    if (R) R.view(k);
  }
  function setTall(on) {
    tall = !!on;
    root.classList.toggle("bv-tall", tall);
    expandBtn.setAttribute("aria-pressed", String(tall));
    expandBtn.textContent = tall ? "Smaller" : "Expand";
    measure();
  }
  function focusSel() {
    const L = sel && lightOf(sel);
    if (!L || !R || !(V.size[slot(L)] > 0)) return;
    const pts = [];
    for (let i = 0; i < L.n; i += Math.max(1, Math.floor(L.n / 16))) { const j = slot(L, i); pts.push([V.pos[j * 3], V.pos[j * 3 + 1], V.pos[j * 3 + 2]]); }
    const j = slot(L, L.n - 1); pts.push([V.pos[j * 3], V.pos[j * 3 + 1], V.pos[j * 3 + 2]]);
    R.ensureVisible(pts);
  }

  // ---- the dock: lights that are not placed yet ------------------------------------------------------------------
  let dockItems = [];
  function paintDock() {
    const un = mode === "hidden" || T ? [] : lights.filter(L => !L.placed);
    const key = un.map(L => `${L.out}:${L.k}:${L.n}:${L.name}`).join("|");
    if (key !== paintDock.key) {
      paintDock.key = key;
      clear(dockList);
      dockItems = un.map(L => {
        const strip = ledStrip({ height: 10 });
        const b = el("button", { type: "button", class: "bv-dock-item", id: `bvDock-${L.out}-${L.k}`, "data-light": `${L.out}:${L.k}`,
          onclick: () => { if (onPick) onPick({ out: L.out, k: L.k }); } }, strip.el, el("span", {}, L.name || "Light"));
        dockList.append(b);
        return { L, strip, b };
      });
    }
    const was = dock.hidden;
    dock.hidden = !dockItems.length;
    if (was !== dock.hidden && R) R.setInsets(insets());
  }

  // ---- the placing tools ---------------------------------------------------------------------------------------
  function endTool(value) {
    if (!T) return;
    const t = T; T = null;
    t.tool.bar.remove();
    stageEl.classList.remove("bv-placing");
    root.classList.remove("placing");
    override = null;
    try { t.res(value); } catch (e) { /* nobody listens */ }
    if (!dead) { measure(); refreshGeometry(); }
  }
  async function place(ref, tool, opts = {}) {
    endTool(null);
    if (dead || !["bar", "curve", "matrix"].includes(tool)) return null;
    if (geomDirty && S.settings) { const m = mode; mode = "ride"; refreshGeometry(); mode = m; }
    const L = lightOf(ref);
    if (!L) return null;
    const token = {};
    placeToken = token;
    let shape = null;
    if (tool === "matrix") {
      try {
        const mx = await import("./matrix.js");
        const s = typeof mx.loadShape === "function" ? mx.loadShape(L.id) : null;
        shape = { design: s && s.design, frame: s && s.frame, points: typeof mx.designPoints === "function" ? mx.designPoints : null };
      } catch (e) { shape = null; }
      if (placeToken !== token || dead) return null;
    }
    // A curve may use every path point the output still has room for (96 per output, shared by its lights).
    if (tool === "curve" && !(opts && opts.maxPts)) {
      const st = S.settings && S.settings.strips[L.out];
      opts = { ...(opts || {}), maxPts: st ? ptsRoom(st, L.k) : LIMITS.pts };
    }
    return new Promise(res => {
      const ctx = {
        tool, opts, shape, light: { n: L.n, den: L.den, kind: L.kind, id: L.id, pts: L.pts, firstSide: firstSideOf(L) },
        flat: !R || R.kind === "flat", halfWidth: (R && R.halfWidth) || 390,
        pick: (x, y, o) => (R ? R.pick(x, y, o) : null),
        camDir: () => (R ? R.camDir() : [0, -1, 0]),
        changed: () => { if (T) { override = { out: L.out, k: L.k, pts: T.tool.ledPts() || [] }; compose(); paintHandles(); } },
        finish: v => endTool(v),
      };
      T = { ref: { out: L.out, k: L.k }, res, tool: null };
      T.tool = createTool(ctx);
      toolSlot.append(T.tool.bar);
      stageEl.classList.add("bv-placing");
      root.classList.add("placing");
      paintDock();
      subscribe(mode !== "hidden" && !pageHidden());
      ctx.changed();
      measure();
      if (L.placed) focusSel();
    });
  }
  let placeToken = null;
  // Which side of the bike a light's first LED is on, read from its sections: a bar whose first section is the right
  // turn signal starts on the bike's right. null = the sections do not say.
  function firstSideOf(L) {
    const st = S.settings && S.settings.strips[L.out];
    const first = st ? sectionsOf(st, L.k).sections.find(x => x.role !== "none") : null, role = first ? first.role : "";
    return /turn_r$/.test(role) ? "right" : /turn_l$/.test(role) ? "left" : null;
  }

  // ---- the view object -------------------------------------------------------------------------------------------
  const view = {
    get mode() { return mode; },
    setMode(m) {
      if (!["ride", "edit", "hidden"].includes(m)) return;
      const was = mode; mode = m;
      root.dataset.mode = m;
      if (m === "hidden") { endTool(null); if (renderH) { unraf(renderH); renderH = 0; } }
      subscribe(m !== "hidden" && !pageHidden());
      if (m !== "hidden" && (geomDirty || was === "hidden")) refreshGeometry();
      paintHandles();
      if (m !== "hidden" && was === "hidden") measure();
      requestRender();
    },
    select(ref) {
      const L = ref && lightOf(ref);
      sel = ref && (L || (S.settings && geomDirty)) ? { out: ref.out, k: ref.k } : null;
      root.dataset.selected = sel ? sel.out + ":" + sel.k : "";
      paintHandles();
      if (sel && !T) focusSel();
      requestRender();
    },
    // Point out LEDs a to b (from 0, within the light) of a light; mark(null) clears it. The view turns to show them.
    mark(ref, a, b) {
      const L = ref && lightOf(ref);
      marked = L && Number.isFinite(a) && Number.isFinite(b) ? { out: ref.out, k: ref.k, a: Math.round(a), b: Math.round(b) } : null;
      root.dataset.marked = marked ? `${marked.out}:${marked.k}:${marked.a}:${marked.b}` : "";
      if (marked && L && R && !T && V.size[slot(L)] > 0) {
        const pts = [], lo = Math.max(0, Math.min(L.n - 1, marked.a)), hi = Math.max(lo, Math.min(L.n - 1, marked.b));
        for (let i = lo; i <= hi; i += Math.max(1, Math.floor((hi - lo) / 8))) { const j = slot(L, i); pts.push([V.pos[j * 3], V.pos[j * 3 + 1], V.pos[j * 3 + 2]]); }
        const j = slot(L, hi); pts.push([V.pos[j * 3], V.pos[j * 3 + 1], V.pos[j * 3 + 2]]);
        if (pts.every(q => q[0] === q[0])) R.ensureVisible(pts);
      }
      requestRender();
    },
    place(ref, tool, opts) { return place(ref, tool, opts); },
    // Stop a running placing tool; its promise resolves null. (The Placement tab's own Cancel, beside the view on a PC.)
    cancelPlace() { placeToken = null; endTool(null); },
    destroy() {
      if (dead) return;
      endTool(null);
      dead = true;
      placeToken = null;
      subscribe(false);
      offs.forEach(f => f());
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("resize", onWinResize);
      if (ro) ro.disconnect();
      if (renderH) { unraf(renderH); renderH = 0; }
      if (R) { try { R.destroy(); } catch (e) { /* gone */ } R = null; }
      root.remove();
      stageEl.classList.remove("bv-placing");
      if (!readyDone) { readyDone = true; readyRes(); }
    },
    debug() {
      let leds = 0; for (let i = 0; i < N; i++) if (V.size[i] > 0) leds++;
      return {
        kind: R ? R.kind : null, mode, leds,
        placed: lights.filter(L => L.placed).length, unplaced: dockItems.length,
        selected: sel ? { ...sel } : null, marked: marked ? { ...marked } : null, placing: T ? T.tool.tool : null,
        tool: T ? T.tool.state() : null,
        screen(ref, px = 0) {
          const L = lightOf(ref);
          if (!L || !R || px < 0 || px >= L.n) return null;
          const j = slot(L, px);
          if (!(V.size[j] > 0)) return null;
          const s = R.project([V.pos[j * 3], V.pos[j * 3 + 1], V.pos[j * 3 + 2]]);
          if (!s) return null;
          const r = root.getBoundingClientRect();
          return [r.left + s[0], r.top + s[1]];
        },
        // page px of a point in bike mm (scripted checks of the tools)
        toScreen(p) { if (!R) return null; const s = R.project(p); if (!s) return null; const r = root.getBoundingClientRect(); return [r.left + s[0], r.top + s[1]]; },
        camera: () => (R && R.camState ? R.camState() : null),
        ready,
      };
    },
  };
  view.setMode("ride");
  refreshGeometry();
  // the renderer last: everything it calls back into exists by now
  const canGl = () => !isJsdom() && typeof window !== "undefined" && "WebGL2RenderingContext" in window;
  if (!canGl()) useFlat(isJsdom() ? "jsdom" : "no WebGL 2");
  else create3d(host, V, rhooks).then(r => { if (dead) { r.destroy(); return; } useRenderer(r); }).catch(e => useFlat(e && e.message || String(e)));
  return view;
}
