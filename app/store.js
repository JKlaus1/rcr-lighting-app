// The app's state and the only module that talks to the link (spec 4.4): the mirror, sending, replies,
// operations, the reconnect flow (ported from the 0.4.9 app) and the frame loop.
import { BleLink, DemoLink, MAX_WRITE } from "./link.js";
import { createController, coreReady } from "./core.js";
import * as L from "./lights.js";

export const S = {
  phase: "idle",          // "idle" | "waiting" (listening for the remembered controller) | "connecting" | "ready"
  demo: false, name: "", fw: null, settings: null, status: null,
  looks: { pre: -1, prem: 0, slots: Array(8).fill(null) }, warn: "",
  sim: { running: null, brake: null, left: null, right: null, haz: null },
  connText: "Not connected",   // the header's connection line while not ready ("Reconnecting in 2 s", "Waiting for the controller (key on?)")
  connErr: "",                 // why the last connect did not work (shown on the connect screen)
};
export let mirror = null;      // the core instance that holds what the controller should hold

// ---- events --------------------------------------------------------------------------------------
const subs = {};
export function on(kind, fn) {
  (subs[kind] = subs[kind] || new Set()).add(fn);
  if (kind === "frame") frameKick();
  return () => { subs[kind].delete(fn); };
}
function emit(kind, ...args) {
  for (const fn of [...(subs[kind] || [])]) { try { fn(...args); } catch (e) { console.error(kind, "listener failed:", e); } }
}
let noteHook = null;
export function setNoteHook(fn) { noteHook = fn; }
function note(text, kind = "warn", line) { if (noteHook) noteHook(line || "", text); emit("note", text, kind); }

// ---- setup -----------------------------------------------------------------------------------------
let link = null;
export function init() {
  if (!coreReady()) throw new Error("initCore() first");
  if (!mirror) mirror = createController();
}
export const demoLink = () => (link instanceof DemoLink ? link : null);
export const fwAtLeast = (a, b = 0, c = 0) => !!(S.fw && cmpVer(S.fw.n, [a, b, c]) >= 0);
const cmpVer = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] | 0) !== (b[i] | 0)) return (a[i] | 0) - (b[i] | 0); return 0; };
function setPhase(phase, text) {
  S.phase = phase;
  if (text != null) S.connText = text;
  emit("phase", S.phase);
}

// ---- replies ---------------------------------------------------------------------------------------
// The firmware appends its setup warnings ("no brake light configured" ...) to every `set` reply as a final
// "WARNING: ..." note. Those show as the banner from the live status; only real notes are worth a toast.
export const realNotes = n => (n || "").replace(/(?:^|;\s*)WARNING: [\s\S]*$/, "").trim();
const pendingSets = [];   // sent `set` lines waiting for their reply, oldest first: { line, text, mine, quiet }
const handlers = {
  onOut(line) {
    emit("out", line, "in");
    if (line[0] === "{") {
      let j = null;
      try { j = JSON.parse(line); } catch (e) { /* not ours */ }
      if (j) {
        if (j.strips && j.head) { gotSettings(line); return; }
        if (Array.isArray(j.slots) && "pre" in j) { gotLooks(j); return; }
        if ("ok" in j) { gotReply(j); return; }
        if ("ch" in j && "en" in j) { gotStatus(j); return; }
      }
    }
    if (/^RCR Lighting/.test(line)) setFw(line);
    if (/^tx aborted/.test(line) && !txAborting) { refresh(); note("The controller dropped a change that took too long; the app read the bike again", "warn"); }
    txAborting = false;
  },
  onLive(line) { let j; try { j = JSON.parse(line); } catch (e) { return; } gotStatus(j); },
  onDrop() { dropped(); },
};
function gotSettings(text) {
  const keep = mirror.getText();
  const n = mirror.load(text);
  if (n.startsWith("!")) { mirror.load(keep); note("The controller's settings could not be read: " + n.slice(1), "bad"); return; }
  // lines sent after that `get` are already in the mirror's future: put them back on top
  for (const p of pendingSets) mirror.patch(p.text);
  for (const w of Object.values(waiting)) for (const t of w.texts) mirror.patch(t);
  settingsWatch.got = true;
  publishSettings();
}
function publishSettings() { S.settings = mirror.get(); emit("settings", S.settings); }
function gotLooks(j) {
  S.looks = { pre: j.pre, prem: j.prem | 0, slots: (j.slots || []).slice(0, 8).concat(Array(8).fill(null)).slice(0, 8) };
  emit("looks", S.looks);
}
function gotReply(j) {
  const p = pendingSets.shift();
  const theirs = j.ok ? realNotes(j.notes) : (j.notes || "error");
  if (!p) { if (!j.ok || theirs) note((j.ok ? "" : "Not applied: ") + theirs, j.ok ? "warn" : "bad"); return; }
  const mine = p.mine == null ? null : realNotes(p.mine);
  if (!j.ok) { note("Not applied: " + theirs, "bad", p.line); refresh(); return; }
  if (mine != null && theirs !== mine) { note(theirs || "The controller and the app disagreed; the app read the bike again", "warn", p.line); refresh(); return; }
  if (mine == null && theirs) { note(theirs, "warn", p.line); refresh(); return; }
  if (theirs && !p.quiet) note(theirs, "warn", p.line);
}
function gotStatus(j) {
  S.status = j;
  const w = j.warn || "";
  if (w !== S.warn) { S.warn = w; emit("warn", w); }
  if ("pre" in j && (j.pre !== S.looks.pre || (j.prem | 0) !== S.looks.prem)) { S.looks = { ...S.looks, pre: j.pre, prem: j.prem | 0 }; emit("looks", S.looks); }
  emit("status", j);
}
// Firmware version from the `info` reply ("RCR Lighting rev D firmware 0.5.0 (...)").
function setFw(line) {
  const m = /firmware (\d+\.\d+\.\d+)/.exec(line);
  if (!m) return;
  S.fw = { text: m[1], n: m[1].split(".").map(Number) };
  emit("phase", S.phase);
}

