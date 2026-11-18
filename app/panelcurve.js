// "Curve the panel" (0.6.0, spec 5.2): the box on the Placement tab of a matrix light. Flat, Wraps round the rear (side length,
// corner radius, rear width) or Custom (pieces like the strip shape builder's: Straight, Bend). The geometry is panelbend.js;
// this is only the screen. onChange(bend) is called with the new curve (null = flat) and returns "" or why it could not be used.
import { el, button, seg, note, clamp } from "./ui.js";
import { UNITS, show, sized, unitPref, setUnitPref } from "./barshape.js";
import * as PB from "./panelbend.js";

const NS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, String(v));
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
const r2 = v => Math.round(v * 100) / 100;
export const KINDS = [["flat", "Flat"], ["wrap", "Wraps round the rear"], ["custom", "Custom"]];
export const kindOf = bend => (bend ? bend.kind : "flat");

// The top view: the profile as a band, the LED columns as dots, seen from above with the LEDs facing up the page.
export function picture(design, bend, width) {
  const T = PB.topView(design, bend, width), b = T.box;
  const pitch = 1000 / (design.den || 60), band = Math.max(2, (design.thick || 5) * 0.6);
  const span = Math.max(b.x1 - b.x0, b.w1 - b.w0, 40), m = Math.max(span * 0.08, band * 2);
  const X = x => r2(x - b.x0 + m), Y = w => r2(b.w1 - w + m);   // the drawing's y runs down; the LED side is up
  const wv = r2(b.x1 - b.x0 + 2 * m), hv = r2(b.w1 - b.w0 + 2 * m);
  const svg = sv("svg", { class: "bs-svg pl-cv-svg", viewBox: `0 0 ${wv} ${hv}`, role: "img", preserveAspectRatio: "xMidYMid meet",
    "aria-label": bend ? "The panel from above, curved" : "The panel from above, flat" });
  svg.setAttribute("style", `aspect-ratio: ${wv} / ${hv}`);
  svg.append(sv("path", { class: "bs-band", "stroke-width": r2(band), d: T.line.map((p, i) => `${i ? "L" : "M"}${X(p[0])} ${Y(p[1])}`).join(" ") }));
  const dot = Math.max(band * 0.45, Math.min(pitch * 0.32, band * 0.8));
  T.dots.forEach((p, i) => svg.append(sv("circle", { class: "bs-led" + (i === 0 ? " first" : i === T.dots.length - 1 ? " last" : ""), cx: X(p[0]), cy: Y(p[1]), r: r2(dot), "data-col": i })));
  return svg;
}

