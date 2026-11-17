// Shared bits of the System pages: the lamp tables, a tiny "page" helper that builds every control once and
// repaints it from the settings afterwards (so nothing is rebuilt while a finger is on it), and the 0.4.9 control texts.
// No DOM access at module top level.
import { S, op } from "./store.js";
import { el, slider, numRow, selectRow, toggleRow, seg, note } from "./ui.js";

// The four lamp outputs: key, the name the board gives it, where it is on the board and what it carries, and the
// short form of that for a table cell.
// The name shown in the app is the rider's own (settings.lamp_label, controller firmware 0.5.2) when there is one.
export const LAMPS = [["low", "Low output", "LOW · J6 pin 5 · 15 A", "LOW · pin 5"], ["high", "High output", "HIGH · J6 pin 6 · 15 A", "HIGH · pin 6"],
  ["aux", "Aux output", "AUX · J6 pin 7 · 7.5 A", "AUX · pin 7"], ["drl", "DRL output", "DRL · J6 pin 8 · 7.5 A", "DRL · pin 8"]];
export const lampLabel = (lamp, s = S.settings) => (s && s.lamp_label && s.lamp_label[lamp]) || (LAMPS.find(l => l[0] === lamp) || [lamp, lamp])[1];
// The outputs the extra switch lights (head.extra; left out of the settings while it is the AUX output alone).
export const extraSet = head => (head && Array.isArray(head.extra) ? head.extra : ["aux"]);
export const HEAD_STATES = [["O", "Off"], ["R", "Running"], ["L", "Low"], ["H", "High"]];
// Same tables as the firmware's applyHeadPreset().
export const HEAD_PRESETS = {
  two_feed: { low: "L", high: "H", aux: "", drl: "RLH" },
  two_feed_both: { low: "LH", high: "H", aux: "", drl: "RLH" },
  lp6: { low: "L", high: "H", aux: "H", drl: "RLH" },
};
export const HEAD_PRESET_NAMES = [["two_feed", "Two feeds"], ["two_feed_both", "Two feeds, low stays on"], ["lp6", "Baja LP6"], ["custom", "Custom"]];
export const sortMask = s => HEAD_STATES.map(h => h[0]).filter(c => String(s || "").toUpperCase().includes(c)).join("");
export function detectPreset(head) {
  for (const [k, m] of Object.entries(HEAD_PRESETS)) if (LAMPS.every(([l]) => sortMask(head[l]) === sortMask(m[l]))) return k;
  return "custom";
}
export const stripPatch = (i, o) => ({ strips: [...Array(i).fill(null), o] });
export const amps = ma => (ma / 1000).toFixed(1) + " A";

// A row of help text inside a panel.
export const hint = text => el("div", { class: "field" }, el("div", { class: "hint" }, text));

// A page: build controls with P.slider / P.toggle / P.num / P.select, each bound to a getter on the settings.
// P.update() re-reads the settings into every control (the controls ignore it while being dragged or typed in).
export function newPage() {
  const ups = [];
  const reg = (ctl, get) => { ups.push(() => { const v = S.settings ? get(S.settings) : undefined; if (v !== undefined) ctl.set(v); }); return ctl.el; };
  const cur = get => (S.settings ? get(S.settings) : undefined);
  return {
    update() { ups.forEach(f => f()); },
    onUpdate(f) { ups.push(f); },
    reg,
    // key: coalesces a drag into one `set` after 150 ms of quiet
    slider(label, get, o, mk) {
      const c = slider(label, cur(get), { min: o.min, max: o.max, step: o.step || 1, unit: o.unit || "", id: o.id,
        onInput: v => op.set(mk(v), { key: "sys:" + (o.id || label), ms: 150 }) });
      return reg(c, get);
    },
    toggle(label, get, mk, h, id) { return reg(toggleRow(label, !!cur(get), v => op.set(mk(v)), { hint: h, id }), s => !!get(s)); },
    num(label, get, o, mk) {
      return reg(numRow(label, cur(get), { min: o.min, max: o.max, step: o.step || 1, unit: o.unit, id: o.id, onCommit: v => op.set(mk(v)) }), get);
    },
    select(label, options, get, mk, id) { return reg(selectRow(label, options, cur(get), v => op.set(mk(v)), { id }), s => String(get(s))); },
    seg(options, get, mk, id) { return reg(seg(options, cur(get), v => op.set(mk(v)), { id }), get); },
    hint,
  };
}
export { note };
