// The Bike tab (spec 3.5): the outputs and what is chained on each, the lamp plug, Add a light, and Try it.
import { S, on, op, setSim, fwAtLeast } from "./store.js";
import { el, clear, button, armed, chips, panel, note, icon } from "./ui.js";
import { lightsOf, usedOf, loadOf, isLampOut, canAdd, LIMITS, refEq } from "./lights.js";
import { JACKS, OUT_MODES } from "./fxdata.js";
import { LAMPS, lampLabel } from "./system-kit.js";
import { startAddLight, addingOn } from "./wizard.js";
import { openLight, currentLight, onLightChange } from "./sheet.js";
import { nav, bikeView } from "./main.js";

const amps = ma => (ma / 1000).toFixed(1);
// The load line under an output (also on the light sheet's Wiring tab). `over` is for the warning color.
// all: the controller is on 0.6.3 or newer, where brake and turn come first under a cap and are held at a fixed level
// when it is tight; before that they were never dimmed and the cap was raised for them.
export function loadLine(strip, all = fwAtLeast(0, 6, 3)) {
  const ld = loadOf(strip);
  if (!ld.leds) return { text: "Nothing on this output yet.", over: false };
  if (!ld.over) return { text: `Up to ${amps(ld.fullMa)} A at full white, inside the ${amps(ld.capMa)} A cap.`, over: false };
  return { text: `Full white on everything here would be ${amps(ld.fullMa)} A. ` + (all ? `Under the ${amps(ld.capMa)} A cap brake and turn come first; looks and the bike effect share the rest and stay lit.`
    : `The ${amps(ld.capMa)} A cap dims decoration to fit; brake and turn never dim.`), over: true };
}
// The lamp plug's line: the rider's names for its four outputs once any is named (System › Headlight pods).
const lampPlugText = () => (LAMPS.some(l => ((S.settings && S.settings.lamp_label) || {})[l[0]])
  ? LAMPS.map(l => lampLabel(l[0])).join(", ") + ": switch positions, dimming and strobe are in System"
  : "Four outputs for headlights and pods: name them and choose their switch positions in System");
// What the LED total of an output is: the end of the last light (a finder may have grown px for a while).
export const usedLeds = strip => (lightsOf(strip).length ? usedOf(strip) : strip.px | 0);
const preV05 = strip => !isLampOut(strip) && !lightsOf(strip).length && ((strip.px | 0) > 0 || (strip.seg || []).length > 0);

const SIMS = [["running", "Headlight on"], ["brake", "Brake"], ["left", "Left turn"], ["right", "Right turn"], ["haz", "Hazards"]];
const LAMP_JOBS = OUT_MODES.slice(1);

