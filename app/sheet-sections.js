// The light sheet's Sections tab (spec 3.3): the light's LEDs, first to last, as one bar of sections.
// A section is a run of LEDs with a job (look only, a turn signal, brake, tail, DRL), or Dark: LEDs that stay off.
// Sections always cover the light exactly, in order. Every edit goes live through op.light.setSections, coalesced by
// key while a split is dragged.
import { S, op, send } from "./store.js";
import { el, clear, button, chips, seg, toggleRow, note } from "./ui.js";
import { lightsOf, sectionsOf, withSections, templateSections, mergeDark, isDark, LIMITS } from "./lights.js";
import { ROLES, ROLE_BY, TAIL_ROLES, TURN_ROLES, SIGNAL_ROLES, SECTION_RESTS, RX_BITS } from "./fxdata.js";

const FIND_MS = 3000;
const ONE_SECTION = n => [{ n, role: "look", rest: "light", rx: 0, nb: false, rev: false }];
const TEMPLATES = {
  front: [["default", "Turn · DRL · turn"], ["turns", "Turns only"], ["look", "All look"]],
  rear: [["default", "Turn · tail · brake · tail · turn"], ["brake", "Whole bar brakes"], ["look", "All look"]],
};
const RX_OPTIONS = [[RX_BITS.brake, "Brake"], [RX_BITS.left, "Left turn"], [RX_BITS.right, "Right turn"]];
const roleName = r => (ROLE_BY[r] || { name: r }).name;
const rxBits = set => [...set].reduce((m, v) => m | Number(v), 0);

