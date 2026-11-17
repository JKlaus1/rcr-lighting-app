// The Ride screen (spec 3.2) and the body of the bike-effect sheet (spec 3.3).
//   mountRide(panelEl) -> { destroy() }          renderBikeEffect(body) -> { update(), destroy() }
// Everything shown is read from S.settings, S.status and S.looks; nothing is hard-coded. The frame loop runs only while
// a screen here is mounted (every subscription is dropped in destroy()).
import { S, on, op, send, mirror } from "./store.js";
import { el, clear, button, seg, row, note, slider, selectRow, numRow, toggleRow, armed, icon, ledStrip, sheet, clamp, toIn, toMm } from "./ui.js";
import { allLights } from "./lights.js";
import { effectName, SPANS } from "./fxdata.js";
import { openLight, openBikeEffect } from "./sheet.js";
import { nav } from "./main.js";
import { fxEditor, attachBikePreview } from "./fx.js";

// ---- what the bike is doing now -----------------------------------------------------------------------
const accent = () => (S.settings && S.settings.accent) || {};
const acc = () => (S.status && "acc" in S.status ? !!S.status.acc : !!accent().on);
let allTouched = 0;   // the "Every light" switch was just used: the status may still show the old value
const allOn = () => (S.status && "all" in S.status && Date.now() - allTouched > 1500 ? !!S.status.all : !!accent().all);
const strobeSet = () => !!(S.settings && S.settings.strobe && Object.values(S.settings.strobe.grp || {}).some(g => g > 0));
const spanName = () => (SPANS.find(([k]) => k === (accent().span || "light")) || SPANS[0])[1].toLowerCase();
const lights = () => allLights(S.settings);
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// The line under a light's name: what it shows right now, in the words of spec 3.2.
export function lightLine(L) {
  const a = acc();
  if (a && allOn() && !L.solo) return "Showing the bike effect";
  if (L.rest === "off") return "Off at rest";
  if (L.rest === "bike") return a ? "Follows the bike effect" : "Accent lights are off";
  return a || !L.look.master ? `Own look · ${effectName(L.look.mode)}` : "Accent lights are off";
}
export function bikeLine() {
  if (!acc()) return "Accent lights are off";
  const all = lights(), f = all.filter(l => l.rest === "bike").length;
  return `${effectName(accent().mode)} · ${spanName()} · ${allOn() ? "on every light" : `on ${f} of ${plural(all.length, "light")}`}`;
}
// What the bike-effect preview draws: the effect, or darkness while Accent lights are off.
const previewLook = () => (acc() ? accent() : { mode: "solid", rgb: [0, 0, 0] });

// ---- the screen ----------------------------------------------------------------------------------------
const TOGGLES = [
  { id: "ride-hazard", label: "Hazards", on: () => !!(S.status && S.status.hz), text: v => (v ? "Flashing" : "Off"), flip: () => send("hazard toggle") },
  { id: "ride-accent", label: "Accent lights", on: acc, text: v => (v ? "On" : "Off"), flip: v => op.accent({ on: !v }) },
  { id: "ride-drl", label: "DRL", on: () => !!(S.settings && S.settings.drl && S.settings.drl.on), text: v => (v ? "On" : "Off"), flip: v => op.drl({ on: !v }) },
  { id: "ride-pods", label: "Pods", on: () => !!(S.status && S.status.aux), text: v => (v ? "On" : "Off"), flip: v => send(v ? "aux off" : "aux on") },
  { id: "ride-strobe", label: "Strobe", show: strobeSet, on: () => !!(S.status && S.status.sb), text: v => (v ? "On" : "Off"), flip: () => send("strobe toggle") },
];

