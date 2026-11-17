// System › Diagnostics: Live (input wires, headlight switch, each output's current and state, the strip estimates and
// the budget, counters, button events), repainted from `status` without rebuilding; and the Console (raw lines in and
// out, a command box with history, Clear, Copy all). Ported from the 0.4.9 Live and Console tabs.
import { S, on, send, demoLink } from "./store.js";
import { el, clear, button, seg, panel, note, toast } from "./ui.js";
import { OUT_MODES } from "./fxdata.js";
import { isLampOut } from "./lights.js";
import { LAMPS, lampLabel, extraSet } from "./system-kit.js";

export const INPUTS = [   // bit order = firmware rcr::In
  { key: "brake", name: "Brake", where: "tail red", sw: "#d8322a" },
  { key: "l", name: "Left turn", where: "turn lead L", sw: "#8f99a3" },
  { key: "r", name: "Right turn", where: "turn lead R", sw: "#8f99a3" },
  { key: "low", name: "Low beam", where: "headlight yellow", sw: "#f2c40f" },
  { key: "high", name: "High beam", where: "headlight blue", sw: "#2f6fe0" },
  { key: "btn", name: "Handlebar button", where: "button lead", sw: "#2b2f33" },
  { key: "run", name: "Lights on", where: "headlight red", sw: "#d8322a" },
  { key: "spare", name: "Tail running", where: "tail white", sw: "#f4f6f8" },
];
// status.en index -> enable line; status.ch / status.a index -> sense channel
// The first four are the lamp outputs: their names are the rider's (senseName), these are the board's.
export const senseName = i => (i < LAMPS.length ? lampLabel(LAMPS[i][0]) : SENSE[i].name);
export const SENSE = [
  { name: "Low output", where: "J6 pin 5", rating: 15 }, { name: "High output", where: "J6 pin 6", rating: 15 },
  { name: "Aux output", where: "J6 pin 7", rating: 7.5 }, { name: "DRL output", where: "J6 pin 8", rating: 7.5 },
  { name: "Output 1", where: "J3", rating: 7.5, en: 4, strip: 0 }, { name: "Output 2", where: "J4", rating: 7.5, en: 5, strip: 1 },
  { name: "Output 3", where: "J5", rating: 7.5, en: 6, strip: 2 }, { name: "Output 4", where: "J15", rating: 7.5, en: 7, strip: 3 },
  { name: "Accessory 1", where: "J10 pin 3", rating: 7.5 }, { name: "Accessory 2", where: "J10 pin 4", rating: 7.5 },
];
const STATE = { ".": ["off", ""], o: ["on", "ok"], s: ["switching", ""], O: ["lamp out", "warn"], F: ["fault", "bad"], X: ["high while off", "bad"] };
const HEAD_NAME = { off: "Off", running: "Running", low: "Low", high: "High" };
const BTN_EVENTS = { short: "short press", double: "double press", long: "long press", "hold-5s": "held 5 s (pairing)" };
const OTA_STATE = ["", "Firmware update: turning Bluetooth off…", "Firmware update Wi-Fi is on.", "Firmware update: uploading…", "Firmware update: restarting…",
  "Firmware update Wi-Fi FAILED to start.", "Firmware update Wi-Fi closed: restarts once the lights are off."];
const fmtAge = ms => ms < 60000 ? Math.round(ms / 1000) + " s" : Math.round(ms / 60000) + " min";

// ---- the console's lines ------------------------------------------------------------------------------------------
// Collected from the store's "out" events from the first visit to System on, so the console shows what happened before it was opened.
const LOG_MAX = 400;
const logLines = [], history = [];
let logDoc = null, logOff = null, sink = null;
export function startConsoleLog() {
  if (logDoc === document && logOff) return;
  if (logOff) logOff();
  logDoc = document; logLines.length = 0;
  logOff = on("out", (line, dir) => {
    const e = { text: (dir === "me" ? "> " : "") + line, me: dir === "me" };
    logLines.push(e);
    while (logLines.length > LOG_MAX) logLines.shift();
    if (sink) sink(e);
  });
}
export const consoleLines = () => logLines.map(l => l.text);

let view = "live";   // which half of Diagnostics was open last

