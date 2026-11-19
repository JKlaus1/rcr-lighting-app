// System tab (spec 3.6): a list of pages; a page opens in place under a back row. The pages with a lot in them live in
// system-pods.js, system-power.js, system-controller.js, system-backup.js and system-diag.js; this file holds the list,
// the two small pages (Signals, Handlebar button) and the console collector that starts with the first visit.
import { S, on, op, fwAtLeast } from "./store.js";
import { el, clear, button, panel, note, row, icon, hex, unhex } from "./ui.js";
import { turnStyles, BTN_ACTIONS, SCROLL_NOTE, SCROLL_SPEED_NOTE } from "./fxdata.js";
import { usesScroll } from "./lights.js";
import { newPage, hint } from "./system-kit.js";
import { buildPods } from "./system-pods.js";
import { buildPower } from "./system-power.js";
import { buildController } from "./system-controller.js";
import { buildBackup } from "./system-backup.js";
import { buildDiag, startConsoleLog } from "./system-diag.js";

export const PAGES = [
  ["signals", "Signals", "Turn color and style, flash rate, brake and tail brightness", buildSignals],
  ["pods", "Headlight pods", "Which pod lights in each switch position, dimming, strobe", buildPods],
  ["button", "Handlebar button", "Short, double and long press", buildButton],
  ["power", "Power", "Current cap per output, shared budget, calibration", buildPower],
  ["controller", "Controller", "Name, phones, firmware update, restart", buildController],
  ["backup", "Backup", "Save or restore the whole setup, start over", buildBackup],
  ["diagnostics", "Diagnostics", "Live inputs and currents, console", buildDiag],
];
const PAGE_ALIAS = { headlight: "pods", headlights: "pods", handlebar: "button", live: "diagnostics", console: "diagnostics" };

export function mountSystem(panelEl, { page } = {}) {
  startConsoleLog();
  const root = el("div", { class: "sys", id: "system" });
  panelEl.append(root);
  let cur = null, inst = null, offs = [], pageKey = PAGE_ALIAS[page] || page;
  const destroyPage = () => { if (inst && inst.destroy) { try { inst.destroy(); } catch (e) { console.error(e); } } inst = null; cur = null; };
  function list() {
    destroyPage(); clear(root);
    root.append(el("div", { class: "panel", id: "sysList" }, PAGES.map(([key, name, what]) =>
      row(name, { sub: what, id: "sys-open-" + key, onClick: () => open(key) }))),
      el("div", { class: "note sys-foot" }, "Set-once things live here. Everything about a single light is on that light's sheet."));
  }
  function open(key) {
    const def = PAGES.find(p => p[0] === key);
    if (!def) { list(); return; }
    destroyPage(); clear(root);
    const body = el("div", { class: "sys-body", id: "sys-page-" + key });
    root.append(el("div", { class: "sys-back" },
      el("button", { type: "button", class: "iconbtn", id: "sysBack", "aria-label": "Back to System", onclick: list }, icon("back", 22)),
      el("div", { class: "sys-title" }, el("b", {}, def[1]), el("small", {}, def[2]))), body);
    cur = key;
    inst = def[3](body) || {};
    if (inst.update) inst.update();
  }
  // The pages need the controller's settings; before they arrive say so, then build.
  function waitForSettings() {
    clear(root);
    root.append(panel(null, el("div", { class: "pad" }, note("Reading the controller's settings…"))));
    const off = on("settings", () => { if (!S.settings) return; off(); offs = offs.filter(f => f !== off); start(); });
    offs.push(off);
  }
  function start() {
    clear(root);
    if (pageKey && PAGES.some(p => p[0] === pageKey)) open(pageKey); else list();
    offs.push(on("settings", () => { if (inst && inst.update) inst.update(); }));
    offs.push(on("status", s => { if (inst && inst.status) inst.status(s); }));
    offs.push(on("looks", () => { if (inst && inst.looks) inst.looks(); }));
    offs.push(on("phase", () => { if (inst && inst.phase) inst.phase(); }));
  }
  if (S.settings) start(); else waitForSettings();
  return { destroy() { offs.forEach(f => f()); offs = []; destroyPage(); root.remove(); }, open, current: () => cur };
}