export function mountRide(panelEl) {
  const root = el("div", { class: "ride", id: "ride" });
  panelEl.append(root);
  const wait = note("Reading the controller's settings…");
  const content = el("div", { class: "ride-content" });
  root.append(wait, content);
  const offs = [];
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  // 1. toggles, optimistic until the next status agrees
  const opt = {};   // id -> { val, until }
  const bigs = el("div", { class: "bigs", id: "rideToggles" });
  const tBtns = TOGGLES.map(t => {
    const b = el("button", { type: "button", class: "big", id: t.id, "aria-pressed": "false", onclick: () => {
      const now = shown(t);
      opt[t.id] = { val: !now, until: Date.now() + 1500 };
      t.flip(now);
      paintToggles();
      later(paintToggles, 1600);
    } }, el("b", {}, t.label), el("small", {}));
    return b;
  });
  bigs.append(...tBtns);
  const shown = t => { const o = opt[t.id]; return o && o.until > Date.now() ? o.val : t.on(); };
  function paintToggles() {
    TOGGLES.forEach((t, i) => {
      const v = shown(t), b = tBtns[i];
      if (opt[t.id] && t.on() === opt[t.id].val) delete opt[t.id];   // the controller caught up
      b.hidden = !!(t.show && !t.show());
      b.setAttribute("aria-pressed", String(v));
      b.lastChild.textContent = t.text(v);
    });
  }

  // 2. looks
  const looksBox = el("div", { class: "looks", id: "rideLooks" });
  let naming = null;   // { slot } while the name field is open
  let manage = null;   // the Manage looks sheet while it is open
  const nextFree = () => S.looks.slots.findIndex(s => !s);
  function paintLooks() {
    clear(looksBox);
    const { pre, prem, slots } = S.looks, named = slots.map((n, i) => [i, n]).filter(([, n]) => n);
    const edited = pre >= 0 && prem > 0;
    looksBox.append(el("div", { class: "section-head" }, el("div", { class: "section-title" }, "Looks"),
      el("div", { class: "note" }, "One tap changes the whole bike")));
    if (!named.length) {
      looksBox.append(note("No looks saved yet. A look keeps the whole bike's lights, effects and sections so one tap brings them back."));
    } else {
      looksBox.append(el("div", { class: "bigs" }, named.map(([i, name]) =>
        el("button", { type: "button", class: "tile", id: "look-" + i, "aria-pressed": String(i === pre), onclick: () => { if (i !== pre || edited) op.looks.apply(i); } },
          el("b", {}, name), el("small", {}, i === pre ? (edited ? "Active · edited" : "Active") : "Tap to switch")))));
    }
    if (naming) { looksBox.append(nameField()); }
    else if (!named.length) {
      looksBox.append(button("Save this as the first look", { id: "look-first", kind: "primary", onClick: () => { naming = { slot: 0 }; paintLooks(); } }));
    } else if (edited || pre < 0) {
      const btns = [];
      if (edited) btns.push(button(`Save changes to ${slots[pre]}`, { id: "look-save", kind: "primary", onClick: () => op.looks.save(pre) }));
      btns.push(button("Save as a new look", { id: "look-saveas", onClick: () => {
        const slot = nextFree();
        if (slot < 0) { looksBox.append(note("All 8 look slots are in use. Delete one under Manage looks first.", "warn")); return; }
        naming = { slot }; paintLooks();
      } }));
      looksBox.append(el("div", { class: "btns two" }, btns));
    }
    if (named.length) looksBox.append(row("Manage looks", { id: "look-manage", sub: "Rename or delete a saved look", onClick: openManage }));
  }
  // the name prompt: an inline field, never a dialog
  function nameField() {
    const slot = naming.slot;
    const inp = el("input", { type: "text", class: "text", id: "look-name", maxLength: 24, "aria-label": "Look name", placeholder: "Name this look" });
    const save = () => { const n = inp.value.replace(/[^\x20-\x7e]/g, "").trim() || `Look ${slot + 1}`; naming = null; op.looks.save(slot, n); paintLooks(); };
    inp.addEventListener("keydown", e => { if (e.key === "Enter") save(); if (e.key === "Escape") { naming = null; paintLooks(); } });
    later(() => inp.focus(), 0);
    return el("div", { class: "namebox" }, inp, button("Save", { id: "look-name-save", kind: "primary", onClick: save }),
      button("Cancel", { id: "look-name-cancel", onClick: () => { naming = null; paintLooks(); } }));
  }
  // Manage looks: rename (saves the look under the new name) and delete (armed)
  function openManage() {
    if (manage) manage.close();
    const me = manage = sheet({ title: "Manage looks", sub: "Rename or delete a saved look", onClose: () => { off(); if (manage === me) manage = null; } });
    const paint = () => {
      clear(me.body);
      const { pre, prem, slots } = S.looks;
      slots.forEach((name, i) => {
        if (!name) return;
        const r = el("div", { class: "row manage-row", id: "manage-" + i }, el("span", { class: "txt" }, el("b", {}, name),
          el("small", {}, i === pre ? (prem ? "Active · edited" : "Active") : "Saved")));
        r.append(button("Rename", { small: true, id: "manage-rename-" + i, onClick: () => rename(r, i, name) }),
          armed(button("Delete", { small: true, kind: "danger", id: "manage-del-" + i }), "Tap again to delete", () => op.looks.del(i)));
        me.body.append(r);
      });
      if (!slots.some(Boolean)) me.body.append(note("No looks saved."));
      me.body.append(note("Renaming saves the look under the new name. A look that is not active is switched on first, so unsaved changes to the active look are lost."));
    };
    const rename = (r, i, name) => {
      const inp = el("input", { type: "text", class: "text", id: "manage-name-" + i, maxLength: 24, value: name, "aria-label": "New name" });
      const go = () => {
        const n = inp.value.replace(/[^\x20-\x7e]/g, "").trim();
        if (!n) return;
        if (i !== S.looks.pre) op.looks.apply(i);
        op.looks.save(i, n);
      };
      inp.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      clear(r).append(inp, button("Save", { small: true, kind: "primary", id: "manage-rename-save-" + i, onClick: go }), button("Cancel", { small: true, onClick: paint }));
      inp.focus();
    };
    const off = on("looks", paint);
    paint();
  }

  // 3. the bike effect card
  const bikeStrip = ledStrip({});
  const bikeLineEl = el("small", {});
  const scope = seg([[0, "Lights that follow it"], [1, "Every light"]], 0, v => { allTouched = Date.now(); op.accent({ all: !!Number(v) }); }, { id: "ride-scope" });
  const bikeCard = el("div", { class: "panel bike-card" },
    el("button", { type: "button", class: "row", id: "rideBikeEffect", onclick: () => openBikeEffect() }, bikeStrip.el,
      el("span", { class: "txt" }, el("b", {}, "Bike effect"), bikeLineEl), el("span", { class: "chev" }, icon("chevron"))),
    scope.el);

  // 4. the lights, in wiring order
  const list = el("div", { id: "rideLights" });
  const lightsCard = el("div", { class: "panel lights-card" }, el("div", { class: "ptitle" }, "Lights"), list,
    row("Headlight pods", { id: "ridePods", sub: "Which pod lights in each switch position, dimming, strobe", onClick: () => nav.go("system", { page: "pods" }) }));
  let rows = [], sig = null;
  function paintLights() {
    const all = lights(), s = all.map(l => `${l.out}:${l.k}:${l.id}`).join();
    if (s !== sig) {
      sig = s; clear(list); rows = [];
      for (const L of all) {
        const strip = ledStrip({}), name = el("b", {}), line = el("small", {});
        const btn = el("button", { type: "button", class: "row", id: `light-${L.out}-${L.k}`, onclick: () => openLight({ out: L.out, k: L.k }) },
          strip.el, el("span", { class: "txt" }, name, line), el("span", { class: "chev" }, icon("chevron")));
        list.append(btn);
        rows.push({ out: L.out, k: L.k, strip, name, line });
      }
      if (!all.length) list.append(note("No lights on the bike yet. Add one on the Bike tab."));
    }
    all.forEach((L, i) => {
      const r = rows[i];
      r.s = L.s; r.n = L.n;
      r.name.textContent = L.name || "Unnamed light";
      r.line.textContent = lightLine(L);
    });
  }

  function paintAll() {
    const ok = !!S.settings;
    wait.hidden = ok; content.hidden = !ok;
    if (!ok) return;
    paintToggles();
    bikeLineEl.textContent = bikeLine();
    scope.set(accent().all ? 1 : 0);
    paintLights();
  }
  content.append(bigs, looksBox, bikeCard, lightsCard);
  paintLooks();
  paintAll();

  // the live strips: the bike effect preview and every light's own LEDs
  offs.push(attachBikePreview(bikeStrip, previewLook));
  offs.push(on("frame", () => {
    if (!mirror || !S.settings) return;
    for (const r of rows) if (r.n && mirror.pxCount(r.out) >= r.s + r.n) r.strip.draw(mirror.px(r.out), r.s, r.n);
  }));
  offs.push(on("status", paintAll), on("settings", paintAll), on("looks", paintLooks));

  return {
    destroy() {
      offs.forEach(f => f()); timers.forEach(clearTimeout); timers.clear();
      if (manage) manage.close();
      root.remove();
    },
  };
}

