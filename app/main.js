// Boot, the connect screen, header, banner, nav and the layout frame (spec 3.1).
// Regions: #stage (the bike view), #panel (the tab), #side (sheets). Phone: one column, nav at the bottom; PC (>= 1100 px):
// nav in the header and three columns.
import { initCore } from "./core.js";
import * as store from "./store.js";
import { S, on, connect, disconnect, reconnectNow, op } from "./store.js";
import { el, clear, button, toast, panel, note, setSideHint, currentSheet } from "./ui.js";
import { mountRide } from "./ride.js";
import { mountBike } from "./bike.js";
import { mountSystem } from "./system.js";
import { mountBikeView } from "./bikeview.js";
import { openLight, closeSheet, onLightChange, currentLight } from "./sheet.js";

export const MIN_FW = [0, 5, 0];
const TABS = [["ride", "Ride"], ["bike", "Bike"], ["system", "System"]];
const R = {};                 // the frame's elements
let mounted = null, mountedKey = "", view = null, offs = [], visHandler = null;
const navSubs = new Set();

export const nav = {
  tab: "ride", page: null,
  go(tab, { page } = {}) {
    if (!TABS.some(t => t[0] === tab)) return;
    nav.tab = tab; nav.page = page || null;
    render();
    navSubs.forEach(fn => { try { fn(tab, nav.page); } catch (e) { console.error(e); } });
  },
  on(fn) { navSubs.add(fn); return () => navSubs.delete(fn); },
};
export const bikeView = () => (view && R.frame && !R.frame.classList.contains("no-stage") && S.settings ? view : null);
// Firmware older than 0.5.0: the mirror cannot hold its settings as lights, so only System is usable.
export const fwTooOld = () => !!(S.fw && cmp(S.fw.n, MIN_FW) < 0);
const cmp = (a, b) => { for (let i = 0; i < 3; i++) if ((a[i] | 0) !== (b[i] | 0)) return (a[i] | 0) - (b[i] | 0); return 0; };
const inApp = () => S.phase === "ready" || (S.phase === "connecting" && !!S.settings);

export async function boot({ wasm } = {}) {
  shutdown();
  await initCore({ bytes: wasm });
  store.init();
  build();
  offs = [
    on("phase", render), on("warn", paintBanner), on("settings", () => { if (fwTooOld() !== R.gated || !R.hinted) { R.hinted = !!S.settings; render(); } else paintBanner(); }),
    on("note", (t, kind) => toast(t, kind === "bad" ? "bad" : "warn")),
    onLightChange(ref => { if (view) view.select(ref); }),
  ];
  // For the browser console and scripted checks: rcr.S, rcr.store.op..., rcr.bikeView(), rcr.nav.go("bike").
  if (typeof window !== "undefined") window.rcr = { S, store, nav, bikeView, openLight, closeSheet };
  render();
  start();
}
export function shutdown() {
  offs.forEach(f => f()); offs = [];
  if (mounted) { try { mounted.destroy(); } catch (e) { /* stub */ } mounted = null; mountedKey = ""; }
  if (view) { try { view.destroy(); } catch (e) { /* stub */ } view = null; }
  try { closeSheet(); } catch (e) { /* none */ }
  if (visHandler) { document.removeEventListener("visibilitychange", visHandler); visHandler = null; }
  store.reset();
  nav.tab = "ride"; nav.page = null;
}

function build() {
  const root = document.getElementById("app") || document.body.appendChild(el("div", { id: "app" }));
  clear(root);
  R.dot = el("span", { class: "dot", "aria-hidden": "true" });
  R.linkText = el("span", { class: "txt", id: "linkText" }, "Not connected");
  R.linkBtn = button("Connect", { small: true, id: "linkBtn", onClick: linkBtn });
  R.nav = el("nav", { class: "nav", id: "nav", "aria-label": "Screens" },
    TABS.map(([k, label]) => el("button", { type: "button", "data-tab": k, id: "nav-" + k, "aria-pressed": "false", onclick: () => nav.go(k) }, label)));
  R.hdr = el("header", { class: "hdr" }, el("div", { class: "brand" }, "RCR Lighting"), R.nav, el("div", { class: "grow" }),
    el("div", { class: "conn" }, R.dot, R.linkText, R.linkBtn));
  R.banner = el("div", { class: "banners", id: "banner", role: "status" });
  R.panel = el("section", { id: "panel" });
  R.stage = el("section", { id: "stage", "aria-label": "Bike view" });
  R.side = el("aside", { id: "side" });
  R.frame = el("div", { class: "frame", id: "frame" }, R.panel, R.stage, R.side);
  root.append(R.hdr, R.banner, R.frame);
  setSideHint(() => el("div", { class: "side-hint", id: "sideHint" }, S.settings ? "Tap a light, on the bike or in the list, to open its sheet." : ""));
  R.side.append(el("div", { class: "side-hint", id: "sideHint" }));
}

