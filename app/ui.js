// DOM helpers and the shared controls (spec 4.1). Every screen builds with these; base.css gives them their look.
// No DOM access at module top level: tests import this under jsdom globals.

// ---- elements ----------------------------------------------------------------------------------
export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = Array.isArray(v) ? v.filter(Boolean).join(" ") : v;
    else if (k === "style") { if (typeof v === "string") e.style.cssText = v; else Object.assign(e.style, v); }
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k.startsWith("data-") || k.startsWith("aria-") || k === "id" || k === "role" || k === "for" || k === "viewBox") e.setAttribute(k, v === true ? "" : String(v));
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  append(e, kids);
  return e;
}
function append(e, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(e, k);
    else e.append(k instanceof Node ? k : String(k));
  }
}
export function clear(node) { if (node) while (node.firstChild) node.firstChild.remove(); return node; }

// ---- icons: inline stroke SVG --------------------------------------------------------------------
const ICONS = {
  chevron: "M9 5l7 7-7 7", back: "M15 5l-7 7 7 7", plus: "M12 5v14M5 12h14", arrow: "M5 12h14M13 6l6 6-6 6",
  close: "M6 6l12 12M18 6L6 18", check: "M5 12l5 5 9-10", warn: "M12 4l9 16H3zM12 10v4M12 17v.5",
  drag: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01", dots: "M5 12h.01M12 12h.01M19 12h.01",
};
const SVGNS = "http://www.w3.org/2000/svg";
export function icon(name, size = 18) {
  const s = document.createElementNS(SVGNS, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    "stroke-width": name === "drag" || name === "dots" ? 3 : 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "icon" })) s.setAttribute(k, v);
  const p = document.createElementNS(SVGNS, "path");
  p.setAttribute("d", ICONS[name] || ICONS.dots);
  s.append(p);
  return s;
}

// ---- buttons -----------------------------------------------------------------------------------
export function button(label, { kind = "plain", small, id, pressed, disabled, onClick, data, title } = {}) {
  const b = el("button", { type: "button", class: ["btn", kind !== "plain" && kind, small && "small"], id, disabled: !!disabled, title,
    "aria-pressed": pressed == null ? null : String(!!pressed), onclick: onClick || null }, label);
  for (const [k, v] of Object.entries(data || {})) b.dataset[k] = v;
  return b;
}
// Two taps for anything destructive: the first changes the label to `prompt` for 4 s, the second runs `action`.
export function armed(btn, prompt, action) {
  let timer = 0, label = null;
  const disarm = () => { clearTimeout(timer); if (label != null) { btn.textContent = label; label = null; } delete btn.dataset.armed; };
  btn.addEventListener("click", ev => {
    ev.stopImmediatePropagation();
    if (btn.dataset.armed == null) {
      label = btn.textContent; btn.textContent = prompt; btn.dataset.armed = "";
      timer = setTimeout(disarm, 4000);
      return;
    }
    disarm(); action();
  });
  return btn;
}

// ---- choice controls -----------------------------------------------------------------------------
const eqv = (a, b) => String(a) === String(b);
export function seg(options, value, onPick, { id } = {}) {
  const wrap = el("div", { class: "seg", id, role: "group" });
  let cur = value;
  const btns = options.map(([v, label]) => el("button", { type: "button", "data-value": v, "aria-pressed": String(eqv(v, cur)),
    onclick: () => { if (eqv(v, cur)) return; set(v); onPick(v); } }, label));
  append(wrap, btns);
  function set(v) { cur = v; btns.forEach((b, i) => b.setAttribute("aria-pressed", String(eqv(options[i][0], v)))); }
  return { el: wrap, set };
}
export function chips(options, value, onPick, { multi, id } = {}) {
  const wrap = el("div", { class: "chips", id, role: "group" });
  let cur = multi ? new Set(value || []) : value;
  const on = v => multi ? [...cur].some(x => eqv(x, v)) : eqv(v, cur);
  const btns = options.map(([v, label]) => el("button", { type: "button", class: "chip", "data-value": v, "aria-pressed": String(on(v)),
    onclick: () => {
      if (multi) { const n = new Set(cur); const hit = [...n].find(x => eqv(x, v)); if (hit !== undefined) n.delete(hit); else n.add(v); set(n); onPick(new Set(n)); }
      else { if (eqv(v, cur)) return; set(v); onPick(v); }
    } }, label));
  append(wrap, btns);
  function set(v) { cur = multi ? new Set(v || []) : v; btns.forEach((b, i) => b.setAttribute("aria-pressed", String(on(options[i][0])))); }
  return { el: wrap, set };
}
export function toggleRow(label, on, onFlip, { hint, id } = {}) {
  let cur = !!on;
  const b = el("button", { type: "button", class: "toggle", id, "aria-pressed": String(cur),
    onclick: () => { set(!cur); onFlip(cur); } },
    el("span", { class: "txt" }, el("b", {}, label), hint ? el("small", {}, hint) : null), el("span", { class: "switch", "aria-hidden": "true" }));
  function set(v) { cur = !!v; b.setAttribute("aria-pressed", String(cur)); }
  return { el: b, set };
}

