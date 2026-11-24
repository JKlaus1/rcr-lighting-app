// Areas of a panel (0.6.0, spec 5.3): the Sections tab of a matrix light. A block of the panel's columns x rows with a job
// (brake, tail, a turn signal, DRL) that the controller draws over the panel's look, so the brake can be a band along the
// bottom rows all the way round and the turn signals can sit on the top half. The model is lights.js (areasOf, withAreas);
// every change goes to the controller at once through op.light.setAreas.
// The panel is drawn as a grid of its columns and rows (as the controller has them: the path points' cells). Drag over it, or
// tap two corners, to mark a block, then tap the job. Numbers shown are 1-based.
import { S, op, fwAtLeast, mirror } from "./store.js";
import { el, clear, button, armed, chips, seg, selectRow, toggleRow, note, clamp } from "./ui.js";
import { lightsOf, areasOf, areaCount, cellGrid, AREA_MAX } from "./lights.js";
import { ROLE_BY, TAIL_ROLES, TURN_ROLES } from "./fxdata.js";

export const AREA_JOBS = [["brake", "Brake"], ["tail", "Tail"], ["turn_l", "Left turn"], ["turn_r", "Right turn"],
  ["tail_turn_l", "Tail + left turn"], ["tail_turn_r", "Tail + right turn"], ["drl", "DRL"]];
const JOB_NAME = Object.fromEntries(AREA_JOBS);
export const DIRECTIONS = [["lr", "Left to right"], ["rl", "Right to left"], ["up", "Up"], ["down", "Down"]];
const NS = "http://www.w3.org/2000/svg";
const sv = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, String(v));
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
// which way an area runs, as the words the list shows, and back
export const directionOf = a => (a.vert ? (a.rev ? "up" : "down") : (a.rev ? "rl" : "lr"));
export const flagsOf = dir => ({ vert: dir === "up" || dir === "down", rev: dir === "rl" || dir === "up" });
// A new turn area runs outward: toward the nearer side edge of the panel (a block in the left half runs right to left).
export function outward(role, c0, c1, cols) {
  const mid = (c0 + c1) / 2, centre = (cols - 1) / 2;
  const left = mid < centre ? true : mid > centre ? false : /_l$/.test(role);
  return left ? "rl" : "lr";
}
export const isTurn = role => TURN_ROLES.includes(role);
export const rectOf = (a, b) => ({ c0: Math.min(a.c, b.c), r0: Math.min(a.r, b.r), c1: Math.max(a.c, b.c), r1: Math.max(a.r, b.r) });