// ---- what is on screen -------------------------------------------------------------------------------
function render() {
  if (!R.frame) return;
  paintHeader();
  const hint = document.getElementById("sideHint");
  if (hint && !currentSheet()) hint.textContent = inApp() && S.settings && !fwTooOld() && nav.tab !== "system" ? "Tap a light, on the bike or in the list, to open its sheet." : "";
  paintBanner();
  const app = inApp();
  R.nav.hidden = !app;
  R.gated = fwTooOld();
  if (!app) {
    if (mounted) { mounted.destroy(); mounted = null; mountedKey = ""; }
    if (currentSheet()) closeSheet();
    R.frame.classList.add("no-stage");
    if (view) view.setMode("hidden");
    showConnect();
    return;
  }
  R.nav.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.tab === nav.tab)));
  const sys = nav.tab === "system";
  const key = R.gated && !sys ? "gate:" + nav.tab : nav.tab + ":" + (nav.page || "");
  R.frame.classList.toggle("no-stage", sys || R.gated);
  if (!sys && !R.gated && !view) {
    view = mountBikeView(R.stage, { onPick: ref => openLight(ref), onMove: (ref, pts) => op.light.setGeom(ref.out, ref.k, pts) });
    view.select(currentLight());
  }
  if (view) view.setMode(sys || R.gated ? "hidden" : nav.tab === "bike" ? "edit" : "ride");
  if (key === mountedKey && mounted) return;
  if (mounted) { try { mounted.destroy(); } catch (e) { console.error(e); } }
  clear(R.panel);
  mountedKey = key;
  if (R.gated && !sys) mounted = mountGate(R.panel);
  else if (nav.tab === "ride") mounted = mountRide(R.panel);
  else if (nav.tab === "bike") mounted = mountBike(R.panel);
  else mounted = mountSystem(R.panel, { page: nav.page });
}
function paintHeader() {
  const ready = S.phase === "ready";
  R.dot.className = "dot" + (ready ? (S.demo ? " demo" : " ok") : "");
  R.linkText.textContent = ready ? (S.demo ? "Demo" : "Connected" + (S.fw ? " · " + S.fw.text : "")) : S.connText || "Not connected";
  R.linkBtn.textContent = ready ? "Disconnect" : inApp() ? "Reconnect" : "Connect";
  R.linkBtn.disabled = !inApp() && !(typeof navigator !== "undefined" && navigator.bluetooth);
}
function paintBanner() {
  if (!R.banner) return;
  clear(R.banner);
  if (!inApp()) return;
  if (fwTooOld()) R.banner.append(el("div", { class: "banner bad", id: "fwBanner" }, `Update the controller to ${MIN_FW.join(".")}: it runs ${S.fw.text}. `,
    el("button", { type: "button", class: "link", onclick: () => nav.go("system", { page: "controller" }) }, "System › Controller")));
  if (S.warn) R.banner.append(el("div", { class: "banner", id: "warnBanner" }, "Setup: " + S.warn));
  // Outputs that hold LEDs or sections but no lights were set up by the previous app (or are the factory sample):
  // they keep working as they are, but nothing here can edit them until they are cleared.
  const before = !fwTooOld() && S.settings ? S.settings.strips.map((st, i) => ((!st.out || st.out === "pixels") && !(st.lights || []).length && ((st.px | 0) > 0 || (st.seg || []).length) ? i + 1 : 0)).filter(Boolean) : [];
  if (before.length) R.banner.append(el("div", { class: "banner", id: "oldSetupBanner" },
    `Output${before.length > 1 ? "s" : ""} ${before.join(", ")} ${before.length > 1 ? "were" : "was"} set up before version 0.5 and cannot be edited here. To set the bike up in this app: `,
    el("button", { type: "button", class: "link", onclick: () => nav.go("system", { page: "backup" }) }, "System › Backup › Start over")));
}
function mountGate(host) {
  host.append(panel(null, el("div", { class: "pad", id: "updateCard" },
    el("h2", { style: "font:700 20px/1.2 var(--cond);margin-bottom:6px" }, "Update the controller"),
    note(`This app needs controller firmware ${MIN_FW.join(".")} or newer to show the bike's lights. The controller runs ${S.fw ? S.fw.text : "an older version"}. `
      + "The firmware update is in System › Controller; everything in System works on this version."),
    el("div", { class: "btns", style: "margin-top:10px" }, button("Open System › Controller", { kind: "primary", id: "gateGo", onClick: () => nav.go("system", { page: "controller" }) }),
      el("a", { class: "btn", id: "gateOld", href: "v049.html" }, "Use the previous app")),
    note("The previous app still works with this controller as it is. Disconnect here first: the controller talks to one page at a time."))));
  return { destroy() {} };
}
async function linkBtn() {
  if (S.phase === "ready") { disconnect(); return; }
  if (inApp()) { reconnectNow(); return; }
  connect("ble");
}