export function buildDiag(host) {
  const body = el("div", { class: "sys-diag" });
  let sub = null;
  const pick = v => { view = v; if (sub && sub.destroy) sub.destroy(); clear(body); sub = v === "console" ? buildConsole(body) : buildLive(body); };
  const sw = seg([["live", "Live"], ["console", "Console"]], view, pick, { id: "sys-diag-seg" });
  host.append(el("div", { class: "sys-segwrap" }, sw.el), body);
  pick(view);
  // the "Counter details" button switches to the console
  host.addEventListener("sys:console", () => { sw.set("console"); pick("console"); });
  return { status: s => { if (sub && sub.status) sub.status(s); }, destroy() { if (sub && sub.destroy) sub.destroy(); sink = null; } };
}

// ---- Live --------------------------------------------------------------------------------------------------------
function buildLive(host) {
  const alerts = el("div", { id: "sys-alerts" });
  const headVal = el("span", { class: "val", id: "sys-head" }, "–"), podsVal = el("span", { class: "val", id: "sys-pods" }, "–");
  // the extra switch (Extra lights on Ride, a button action): which outputs it lights, by the rider's names
  const podsWhat = el("small", { id: "sys-pods-what" });
  const extraText = () => { const x = extraSet(S.settings && S.settings.head); return x.length ? "lights " + x.map(l => lampLabel(l)).join(", ") : "lights no output"; };
  const headPanel = panel("Headlight switch",
    el("div", { class: "row" }, el("span", { class: "txt" }, el("b", {}, "Switch position"), el("small", {}, "from the headlight wires")), headVal),
    el("div", { class: "row" }, el("span", { class: "txt" }, el("b", {}, "Extra switch"), podsWhat), podsVal));

  const demo = demoLink();
  const wires = INPUTS.map((inp, bit) => {
    const t = el("span", { class: "txt" }, el("b", {}, inp.name), el("span", {}, inp.where));
    const w = el(demo ? "button" : "div", { class: "wire", id: "sys-wire-" + inp.key, "data-bit": bit, "aria-pressed": demo ? "false" : null,
      onclick: demo ? () => { const d = demoLink(); if (d) d.setInput(bit, !((d.inputs >> bit) & 1)); } : null },
      el("span", { class: "sw", style: `background:${inp.sw}` }), t, el("span", { class: "lamp" }));
    return { w, note: t.lastChild, inp, bit };
  });
  const wiresPanel = el("div", { class: "panel wires", id: "sys-wires" }, wires.map(x => x.w));

  const outs = SENSE.map((c, i) => {
    const amps = el("div", { class: "amps" }, "–"), state = el("div", { class: "state" }), bar = el("i"), name = el("div", { class: "name" }, senseName(i));
    return { c, amps, state, bar, name, li: el("li", { id: "sys-out-" + i }, el("div", {}, name, el("div", { class: "where" }, c.where)),
      el("div", {}, amps, state), el("div", { class: "bar" }, bar)) };
  });
  const tot = { amps: el("div", { class: "amps" }, "–"), state: el("div", { class: "state" }), bar: el("i"), where: el("div", { class: "where" }, "shared budget") };
  const totLi = el("li", { id: "sys-out-total" }, el("div", {}, el("div", { class: "name" }, "Outputs total"), tot.where), el("div", {}, tot.amps, tot.state), el("div", { class: "bar" }, tot.bar));
  const rows = el("ul", { class: "panel rows", id: "sys-out-rows" }, ...outs.slice(0, 8).map(o => o.li), totLi, ...outs.slice(8).map(o => o.li));
  const dimNote = el("p", { class: "note warn", id: "sys-dim", hidden: true });

  const evList = el("ul", { class: "sys-events", id: "sys-events" });
  const foot = el("p", { class: "note", id: "sys-live-foot" });
  host.append(alerts, headPanel,
    el("h2", { class: "section-title" }, "Bike inputs"), wiresPanel,
    el("div", { class: "btns" }, button("Counter details", { id: "sys-cnt-show", onClick: () => { send("counters"); host.parentNode.dispatchEvent(new Event("sys:console")); } }),
      button("Reset counters", { id: "sys-cnt-reset", onClick: () => { lastBn = null; events.length = 0; send("counters reset"); } })),
    note("Changes = how often an input switched since key-on or the last reset. Cut-outs = a lamp's current dropping out while its output was on (the LOW and HIGH outputs are checked every millisecond). A lamp that cuts out with no input changes is the lamp or its supply; an input that changes with nobody at the switch is a signal line dropping out."),
    el("h2", { class: "section-title" }, "Outputs"), rows, dimNote,
    el("h2", { class: "section-title" }, "Button events"), el("div", { class: "panel pad" }, evList), foot);

  let lastBn = null; const events = [];
  const wireNote = (inp, bit, s) => {
    const edges = Array.isArray(s.edges) ? (s.edges[bit] | 0) : 0;
    if (inp.key === "btn") {
      const parts = [];
      if (s.btn) parts.push("pressed");
      if (s.bev) parts.push(`last: ${BTN_EVENTS[s.bev] || s.bev}` + (typeof s.bage === "number" ? ` ${fmtAge(s.bage)} ago` : ""));
      if (typeof s.bn === "number") parts.push(`${s.bn} press${s.bn === 1 ? "" : "es"}`);
      return parts.length ? parts.join(" · ") : inp.where;
    }
    return inp.where + (edges ? ` · ${edges} change${edges === 1 ? "" : "s"}` : "");
  };
  function paintEvents() {
    clear(evList);
    if (!events.length) { evList.append(el("li", { class: "note" }, "No button presses since this page opened.")); return; }
    for (const e of events.slice().reverse()) evList.append(el("li", {}, el("b", {}, e.text), el("span", { class: "note" }, ` ${fmtAge(Date.now() - e.at)} ago`)));
  }
  function paint(s) {
    if (!s) return;
    headVal.textContent = HEAD_NAME[s.head] || "–"; podsVal.textContent = s.aux ? "On" : "Off";
    { const t = extraText(); if (podsWhat.textContent !== t) podsWhat.textContent = t; }
    wires.forEach(({ w, note: n, inp, bit }) => {
      const on_ = !!((s.in >> bit) & 1);
      w.classList.toggle("on", on_); if (w.tagName === "BUTTON") w.setAttribute("aria-pressed", String(on_));
      n.textContent = wireNote(inp, bit, s);
    });
    if (typeof s.bn === "number") {
      if (lastBn != null && s.bn > lastBn) events.push({ text: BTN_EVENTS[s.bev] || s.bev || "press", at: Date.now() });
      lastBn = s.bn;
    }
    paintEvents();
    const list = [];
    outs.forEach(({ c, amps, state, bar, name }, i) => {
      if (name.textContent !== senseName(i)) name.textContent = senseName(i);   // a lamp output renamed since the page was built
      const code = (s.ch || "")[i] || ".", [label, cls] = STATE[code] || ["?", ""];
      const a = (s.a || [])[i] || 0;
      let rating = c.rating, extra = "";
      if (c.strip != null && S.settings) {
        const sp = S.settings.strips[c.strip];
        if (isLampOut(sp)) extra = " · " + ((OUT_MODES.find(m => m[0] === sp.out) || [0, ""])[1]).toLowerCase();
        else { rating = sp.cap_ma / 1000; extra = sp.px ? ` · est. ${(((s.sma || [])[c.strip] || 0) / 1000).toFixed(2)} A` : " (unused)"; }
      }
      const locked = c.en != null && (s.lk || "")[c.en] === "L", retries = c.en != null ? (s.rt || [])[c.en] : 0;
      const dips = i < 4 && Array.isArray(s.dip) ? (s.dip[i] | 0) : 0;
      const dipTxt = dips ? ` · ${dips} cut-out${dips === 1 ? "" : "s"}, longest ${(s.dipms || [])[i] | 0} ms` : "";
      amps.textContent = a.toFixed(2) + " A";
      state.textContent = (locked ? "fault, gave up retrying" : label + (retries && code === "F" ? `, retry ${retries}` : "") + extra) + dipTxt;
      state.className = "state " + (locked ? "bad" : dips && cls === "ok" ? "warn" : cls);
      bar.style.width = Math.min(100, a / rating * 100) + "%"; bar.classList.toggle("lit", code === "o");
      if (dips && code === "o") list.push(["warn", `${senseName(i)}: current cut out ${dips}× (longest ${(s.dipms || [])[i] | 0} ms): lamp or supply flicker`]);
      if (code === "F" || locked) list.push(["bad", `${senseName(i)}: ${locked ? "faulted and switched off" : "fault (short, overload or overheating), retrying"}`]);
      else if (code === "O") list.push(["warn", `${senseName(i)}: no current. Lamp out or unplugged?`]);
      else if (code === "X") list.push(["bad", `${senseName(i)}: output is live while switched off`]);
    });
    // The budget works on the board's model of what the commanded LEDs should draw (`tot`); the measured sum sits beside it
    // so an unplugged strip does not look like 3 A of load.
    const has = typeof s.tot === "number";
    totLi.hidden = !has; dimNote.hidden = true;
    if (has) {
      const est = s.tot / 1000, bud = typeof s.bud === "number" ? s.bud : 100;
      const meas = Array.isArray(s.a) ? [4, 5, 6, 7].reduce((m, i) => m + (Number(s.a[i]) || 0), 0) : est;
      const B = S.settings && S.settings.budget, cap = B ? ((s.head === "low" || s.head === "high") ? B.lit_ma : B.dark_ma) / 1000 : 0;
      tot.amps.textContent = meas.toFixed(2) + " A";
      tot.state.textContent = `model ${est.toFixed(2)} A · ` + (bud < 100 ? `lights dimmed to ${bud} %` : `budget ${bud} %, not limiting`);
      tot.state.className = "state " + (bud < 100 ? "warn" : "ok");
      tot.bar.style.width = (cap ? Math.min(100, est / cap * 100) : 0) + "%";
      tot.where.textContent = (cap ? `shared budget ${cap.toFixed(1)} A` : "shared budget") + ", measured";
      if (bud < 100) { dimNote.hidden = false; dimNote.textContent = `The shared budget is dimming the bike effect and looks to ${bud} %.`; }
    }
    if (s.save_err) list.unshift(["bad", "Settings are not being saved. Storage full? Changes are lost at key-off."]);
    if (s.board_mismatch) list.unshift(["bad", "Wrong firmware for this board: the outputs are off. Flash the other image."]);
    if (s.strips_err) list.unshift(["bad", "The LED outputs failed to start."]);
    if (s.v === 0) list.unshift(["warn", "Inputs not settled yet: the LOW output and rear red held on."]);
    if (s.bench) list.unshift(["warn", "Bench override active (output test, finder or USB console)."]);
    clear(alerts);
    for (const [cls, msg] of list) alerts.append(el("div", { class: "banner " + cls }, msg));
    foot.textContent = s.ota ? (OTA_STATE[s.ota] || "Firmware update Wi-Fi is on.") : "";
  }
  paint(S.status);
  return { status: paint, destroy() {} };
}