// ---- value controls -------------------------------------------------------------------------------
const fmtVal = (v, unit) => unit ? `${v} ${unit}` : String(v);
export function slider(label, value, { min = 0, max = 100, step = 1, unit = "", onInput, onCommit, id } = {}) {
  const out = el("span", {}, fmtVal(value, unit));
  const inp = el("input", { type: "range", min, max, step, value, id, "aria-label": label });
  let dragging = false, idle = 0;
  // A set() from a store update must never yank the thumb out from under a finger.
  const busy = () => { dragging = true; clearTimeout(idle); idle = setTimeout(() => { dragging = false; }, 1500); };
  inp.addEventListener("pointerdown", busy);
  inp.addEventListener("input", () => { busy(); out.textContent = fmtVal(inp.value, unit); if (onInput) onInput(Number(inp.value)); });
  inp.addEventListener("change", () => { dragging = false; clearTimeout(idle); out.textContent = fmtVal(inp.value, unit); if (onCommit) onCommit(Number(inp.value)); });
  const wrap = el("label", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, label), out), inp);
  return { el: wrap, input: inp, set(v) { if (dragging) return; inp.value = v; out.textContent = fmtVal(v, unit); } };
}
export function selectRow(label, options, value, onPick, { id } = {}) {
  const sel = el("select", { id, "aria-label": label, onchange: () => onPick(sel.value) },
    options.map(([v, l]) => el("option", { value: v }, l)));
  sel.value = value;
  const wrap = el("label", { class: "field inline" }, el("span", { class: "lbl" }, el("b", {}, label)), sel);
  return { el: wrap, input: sel, set(v) { if (document.activeElement !== sel) sel.value = v; } };
}
export function numRow(label, value, { min, max, step = 1, unit = "", onCommit, id } = {}) {
  const inp = el("input", { type: "number", min, max, step, value, id, inputMode: "decimal", "aria-label": label });
  inp.addEventListener("change", () => {
    let v = Number(inp.value);
    if (!Number.isFinite(v)) { inp.value = value; return; }
    v = clamp(v, min ?? -Infinity, max ?? Infinity); inp.value = v; value = v;
    if (onCommit) onCommit(v);
  });
  const wrap = el("label", { class: "field inline" }, el("span", { class: "lbl" }, el("b", {}, label)),
    el("span", {}, inp, unit ? el("span", { class: "unit" }, unit) : null));
  return { el: wrap, input: inp, set(v) { if (document.activeElement !== inp) { inp.value = v; value = v; } } };
}

// ---- layout pieces ---------------------------------------------------------------------------------
export function row(label, { sub, value, onClick, action, id } = {}) {
  const txt = [el("span", { class: "txt" }, el("b", {}, label), sub ? el("small", {}, sub) : null),
    value != null ? el("span", { class: "val" }, value) : null];
  if (onClick && !action) return el("button", { type: "button", class: "row", id, onclick: onClick }, txt, el("span", { class: "chev" }, icon("chevron")));
  const r = el("div", { class: "row", id }, txt);
  if (onClick) { r.style.cursor = "pointer"; r.firstChild.addEventListener("click", onClick); }
  if (action) r.append(button(action.label, { small: true, onClick: action.onClick, id: action.id }));
  return r;
}
export function panel(title, ...kids) {
  return el("div", { class: "panel" }, title ? el("div", { class: "ptitle" }, title) : null, ...kids);
}
export function note(text, kind) { return el("p", { class: ["note", kind] }, text); }

let toastEl = null, toastTimer = 0;
export function toast(msg, kind) {
  if (!toastEl || !toastEl.isConnected) { toastEl = el("div", { class: "toast", role: "status", hidden: true }); document.body.append(toastEl); }
  toastEl.textContent = msg; toastEl.className = "toast" + (kind ? " " + kind : ""); toastEl.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastEl.hidden = true; }, kind ? 5000 : 3000);
}

