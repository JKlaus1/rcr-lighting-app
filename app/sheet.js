// The light sheet frame (Look / Sections / Placement / Wiring) and the bike-effect sheet frame (spec 3.3, 4.7).
// The tabs are rendered by their own modules; this file owns the header, the tab bar and following the light.
import { S, on, op, send } from "./store.js";
import { el, sheet, button, clear } from "./ui.js";
import { lightsOf, refEq } from "./lights.js";
import { chipLabel, JACKS } from "./fxdata.js";
import { renderLook } from "./sheet-look.js";
import { renderSections } from "./sheet-sections.js";
import { renderPlacement } from "./sheet-placement.js";
import { renderWiring } from "./sheet-wiring.js";
import { renderBikeEffect } from "./ride.js";

export const LIGHT_TABS = [["look", "Look"], ["sections", "Sections"], ["placement", "Placement"], ["wiring", "Wiring"]];
const RENDER = { look: renderLook, sections: renderSections, placement: renderPlacement, wiring: renderWiring };
let cur = null;   // { ref, id, sh, tab, part, off, findTimer }
// main.js listens here to highlight the sheet's light in the bike view: fn(ref | null) on open, move and close.
const lightSubs = new Set();
export function onLightChange(fn) { lightSubs.add(fn); return () => lightSubs.delete(fn); }
const tellLight = () => { const ref = currentLight(); lightSubs.forEach(fn => { try { fn(ref); } catch (e) { console.error(e); } }); };

const lightOf = ref => { const st = S.settings && S.settings.strips[ref.out]; return st ? lightsOf(st)[ref.k] || null : null; };
// "Output 1 · LEDs 1 to 57 · WS2815 12 V" (LEDs counted from 1 on screen)
export function lightSub(ref) {
  const st = S.settings.strips[ref.out], L = lightOf(ref);
  if (!L) return "";
  const chip = L.chip && L.chip !== "same" ? L.chip : st.chip;
  return `Output ${ref.out + 1} · LEDs ${L.s + 1} to ${L.s + L.n} · ${chipLabel(chip)}`;
}
export const jackOf = out => JACKS[out] || "";

export function currentLight() { return cur && cur.ref ? { out: cur.ref.out, k: cur.ref.k } : null; }

export function openLight(ref, tab = "look") {
  if (!ref || !lightOf(ref)) return null;
  if (cur && cur.ref && refEq(cur.ref, ref)) { showTab(tab); cur.sh.setTab(tab); return cur.sh; }
  const L = lightOf(ref);
  const find = button("Find it", { small: true, id: "sheetFind", onClick: () => findIt() });
  const me = { ref: { out: ref.out, k: ref.k }, id: L.id, tab: null, part: null };
  cur = me;
  me.sh = sheet({ title: titleEl(), sub: lightSub(ref), tabs: LIGHT_TABS, tab, onTab: k => showTab(k), actions: [find], onClose: () => cleanup(me) });
  me.sh.el.dataset.light = `${ref.out}:${ref.k}`;
  me.off = on("settings", () => follow(me));
  showTab(tab);
  tellLight();
  return me.sh;
}
function titleEl() {
  const L = lightOf(cur.ref);
  return el("button", { type: "button", class: "name", id: "sheetName", title: "Rename", onclick: rename }, L.name || "Unnamed light");
}
// Tap the name to rename it (16 characters); Enter or leaving the field saves it.
function rename() {
  const me = cur; if (!me) return;
  const L = lightOf(me.ref);
  const inp = el("input", { type: "text", class: "text", id: "sheetNameInput", maxLength: 16, value: L.name, "aria-label": "Light name" });
  let done = false;
  const commit = () => {
    if (done) return; done = true;
    const v = inp.value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16);
    if (v !== L.name) op.light.patch(me.ref.out, me.ref.k, { name: v });
    if (cur === me) me.sh.setTitle(titleEl());
  };
  inp.addEventListener("keydown", e => { if (e.key === "Enter") commit(); if (e.key === "Escape") { done = true; me.sh.setTitle(titleEl()); } });
  inp.addEventListener("blur", commit);
  me.sh.setTitle(inp);
  inp.focus();
}
function showTab(tab) {
  const me = cur; if (!me) return;
  if (me.part) { try { me.part.destroy(); } catch (e) { console.error(e); } }
  me.tab = RENDER[tab] ? tab : "look";
  clear(me.sh.body);
  me.part = RENDER[me.tab](me.sh.body, me.ref) || { update() {}, destroy() {} };
}
// Keep the sheet on the same light when it moves in the chain (by id); close it when the light is gone.
function follow(me) {
  if (cur !== me) return;
  let ref = me.ref;
  if (me.id) {
    const st = S.settings && S.settings.strips;
    let found = null;
    (st || []).forEach((x, out) => lightsOf(x).forEach(L => { if (L.id === me.id) found = { out, k: L.k }; }));
    ref = found;
  } else if (!lightOf(ref)) ref = null;
  if (!ref) { closeSheet(); return; }
  const moved = ref.out !== me.ref.out || ref.k !== me.ref.k;
  me.ref.out = ref.out; me.ref.k = ref.k;
  if (moved) tellLight();
  me.sh.el.dataset.light = `${ref.out}:${ref.k}`;
  if (document.activeElement && document.activeElement.id !== "sheetNameInput") me.sh.setTitle(titleEl());
  me.sh.setSub(lightSub(me.ref));
  if (me.part && me.part.update) me.part.update();
}
// Light the light's range white for 3 s.
function findIt() {
  const me = cur; if (!me) return;
  const L = lightOf(me.ref); if (!L) return;
  clearTimeout(me.findTimer);
  send(`find ${me.ref.out + 1} ${L.s} ${L.n} 255 255 255`);
  me.findTimer = setTimeout(() => send("find off"), 3000);
}
function cleanup(me) {
  if (me.part) { try { me.part.destroy(); } catch (e) { console.error(e); } }
  if (me.off) me.off();
  if (me.findTimer) { clearTimeout(me.findTimer); send("find off"); }
  if (cur === me) { cur = null; tellLight(); }
}

export function openBikeEffect() {
  const me = { ref: null, id: 0, tab: "bike", part: null };
  cur = me;
  tellLight();
  me.sh = sheet({ title: "Bike effect", sub: "One effect the lights can share", onClose: () => cleanup(me) });
  me.sh.el.dataset.sheet = "bike";
  me.part = renderBikeEffect(me.sh.body) || { update() {}, destroy() {} };
  me.off = on("settings", () => { if (cur === me && me.part.update) me.part.update(); });
  return me.sh;
}
export function closeSheet() { if (cur && cur.sh) cur.sh.close(); cur = null; }