// ---- the connect screen (texts and behavior of the 0.4.9 app) ------------------------------------------
function showConnect() {
  if (mountedKey === "connect" && document.getElementById("btnConnect")) { paintConnect(); return; }
  clear(R.panel); mountedKey = "connect";
  R.err = el("p", { class: "err", id: "connectErr", hidden: true });
  R.hint = el("p", { class: "note", id: "connectHint", hidden: true }, "To have this page find the controller by itself every time it opens: in Chrome, open ",
    el("code", { style: "user-select:all" }, "chrome://flags/#enable-web-bluetooth-new-permissions-backend"),
    ", set it to Enabled, relaunch Chrome, then Connect here once. After that there is no chooser on a reload, and the page connects when the key comes on.");
  R.btnConnect = button("Connect", { kind: "primary", id: "btnConnect", onClick: () => connect("ble") });
  R.wait = el("p", { class: "note", id: "connectWait", hidden: true });
  R.panel.append(el("div", { class: "panel hello", id: "connect" },
    el("h2", {}, "Connect to the controller"),
    el("ol", {},
      el("li", {}, "Switch the key on. The first phone can pair in the 2 minutes after power-up. To add another phone later, hold the handlebar button for 5 seconds (the hazards flash while it opens), or use Add a phone in System › Controller from a phone that is already paired."),
      el("li", {}, "Tap Connect and pick “RCR Lighting”. Android asks to pair the first time."),
      el("li", {}, "On a Windows PC, Chrome cannot do the pairing itself: pair in Windows Settings › Bluetooth › Add device › RCR Lighting while the pairing window is open, then press Connect here.")),
    el("div", { class: "btns" }, R.btnConnect, button("Try the demo", { id: "btnDemo", onClick: () => connect("demo") })),
    R.wait, R.err, R.hint),
    note("The demo runs a simulated controller in this page, on the controller's own firmware code."));
  paintConnect();
}
function paintConnect() {
  const bt = typeof navigator !== "undefined" && navigator.bluetooth;
  const framed = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
  R.btnConnect.disabled = !bt || framed;
  let err = S.connErr;
  if (!bt || framed) err = framed ? "Connecting needs this page open on its own in Chrome, not inside another app. The demo works here."
    : "This browser can't use Bluetooth. Open this page in Chrome on Android (or desktop Chrome) over https. The demo works anywhere.";
  R.err.textContent = err; R.err.hidden = !err;
  R.hint.hidden = !(bt && !framed && !bt.getDevices);
  R.wait.textContent = S.phase === "waiting" || S.phase === "connecting" ? S.connText : "";
  R.wait.hidden = !R.wait.textContent;
}
function start() {
  let q = null;
  try { q = new URLSearchParams(location.search); } catch (e) { /* no location */ }
  if (q && q.has("demo")) { connect("demo"); return; }
  const bt = navigator.bluetooth;
  const framed = (() => { try { return window.top !== window.self; } catch (e) { return true; } })();
  if (!bt || framed || !bt.getDevices) return;
  // Reload or reopen: go straight back to the controller this page last used, no chooser.
  connect("auto");
  // Hidden page: stop listening (no scan with the phone in a pocket). Shown again: listen again.
  visHandler = () => { if (document.hidden) store.stopAutoWait(); else store.pageShown(); };
  document.addEventListener("visibilitychange", visHandler);
}

// In the browser the module boots itself; the tests import it and call boot() with the wasm bytes.
if (typeof window !== "undefined" && typeof document !== "undefined" && !/jsdom/i.test(navigator.userAgent || "")) {
  boot().catch(e => {
    console.error(e);
    const root = document.getElementById("app");
    if (root) root.textContent = "The app could not start: " + e.message;
  });
}
