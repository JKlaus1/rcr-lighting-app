// The light sheet's Wiring tab (spec 3.3): the chain on the output, LED type, LED count, color order, current, remove.
import { S, op, send } from "./store.js";
import { el, clear, button, armed, chips, selectRow, note, icon, clamp } from "./ui.js";
import { lightsOf, usedOf, orderOf, LIMITS } from "./lights.js";
import { CHIPS, CHIP_BY, ORDERS, JACKS } from "./fxdata.js";
import { createFinder, finderPanel } from "./wizard.js";
import { loadLine } from "./bike.js";
import { closeSheet } from "./sheet.js";

// What a strip really is, from what it showed. The controller sends logical R, G, B at the wire positions the order O names;
// the LED's k-th wire position drives channel T[k]. So logical red shows as T[posO(R)] = s1 and logical green as T[posO(G)] = s2,
// and blue is the channel left over. s1, s2: "R", "G" or "B". -> the true order, or null when the answers cannot tell.
// (Ported from the 0.4.9 app's mxOrderFromSeen.)
export function orderFromSeen(O, s1, s2) {
  if (!s1 || !s2 || s1 === s2 || !"RGB".includes(s1) || !"RGB".includes(s2) || !O || O.length !== 3) return null;
  const T = [];
  T[O.indexOf("R")] = s1; T[O.indexOf("G")] = s2; T[O.indexOf("B")] = "RGB".replace(s1, "").replace(s2, "");
  return T.join("");
}
const SEEN = [["R", "Red"], ["G", "Green"], ["B", "Blue"]];