// ---- the sheet frame: one at a time, in #side ---------------------------------------------------------
let openSheet = null;
export function sheet({ title = "", sub = "", tabs, tab, onTab, onClose, actions } = {}) {
  if (openSheet) openSheet.close(true);
  const side = document.getElementById("side") || document.body;
  const ttl = el("b", {}, title), subEl = el("small", {}, sub);
  let curTab = tab;
  const tabBtns = (tabs || []).map(([k, label]) => el("button", { type: "button", "data-tab": k, "aria-pressed": String(k === curTab),
    onclick: () => { if (k === curTab) return; me.setTab(k); if (onTab) onTab(k); } }, label));
  const body = el("div", { class: "sheet-body" });
  const root = el("div", { class: "sheet", role: "dialog", "aria-label": typeof title === "string" ? title : "" },
    el("div", { class: "sheet-head" },
      el("button", { type: "button", class: "iconbtn", "aria-label": "Back", id: "sheetClose", onclick: () => me.close() }, icon("back", 22)),
      el("div", { class: "ttl" }, ttl, subEl),
      actions && actions.length ? el("div", { class: "acts" }, actions) : null),
    tabBtns.length ? el("div", { class: "tabs", role: "tablist" }, tabBtns) : null,
    body);
  if (side.id === "side") clear(side);
  side.append(root); side.classList.add("open");
  const me = {
    el: root, body,
    setTitle(t) { clear(ttl); append(ttl, [t]); },
    setSub(t) { subEl.textContent = t; },
    setTab(k) { curTab = k; tabBtns.forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === k))); },
    // replaced = another sheet is taking the place: onClose still runs so the owner can clean up.
    close(replaced) {
      if (openSheet !== me) return;
      openSheet = null; root.remove();
      if (!replaced) { side.classList.remove("open"); if (side.id === "side" && sideHint) side.append(sideHint()); }
      if (onClose) onClose(!!replaced);
    },
  };
  openSheet = me;
  return me;
}
let sideHint = null;
// main.js tells the frame what #side shows when no sheet is open (the PC hint).
export function setSideHint(fn) { sideHint = fn; }
export function currentSheet() { return openSheet; }

// ---- LED preview strip -------------------------------------------------------------------------------
// A canvas that paints a run of LEDs from r,g,b bytes. More LEDs than pixels: nearest sample. Where canvas has
// no 2D context (jsdom) it draws nothing and never throws.
const OFF = [20, 26, 32];
// How an LED value looks on a screen. LEDs are far brighter than a screen pixel of the same number: 10 % on the bike is
// clearly lit, 10 % gray on a screen is nearly black. LED_GAIN[max(r, g, b)] is the factor for all three channels:
// it lifts dim LEDs and keeps the hue, and a full-brightness color is shown exactly as picked.
// Every place that draws an LED (the preview strips here, the bike view) uses it.
export const LED_GAIN = (() => { const g = new Float32Array(256); for (let m = 1; m < 256; m++) g[m] = Math.sqrt(m / 255) * 255 / m; return g; })();
export function ledRgb(r, g, b) { const k = LED_GAIN[Math.max(r, g, b) | 0]; return [Math.round(r * k), Math.round(g * k), Math.round(b * k)]; }
export function ledStrip({ height = 14, wide } = {}) {
  const c = el("canvas", { class: ["ledstrip", wide && "wide"], height: 1, width: 1, "aria-hidden": "true" });
  if (height !== 14) c.style.height = height + "px";
  let ctx, img;
  const g2 = () => {
    if (ctx === undefined) {
      ctx = null;
      // jsdom without the canvas package logs a "not implemented" error for getContext: skip it there.
      if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "")) return null;
      try { ctx = c.getContext("2d") || null; } catch (e) { ctx = null; }
    }
    return ctx;
  };
  return {
    el: c,
    draw(u8, start = 0, count) {
      if (count == null) count = Math.floor((u8 ? u8.length : 0) / 3) - start;
      const ctx2 = g2(); if (!ctx2 || !u8) return;
      const w = Math.max(1, Math.min(count, 240));
      if (c.width !== w) { c.width = w; img = null; }
      if (!img) img = ctx2.createImageData(w, 1);
      const d = img.data;
      for (let i = 0; i < w; i++) {
        const k = (start + (count > w ? Math.floor((i + 0.5) * count / w) : i)) * 3;
        let r = u8[k] | 0, g = u8[k + 1] | 0, b = u8[k + 2] | 0;
        if (r < 2 && g < 2 && b < 2) [r, g, b] = OFF;
        else { const q = LED_GAIN[Math.max(r, g, b)]; r *= q; g *= q; b *= q; }
        d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255;
      }
      ctx2.putImageData(img, 0, 0);
    },
  };
}

// ---- numbers and units -------------------------------------------------------------------------------
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const hex = rgb => "#" + (rgb || [0, 0, 0]).slice(0, 3).map(v => clamp(Math.round(v) || 0, 0, 255).toString(16).padStart(2, "0")).join("");
export const unhex = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); const n = m ? parseInt(m[1], 16) : 0; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
export const toIn = mm => Math.round((Number(mm) || 0) / 25.4 * 10) / 10;
export const toMm = inches => Math.round((Number(inches) || 0) * 25.4);
export const fmtIn = mm => toIn(mm).toFixed(1) + " in";
export const perFoot = perMeter => Math.round((Number(perMeter) || 0) * 0.3048);
