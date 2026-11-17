// System › Headlight pods: a name for each of the four lamp outputs, the table of which output lights in which switch
// position (and with the extra switch), its presets, brightness per position, PWM, strobe, lamp-out thresholds,
// relight, input hold, tail white as running.
// From controller firmware 0.5.2 any output may light in any position and carries the rider's own name. Up to 0.5.1
// the controller put the LOW output back on in Low, and LOW or HIGH back on in High ("1 value clamped").
import { S, op, send, fwAtLeast } from "./store.js";
import { el, button, panel, selectRow, note } from "./ui.js";
import { LAMPS, HEAD_STATES, HEAD_PRESET_NAMES, detectPreset, newPage, hint, lampLabel, extraSet } from "./system-kit.js";

const STROBE_PATS = [["together", "All together"], ["alternate", "Alternate A / B (wig-wag)"], ["double", "Double flash, A then B"]];
const STROBE_GRPS = [["0", "Not in the strobe"], ["1", "Group A"], ["2", "Group B"]];

export function buildPods(host) {
  const P = newPage();

  const free = fwAtLeast(0, 5, 2);   // the controller takes any table, names and a set for the extra switch
  // An output's name wherever this page shows it: a span that follows the settings, so a name typed at the top shows
  // in every table below at once.
  const nameOf = lamp => el("span", { "data-lamp-name": lamp }, lampLabel(lamp));
  const named = (rowEl, lamp) => { const b = rowEl.querySelector(".lbl b") || rowEl.querySelector("b"); if (b) { b.textContent = ""; b.append(nameOf(lamp)); } return rowEl; };

  // ---- a name for each output ---------------------------------------------------------------------------------------
  const nameIn = {};
  const nameRows = LAMPS.map(([lamp, label, where]) => {
    const inp = el("input", { type: "text", maxLength: 16, id: "sys-lamp-name-" + lamp, placeholder: label, value: (S.settings.lamp_label || {})[lamp] || "",
      disabled: !free, autocomplete: "off", "aria-label": `Name of the light on ${where}`,
      onchange: () => {
        // what the controller keeps, like a light's name: printable ASCII, 16 characters, no space at either end
        const v = inp.value.replace(/[^\x20-\x7e]/g, "").trim().slice(0, 16).trim();
        inp.value = v;
        if (v !== ((S.settings.lamp_label || {})[lamp] || "")) op.set({ lamp_label: { [lamp]: v } });
      } });
    inp.setAttribute("spellcheck", "false");
    nameIn[lamp] = inp;
    return el("label", { class: "field inline sys-lamp-name" }, el("span", { class: "lbl" }, el("b", {}, where)), inp);
  });
  P.onUpdate(() => {
    for (const [lamp] of LAMPS) if (document.activeElement !== nameIn[lamp]) nameIn[lamp].value = (S.settings.lamp_label || {})[lamp] || "";
    host.querySelectorAll("[data-lamp-name]").forEach(e => { const t = lampLabel(e.dataset.lampName); if (e.textContent !== t) e.textContent = t; });
  });

  // The board's own start-up light: with R32 fitted the LOW output is on from power-up until the switch has been read
  // (status.r32, firmware 0.5.2), whatever the table says. Said here because the table can now leave LOW dark.
  const r32Note = el("div", { class: "field", id: "sys-r32", hidden: true }, note("At every key-on this board lights the LOW output for a moment, before the controller has read the switch (resistor R32). A light that must stay dark at key-on belongs on another output, or R32 comes off the board.", "warn"));
  const paintR32 = () => { r32Note.hidden = !(S.status && S.status.r32); };
  paintR32();

  // ---- which output lights in which position ---------------------------------------------------------------------
  const presetSel = selectRow("Preset", HEAD_PRESET_NAMES, detectPreset(S.settings.head), v => { if (v !== "custom") op.set({ head: { preset: v } }); }, { id: "sys-head-preset" });
  const boxes = {}, extraBox = {};
  // Shown only with firmware up to 0.5.1; a tick that firmware would put back is refused here and the note turns bold.
  const ruleText = note("This controller's firmware keeps the LOW output on in Low, and LOW or HIGH on in High. Firmware 0.5.2 lifts that, and adds names for the outputs and a choice of outputs for the extra switch.", "warn");
  const ruleNote = el("div", { class: "field", id: "sys-head-rule", hidden: free }, ruleText);
  const letters = set => HEAD_STATES.map(h => h[0]).filter(x => set.has(x)).join("");
  const table = el("table", { class: "grid sys-grid", id: "sys-head-grid" },
    el("tr", {}, el("th", {}, "Output"), HEAD_STATES.map(h => el("th", {}, h[1])), free ? el("th", {}, "Extra switch") : null),
    LAMPS.map(([lamp, , , tag]) => el("tr", {}, el("td", {}, nameOf(lamp), el("small", { class: "hint" }, tag)),
      HEAD_STATES.map(([c, name]) => {
        const box = el("input", { type: "checkbox", checked: S.settings.head[lamp].includes(c), "aria-label": `${lampLabel(lamp)} in ${name}`, "data-head": `${lamp}.${c}`,
          onchange: () => {
            const cur = new Set(S.settings.head[lamp].split(""));
            if (box.checked) cur.add(c); else cur.delete(c);
            const next = letters(cur);
            if (!free) {   // the old rule: the controller would put the tick back and answer "1 value clamped"
              const h = { ...S.settings.head, [lamp]: next };
              if (!h.low.includes("L") || !(h.low + h.high).includes("H")) { box.checked = !box.checked; ruleText.className = "note bad"; return; }
            }
            op.set({ head: { [lamp]: next } });
          } });
        boxes[lamp + c] = box;
        return el("td", {}, box);
      }),
      free ? el("td", {}, extraBox[lamp] = el("input", { type: "checkbox", checked: extraSet(S.settings.head).includes(lamp), "aria-label": `${lampLabel(lamp)} with the extra switch`, "data-extra": lamp,
        onchange: () => op.set({ head: { extra: LAMPS.map(l => l[0]).filter(k => (k === lamp ? extraBox[lamp].checked : extraSet(S.settings.head).includes(k))) } }) })) : null)));
  P.onUpdate(() => {
    const h = S.settings.head;
    presetSel.set(detectPreset(h));
    for (const [lamp] of LAMPS) {
      for (const [c, name] of HEAD_STATES) { boxes[lamp + c].checked = h[lamp].includes(c); boxes[lamp + c].setAttribute("aria-label", `${lampLabel(lamp)} in ${name}`); }
      if (extraBox[lamp]) { extraBox[lamp].checked = extraSet(h).includes(lamp); extraBox[lamp].setAttribute("aria-label", `${lampLabel(lamp)} with the extra switch`); }
    }
  });

  // ---- brightness per lamp per position (PWM) -----------------------------------------------------------------------
  const pctIn = {};
  const pctTable = el("table", { class: "grid sys-grid", id: "sys-pct-grid" },
    el("tr", {}, el("th", {}, "Output"), HEAD_STATES.map(h => el("th", {}, h[1]))),
    LAMPS.map(([lamp, , , tag]) => el("tr", {}, el("td", {}, nameOf(lamp), el("small", { class: "hint" }, tag)),
      HEAD_STATES.map(([c, name], h) => {
        const n = el("input", { type: "number", min: 5, max: 100, step: 5, value: S.settings.lamp_pct[lamp][h], inputMode: "numeric",
          "aria-label": `${lampLabel(lamp)} brightness in ${name}`, "data-lamp-pct": `${lamp}.${h}`,
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
      // a position where the output is not lit by the table: the value only matters there while the extra switch lights it
      n.classList.toggle("dim", !S.settings.head[lamp].includes(c));
      n.setAttribute("aria-label", `${lampLabel(lamp)} brightness in ${HEAD_STATES[h][1]}`);
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
    panel("The four outputs",
      nameRows,
      hint(free ? "Name each output after the light that is plugged into it. The names are kept in the controller and used everywhere in the app."
        : "Naming the outputs needs controller firmware 0.5.2."),
      r32Note),
    panel("Which lights are on",
      presetSel.el, el("div", { class: "sys-scroll" }, table), ruleNote,
      hint("A tick lights that output in that position of the bike's headlight switch." + (free ? " Any output can light in any position, or in none. Extra switch: the outputs that Extra lights on the Ride tab (or a button) adds, in every position but Off." : "")),
      hint(free ? "When a light ticked in High but not in Low is out (a fault, or less current than its lamp-out value further down), the lights ticked in Low but not in High come on with what is left."
        : "When the light on the HIGH output is out in High, the LOW output comes on."),
      hint("Presets. Two feeds: a headlight with separate low and high beam wires. Baja LP6 DOT: the high-beam wire lights the whole lamp, so low and high are never on together; pods with high.")),
    panel("Brightness in each position",
      el("div", { class: "sys-scroll" }, pctTable),
      P.num("PWM frequency", s => s.lamp_pwm_hz || 200, { min: 100, max: 1000, step: 50, unit: "Hz", id: "sys-pwm-hz" }, v => ({ lamp_pwm_hz: v })),
      hint("Below 100 % an output is switched on and off fast (PWM) to dim it. 200 Hz suits most lamp drivers; try 100 or 500 if a lamp flickers or will not dim evenly. Lamps with their own driver (Baja pods) may only dim smoothly down to about 20 %; check on the bench first.")),
    panel("Strobe",
      el("div", { class: "field" }, strobeBtn, el("div", { class: "hint" }, "Runs until you stop it or the key goes off; never saved as on. Also on Ride and as a button action.")),
      P.select("Pattern", STROBE_PATS, s => s.strobe.pat, v => ({ strobe: { pat: v } }), "sys-strobe-pat"),
      P.num("Speed", s => s.strobe.hz, { min: 1, max: 10, unit: "cycles/s", id: "sys-strobe-hz" }, v => ({ strobe: { hz: v } })),
      P.num("Flash brightness", s => s.strobe.pct, { min: 5, max: 100, step: 5, unit: "%", id: "sys-strobe-pct" }, v => ({ strobe: { pct: v } })),
      LAMPS.map(([lamp, label]) => named(P.select(label, STROBE_GRPS, s => String(s.strobe.grp[lamp] | 0), v => ({ strobe: { grp: { [lamp]: Number(v) } } }), "sys-strobe-grp-" + lamp), lamp)),
      hint("While the strobe runs, the outputs in a group flash in the pattern and ignore the switch; the others keep following it. One cycle is A's flash then B's. Check on the bench how fast your lamps can flash: drivers with a soft start may come on late or dim at high speeds.")),
    panel("Lamp-out warning",
      LAMPS.map(([lamp, label]) => named(P.num(label, s => s.lamp_min_ma[lamp], { min: 0, max: 20000, step: 50, unit: "mA", id: "sys-lampmin-" + lamp }, v => ({ lamp_min_ma: { [lamp]: v } })), lamp)),
      hint("Warn when an output is on but draws less than this. 0 means nothing is expected on that output."),
      P.toggle("Tail white counts as lights on", s => s.spare_as_run, v => ({ spare_as_run: v }), null, "sys-spare-run")),
    panel("Switch inputs",
      P.num("Ride through switch dropouts up to", s => s.in_hold_ms | 0, { min: 0, max: 2000, step: 10, unit: "ms", id: "sys-in-hold" }, v => ({ in_hold_ms: v })),
      hint("0 = off. Try 200 if Diagnostics › Live counts input changes while nobody touches the switch: the bike's signal lines are dropping out. A hold keeps every light and signal on through gaps shorter than this; it only delays the switch-off, never the switch-on."),
      P.toggle("Re-strike a lamp that goes dark", s => s.lamp_relight !== false, v => ({ lamp_relight: v }),
        "A lamp that was drawing current and reads nothing for 0.4 s while on gets its feed cycled off for 0.5 s to clear a latched driver, at most every 5 s. Counted under counters in the console.", "sys-relight")));
  return { update: P.update, status() { paintStrobe(); paintR32(); } };
}