// ctx: { design, bend, width, onChange(bend) -> why or "", why }
export function curveBox({ design, bend, width, onChange, why = "" }) {
  let unit = unitPref();
  const box = el("div", { class: "wr-sec", id: "plCurve" }, el("div", { class: "label" }, "Curve the panel"));
  const blocked = PB.checkDesign(design);
  if (blocked) { box.append(el("p", { class: "note warn", id: "plCurveWhy" }, blocked), note("Flat is the only choice for this panel for now."), seg(KINDS.slice(0, 1), "flat", () => {}, { id: "plCurveKind" }).el); return box; }
  const kind = kindOf(bend);
  const length = PB.lengthOf(bend);
  const change = next => {
    const res = onChange(next);
    if (res) { msg.textContent = res; msg.hidden = false; }
  };
  const msg = el("p", { class: "note warn", id: "plCurveMsg", hidden: !why }, why);
  box.append(note("A panel wrapped round something sits where it really is. Each LED goes where the curve puts it across the panel's width; its height stays. The middle of the panel stays where the flat panel's middle is."),
    seg(KINDS, kind, v => {
      if (v === kind) return;
      if (v === "flat") change(null);
      else if (v === "wrap") change(kind === "custom" ? PB.defaultWrap(width, bend.bulge) : PB.defaultWrap(width, bend ? bend.bulge : "toward"));
      else change(PB.toCustom(bend, width));
    }, { id: "plCurveKind" }).el);
  if (!bend) { box.append(note(`The panel is ${sized(width, unit)} wide and lies flat.`), picture(design, null, width), msg); return box; }

  const unitSeg = seg([["in", "Inches"], ["mm", "Millimeters"]], unit, v => { unit = v; setUnitPref(v); const nb = curveBox({ design, bend, width, onChange, why }); box.replaceWith(nb); }, { id: "plCvUnit" });
  const field = (label, mm, id, set, { lo = 0.1, hi = 6000, deg = false } = {}) => {
    const val = () => (deg ? r2(mm) : show(mm, unit));
    const inp = el("input", { type: "number", id, inputMode: "decimal", "aria-label": label, step: deg ? 1 : UNITS[unit].step, value: val() });
    inp.addEventListener("change", () => {
      const v = Number(inp.value);
      if (inp.value === "" || !Number.isFinite(v)) { inp.value = val(); return; }
      inp.blur();   // the tab is rebuilt by the change that follows, which it does not do under a field with the focus
      set(deg ? v : r2(v * UNITS[unit].per));
    });
    return el("label", { class: "pl-f" }, el("span", {}, label), inp);
  };
  const setWrap = patch => {
    const w = { ...bend, ...patch };
    // the sides are what is left of the panel's width, until a length is typed for them
    const was = PB.wrapSide(width, bend.radius, bend.rear);
    if (!("side" in patch) && Math.abs(bend.side - was) < 0.06) w.side = PB.wrapSide(width, w.radius, w.rear);
    change(PB.validBend(w) ? w : bend);
  };
  if (bend.kind === "wrap") {
    box.append(el("div", { class: "pl-pt" },
      field(`Side length (${unit})`, bend.side, "plCvSide", mm => setWrap({ side: clamp(mm, 0, 6000) })),
      field(`Corner radius (${unit})`, bend.radius, "plCvRadius", mm => setWrap({ radius: clamp(mm, 2, 6000) })),
      field(`Rear width (${unit})`, bend.rear, "plCvRear", mm => setWrap({ rear: clamp(mm, 0.1, 6000) }))),
      note("Two 90 degree corners. The side lengths follow the other two sizes so the curve is as long as the panel."));
  } else {
    const rows = el("div", { class: "bs-rows", id: "plCvPieces" });
    const put = pieces => change({ ...bend, pieces });
    bend.pieces.forEach((p, i) => {
      const row = el("div", { class: "pl-pt pl-cv-row", "data-piece": i }, el("b", { class: "pl-led" }, p.t === "s" ? `Piece ${i + 1}: Straight` : `Piece ${i + 1}: Bend`));
      if (p.t === "s") row.append(field(`Length (${unit})`, p.len, `plCvLen-${i}`, mm => put(bend.pieces.map((q, j) => (j === i ? { ...q, len: clamp(mm, 0.1, 6000) } : q)))));
      else {
        row.append(field("Angle (degrees)", p.dir < 0 ? -p.deg : p.deg, `plCvAng-${i}`, a => { if (Math.abs(a) >= 1 && Math.abs(a) <= 360) put(bend.pieces.map((q, j) => (j === i ? { ...q, deg: Math.abs(a), dir: a < 0 ? -1 : 1 } : q))); }, { deg: true }),
          field(`Radius (${unit})`, p.r, `plCvRad-${i}`, mm => put(bend.pieces.map((q, j) => (j === i ? { ...q, r: clamp(mm, 2, 6000) } : q)))));
      }
      row.append(button("Remove", { small: true, kind: "ghost", id: `plCvDel-${i}`, disabled: bend.pieces.length < 2, onClick: () => put(bend.pieces.filter((_, j) => j !== i)) }));
      rows.append(row);
    });
    box.append(rows, el("div", { class: "pl-bar-row" },
      button("Add a straight piece", { id: "plCvAddS", disabled: bend.pieces.length >= PB.MAX_BEND_PIECES, onClick: () => put([...bend.pieces, { t: "s", len: 25.4 }]) }),
      button("Add a bend", { id: "plCvAddB", disabled: bend.pieces.length >= PB.MAX_BEND_PIECES, onClick: () => put([...bend.pieces, { t: "b", r: 25.4, deg: 90, dir: 1 }]) })),
      note("Pieces run from the panel's left edge to its right edge. A bend curls the way the corners of Wraps round the rear do; a negative angle curls the other way."));
  }
  box.append(el("div", { class: "label" }, "The middle bulges"),
    seg([["toward", "Toward the LEDs"], ["away", "Away from the LEDs"]], bend.bulge, v => change({ ...bend, bulge: v }), { id: "plCvBulge" }).el,
    el("div", { class: "label" }, "Sizes in"), unitSeg.el,
    el("div", { class: "pl-cv-pic", id: "plCvPic" }, picture(design, bend, width)),
    el("p", { class: "pl-shape", id: "plCvInfo" }, `Curve ${sized(length, unit)} long · panel ${sized(width, unit)} wide`),
    note("Seen from above, the LEDs face up the page. Dots are the LED columns, the first one green and the last one amber."), msg);
  return box;
}
