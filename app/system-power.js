// System › Power: current cap and LED current per output (with the load line from lights.loadOf), the shared budgets,
// converter size, calibration (`cal`) and the output test. Ported from the 0.4.9 Setup / Bike / Map panels.
import { S, op, send, refresh } from "./store.js";
import { el, button, panel, note, selectRow, numRow, toast } from "./ui.js";
import { loadOf, isLampOut, lightsOf } from "./lights.js";
import { JACKS, OUT_MODES } from "./fxdata.js";
import { newPage, hint, stripPatch, amps } from "./system-kit.js";

export const CAL_CHANNELS = [["low", "Low beam"], ["high", "High beam"], ["aux", "Pods"], ["drl", "DRL"], ["s1", "Strip 1 (J3)"], ["s2", "Strip 2 (J4)"],
  ["s3", "Strip 3 (J5)"], ["s4", "Strip 4 (J15)"], ["acc1", "Accessory 1"], ["acc2", "Accessory 2"]];
const OUT_TEST = [["low", "Low beam", "J6 pin 5"], ["high", "High beam", "J6 pin 6"], ["aux", "Pods", "J6 pin 7"], ["drl", "DRL", "J6 pin 8"],
  ["s1", "Output 1", "J3"], ["s2", "Output 2", "J4"], ["s3", "Output 3", "J5"], ["s4", "Output 4", "J15"]];

// The one-line load statement for an output (also used by the tests).
export function loadLine(strip) {
  const ld = loadOf(strip);
  if (!ld.leds) return "No LEDs on this output.";
  const per = ld.fullMa / ld.leds, fits = Math.max(0, Math.floor(ld.capMa / per));
  return ld.over
    ? `Full white on all ${ld.leds} LEDs would draw up to ${amps(ld.fullMa)}, over the ${amps(ld.capMa)} cap: the limiter dims the bike effect and looks above about ${fits} LEDs at full white.`
    : `Up to ${amps(ld.fullMa)} at full white, inside the ${amps(ld.capMa)} cap.`;
}