export function renderSections(body, ref) {
  const root = el("div", { class: "sec-tab", id: "tab-sections" });
  body.append(root);
  let sel = 0, drag = null, findTimer = 0, findPx = -1, shownClean = null, fitTimer = 0;
  const stripOf = () => S.settings.strips[ref.out];
  const cur = () => {
    const st = stripOf(), L = st && lightsOf(st)[ref.k];
    return L ? { st, L, ...sectionsOf(st, ref.k) } : null;
  };
  const startOf = (secs, i) => secs.slice(0, i).reduce((a, s) => a + s.n, 0);

  // ---- sending -----------------------------------------------------------------------------------
  const msg = el("p", { class: "note bad", id: "sec-msg", hidden: true }), msgRead = el("p", { class: "note bad", hidden: true });
  const say = t => { for (const m of [msg, msgRead]) { m.textContent = t || ""; m.hidden = !t; } };
  // Returns false (and sends nothing) when the output could not hold the result. Dark sections that end up side by
  // side become one, and the selection follows the section it was on.
  function commit(secs, { live = true } = {}) {
    const c = cur(); if (!c) return false;
    const m = mergeDark(secs, sel);
    secs = m.sections;
    if (withSections(c.st, ref.k, secs).seg.length > LIMITS.segs) {
      say(`An output holds at most ${LIMITS.segs} sections across all its lights. Merge two sections first.`);
      return false;
    }
    say("");
    sel = m.sel;
    op.light.setSections(ref.out, ref.k, secs, live ? { key: "sec" + (c.L.id || `${ref.out}.${ref.k}`), ms: 250 } : undefined);
    return true;
  }
  const edit = fn => {
    const c = cur(); if (!c || !c.clean) return;
    const secs = c.sections.map(s => ({ ...s }));
    secs[sel] = fn(secs[sel]);
    commit(secs);
  };

  // ---- finding the split on the bike -----------------------------------------------------------------
  function findLed(p) {
    const c = cur(); if (!c) return;
    const px = c.L.s + Math.min(p, c.L.n - 1);
    if (px !== findPx) send(`find ${ref.out + 1} ${px}`);
    findPx = px;
    clearTimeout(findTimer);
    findTimer = setTimeout(findOff, FIND_MS);
  }
  function findOff() { clearTimeout(findTimer); findTimer = 0; if (findPx >= 0) { findPx = -1; send("find off"); } }

  // ---- moving a split ----------------------------------------------------------------------------------
  // The split after section i moves so that section i holds `p - start` LEDs; the next section gives or takes the rest.
  function moveSplit(i, p) {
    const c = cur(); if (!c || !c.clean || i < 0 || i >= c.sections.length - 1) return;
    const start = startOf(c.sections, i), total = c.sections[i].n + c.sections[i + 1].n;
    p = Math.max(start + 1, Math.min(start + total - 1, Math.round(p)));
    if (p === start + c.sections[i].n) return;
    const secs = c.sections.map(s => ({ ...s }));
    secs[i].n = p - start; secs[i + 1].n = total - (p - start);
    if (commit(secs)) findLed(p);
  }
  const nudge = d => { const c = cur(); if (c && c.clean && sel < c.sections.length - 1) moveSplit(sel, startOf(c.sections, sel) + c.sections[sel].n + d); };

  // ---- the bar --------------------------------------------------------------------------------------------
  const bar = el("div", { class: "secbar", id: "sec-bar" });
  function paintBar(c) {
    const secs = c.sections, total = c.L.n;
    if (bar.children.length !== secs.length * 2 - 1) {
      clear(bar);
      secs.forEach((_, i) => {
        bar.append(el("button", { type: "button", class: "secbtn", "data-sec": i, onclick: () => { sel = i; paint(); } }, el("span", { class: "cnt" })));
        if (i < secs.length - 1) bar.append(handle(i));
      });
    }
    let at = 0;
    secs.forEach((s, i) => {
      const b = bar.children[i * 2], role = ROLE_BY[s.role];
      b.style.left = (at / total * 100) + "%"; b.style.width = (s.n / total * 100) + "%";
      b.style.backgroundColor = role ? role.color : "var(--edge)";   // the color only: a Dark section's hatch is the class's background image
      b.classList.toggle("dark", isDark(s));
      b.setAttribute("aria-pressed", String(i === sel));
      b.setAttribute("aria-label", `${roleName(s.role)}, ${s.n} LEDs`);
      b.title = `${roleName(s.role)}: LEDs ${at + 1} to ${at + s.n}`;
      b.firstChild.textContent = s.n;
      at += s.n;
      if (i < secs.length - 1) { const h = bar.children[i * 2 + 1]; h.style.left = (at / total * 100) + "%"; h.setAttribute("aria-label", `Move the split after section ${i + 1}`); }
    });
    clearTimeout(fitTimer);
    fitTimer = setTimeout(fit, 0);
  }
  // The LED count is shown only where the section is wide enough to hold it.
  function fit() {
    for (const b of bar.querySelectorAll(".secbtn")) { const w = b.offsetWidth; b.classList.toggle("tight", w > 0 && w < 26); }
  }
  function handle(i) {
    const h = el("button", { type: "button", class: "sechandle", "data-handle": i }, el("span", { class: "grip" }));
    const at = ev => {
      const c = cur(), r = bar.getBoundingClientRect();
      return c && r.width ? (ev.clientX - r.left) / r.width * c.L.n : null;
    };
    h.addEventListener("pointerdown", ev => {
      drag = i; sel = i; h.classList.add("active");
      try { h.setPointerCapture(ev.pointerId); } catch (e) { /* no capture in this browser */ }
      ev.preventDefault();
    });
    h.addEventListener("pointermove", ev => { if (drag !== i) return; const p = at(ev); if (p != null) moveSplit(i, p); });
    const end = () => { if (drag !== i) return; drag = null; h.classList.remove("active"); paint(); };
    h.addEventListener("pointerup", end); h.addEventListener("pointercancel", end);
    h.addEventListener("keydown", ev => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      const c = cur(); if (!c) return;
      sel = i;
      moveSplit(i, startOf(c.sections, i) + c.sections[i].n + (ev.key === "ArrowRight" ? 1 : -1));
      ev.preventDefault();
    });
    return h;
  }

  // ---- the parts around the bar ---------------------------------------------------------------------------
  const intro = el("div", { class: "label" });
  const minus = button("−", { id: "sec-minus", small: true, onClick: () => nudge(-1) });
  const plus = button("+", { id: "sec-plus", small: true, onClick: () => nudge(1) });
  const splitAt = el("span", { class: "split-at", id: "sec-splitat" });
  const splitCtl = el("div", { class: "split-ctl" }, minus, splitAt, plus);
  const hint = el("p", { class: "note" }, "Drag the gap between two sections to move the split, or use − and +. The LED at the split lights on the bike.");
  const tplBox = el("div", { class: "chips", id: "sec-templates", role: "group" });
  const card = el("div", { class: "panel seccard", id: "sec-card" });
  const editBox = el("div", { class: "sec-edit" },
    el("div", { class: "label" }, "Layout"), tplBox, intro, bar, splitCtl, hint, msg, card,
    note("Sections are saved with each look."));
  const readBox = el("div", { class: "sec-read", id: "sec-read" });
  root.append(editBox, readBox);

  function paintTemplates(c) {
    clear(tplBox);
    for (const [v, label] of TEMPLATES[c.L.kind] || [["look", "All look"]]) {
      tplBox.append(el("button", { type: "button", class: "chip", "data-template": v, onclick: () => applyTemplate(v) }, label));
    }
  }
  // Which end the data wire comes in at, read from the first turn section; the middle from the DRL or brake section.
  function applyTemplate(v) {
    const c = cur(); if (!c) return;
    const first = c.sections.find(s => TURN_ROLES.includes(s.role));
    const feed = first ? (/_l$/.test(first.role) ? "left" : "right") : (c.L.kind === "rear" ? "left" : "right");
    const m = c.sections.findIndex(s => s.role === "drl" || s.role === "brake");
    const mid = m >= 0 ? startOf(c.sections, m) + Math.floor(c.sections[m].n / 2) : undefined;
    sel = 0;
    commit(templateSections(c.L.kind, c.L.n, { mid, feed, variant: v === "default" ? undefined : v }));
  }

  function paintCard(c) {
    clear(card);
    const s = c.sections[sel], start = startOf(c.sections, sel);
    const kids = [el("div", { class: "seccard-head" }, el("b", {}, roleName(s.role)), el("span", {}, `LEDs ${start + 1} to ${start + s.n} of this light`))];
    kids.push(el("div", { class: "label" }, "What it does"),
      chips(ROLES.map(r => [r.key, r.name]), s.role, v => edit(x => ({ ...x, role: v, rest: v === "look" || v === "drl" || v === "none" ? "light" : x.rest,
        rx: v === "look" ? x.rx : 0, nb: TAIL_ROLES.includes(v) ? x.nb : false, rev: v === "none" ? false : x.rev })), { id: "sec-roles" }).el);
    if (isDark(s)) kids.push(note("These LEDs stay off whatever the bike is doing: no look, no bike effect, no signal. Use it for LEDs that are tucked away or that you don't want lit.", null));
    if (SIGNAL_ROLES.includes(s.role)) {
      kids.push(el("div", { class: "label" }, "When it is not signaling"), chips(SECTION_RESTS, s.rest, v => edit(x => ({ ...x, rest: v })), { id: "sec-rest" }).el);
    }
    if (s.role === "look") {
      const on = RX_OPTIONS.filter(([b]) => s.rx & b).map(([b]) => b);
      kids.push(el("div", { class: "label" }, "Also reacts to"),
        chips(RX_OPTIONS, new Set(on), set => edit(x => ({ ...x, rx: rxBits(set) })), { multi: true, id: "sec-rx" }).el);
    }
    if (TAIL_ROLES.includes(s.role)) {
      kids.push(toggleRow("Brightens on brake", !s.nb, v => edit(x => ({ ...x, nb: !v })), { id: "sec-nb" }).el);
    }
    if (TURN_ROLES.includes(s.role) || (s.role === "look" && s.rx)) {
      kids.push(el("div", { class: "label" }, "Direction"),
        seg([[0, "Runs toward the end"], [1, "Runs toward the start"]], s.rev ? 1 : 0, v => edit(x => ({ ...x, rev: !!Number(v) })), { id: "sec-rev" }).el);
    }
    kids.push(el("div", { class: "btns" },
      button(isDark(s) ? "Light its second half" : "Split in two", { id: "sec-split", disabled: s.n < 2, onClick: splitSection }),
      button("Merge with the next section", { id: "sec-merge", disabled: sel >= c.sections.length - 1, onClick: mergeSection })));
    card.append(...kids);
  }
  function splitSection() {
    const c = cur(); if (!c || !c.clean) return;
    const s = c.sections[sel], h = Math.floor(s.n / 2);
    if (h < 1) return;
    const secs = c.sections.map(x => ({ ...x }));
    // Two Dark halves would be the same section again: a Dark section gives its second half back as a look section.
    secs.splice(sel, 1, { ...s, n: h }, isDark(s) ? { ...ONE_SECTION(s.n - h)[0] } : { ...s, n: s.n - h });
    commit(secs, { live: false });
  }
  function mergeSection() {
    const c = cur(); if (!c || !c.clean || sel >= c.sections.length - 1) return;
    const secs = c.sections.map(x => ({ ...x }));
    secs.splice(sel, 2, { ...secs[sel], n: secs[sel].n + secs[sel + 1].n });
    commit(secs, { live: false });
  }

  // a light whose segments are not a clean cover (hand-made): read-only
  function paintRead(c) {
    clear(readBox);
    readBox.append(note(c.sections.length
      ? "This light's sections were set up by hand and do not cover it exactly, so they can't be edited here."
      : "This light has no sections yet."));
    const list = el("div", { class: "panel" });
    c.sections.forEach(s => {
      const at = s.at != null ? s.at : 0;
      list.append(el("div", { class: "row" }, el("span", { class: "txt" }, el("b", {}, roleName(s.role)), el("small", {}, `LEDs ${at + 1} to ${at + s.n}`)),
        el("span", { class: "val" }, `${s.n} LEDs`)));
    });
    if (c.sections.length) readBox.append(list);
    readBox.append(button("Reset to one section", { id: "sec-reset", kind: "primary", onClick: () => commit(ONE_SECTION(c.L.n), { live: false }) }), msgRead);
  }

  function paint() {
    const c = cur(); if (!c) return;
    if (c.clean !== shownClean) { shownClean = c.clean; editBox.hidden = !c.clean; readBox.hidden = c.clean; if (c.clean) paintTemplates(c); }
    if (!c.clean) { paintRead(c); return; }
    sel = Math.max(0, Math.min(sel, c.sections.length - 1));
    intro.textContent = `${c.L.n} LEDs, first to last. Tap a section.`;
    paintBar(c);
    const p = startOf(c.sections, sel) + c.sections[sel].n, last = sel >= c.sections.length - 1;
    splitAt.textContent = last ? "No split to the right of the last section" : `Split after LED ${p} of ${c.L.n}`;
    minus.disabled = last || c.sections[sel].n < 2; plus.disabled = last || c.sections[sel + 1].n < 2;
    if (drag == null) paintCard(c);
  }
  paint();

  return {
    update() { paint(); },
    destroy() { findOff(); clearTimeout(fitTimer); root.remove(); },
  };
}