// ---- Signals ----------------------------------------------------------------------------------------------------
function buildSignals(host) {
  const P = newPage();
  const colorInp = el("input", { type: "color", id: "sys-turn-rgb", value: hex(S.settings.turn.rgb), "aria-label": "Turn signal color",
    oninput: () => op.set({ turn: { rgb: unhex(colorInp.value) } }, { key: "sys:turn.rgb", ms: 150 }) });
  const amber = button("Amber", { small: true, id: "sys-turn-amber", onClick: () => op.set({ turn: { rgb: [255, 96, 0] } }) });
  P.onUpdate(() => { if (document.activeElement !== colorInp && Array.isArray(S.settings.turn.rgb)) colorInp.value = hex(S.settings.turn.rgb); });
  const colorField = el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Turn signal color")),
    el("div", { class: "sys-color" }, colorInp, amber),
    el("div", { class: "hint" }, "Front and rear turn signals and the front marker. Amber puts back the default 255 / 96 / 0."));
  // Scrolling arrows (0.6.2): the line under the bike's style, and the one speed (turn.speed, missing = 5) when any style is scroll
  const scrollNote = hint(SCROLL_NOTE), scrollBox = el("div", { id: "sys-scroll-box" },
    P.slider("Arrow speed", s => s.turn.speed ?? 5, { min: 1, max: 10, id: "sys-turn-speed" }, v => ({ turn: { speed: v } })),
    hint(SCROLL_SPEED_NOTE));
  scrollNote.id = "sys-scroll-note";
  P.onUpdate(() => { scrollNote.hidden = S.settings.turn.style !== "scroll"; scrollBox.hidden = !usesScroll(S.settings); });
  const withScroll = fwAtLeast(0, 6, 2);
  scrollNote.hidden = S.settings.turn.style !== "scroll"; scrollBox.hidden = !usesScroll(S.settings);
  host.append(
    panel("Turn signals",
      colorField,
      P.select("Rear turn color", [["amber", "Same as the turn signal color"], ["red", "Red"]], s => s.turn.color, v => ({ turn: { color: v } }), "sys-turn-color"),
      P.select("Turn style", turnStyles(fwAtLeast(0, 5, 1), false, fwAtLeast(0, 6, 0), withScroll), s => s.turn.style, v => ({ turn: { style: v } }), "sys-turn-style"),
      ...(withScroll ? [scrollNote, scrollBox] : []),
      P.slider("Flash rate", s => s.blink.fpm, { min: 60, max: 120, unit: "/min", id: "sys-blink-fpm" }, v => ({ blink: { fpm: v } })),
      P.slider("On time", s => s.blink.duty, { min: 30, max: 75, unit: "%", id: "sys-blink-duty" }, v => ({ blink: { duty: v } })),
      P.toggle("Stock flasher still fitted", s => s.turn.follow, v => ({ turn: { follow: v } }),
        "On when the bike's own flasher relay is still in place, so the turn leads pulse and the lights flash with the pulses. "
        + "The turn style runs over each pulse. Off when the flasher was removed and the leads carry steady 12 V.", "sys-turn-follow")),
    panel("Brightness",
      P.slider("Turn signals", s => s.turn.pct, { min: 40, max: 100, unit: "%", id: "sys-turn-pct" }, v => ({ turn: { pct: v } })),
      P.slider("Brake", s => s.brake_pct, { min: 50, max: 100, unit: "%", id: "sys-brake-pct" }, v => ({ brake_pct: v })),
      P.slider("Tail", s => s.tail_pct, { min: 5, max: 33, unit: "%", id: "sys-tail-pct" }, v => ({ tail_pct: v })),
      hint("Tail is capped at a third of the brake level so braking stands out."),
      P.slider("Front marker", s => s.marker_pct, { min: 0, max: 50, unit: "%", id: "sys-marker-pct" }, v => ({ marker_pct: v })),
      hint("Amber glow on the front turn sections while the lights are on. 0 turns it off.")),
    panel("Key and start-up",
      P.toggle("Tail on with the key", s => s.tail_always, v => ({ tail_always: v }), "Otherwise the tail follows the headlight switch.", "sys-tail-always"),
      P.toggle("Allow red at the front", s => s.front_red, v => ({ front_red: v }),
        "Off-road and show use: lets the front turn sections show a red idle color or look (a red scanner). Off by default; red visible from the front is not road legal. Turn signals keep the turn signal color.", "sys-front-red"),
      P.slider("Start-up red", s => s.boot_red_pct, { min: 10, max: 60, unit: "%", id: "sys-boot-red" }, v => ({ boot_red_pct: v })),
      hint("Shown for a moment at key-on until the switches have been read.")));
  return { update: P.update };
}

// ---- Handlebar button ------------------------------------------------------------------------------------------
function buildButton(host) {
  const P = newPage();
  host.append(
    panel("Actions",
      P.select("Short press", BTN_ACTIONS, s => s.button.short, v => ({ button: { short: v } }), "sys-btn-short"),
      P.select("Double press", BTN_ACTIONS, s => s.button.double, v => ({ button: { double: v } }), "sys-btn-double"),
      P.select("Long press", BTN_ACTIONS, s => s.button.long, v => ({ button: { long: v } }), "sys-btn-long")),
    panel("Timing",
      P.num("Long press after", s => s.button.long_ms || 1000, { min: 300, max: 3000, step: 100, unit: "ms", id: "sys-btn-long-ms" }, v => ({ button: { long_ms: v } })),
      P.num("Double-press gap", s => s.button.gap_ms || 350, { min: 150, max: 800, step: 50, unit: "ms", id: "sys-btn-gap-ms" }, v => ({ button: { gap_ms: v } })),
      hint("A single press waits this long for a second one when a double-press action is set.")),
    note("Holding the button 5 s opens Bluetooth pairing; holding it while switching the key on starts the firmware update Wi-Fi. Diagnostics › Live shows every press as it is decoded."));
  return { update: P.update };
}