// ---- sending ----------------------------------------------------------------------------------------
export function send(line) {
  if (!link) return Promise.resolve();
  emit("out", line, "me");
  return link.send(line).catch(e => note("Not sent: " + e.message, "bad"));
}
const setLine = text => "set " + text;
const tooLong = line => new TextEncoder().encode(line).length > Math.min(L.SET_LIMIT, MAX_WRITE - 1);
// Apply to the mirror and send one `set`. mine = what the mirror said (null: unknown, compare loosely).
function sendSet(text, { quiet, mine } = {}) {
  const line = setLine(text);
  if (tooLong(line)) { note("That change is too large to send at once", "bad", line); return false; }
  if (mine === undefined) {
    mine = mirror.patch(text);
    if (mine.startsWith("!")) { note("Not applied: " + mine.slice(1), "bad", line); return false; }
  }
  if (!link) return true;
  pendingSets.push({ line, text, mine, quiet });
  send(line);
  return true;
}
// Coalesced drags: key -> { texts (applied to the mirror, newest last), timer, flush }
const waiting = {};
function flushAll() { for (const k of Object.keys(waiting)) waiting[k].flush(); }
export function patch(objs, { key, ms = 150 } = {}) {
  const list = (Array.isArray(objs) ? objs : [objs]).filter(Boolean);
  if (!list.length) return;
  if (!key) {
    for (const o of list) sendSet(JSON.stringify(o));
    publishSettings();
    return;
  }
  const texts = list.map(o => JSON.stringify(o)), mines = [];
  for (const t of texts) { const n = mirror.patch(t); if (n.startsWith("!")) { note("Not applied: " + n.slice(1), "bad"); return; } mines.push(n); }
  publishSettings();
  const w = waiting[key] || (waiting[key] = { texts: [], timer: 0 });
  clearTimeout(w.timer);
  w.texts = texts;   // the newest patch with this key replaces the waiting one
  w.flush = () => { clearTimeout(w.timer); delete waiting[key]; w.texts.forEach((t, i) => sendSet(t, { mine: mines[i] })); };
  w.timer = setTimeout(w.flush, ms);
}
let txAborting = false;
// A structural change: one transaction. One line only: sent plain.
export function tx(patchList, { quietNotes = true } = {}) {
  const list = (patchList || []).filter(Boolean);
  if (!list.length) return;
  flushAll();
  if (list.length === 1) { patch(list[0]); return; }
  const useTx = link && fwAtLeast(0, 5, 0);
  if (useTx) send("tx begin");
  list.forEach((o, i) => sendSet(JSON.stringify(o), { quiet: quietNotes && i < list.length - 1 }));
  if (useTx) send("tx commit");
  publishSettings();
}
export function refresh() { send("get"); send("preset list"); }