export function renderWiring(body, ref) {
  const root = el("div", { class: "wr-root", id: "tab-wiring" });
  body.append(root);
  let F = null, test = null, msg = "";
  const strip = () => S.settings.strips[ref.out];
  const light = () => lightsOf(strip())[ref.k];

  // ---- the color-order test: light the light red, ask, light it green, ask ----
  const lightRun = rgb => { const L = light(); send(`find ${ref.out + 1} ${L.s} ${L.n} ${rgb.join(" ")}`); };
  function startTest() {
    test = { O: orderOf(strip(), ref.k), step: 1, s1: null };
    msg = ""; lightRun([255, 0, 0]); draw();
  }
  function endTest() { if (test) { test = null; send("find off"); } }
  function answer(seen) {
    if (test.step === 1) { test.s1 = seen; test.step = 2; lightRun([0, 255, 0]); draw(); return; }
    const got = orderFromSeen(test.O, test.s1, seen);
    endTest();
    if (!got) msg = "Could not tell the color order from those answers, so nothing was changed. Try again, or pick the order by hand.";
    else { msg = `This light uses ${got}.`; if (got !== orderOf(strip(), ref.k)) op.light.setOrder(ref.out, ref.k, got); }
    draw();
  }

  // ---- the finder on this light's range ----
  function startFind() {
    const L = light(), st = strip();
    F = createFinder({ out: ref.out, start: L.s, n: L.n, close: { px: st.px | 0 } });
    F.begin(); draw();
  }
  function endFind() { if (F) { F.stop(); F = null; } }
  function finishFind(n) {
    const L = light();
    endFind();   // px first: the light is resized from the output as it was
    if (n !== L.n) op.light.resize(ref.out, ref.k, n);
    draw();
  }

  // ---- pieces ----
  function chainBox() {
    const st = strip(), all = lightsOf(st), wrap = el("div", { class: "bk-chain" });
    all.forEach((L, k) => {
      if (k) wrap.append(icon("arrow", 14));
      wrap.append(el("span", { class: "bk-chip here", "data-k": k, "aria-current": k === ref.k ? "true" : null },
        el("span", { class: "n" }, L.name || "Light"), el("span", { class: "s" }, `LEDs ${L.s + 1} to ${L.s + L.n}`)));
    });
    const early = button("Move earlier", { id: "wrEarlier", disabled: ref.k === 0, onClick: () => op.light.move(ref.out, ref.k, -1) });
    const late = button("Move later", { id: "wrLater", disabled: ref.k >= all.length - 1, onClick: () => op.light.move(ref.out, ref.k, 1) });
    return el("div", { class: "wr-sec" }, el("div", { class: "label" }, `Output ${ref.out + 1} · plug ${JACKS[ref.out]}, in wiring order`), wrap,
      el("div", { class: "btns two" }, early, late), note("The data wire runs through the lights in this order."));
  }
  function chipRow() {
    const st = strip(), L = light(), only = lightsOf(st).length === 1;
    const opts = (only ? CHIPS : CHIPS.filter(c => c.timing === st.timing && !!c.rgbw === !!st.rgbw)).map(c => [c.key, c.label]);
    const cur = L.chip && L.chip !== "same" ? L.chip : st.chip;
    if (!opts.some(o => o[0] === cur)) opts.unshift([cur, CHIP_BY[cur] ? CHIP_BY[cur].label : "Custom LED type"]);
    const sel = selectRow("LED type", opts, cur, v => {
      const c = CHIP_BY[v];
      if (only) {
        // the only light on its output: the output's own type changes with it
        op.strip(ref.out, s => {
          Object.assign(s, { chip: c.key, timing: c.timing, rgbw: c.rgbw, lpp: c.lpp, sum: c.sum, px_ma: c.px_ma });
          const e = s.lights[ref.k]; if (e && e[4]) { delete e[4].chip; delete e[4].ma; }
          return s;
        });
      } else op.light.patch(ref.out, ref.k, { chip: v === st.chip ? "same" : v, ma: v === st.chip ? 0 : c.px_ma });
    }, { id: "wrChip" });
    return el("div", { class: "wr-sec" }, sel.el, note(only ? "This is the only light on its output, so the output takes this LED type too." : "Only LED types with the same data speed and bytes per LED as the other lights on this output are listed."));
  }
  function countRow() {
    const st = strip(), L = light(), all = lightsOf(st), last = ref.k === all.length - 1;
    const maxN = LIMITS.px - (usedOf(st) - L.n);
    const inp = el("input", { type: "number", min: 1, max: maxN, step: 1, value: L.n, id: "wrCount", inputMode: "numeric", "aria-label": "LED count" });
    inp.addEventListener("change", () => {
      const v = clamp(Math.round(Number(inp.value)) || L.n, 1, maxN);
      inp.value = v;
      if (v !== L.n) op.light.resize(ref.out, ref.k, v);
    });
    const kids = [el("label", { class: "field inline" }, el("span", { class: "lbl" }, el("b", {}, "LED count")), inp),
      last ? button("Find the last LED", { id: "wrFind", onClick: startFind })
        : note("Later lights shift when this one gets longer or shorter: their LED numbers change, and so does the position of everything after it in the chain. Type the count, then check the others with Find it.", "warn")];
    return el("div", { class: "wr-sec" }, ...kids);
  }
  function orderRow() {
    const cur = orderOf(strip(), ref.k);
    const sel = selectRow("Color order", ORDERS.map(o => [o, o]), cur, v => { msg = ""; op.light.setOrder(ref.out, ref.k, v); }, { id: "wrOrder" });
    const kids = [sel.el];
    if (!test) kids.push(button("Test the color order", { id: "wrTest", onClick: startTest }));
    else {
      kids.push(el("div", { class: "wr-test", id: "wrTestBox" },
        el("b", {}, test.step === 1 ? "The light should be red now." : "Now it should be green."), el("span", {}, "What color do you see?"),
        chips(SEEN, null, v => answer(v), { id: "wrSeen" }).el,
        button("Stop the test", { kind: "ghost", id: "wrTestStop", onClick: () => { endTest(); draw(); } })));
    }
    if (msg) kids.push(note(msg, /^Could not/.test(msg) ? "warn" : ""));
    return el("div", { class: "wr-sec" }, ...kids);
  }
  function maRow() {
    const st = strip(), L = light();
    const cur = L.chip && L.chip !== "same" ? L.chip : st.chip;
    const typeMa = L.chip && L.chip !== "same" && CHIP_BY[L.chip] ? CHIP_BY[L.chip].px_ma : st.px_ma;
    const inp = el("input", { type: "number", min: 0, max: 80, step: 1, value: L.ma || "", placeholder: String(typeMa), id: "wrMa", inputMode: "numeric", "aria-label": "Current per LED in milliamps" });
    inp.addEventListener("change", () => {
      let v = inp.value === "" ? 0 : clamp(Math.round(Number(inp.value)) || 0, 0, 80);
      if (v > 0 && v < 5) v = 5;   // the firmware accepts 0 or 5..80
      inp.value = v || "";
      if (v !== L.ma) op.light.patch(ref.out, ref.k, { ma: v });
    });
    return el("div", { class: "wr-sec" }, el("label", { class: "field inline" }, el("span", { class: "lbl" }, el("b", {}, "Current per LED, mA"), el("small", {}, "at full white")), el("span", {}, inp, el("span", { class: "unit" }, "mA"))),
      note(`Blank: the LED type's own ${typeMa} mA (${CHIP_BY[cur] ? CHIP_BY[cur].label : "this type"}). Type a number to use something else for this light.`));
  }
  function loadBox() {
    const ln = loadLine(strip());
    return el("div", { class: ["bk-load", ln.over && "over"], id: "wrLoad" }, ln.text);
  }
  function removeBox() {
    const rm = button("Remove this light", { kind: "danger", id: "wrRemove" });
    armed(rm, "Tap again to remove", () => { op.light.remove(ref.out, ref.k); closeSheet(); });
    return el("div", { class: "wr-sec" }, rm);
  }

  function draw() {
    clear(root);
    if (!S.settings || !light()) return;
    if (F) {
      root.append(el("div", { class: "label" }, "Find the last LED"),
        note("One LED is lit white on the bike and the other lights go dark while you look for it (brake and turn signals keep working). Slide until the last LED of this light is the one that is lit."),
        (parts.find = finderPanel(F, { onLast: finishFind })).el,
        button("Cancel", { kind: "ghost", id: "wrFindCancel", onClick: () => { endFind(); draw(); } }));
      return;
    }
    root.append(chainBox(), chipRow(), countRow(), orderRow(), maRow(), loadBox(), removeBox());
  }
  const parts = {};
  draw();
  return {
    update() {
      if (F || !S.settings) return;
      const a = document.activeElement;
      if (a && root.contains(a) && /^(INPUT|SELECT)$/.test(a.tagName)) return;   // do not pull a field out from under the user
      draw();
    },
    destroy() { endTest(); endFind(); if (parts.find) parts.find.destroy(); root.remove(); },
  };
}
