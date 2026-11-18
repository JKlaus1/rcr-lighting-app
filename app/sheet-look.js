// The light sheet's Look tab (spec 3.3): what the light shows at rest, its own look, brightness, and the switches.
// Everything is live through op.light.patch; slider drags and color drags are coalesced by key.
import { S, on, op, mirror, fwAtLeast } from "./store.js";
import { el, clear, seg, slider, toggleRow, selectRow, panel, note, button, ledStrip } from "./ui.js";
import { lightsOf, sectionsOf, areasOf, cellGrid, textSharers } from "./lights.js";
import { RESTS, turnStyles, TURN_ROLES } from "./fxdata.js";
import { fxEditor } from "./fx.js";
import { openBikeEffect } from "./sheet.js";

const lightOf = ref => { const st = S.settings && S.settings.strips[ref.out]; return st ? lightsOf(st)[ref.k] || null : null; };
// a turn section, or a turn area of a panel (0.6.0): either one takes the light's turn signal style
const hasTurn = ref => { const st = S.settings.strips[ref.out]; return sectionsOf(st, ref.k).sections.some(s => TURN_ROLES.includes(s.role)) || areasOf(st, ref.k).some(a => TURN_ROLES.includes(a.role)); };

export function renderLook(body, ref) {
  const root = el("div", { class: "look-tab", id: "tab-look" });
  body.append(root);
  const key = f => `lt${ref.out}.${ref.k}:${f}`;
  const patch = (fields, o) => op.light.patch(ref.out, ref.k, fields, o);

  // rest switch and the strip that shows what the light's LEDs do right now
  const L0 = lightOf(ref);
  const rest = seg(RESTS, L0.rest, v => patch({ rest: v }), { id: "look-rest" });
  const strip = ledStrip({ wide: true });
  strip.el.id = "look-preview";
  const draw = () => {
    const L = lightOf(ref);
    if (L && mirror && mirror.pxCount(ref.out) >= L.s + L.n) strip.draw(mirror.px(ref.out), L.s, L.n);
  };
  const offFrame = on("frame", draw);
  root.append(el("div", { class: "look-rest" }, el("div", { class: "label" }, "At rest this light shows"), rest.el, strip.el));

  const dyn = el("div", { class: "look-dyn" });
  root.append(dyn);
  let shape = "", editor = null, pct = null, master = null, solo = null, ts = null;

  // what is below the switch depends on the rest choice and on whether the light has a turn section
  function build(L) {
    if (editor) { editor.destroy(); editor = null; }
    clear(dyn);
    if (L.rest === "own") {
      const box = el("div", { class: "panel pad look-fx" });
      editor = fxEditor(box, {
        preview: false,
        get: () => (lightOf(ref) || L).look,
        set: (fields, o) => patch({ look: fields }, o && o.key ? { key: key(o.key), ms: o.ms } : undefined),
        // Scrolling text: a light that has cells, on a controller that knows it (0.6.1). The text belongs to the output.
        text: {
          avail: () => fwAtLeast(0, 6, 1) && cellGrid(S.settings.strips[ref.out], ref.k).count > 0,
          get: () => { const st = S.settings.strips[ref.out]; return { text: st.text || "", scroll: !!st.text_scroll, cols: cellGrid(st, ref.k).cols, shared: textSharers(S.settings, ref.out, ref.k).map(x => x.name) }; },
          setText: v => op.text.set(ref.out, v),
          setScroll: v => op.text.scroll(ref.out, v),
        },
      });
      dyn.append(box);
    } else if (L.rest === "bike") {
      dyn.append(el("div", { class: "look-line" }, note("It shows the bike effect. Change that once on Ride and every light that follows it changes with it."),
        button("Edit the bike effect", { id: "look-edit-bike", onClick: () => openBikeEffect() })));
    } else {
      dyn.append(note("Dark unless it is braking, signaling or showing the DRL.", null));
    }
    pct = slider("Brightness", L.pct, { min: 0, max: 100, step: 1, unit: "%", id: "look-pct", onInput: v => patch({ pct: v }, { key: key("pct"), ms: 150 }) });
    master = solo = ts = null;
    const kids = [pct.el];
    if (L.rest === "own") {
      master = toggleRow("Stays on when Accent lights are off", !L.look.master, v => patch({ look: { master: !v } }), { id: "look-master" });
      kids.push(master.el);
    }
    solo = toggleRow("Keeps its look when the bike effect runs on every light", !!L.solo, v => patch({ solo: v }), { id: "look-solo" });
    kids.push(solo.el);
    if (hasTurn(ref)) {
      ts = selectRow("Turn signal style", turnStyles(fwAtLeast(0, 5, 1), true, fwAtLeast(0, 6, 0)), L.ts, v => patch({ ts: v }), { id: "look-ts" });
      kids.push(ts.el);
    }
    dyn.append(panel(null, ...kids));
  }
  function shapeOf(L) { return L.rest + "|" + hasTurn(ref); }

  function update() {
    const L = lightOf(ref);
    if (!L) return;
    rest.set(L.rest);
    if (shapeOf(L) !== shape) { shape = shapeOf(L); build(L); return; }
    if (editor) editor.update();
    pct.set(L.pct);
    if (master) master.set(!L.look.master);
    solo.set(!!L.solo);
    if (ts) ts.set(L.ts);
  }
  shape = shapeOf(L0);
  build(L0);

  return { update, destroy() { offFrame(); if (editor) editor.destroy(); root.remove(); } };
}