// Backup › Restore: each look is rebuilt on the bike and saved into its slot, then the settings themselves.
// looks: 8 entries, each null or a look's JSON (text or object, as `preset get N` returns it).
export function restore(settingsObject, looks) {
  if (Array.isArray(looks)) {
    const scratch = createController();
    looks.forEach((lk, n) => {
      if (!lk) return;
      scratch.load(settingsObject);
      const json = typeof lk === "string" ? lk : JSON.stringify(lk);
      if (scratch.presetApply(json).startsWith("!")) { note(`Look ${n + 1} could not be read from the file`, "bad"); return; }
      tx(L.settingsPatches(S.settings, scratch.get()));
      let name = ""; try { name = JSON.parse(json).name || ""; } catch (e) { /* unnamed */ }
      send(`preset save ${n} ${String(name).replace(/[^\x20-\x7e]/g, "?").slice(0, 24)}`.trim());
    });
    scratch.destroy();
    for (let n = 0; n < 8; n++) if (!looks[n] && S.looks.slots[n]) send(`preset del ${n}`);
  }
  tx(L.settingsPatches(S.settings, settingsObject));
  refresh();
}

// ---- operations -----------------------------------------------------------------------------------------
const stripOf = i => S.settings && S.settings.strips[i];
const wrapStrip = (i, o) => ({ strips: [...Array(i).fill(null), o] });
const stripBase = {};   // coalesced section edits: the strip the controller still holds, per key
export const op = {
  strip(i, fn) {
    const before = stripOf(i); if (!before) return;
    tx(L.stripPatches(i, before, fn(structuredClone(before))));
  },
  light: {
    // -> the new light's index k on that output
    add(i, light, sections, { order, geom } = {}) {
      const id = light.id || L.newLightId(S.settings);
      op.strip(i, st => L.addLight(st, { ...light, id }, sections, { order, geom }));
      const k = L.lightsOf(stripOf(i)).findIndex(l => l.id === id);
      return k;
    },
    remove(i, k) { op.strip(i, st => L.removeLight(st, k)); },
    move(i, k, dir) { op.strip(i, st => L.moveLight(st, k, dir)); },
    resize(i, k, n) { op.strip(i, st => L.resizeLight(st, k, n)); },
    patch(i, k, fields, opts) {
      const lt = Array(k + 1).fill(null); lt[k] = fields;
      patch(wrapStrip(i, { lt }), opts);
    },
    setSections(i, k, sections, { key, ms = 250 } = {}) {
      if (!key) { op.strip(i, st => L.withSections(st, k, sections)); return; }
      // a drag: show it at once, send the difference from what the controller holds after `ms` of quiet
      const id = "sec:" + key + ":" + i;
      if (!stripBase[id]) stripBase[id] = structuredClone(stripOf(i));
      const after = L.withSections(stripOf(i), k, sections);
      for (const p of L.stripPatches(i, stripOf(i), after)) mirror.patch(JSON.stringify(p));
      publishSettings();
      const w = waiting[id] || (waiting[id] = { texts: [], timer: 0 });
      clearTimeout(w.timer);
      w.flush = () => {
        clearTimeout(w.timer); delete waiting[id];
        const base = stripBase[id]; delete stripBase[id];
        const ps = L.stripPatches(i, base, stripOf(i));
        if (!ps.length) return;
        const useTx = link && ps.length > 1 && fwAtLeast(0, 5, 0);
        if (useTx) send("tx begin");
        ps.forEach((p, n) => sendSet(JSON.stringify(p), { mine: null, quiet: n < ps.length - 1 }));
        if (useTx) send("tx commit");
      };
      w.texts = [];
      w.timer = setTimeout(w.flush, ms);
    },
    setGeom(i, k, pts) { op.strip(i, st => L.withGeom(st, k, pts)); },
    setOrder(i, k, order) { op.strip(i, st => L.withOrder(st, k, order)); },
  },
  accent(fields, opts) { patch({ accent: fields }, opts); },
  drl(fields) { patch({ drl: fields }); },
  set(obj, opts) { patch(obj, opts); },
  looks: {
    apply(n) { flushAll(); send(`preset ${n}`); refresh(); },
    save(n, name) { flushAll(); send(`preset save ${n}${name ? " " + String(name).replace(/[^\x20-\x7e]/g, "?").slice(0, 24) : ""}`); send("preset list"); },
    del(n) { send(`preset del ${n}`); send("preset list"); },
  },
};