export function mountBike(panelEl) {
  const outs = el("div", { id: "bikeOuts" });
  const outsCard = panel("Outputs and wiring order", outs);
  const addBtn = button("Add a light", { kind: "primary", id: "bikeAdd", onClick: () => startAddLight({ out: firstFree() }) });
  const tryChips = chips(SIMS.map(([k, l]) => [k, l]), new Set(), pick => setSim(Object.fromEntries(SIMS.map(([k]) => [k, pick.has(k) ? true : null]))), { multi: true, id: "bikeTry" });
  const tryCard = panel("Try it", el("div", { class: "pbody" }, tryChips.el,
    note("Only the picture changes. Nothing is sent to the bike.")));
  const root = el("div", { class: "bike-root" }, outsCard, el("div", { class: "pad bk-add" }, addBtn), tryCard);
  panelEl.append(root);
  const picker = new Set();   // outputs whose lamp job picker is open

  function firstFree() {
    const sts = (S.settings && S.settings.strips) || [];
    const hit = sts.findIndex(st => canAdd(st, { n: 1, sections: 1 }).ok);
    return hit < 0 ? 0 : hit;
  }
  const select = ref => { const v = bikeView(); if (v) v.select(ref); };

  function chain(st, out) {
    const cur = currentLight();
    const wrap = el("div", { class: "bk-chain" });
    lightsOf(st).forEach((L, k) => {
      if (k) wrap.append(icon("arrow", 14));
      const ref = { out, k };
      wrap.append(el("button", { type: "button", class: "bk-chip", "data-ref": `${out}:${k}`, "aria-current": cur && refEq(cur, ref) ? "true" : null,
        onclick: () => { select(ref); openLight(ref, "wiring"); } },
        el("span", { class: "n" }, L.name || "Light"), el("span", { class: "s" }, `${L.n} LEDs`)));
    });
    if (lightsOf(st).length) wrap.append(icon("arrow", 14));
    wrap.append(el("button", { type: "button", class: "bk-plus", id: `bike-add-${out}`, "aria-label": `Add a light to output ${out + 1}`, onclick: () => startAddLight({ out }) }, icon("plus", 18)));
    return wrap;
  }
  function lampRow(st, out) {
    const mode = OUT_MODES.find(m => m[0] === st.out);
    const body = el("div", { class: "bk-lamp" }, el("span", { class: "bk-lampt", id: `bikeLamp-${out}` }, mode ? mode[1] : "12 V lamp"));
    const acts = el("div", { class: "btns" });
    acts.append(button("Change", { small: true, id: `bikeLampChange-${out}`, onClick: () => { picker.has(out) ? picker.delete(out) : picker.add(out); paint(); } }));
    const rm = button("Remove", { small: true, kind: "danger", id: `bikeLampRemove-${out}` });
    armed(rm, "Tap again to remove", () => { picker.delete(out); op.strip(out, s => ({ ...s, out: "pixels" })); });
    acts.append(rm);
    body.append(acts);
    if (picker.has(out)) body.append(chips(LAMP_JOBS.map(([k, l]) => [k, l.replace("12 V lamp: ", "")]), st.out, v => { picker.delete(out); op.strip(out, s => ({ ...s, out: v })); }, { id: `bikeLampJob-${out}` }).el);
    return body;
  }
  function preRow(out) {
    const clearBtn = button("Clear this output", { small: true, kind: "danger", id: `bikeClear-${out}` });
    armed(clearBtn, "Tap again to clear", () => op.strip(out, s => { const o = { ...s, px: 0, seg: [] }; delete o.lights; delete o.geom; delete o.ord; return o; }));
    return el("div", { class: "bk-pre" }, note("Set up before this version: this output has LEDs but no lights in the list."), el("div", { class: "btns" }, clearBtn));
  }
  function paint() {
    clear(outs);
    const sts = (S.settings && S.settings.strips) || [];
    sts.forEach((st, out) => {
      const lamp = isLampOut(st), adding = addingOn() === out;
      const head = el("div", { class: "bk-head" }, el("span", { class: "t" }, `Output ${out + 1} · plug ${JACKS[out]}`),
        lamp ? null : el("span", { class: "u", id: `bikeUsed-${out}` }, `${usedLeds(st)} of ${LIMITS.px} LEDs`));
      const kids = [head];
      if (lamp) kids.push(lampRow(st, out));
      else if (adding) kids.push(note("Adding a light here…"));
      else if (preV05(st)) kids.push(preRow(out));
      else {
        const ln = loadLine(st);
        kids.push(chain(st, out), el("div", { class: ["bk-load", ln.over && "over"], id: `bikeLoad-${out}` }, ln.text));
      }
      outs.append(el("div", { class: "bk-out", id: `bikeOut-${out}`, "data-out": out }, kids));
    });
    outs.append(el("button", { type: "button", class: "row", id: "bikeLampPlug", onclick: () => nav.go("system", { page: "pods" }) },
      el("span", { class: "txt" }, el("b", {}, "Lamp plug · J6"), el("small", { id: "bikeLampPlugText" }, lampPlugText())),
      el("span", { class: "chev" }, icon("chevron"))));
  }
  paint();
  const offs = [on("settings", paint), onLightChange(() => paint()), on("status", () => {
    // another screen (or a reconnect) may have changed the preview scene: show what is pressed
    tryChips.set(new Set(SIMS.filter(([k]) => S.sim[k] === true).map(([k]) => k)));
  })];
  return {
    destroy() {
      offs.forEach(f => f());
      setSim({ running: null, brake: null, left: null, right: null, haz: null });   // Try it is only for this screen
      root.remove();
    },
  };
}