export function buildPower(host) {
  const P = newPage();
  const outs = [0, 1, 2, 3].map(i => {
    const st = () => S.settings.strips[i];
    const loadEl = note("");
    const lamp = isLampOut(st());
    const fields = [];
    if (lamp) {
      fields.push(P.num("Lamp-out below", s => s.strips[i].lamp_min_ma, { min: 0, max: 7000, step: 50, unit: "mA", id: `sys-lampmin-out${i + 1}` }, v => stripPatch(i, { lamp_min_ma: v })),
        hint("Warn when the lamp is on but draws less than this (a 21 W bulb draws about 1700 mA). 0 = no check."));
    }
    fields.push(
      P.num("Current cap", s => s.strips[i].cap_ma, { min: 500, max: 7000, step: 100, unit: "mA", id: `sys-cap-out${i + 1}` }, v => stripPatch(i, { cap_ma: v })));
    if (!lamp) fields.push(
      P.num("Default LED current", s => s.strips[i].px_ma, { min: 5, max: 80, step: 1, unit: "mA", id: `sys-pxma-out${i + 1}` }, v => stripPatch(i, { px_ma: v })),
      hint("Per LED at full white, measured on the 12 V side. A light with its own current on its Wiring tab uses that instead."));
    const title = el("span", {}, `Output ${i + 1} · ${JACKS[i]}`);
    const p = panel(null, el("div", { class: "ptitle" }, title), fields, el("div", { class: "field" }, loadEl));
    P.onUpdate(() => {
      const s = st(), isLamp = isLampOut(s);
      const lights = lightsOf(s).length;
      title.textContent = `Output ${i + 1} · ${JACKS[i]} · ` + (isLamp ? (OUT_MODES.find(m => m[0] === s.out) || [0, "12 V lamp"])[1] : s.px ? `${s.px} LEDs, ${lights} ${lights === 1 ? "light" : "lights"}` : "unused");
      loadEl.textContent = isLamp ? `${JACKS[i]} pin 1 carries 12 V, up to 7.5 A; the current shows in Diagnostics › Live.` : loadLine(s);
      loadEl.className = "note" + (!isLamp && loadOf(s).over ? " warn" : "");
    });
    return p;
  });

  // ---- shared budgets ---------------------------------------------------------------------------------------------
  const budgetNote = note("");
  P.onUpdate(() => { const b = S.settings.budget; budgetNote.textContent = `Shared by all four outputs. The headlight, pods and DRL take about 15 A when lit; the converter gives ${(b.conv_ma / 1000).toFixed(0)} A.`; });
  const budget = panel("Shared current budget",
    P.slider("Headlight Low or High", s => s.budget.lit_ma / 1000, { min: 2, max: 28, step: 0.5, unit: "A", id: "sys-budget-lit" },
      v => ({ budget: { lit_ma: Math.round(v * 1000), dark_ma: Math.max(S.settings.budget.dark_ma, Math.round(v * 1000)) } })),
    P.slider("Headlight Off or Running", s => s.budget.dark_ma / 1000, { min: 2, max: 28, step: 0.5, unit: "A", id: "sys-budget-dark" },
      v => ({ budget: { lit_ma: Math.min(S.settings.budget.lit_ma, Math.round(v * 1000)), dark_ma: Math.round(v * 1000) } })),
    P.slider("Converter size", s => s.budget.conv_ma / 1000, { min: 10, max: 60, step: 1, unit: "A", id: "sys-budget-conv" }, v => ({ budget: { conv_ma: Math.round(v * 1000) } })),
    el("div", { class: "field" }, budgetNote));

  // ---- calibration ------------------------------------------------------------------------------------------------
  const calCh = selectRow("Channel", CAL_CHANNELS, "low", () => {}, { id: "sys-cal-ch" });
  const calAmps = numRow("Clamp meter reading", "", { min: 0.3, max: 40, step: 0.01, unit: "A", id: "sys-cal-amps" });
  const calBtn = button("Calibrate", { id: "sys-cal-go", onClick: () => {
    const a = Number(calAmps.input.value);
    if (!(a >= 0.3)) { toast("Enter the clamp meter reading first (at least 0.3 A)", "warn"); return; }
    send(`cal ${calCh.input.value} ${a}`).then(() => refresh());
  } });
  const calibrate = panel("Current readings", calCh.el, calAmps.el,
    el("div", { class: "field" }, el("div", { class: "hint" }, "With the load on, measure it with a clamp meter and enter the reading."), el("div", { class: "btns", style: "margin-top:8px" }, calBtn)));

  // ---- output test ---------------------------------------------------------------------------------------------------
  let touched = false;
  const run = cmds => { touched = true; cmds.forEach(c => send(c)); };
  const testRows = OUT_TEST.map(([key, name, pin]) => {
    const n = /^s(\d)$/.exec(key);
    const b = (label, cmds) => button(label, { small: true, data: { out: key + ":" + label.toLowerCase() }, onClick: () => run(cmds) });
    return el("div", { class: "field sys-test" }, el("span", { class: "lbl" }, el("b", {}, name), el("span", {}, pin)),
      el("div", { class: "btns" },
        b("On", n ? [`out ${key} on`, `fill ${n[1]} 48 48 48`] : [`out ${key} on`]),
        b("Off", n ? [`fill ${n[1]} off`, `out ${key} off`] : [`out ${key} off`]),
        b("Auto", n ? [`fill ${n[1]} off`, `out ${key} auto`] : [`out ${key} auto`])));
  });
  const clearBtn = button("Clear all overrides", { id: "sys-test-clear", onClick: () => { touched = false; send("bench off"); } });
  const test = panel("Output test", testRows,
    el("div", { class: "field" }, el("div", { class: "btns" }, clearBtn),
      el("div", { class: "hint", style: "margin-top:8px" }, "Forces one output at a time for bench checks: lamps get 12 V, LED outputs get 12 V and a dim white fill. Only while the bike is parked (lights off, no brake or turn signal). Overrides last 10 minutes; Clear all, leaving this page or key off ends them.")));

  host.append(...outs, budget, calibrate, test);
  // Leaving the page puts every forced output back to the firmware.
  return { update: P.update, destroy() { if (touched) send("bench off"); } };
}