// ---- the preview scene and the local blinker ---------------------------------------------------------
const blinker = { on: false, t0: 0 };
export function setSim(fields) { Object.assign(S.sim, fields || {}); emit("status", S.status); }
export function scene(now = Date.now()) {
  const st = S.status || {}, sim = S.sim;
  const pick = (v, dflt) => v == null ? dflt : !!v;
  let left = pick(sim.left, !!st.l), right = pick(sim.right, !!st.r);
  if (sim.haz === true) left = right = true;
  const sc = { valid: !!st.v || S.demo, running: pick(sim.running, st.head ? st.head !== "off" : false), brake: pick(sim.brake, !!st.brk), left, right, blinkOn: false, progress: 0 };
  const turning = left || right;
  if (turning && !blinker.on) blinker.t0 = now;
  blinker.on = turning;
  if (turning) {
    const b = (S.settings && S.settings.blink) || { fpm: 85, duty: 50 };
    const period = 60000 / Math.max(1, b.fpm), ph = ((now - blinker.t0) % period) / period, duty = Math.max(0.05, b.duty / 100);
    sc.blinkOn = ph < duty; sc.progress = sc.blinkOn ? ph / duty : 0;
  }
  return sc;
}

// ---- frame loop: one for the whole app, about 30 a second, only while someone listens -------------------
const frame = { running: false, last: 0, raf: 0, t0: Date.now() };
function frameKick() {
  if (frame.running) return;
  frame.running = true;
  const raf = typeof requestAnimationFrame === "function" ? requestAnimationFrame : f => setTimeout(() => f(Date.now()), 33);
  const step = () => {
    if (!subs.frame || !subs.frame.size) { frame.running = false; return; }
    const now = Date.now();
    const hidden = typeof document !== "undefined" && document.hidden;
    if (!hidden && mirror && S.settings && now - frame.last >= 30) {
      frame.last = now;
      mirror.render(now - frame.t0, scene(now), true);
      emit("frame", now);
    }
    frame.raf = raf(step);
  };
  frame.raf = raf(step);
}
export const frameRunning = () => frame.running;

// ---- connecting, and the reconnect flow of the 0.4.9 app --------------------------------------------------
const recon = { timer: null, attempt: 0, busy: false, quick: 0 };
let autoWait = null, userClosed = false, attachedAt = 0;
const settingsWatch = { timer: null, tries: 0, got: false };
export const reconnectState = () => ({ ...recon, waiting: !!autoWait });