// ---- the bike-effect sheet ----------------------------------------------------------------------------
export function renderBikeEffect(body) {
  const root = el("div", { class: "bike-effect", id: "tab-bike" });
  body.append(root);
  const a = () => accent();
  const offNote = note("Accent lights are off, so no light shows the bike effect now. Switch them on from Ride.", "warn");
  offNote.id = "bike-off-note";

  const box = el("div", { class: "panel pad" });
  const editor = fxEditor(box, { kind: "bike", rev: false, get: () => a(),
    set: (fields, o) => op.accent(fields, o && o.key ? { key: "acc:" + o.key, ms: o.ms } : undefined) });
  const pct = slider("Brightness", a().pct == null ? 100 : a().pct, { min: 0, max: 100, step: 1, unit: "%", id: "bike-pct",
    onInput: v => op.accent({ pct: v }, { key: "acc:pct", ms: 150 }) });
  box.append(pct.el);

  // how it is laid out
  const span = selectRow("How it is laid out", SPANS, a().span || "light", v => op.accent({ span: v }), { id: "bike-span" });
  const rev = toggleRow("Reverse", !!a().rev, v => op.accent({ rev: v }), { id: "bike-rev", hint: "Run the other way" });
  const pitch = numRow("Bulb spacing", toIn(a().pitch || 50), { min: 0.4, max: 9.8, step: 0.1, unit: "in", id: "bike-pitch",
    onCommit: v => op.accent({ pitch: clamp(toMm(v), 10, 250) }) });
  const layout = el("div", { class: "panel" }, span.el, rev.el, pitch.el);

  // where it runs
  const scope = seg([[0, "Lights that follow it"], [1, "Every light"]], 0, v => { allTouched = Date.now(); op.accent({ all: !!Number(v) }); }, { id: "bike-scope" });
  const scopeNote = note("");
  scopeNote.id = "bike-scope-note";
  const runs = el("div", { class: "panel pad runs" }, el("div", { class: "label" }, "Runs on"), scope.el, scopeNote);
  root.append(offNote, box, layout, runs);

  // the spacing of virtual bulbs matters for the effects that count LEDs, when the effect is laid over an axis
  const needsPitch = () => ["x", "y", "z"].includes(a().span) && (["rainbow", "chase", "scanner"].includes(a().mode) || /^(bulbs|march|alternate|theater|wipe|twinkle|shimmer|glitter|candle|fill|comets|stack|bursts|colorwave|fade|show)$/.test(a().mode));
  function update() {
    if (!S.settings) return;
    offNote.hidden = acc();
    editor.update();
    pct.set(a().pct == null ? 100 : a().pct);
    span.set(a().span || "light");
    rev.set(!!a().rev);
    pitch.set(toIn(a().pitch || 50));
    pitch.el.hidden = !needsPitch();
    const all = allOn(), ls = lights(), f = ls.filter(l => l.rest === "bike").length, solos = ls.filter(l => l.solo).map(l => l.name || "Unnamed light");
    scope.set(accent().all ? 1 : 0);
    scopeNote.textContent = all
      ? "Every light shows it while it is not braking, signaling or showing the DRL." + (solos.length ? ` Staying out: ${solos.join(", ")}.` : "")
      : `${f} of ${plural(ls.length, "light")} follow it. The rest keep their own looks.`;
  }
  update();
  const offs = [on("status", () => { offNote.hidden = acc(); })];
  return { update, destroy() { offs.forEach(f => f()); editor.destroy(); root.remove(); } };
}