// ---- Console --------------------------------------------------------------------------------------------------------
function buildConsole(host) {
  const log = el("div", { class: "log", id: "sys-log", role: "log", "aria-live": "polite" });
  const add = e => {
    log.append(el("div", { class: e.me ? "me" : null }, e.text));
    while (log.childNodes.length > LOG_MAX) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
  };
  logLines.forEach(add);
  sink = add;
  let hi = -1;
  const inp = el("input", { type: "text", id: "sys-cmd", autocomplete: "off", autocapitalize: "off", spellcheck: false, placeholder: "help, sense, info…", "aria-label": "Command",
    onkeydown: ev => {
      if (ev.key === "ArrowUp" && history.length) { hi = Math.min(history.length - 1, hi + 1); inp.value = history[history.length - 1 - hi]; ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { hi = Math.max(-1, hi - 1); inp.value = hi < 0 ? "" : history[history.length - 1 - hi]; ev.preventDefault(); }
    } });
  const form = el("form", { class: "cmdline", id: "sys-cmd-form", onsubmit: ev => {
    ev.preventDefault();
    const t = inp.value.trim(); if (!t) return;
    if (history[history.length - 1] !== t) history.push(t);
    while (history.length > 50) history.shift();
    hi = -1; inp.value = ""; send(t);
  } }, inp, button("Send", { id: "sys-cmd-send" }));
  form.lastChild.type = "submit";
  const clearBtn = button("Clear", { small: true, id: "sys-log-clear", onClick: () => { logLines.length = 0; clear(log); } });
  const copyBtn = button("Copy all", { small: true, id: "sys-log-copy", onClick: () => copyText(consoleLines().join("\n")) });
  host.append(panel(null, log, form, el("div", { class: "pad btns" }, clearBtn, copyBtn)));
  log.scrollTop = log.scrollHeight;
  return { destroy() { if (sink === add) sink = null; } };
}
function copyText(text) {
  const done = () => toast("Copied the console");
  const fallback = () => {
    const ta = el("textarea", { style: "position:fixed;left:-1000px", "aria-hidden": "true" }); ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch (e) { toast("This browser would not copy: select the text by hand", "warn"); }
    ta.remove();
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
}
