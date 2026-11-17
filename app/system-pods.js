// System › Headlight pods: the headlight table and its presets, brightness per position, PWM, strobe, lamp-out
// thresholds, relight, input hold, tail white as running. Ported from the 0.4.9 Setup tab.
import { S, op, send } from "./store.js";
import { el, button, panel, selectRow } from "./ui.js";
import { LAMPS, HEAD_STATES, HEAD_PRESET_NAMES, detectPreset, newPage, hint } from "./system-kit.js";

const STROBE_PATS = [["together", "All together"], ["alternate", "Alternate A / B (wig-wag)"], ["double", "Double flash, A then B"]];
const STROBE_GRPS = [["0", "Not in the strobe"], ["1", "Group A"], ["2", "Group B"]];

export function buildPods(host) {
  const P = newPage();

  // ---- the headlight table ---------------------------------------------------------------------------------------
  const presetSel = selectRow("Lamp type", HEAD_PRESET_NAMES, detectPreset(S.settings.head), v => { if (v !== "custom") op.set({ head: { preset: v } }); }, { id: "sys-head-preset" });
  const boxes = {};
  const table = el("table", { class: "grid sys-grid", id: "sys-head-grid" },
    el("tr", {}, el("th", {}, "Output"), HEAD_STATES.map(h => el("th", {}, h[1]))),
    LAMPS.map(([lamp, label, pin]) => el("tr", {}, el("td", {}, label, el("small", { class: "hint" }, pin)),
      HEAD_STATES.map(([c, name]) => {
        const box = el("input", { type: "checkbox", checked: S.settings.head[lamp].includes(c), "aria-label": `${label} in ${name}`, "data-head": `${lamp}.${c}`,
          onchange: () => {
            const cur = new Set(S.settings.head[lamp].split(""));
            if (box.checked) cur.add(c); else cur.delete(c);
            op.set({ head: { [lamp]: HEAD_STATES.map(h => h[0]).filter(x => cur.has(x)).join("") } });
          } });
        boxes[lamp + c] = box;
        return el("td", {}, box);
      }))));
  P.onUpdate(() => {
    const h = S.settings.head;
    presetSel.set(detectPreset(h));
    for (const [lamp] of LAMPS) for (const [c] of HEAD_STATES) boxes[lamp + c].checked = h[lamp].includes(c);
  });

  // ---- brightness per lamp per position (PWM) -----------------------------------------------------------------------
  const pctIn = {};
  const pctTable = el("table", { class: "grid sys-grid", id: "sys-pct-grid" },
    el("tr", {}, el("th", {}, "Output"), HEAD_STATES.map(h => el("th", {}, h[1]))),
    LAMPS.map(([lamp, label, pin]) => el("tr", {}, el("td", {}, label, el("small", { class: "hint" }, pin)),
      HEAD_STATES.map(([c, name], h) => {
        const n = el("input", { type: "number", min: 5, max: 100, step: 5, value: S.settings.lamp_pct[lamp][h], inputMode: "numeric",
          "aria-label": `${label} brightness in ${name}`, "data-lamp-pct": `${lamp}.${h}`,
          onchange: () => {
            const v = Math.min(100, Math.max(5, Number(n.value) | 0)); n.value = v;
            const a = [null, null, null, null]; a[h] = v;
            op.set({ lamp_pct: { [lamp]: a } });
          } });
        pctIn[lamp + h] = n;
        return el("td", {}, n);
      }))));
  P.onUpdate(() => {
    for (const [lamp] of LAMPS) HEAD_STATES.forEach(([c], h) => {
      const n = pctIn[lamp + h];
      if (document.activeElement !== n) n.value = S.settings.lamp_pct[lamp][h];
      n.classList.toggle("dim", !S.settings.head[lamp].includes(c));   // a position where the lamp is not lit: the value does not matter
    });
  });

  // ---- strobe -----------------------------------------------------------------------------------------------------
  const live = () => !!(S.status && S.status.sb);
  const strobeBtn = button("Strobe now", { id: "sys-strobe-now", pressed: false, onClick: () => send("strobe toggle") });
  const paintStrobe = () => {
    strobeBtn.setAttribute("aria-pressed", String(live()));
    strobeBtn.classList.toggle("primary", live());
    strobeBtn.textContent = live() ? "Strobe is on: tap to stop" : "Strobe now";
  };
  paintStrobe();

  // ---- the page ----------------------------------------------------------------------------------------------------
  host.append(
    panel("Headlight",
      presetSel.el, table,
      hint("Ticks set which outputs light in each switch position. Two feeds: separate low and high beam wires. Baja LP6 DOT: the high-beam wire lights the whole lamp, so low and high are never on together; pods with high.")),
    panel("Brightness in each position",
      el("div", { class: "sys-scroll" }, pctTable),
      P.num("PWM frequency", s => s.lamp_pwm_hz || 200, { min: 100, max: 1000, step: 50, unit: "Hz", id: "sys-pwm-hz" }, v => ({ lamp_pwm_hz: v })),
      hint("Below 100 % an output is switched on and off fast (PWM) to dim it. 200 Hz suits most lamp drivers; try 100 or 500 if a lamp flickers or will not dim evenly. Lamps with their own driver (Baja pods) may only dim smoothly down to about 20 %; check on the bench first.")),
    panel("Strobe",
      el("div", { class: "field" }, strobeBtn, el("div", { class: "hint" }, "Runs until you stop it or the key goes off; never saved as on. Also on Ride and as a button action.")),
      P.select("Pattern", STROBE_PATS, s => s.strobe.pat, v => ({ strobe: { pat: v } }), "sys-strobe-pat"),
      P.num("Speed", s => s.strobe.hz, { min: 1, max: 10, unit: "cycles/s", id: "sys-strobe-hz" }, v => ({ strobe: { hz: v } })),
      P.num("Flash brightness", s => s.strobe.pct, { min: 5, max: 100, step: 5, unit: "%", id: "sys-strobe-pct" }, v => ({ strobe: { pct: v } })),
      LAMPS.map(([lamp, label, pin]) => P.select(`${label} (${pin})`, STROBE_GRPS, s => String(s.strobe.grp[lamp] | 0), v => ({ strobe: { grp: { [lamp]: Number(v) } } }), "sys-strobe-grp-" + lamp)),
      hint("While the strobe runs, the outputs in a group flash in the pattern and ignore the switch; the others keep following it. One cycle is A's flash then B's. Check on the bench how fast your lamps can flash: drivers with a soft start may come on late or dim at high speeds.")),
    panel("Lamp-out warning",
      LAMPS.map(([lamp, label]) => P.num(label, s => s.lamp_min_ma[lamp], { min: 0, max: 20000, step: 50, unit: "mA", id: "sys-lampmin-" + lamp }, v => ({ lamp_min_ma: { [lamp]: v } }))),
      hint("Warn when an output is on but draws less than this. 0 means nothing is expected on that output."),
      P.toggle("Tail white counts as lights on", s => s.spare_as_run, v => ({ spare_as_run: v }), null, "sys-spare-run")),
    panel("Switch inputs",
      P.num("Ride through switch dropouts up to", s => s.in_hold_ms | 0, { min: 0, max: 2000, step: 10, unit: "ms", id: "sys-in-hold" }, v => ({ in_hold_ms: v })),
      hint("0 = off. Try 200 if Diagnostics › Live counts input changes while nobody touches the switch: the bike's signal lines are dropping out. A hold keeps every light and signal on through gaps shorter than this; it only delays the switch-off, never the switch-on."),
      P.toggle("Re-strike a lamp that goes dark", s => s.lamp_relight !== false, v => ({ lamp_relight: v }),
        "A lamp that was drawing current and reads nothing for 0.4 s while on gets its feed cycled off for 0.5 s to clear a latched driver, at most every 5 s. Counted under counters in the console.", "sys-relight")));
  return { update: P.update, status: paintStrobe };
}