function scheduleReconnect(attempt) {
  clearTimeout(recon.timer);
  recon.attempt = attempt;
  const wait = attempt === 0 ? 1000 : Math.min(30000, 1000 * 2 ** attempt);
  setPhase("connecting", `Reconnecting in ${Math.round(wait / 1000)} s`);
  recon.timer = setTimeout(tryReconnect, wait);
}
async function tryReconnect() {
  if (!link || S.demo || userClosed || recon.busy) return;
  recon.busy = true;
  try {
    setPhase("connecting", "Reconnecting");
    await link.reconnect();
    attachedAt = Date.now(); recon.attempt = 0;
    linkUp();
  } catch (e) {
    if (!userClosed) scheduleReconnect(recon.attempt + 1);
  } finally { recon.busy = false; }
}
function cancelReconnect() { clearTimeout(recon.timer); recon.timer = null; recon.attempt = 0; }
// Stop the page-load wait for the remembered controller (Connect, the demo, or the page hidden).
export function stopAutoWait() {
  const w = autoWait;
  if (!w) return;
  autoWait = null; link = null;
  w.abort();
  setPhase("idle", "Not connected");
}
function dropped() {
  pendingSets.length = 0;
  emit("drop");
  if (S.demo || userClosed) return;
  if (expectDrop) { expectDrop = false; recon.quick = 0; scheduleReconnect(0); return; }   // restart / update: not a pairing refusal
  // A link the controller cuts within 20 s of coming up is a refusal (not paired, pairing closed), not a radio drop:
  // retrying would only make the phone ask to pair again and again.
  recon.quick = Date.now() - attachedAt < 20000 ? recon.quick + 1 : 0;
  if (recon.quick >= 2) {
    setPhase("connecting", "Disconnected");
    note("The controller keeps closing the link: it does not have this " + (/Windows/.test(navigator.userAgent) ? "PC" : "phone")
      + " paired. Open pairing (hold the handlebar button 5 s, or Add a phone from a paired phone), then Reconnect.", "bad");
    return;
  }
  scheduleReconnect(0);
}
let expectDrop = false;
// System › Controller: a restart or an update is about to drop the link on purpose.
export function expectLinkDrop() { expectDrop = true; }
// The Reconnect button after a drop.
export async function reconnectNow() {
  if (!link) return;
  cancelReconnect();
  try { setPhase("connecting", "Reconnecting…"); await link.reconnect(); attachedAt = Date.now(); recon.quick = 0; linkUp(); }
  catch (e) { setPhase("connecting", "Disconnected"); note(connectHelp(e), "bad"); if (!S.demo) scheduleReconnect(1); }
}
function linkUp() {
  S.name = link.name();
  setPhase("ready", S.demo ? "Demo" : "Connected");
  wantSettings();
}
// The board's settings come back as one long line in several notifications. Ask again, up to 3 times, then say why.
function wantSettings() {
  clearTimeout(settingsWatch.timer);
  settingsWatch.tries = 0; settingsWatch.got = false;
  send("info"); send("get"); send("preset list");
  const check = () => {
    if (!link || S.demo || settingsWatch.got) return;
    if (++settingsWatch.tries > 3) { note("The controller's settings did not come through. Tap Reconnect, or update the firmware.", "bad"); return; }
    send("get");
    settingsWatch.timer = setTimeout(check, 2500);
  };
  settingsWatch.timer = setTimeout(check, 2500);
}
export function connectHelp(e) {
  if (/security|insufficient|auth|gatt/i.test(e.message)) {
    const win = /Windows/.test(navigator.userAgent);
    return "The controller refused this " + (win ? "PC" : "phone") + ": it is not paired and the pairing window is closed. "
      + "Open it (hold the handlebar button 5 s, or Add a phone in System › Controller from a paired phone, or key off/on) and "
      + (win ? "pair in Windows Settings > Bluetooth first, then press Connect again." : "try again within 2 minutes.");
  }
  return "Couldn't connect: " + e.message;
}
// kind: "ble" (needs the tap), "auto" (page load: the remembered controller, no chooser), "demo".
// "auto" keeps listening until the controller is heard (page opened before the key is on) and steps aside the
// moment Connect or the demo is tapped.
export async function connect(kind, opts = {}) {
  const demo = kind === "demo", auto = kind === "auto";
  if (!auto) stopAutoWait();
  if (link) return;
  S.connErr = ""; S.demo = demo; userClosed = false; cancelReconnect();
  S.fw = null; S.settings = null; S.status = null; S.warn = ""; pendingSets.length = 0;
  const mine = link = demo ? new DemoLink(handlers, { fw: opts.fw }) : new BleLink(handlers);
  try {
    if (auto) {
      const wait = autoWait = new AbortController();
      setPhase("waiting", "Looking for the controller…");
      const slow = setTimeout(() => { if (autoWait === wait) setPhase("waiting", "Waiting for the controller (key on?)"); }, 4000);
      let found;
      try { found = await mine.openRemembered(0, wait.signal); }
      finally { clearTimeout(slow); if (autoWait === wait) autoWait = null; }
      if (link !== mine) return;          // Connect or the demo took over while this waited
      if (!found) {
        link = null;
        if (BleLink.why !== "cancelled" && BleLink.why !== "no controller remembered yet") S.connErr = "Didn't reconnect by itself: " + (BleLink.why || "unknown") + ". Tap Connect.";
        setPhase("idle", "Not connected");
        return;
      }
    } else {
      setPhase("connecting", demo ? "Starting demo…" : "Connecting…");
      await link.open();
    }
  } catch (e) {
    if (link !== mine) return;
    link = null;
    if (auto) S.connErr = "Found the controller but couldn't connect by itself: " + e.message + ". Tap Connect.";
    else if (e.name !== "NotFoundError") S.connErr = connectHelp(e);
    setPhase("idle", "Not connected");
    return;
  }
  attachedAt = Date.now(); recon.quick = 0;
  linkUp();
}
export function disconnect() {
  userClosed = true; cancelReconnect(); stopAutoWait(); clearTimeout(settingsWatch.timer);
  if (link) link.close();
  link = null;
  for (const k of Object.keys(waiting)) { clearTimeout(waiting[k].timer); delete waiting[k]; }
  pendingSets.length = 0;
  Object.assign(S, { demo: false, name: "", fw: null, settings: null, status: null, warn: "", looks: { pre: -1, prem: 0, slots: Array(8).fill(null) },
    sim: { running: null, brake: null, left: null, right: null, haz: null }, connErr: "" });
  setPhase("idle", "Not connected");
}
// Page shown again: listen again, and if a reconnect after a drop is waiting on its timer, try it now.
export function pageShown() {
  if (!link && !userClosed && navigator.bluetooth && navigator.bluetooth.getDevices) connect("auto");
  else if (link && !S.demo && recon.timer && !recon.busy) { clearTimeout(recon.timer); tryReconnect(); }
}
// Tests: drop every listener and the link (main.js boot() calls this before mounting again).
export function reset() {
  disconnect();
  for (const k of Object.keys(subs)) subs[k].clear();
  userClosed = false;
  if (mirror) mirror.defaults();
}