export function renderAreas(host, ref) {
  const root = el("div", { class: "ar-root", id: "sec-areas" });
  host.append(root);
  let sel = null, corner = null, dragging = null, msg = "", moved = false;
  const stripOf = () => S.settings.strips[ref.out];
  const lightOf = () => lightsOf(stripOf())[ref.k];
  const grid = () => cellGrid(stripOf(), ref.k);
  // More or bigger areas raise what the output's brake, tail and turn LEDs can need at once. From 0.6.3 the controller keeps
  // the output's current cap as it is and holds those LEDs at a fixed level when they need more than three quarters of
  // it: said here when that is so. Up to 0.6.2 it raised the cap instead, with only "1 value clamped" as its note.
  let capNote = "";
  // 0.6.3: read from the bike as it is now, so the line goes away when the cap is raised or the areas shrink.
  const capText = () => {
    if (!fwAtLeast(0, 6, 3)) return capNote;
    const cap = stripOf().cap_ma | 0, worst = mirror ? mirror.worstMa(ref.out) : 0, held = mirror ? mirror.heldPct(ref.out) : 100;
    return held < 100 ? `The brake, tail and turn LEDs on output ${ref.out + 1} can need up to ${worst} mA, more than three quarters of its ${cap} mA current cap: the cap holds them at about ${held} %. To bring them back to full, raise the cap in System › Power.` : "";
  };
  const send = list => {
    const before = stripOf().cap_ma | 0;
    if (!op.light.setAreas(ref.out, ref.k, list)) { msg = "Areas need the 0.6.0 controller update."; return; }
    const after = stripOf().cap_ma | 0;
    if (!fwAtLeast(0, 6, 3) && after > before) capNote = `Output ${ref.out + 1}'s current cap went up from ${before} mA to ${after} mA so that brake, tail and turn LEDs can always light at full brightness. The bike never dims them.`;
  };

  function addArea(role) {
    const g = grid(), strip = stripOf();
    if (!sel) return;
    if (areaCount(strip) >= AREA_MAX) { msg = `An output holds at most ${AREA_MAX} areas across all its lights. Remove one first.`; paint(); return; }
    const r = { c0: clamp(sel.c0, 0, g.cols - 1), r0: clamp(sel.r0, 0, g.rows - 1), c1: clamp(sel.c1, 0, g.cols - 1), r1: clamp(sel.r1, 0, g.rows - 1) };
    let any = false;
    for (let c = r.c0; c <= r.c1 && !any; c++) for (let q = r.r0; q <= r.r1; q++) if (g.has(c, q)) { any = true; break; }
    if (!any) { msg = "There is no LED in that block."; paint(); return; }
    const a = { ...r, role, rev: false, vert: false, nb: false };
    if (isTurn(role)) Object.assign(a, flagsOf(outward(role, r.c0, r.c1, g.cols)));
    msg = ""; sel = null; corner = null;
    send([...areasOf(strip, ref.k), a]);
    paint();
  }
  function edit(i, patch) {
    const list = areasOf(stripOf(), ref.k).map((a, j) => (j === i ? { ...a, ...patch } : { ...a }));
    msg = ""; send(list); paint();
  }
  function remove(i) { send(areasOf(stripOf(), ref.k).filter((_, j) => j !== i)); msg = ""; paint(); }
  function move(i, d) {
    const list = areasOf(stripOf(), ref.k), j = i + d;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    msg = ""; send(list); paint();
  }

  // ---- the picture -------------------------------------------------------------------------------------------
  function picture(g, list) {
    const cell = 10, W = g.cols * cell, H = g.rows * cell;
    const svg = sv("svg", { class: "ar-grid", id: "ar-grid", viewBox: `0 0 ${W} ${H}`, role: "img", preserveAspectRatio: "xMidYMid meet",
      "aria-label": `The panel, ${g.cols} columns by ${g.rows} rows. Drag to mark a block.` });
    svg.setAttribute("style", `aspect-ratio: ${W} / ${H}`);
    for (let c = 0; c < g.cols; c++) for (let r = 0; r < g.rows; r++) {
      svg.append(sv("rect", { class: "ar-cell" + (g.has(c, r) ? " led" : ""), x: c * cell + 0.4, y: r * cell + 0.4, width: cell - 0.8, height: cell - 0.8, rx: 1.2, "data-c": c, "data-r": r }));
    }
    list.forEach((a, i) => {
      const color = (ROLE_BY[a.role] || { color: "#888" }).color;
      svg.append(sv("rect", { class: "ar-area", x: a.c0 * cell + 0.2, y: a.r0 * cell + 0.2, width: (a.c1 - a.c0 + 1) * cell - 0.4, height: (a.r1 - a.r0 + 1) * cell - 0.4,
        fill: color, "fill-opacity": 0.55, stroke: color, "stroke-width": 1, "data-area": i }));
      svg.append(sv("text", { class: "ar-num", x: a.c0 * cell + 1.6, y: a.r0 * cell + 6.2, "font-size": 5.5 }, String(i + 1)));
    });
    if (sel) svg.append(sv("rect", { class: "ar-sel", id: "ar-sel", x: sel.c0 * cell + 0.3, y: sel.r0 * cell + 0.3, width: (sel.c1 - sel.c0 + 1) * cell - 0.6, height: (sel.r1 - sel.r0 + 1) * cell - 0.6 }));
    // pointer to cell: the drawing is fitted into the box ("meet"), so the box can be wider or taller than the drawing
    const cellAt = ev => {
      const b = svg.getBoundingClientRect(), k = Math.min(b.width / W, b.height / H) || 1;
      const ox = (b.width - W * k) / 2, oy = (b.height - H * k) / 2;
      return { c: clamp(Math.floor((ev.clientX - b.left - ox) / (cell * k)), 0, g.cols - 1), r: clamp(Math.floor((ev.clientY - b.top - oy) / (cell * k)), 0, g.rows - 1) };
    };
    svg.addEventListener("pointerdown", ev => {
      dragging = cellAt(ev); moved = false;
      try { svg.setPointerCapture(ev.pointerId); } catch (e) { /* no capture */ }
      ev.preventDefault();
    });
    svg.addEventListener("pointermove", ev => {
      if (!dragging) return;
      const c = cellAt(ev);
      if (c.c !== dragging.c || c.r !== dragging.r) moved = true;
      if (moved) { sel = rectOf(dragging, c); corner = null; paintSel(); }
    });
    const end = ev => {
      if (!dragging) return;
      const c = cellAt(ev), start = dragging; dragging = null;
      if (moved || c.c !== start.c || c.r !== start.r) sel = rectOf(start, c), corner = null;
      else if (corner) { sel = rectOf(corner, c); corner = null; }
      else { corner = c; sel = rectOf(c, c); }
      msg = ""; paint();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", () => { dragging = null; });
    return svg;
  }
  // the mark while dragging: only the ring moves, nothing is rebuilt under the finger
  function paintSel() {
    const svg = root.querySelector("#ar-grid"); if (!svg || !sel) return;
    let r = svg.querySelector("#ar-sel");
    if (!r) { r = sv("rect", { class: "ar-sel", id: "ar-sel" }); svg.append(r); }
    const cell = 10;
    for (const [k, v] of Object.entries({ x: sel.c0 * cell + 0.3, y: sel.r0 * cell + 0.3, width: (sel.c1 - sel.c0 + 1) * cell - 0.6, height: (sel.r1 - sel.r0 + 1) * cell - 0.6 })) r.setAttribute(k, String(v));
  }

  // ---- numbers ---------------------------------------------------------------------------------------------------
  const num = (label, value, id, min, max, onCommit) => {
    const inp = el("input", { type: "number", min, max, step: 1, value, id, inputMode: "numeric", "aria-label": label });
    inp.addEventListener("change", () => {
      const v = Math.round(Number(inp.value));
      if (inp.value === "" || !Number.isFinite(v)) { inp.value = value; return; }
      inp.blur(); onCommit(clamp(v, min, max) - 1);
    });
    return el("label", { class: "pl-f" }, el("span", {}, label), inp);
  };

  function selBox(g) {
    const box = el("div", { class: "ar-sel-box", id: "ar-selbox" });
    if (!sel) { box.append(note("Drag across the panel to mark a block of LEDs, or tap two corners. Then pick what the block does.")); return box; }
    const leds = (() => { let n = 0; for (let c = sel.c0; c <= sel.c1; c++) for (let r = sel.r0; r <= sel.r1; r++) if (g.has(c, r)) n++; return n; })();
    box.append(el("p", { class: "ar-sel-t", id: "ar-seltext" }, corner && sel.c0 === sel.c1 && sel.r0 === sel.r1 ? "One corner is set. Tap the opposite corner, or pick a job for this one LED." : `Columns ${sel.c0 + 1} to ${sel.c1 + 1}, rows ${sel.r0 + 1} to ${sel.r1 + 1}: ${leds} ${leds === 1 ? "LED" : "LEDs"}`),
      el("div", { class: "pl-pt ar-nums" },
        num("From column", sel.c0 + 1, "ar-c0", 1, g.cols, v => { sel = rectOf({ c: v, r: sel.r0 }, { c: sel.c1, r: sel.r1 }); corner = null; paint(); }),
        num("To column", sel.c1 + 1, "ar-c1", 1, g.cols, v => { sel = rectOf({ c: sel.c0, r: sel.r0 }, { c: v, r: sel.r1 }); corner = null; paint(); }),
        num("From row", sel.r0 + 1, "ar-r0", 1, g.rows, v => { sel = rectOf({ c: sel.c0, r: v }, { c: sel.c1, r: sel.r1 }); corner = null; paint(); }),
        num("To row", sel.r1 + 1, "ar-r1", 1, g.rows, v => { sel = rectOf({ c: sel.c0, r: sel.r0 }, { c: sel.c1, r: v }); corner = null; paint(); })),
      el("div", { class: "label" }, "What this block does"),
      chips(AREA_JOBS, null, addArea, { id: "ar-jobs" }).el,
      button("Clear the mark", { small: true, kind: "ghost", id: "ar-clear", onClick: () => { sel = null; corner = null; paint(); } }));
    return box;
  }

  // ---- the list ---------------------------------------------------------------------------------------------------
  function card(a, i, total, g) {
    const c = el("div", { class: "ar-card", "data-area": i, id: `ar-${i}` });
    const color = (ROLE_BY[a.role] || { color: "#888" }).color;
    c.append(el("div", { class: "ar-head" }, el("span", { class: "ar-dot", style: `background:${color}` }), el("b", {}, `${i + 1}. ${JOB_NAME[a.role] || a.role}`),
      el("span", { class: "ar-where" }, `Columns ${a.c0 + 1} to ${a.c1 + 1}, rows ${a.r0 + 1} to ${a.r1 + 1}`)));
    c.append(selectRow("Job", AREA_JOBS, a.role, v => edit(i, { role: v, nb: TAIL_ROLES.includes(v) ? a.nb : false, ...(isTurn(v) && !isTurn(a.role) ? flagsOf(outward(v, a.c0, a.c1, g.cols)) : {}), ...(!isTurn(v) ? { rev: false, vert: false } : {}) }), { id: `ar-job-${i}` }).el);
    c.append(el("div", { class: "pl-pt ar-nums" },
      num("From column", a.c0 + 1, `ar-${i}-c0`, 1, g.cols, v => edit(i, { c0: v })), num("To column", a.c1 + 1, `ar-${i}-c1`, 1, g.cols, v => edit(i, { c1: v })),
      num("From row", a.r0 + 1, `ar-${i}-r0`, 1, g.rows, v => edit(i, { r0: v })), num("To row", a.r1 + 1, `ar-${i}-r1`, 1, g.rows, v => edit(i, { r1: v }))));
    if (isTurn(a.role)) {
      c.append(el("div", { class: "label" }, "The animation runs"), seg(DIRECTIONS, directionOf(a), v => edit(i, flagsOf(v)), { id: `ar-dir-${i}` }).el);
    }
    if (TAIL_ROLES.includes(a.role)) c.append(toggleRow("Never brightens on the brake", !!a.nb, v => edit(i, { nb: !!v }), { id: `ar-nb-${i}` }).el);
    const rm = button("Remove", { kind: "danger", small: true, id: `ar-del-${i}` });
    armed(rm, "Tap again to remove", () => remove(i));
    c.append(el("div", { class: "btns ar-btns" }, button("Move up", { small: true, id: `ar-up-${i}`, disabled: i === 0, onClick: () => move(i, -1) }),
      button("Move down", { small: true, id: `ar-down-${i}`, disabled: i === total - 1, onClick: () => move(i, 1) }), rm));
    return c;
  }

  function paint() {
    if (!S.settings || !lightOf()) return;
    clear(root);
    const L = lightOf();
    if (L.kind !== "matrix") return;
    root.append(el("div", { class: "label" }, "Areas"));
    if (!fwAtLeast(0, 6, 0)) { root.append(note("Areas need the 0.6.0 controller update (System › Controller).")); return; }
    const g = grid(), list = areasOf(stripOf(), ref.k);
    if (!g.count) { root.append(note("The controller does not have this panel's rows and columns yet. Open the Placement tab and tap Send the rows and columns (the shape has to be on this phone or PC).", "warn")); return; }
    if (g.rows < 2) { root.append(note("Areas need a panel at least two rows high.", "warn")); return; }
    root.append(note("A block of the panel's columns and rows with a job, drawn over the panel's look. Later blocks are drawn over earlier ones. A block with nothing to show leaves the look visible."),
      picture(g, list), selBox(g));
    if (msg) root.append(el("p", { class: "note bad", id: "ar-msg" }, msg));
    { const t = capText(); if (t) root.append(el("p", { class: "note warn", id: "ar-cap" }, t)); }
    const total = areaCount(stripOf());
    root.append(el("div", { class: "label" }, `Areas, in drawing order (${total} of ${AREA_MAX} on this output)`));
    if (!list.length) root.append(el("p", { class: "note", id: "ar-none" }, "No areas yet."));
    list.forEach((a, i) => root.append(card(a, i, list.length, g)));
    if (total >= AREA_MAX) root.append(note(`An output holds at most ${AREA_MAX} areas across all its lights.`, "warn"));
  }
  paint();
  return {
    update() {
      if (dragging) return;
      const a = document.activeElement;
      if (a && root.contains(a) && a.tagName === "INPUT") return;
      paint();
    },
    destroy() { root.remove(); },
  };
}
