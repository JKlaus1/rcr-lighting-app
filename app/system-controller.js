// System › Controller: name, phones, firmware, the update Wi-Fi password, and the two progress cards (firmware update,
// restart) with every state of the 0.4.9 app: the command was sent, the controller confirmed it, the Bluetooth link
// dropped on purpose, it came back and on which firmware. Firmware 0.4.5+ confirms both commands in words; older
// firmware is handled from the link and `info` alone.
import { S, on, op, send, expectLinkDrop } from "./store.js";
import { coreVersion } from "./core.js";
import { el, clear, button, armed, panel, note, toast } from "./ui.js";

export const JOB_STEPS = {
  restart: ["Restart sent", "Controller confirmed: restarting", "Link dropped while it restarts (expected)", "Reconnected"],
  ota: ["Update request sent", "Controller confirmed: update Wi-Fi starting", "Bluetooth off, update Wi-Fi on (link drop expected)",
    "Join the Wi-Fi and upload the -ota.bin file", "Controller back"],
};
// How long each wait lasts (ms). Tests shorten them.
export const JOB_TIMING = { noAnswer: 6000, noDrop: 8000, notBack: 40000 };
const FLAG = "chrome://flags/#enable-web-bluetooth-new-permissions-backend";

// The job lives in this module, not in the page, so it keeps running while the user looks at another page.
export const job = { kind: null, step: 0, t0: 0, fwBefore: null, wifi: null, dropped: false, timer: 0, end: null, why: "", doc: null, offs: [], box: null };
let apInfo = null;   // { ssid, pass } from the `info` reply: the update Wi-Fi as the controller reports it

function jobReset() { clearTimeout(job.timer); job.offs.forEach(f => f()); Object.assign(job, { kind: null, step: 0, wifi: null, dropped: false, end: null, why: "", offs: [] }); }
export function jobStart(kind) {
  jobReset();
  Object.assign(job, { kind, step: 1, t0: Date.now(), fwBefore: S.fw ? S.fw.text : null, doc: document });
  job.offs = [on("out", (line, dir) => { if (dir === "in") jobLine(line); }), on("drop", jobDrop)];
  expectLinkDrop();
  // No reply in time: the command did not reach the controller (or it refused without a reason we know).
  job.timer = setTimeout(() => { if (job.kind === kind && job.step === 1 && !job.end) jobEnd("bad", `No answer from the controller in ${Math.round(JOB_TIMING.noAnswer / 1000)} s. Check the link and try again.`); }, JOB_TIMING.noAnswer);
  jobPaint();
}
function jobEnd(how, why) { job.end = how; job.why = why || ""; clearTimeout(job.timer); job.offs.forEach(f => f()); job.offs = []; jobPaint(); }
export function jobClose() { jobReset(); job.kind = null; jobPaint(); }
// The access point line (from `info`) is kept for the old reply form and shown on the page.
function apLine(line) {
  const ap = /^OTA access point(?::)? (?:Wi-Fi )?"([^"]+)"(?:, password (\S+)| \(open, no password\))/.exec(line);
  if (ap) { apInfo = { ssid: ap[1], pass: ap[2] || "" }; paintAp(); }
}
function jobLine(line) {
  apLine(line);
  if (/^RCR Lighting/.test(line)) { jobInfo(line); return; }
  if (!job.kind || job.end) return;
  let m;
  if (job.kind === "restart" && /^(restarting|rebooting)\b/.test(line)) {
    job.step = Math.max(job.step, 3); clearTimeout(job.timer);
    // The link should drop within a couple of seconds; if it does not, say so.
    job.timer = setTimeout(() => { if (job.kind === "restart" && !job.dropped && !job.end) jobEnd("bad", "The controller said it was restarting, but the link never dropped. Check the uptime in the console (info)."); }, JOB_TIMING.noDrop);
  } else if (job.kind === "ota" && (m = /^OTA (?:starting|already running): Wi-Fi "([^"]+)"(?:, password (\S+)| \(open, no password\)), page (\S+)/.exec(line))) {
    job.wifi = { ssid: m[1], pass: m[2] || "", url: m[3], old: false }; job.step = Math.max(job.step, 3); clearTimeout(job.timer);
  } else if (job.kind === "ota" && (m = /^OTA access point "([^"]+)" starting/.exec(line))) {   // 0.4.4 and older
    job.wifi = { ssid: m[1], pass: (apInfo && apInfo.pass) || "", url: "http://192.168.4.1", old: true }; job.step = Math.max(job.step, 3); clearTimeout(job.timer);
  } else if (/^(ota|reboot): switch the lights off first/.test(line)) {
    jobEnd("bad", "Refused: switch the lights off first (no brake or turn signal), then try again.");
    return;
  } else return;
  jobPaint();
}
function jobDrop() {
  if (!job.kind || job.end) return;
  job.dropped = true;
  job.step = Math.max(job.step, job.kind === "restart" ? 3 : 4);
  clearTimeout(job.timer);
  // A restart is back in about 5 s; give it 40 s. The update waits as long as the person needs.
  if (job.kind === "restart") job.timer = setTimeout(() => { if (job.kind === "restart" && !job.end) jobEnd("bad", `Not back after ${Math.round(JOB_TIMING.notBack / 1000)} s. Is the key on? Tap Reconnect.`); }, JOB_TIMING.notBack);
  jobPaint();
}
function jobInfo(line) {   // the `info` reply after a reconnect says what is running now
  if (!job.kind || job.end || !job.dropped) return;
  const v = (/firmware (\d+\.\d+\.\d+)/.exec(line) || [])[1];
  if (!v) return;
  job.step = JOB_STEPS[job.kind].length;
  if (job.kind === "restart") jobEnd("ok", `Running firmware ${v}.`);
  else if (job.fwBefore && v !== job.fwBefore) jobEnd("ok", `Updated: firmware ${job.fwBefore} → ${v}.`);
  else jobEnd("bad", `Back on the same firmware ${v}: no update was applied (closed without an upload, or the upload failed).`);
}

function jobPaint() {
  const box = job.box;
  if (!box || !box.isConnected) return;
  clear(box);
  if (!job.kind) { box.hidden = true; return; }
  box.hidden = false; box.className = "job" + (job.end === "ok" ? " ok" : job.end === "bad" ? " bad" : "");
  const steps = JOB_STEPS[job.kind];
  const ol = el("ol", {}, steps.map((t, i) => {
    const n = i + 1;
    const cls = job.end === "bad" && n === job.step ? "fail" : n < job.step || (job.end === "ok" && n <= job.step) ? "done" : n === job.step ? "now" : null;
    return el("li", { class: cls }, t);
  }));
  const kids = [el("h3", {}, (job.kind === "ota" ? "Firmware update" : "Restart") + (job.end === "ok" ? ": done" : job.end === "bad" ? ": stopped" : "…")), ol];
  if (job.kind === "ota" && job.wifi && !job.end) {
    kids.push(el("div", { class: "cred", id: "sys-job-wifi" }, el("span", {}, "Wi-Fi"), el("b", {}, job.wifi.ssid), el("span", {}, "Password"), el("b", {}, job.wifi.pass || "none (open)"),
      el("span", {}, "Page"), el("b", {}, job.wifi.url)));
    kids.push(note(job.wifi.old
      ? "This firmware (before 0.4.5) cannot keep Bluetooth and the update Wi-Fi up together: the Wi-Fi may not appear at all. If it does not, update over USB once."
      : "Bluetooth stays off until the controller restarts. Upload the file ending in -ota.bin (not -factory.bin); the page says when it is done and the controller restarts by itself. Nothing to upload? It closes after 15 min and restarts once the lights are off."));
  }
  if (job.why) kids.push(el("p", { class: "note ink", id: "sys-job-why" }, job.why));
  if (job.end || job.step >= 3) kids.push(el("div", { class: "btns" }, button(job.end ? "Close" : "Hide", { small: true, id: "sys-job-close", onClick: jobClose })));
  box.append(...kids);
}
let apEl = null;
function paintAp() { if (apEl && apEl.isConnected) apEl.textContent = apInfo ? (apInfo.pass ? `${apInfo.ssid} / ${apInfo.pass}` : `${apInfo.ssid} (open, no password)`) : "Shown when an update is started"; }

export function buildController(host) {
  // a job from an earlier session of the page (a new boot) is stale
  if (job.doc && job.doc !== document) { jobReset(); job.kind = null; }
  const s = () => S.settings;
  const nameIn = el("input", { type: "text", id: "sys-ble-name", maxLength: 20, value: s().ble_name, "aria-label": "Bluetooth name" });
  const nameBtn = button("Save name", { small: true, id: "sys-ble-save", onClick: () => {
    const v = nameIn.value.trim();
    if (!v) { toast("The name cannot be empty", "warn"); return; }
    op.set({ ble_name: v }); toast("Saved. The new Bluetooth name shows after a restart.");
  } });
  const fwVal = el("span", { class: "val", id: "sys-fw" }), coreVal = el("span", { class: "val", id: "sys-core" }, coreVersion());
  apEl = el("div", { class: "sys-ap", id: "sys-ap" }); paintAp();
  const pairHint = el("div", { class: "hint", id: "sys-pair-hint" });
  const pairBtn = button("Add a phone", { id: "sys-pair", onClick: () => send("pair") });
  const info = panel("Controller",
    el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Bluetooth name")), el("div", { class: "sys-inline" }, nameIn, nameBtn),
      el("div", { class: "hint" }, "The new name shows after a restart.")),
    el("div", { class: "row" }, el("span", { class: "txt" }, el("b", {}, "Controller firmware")), fwVal),
    el("div", { class: "row" }, el("span", { class: "txt" }, el("b", {}, "Core in this app"), el("small", {}, "The settings code the app runs to show the bike")), coreVal),
    el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Phones")), el("div", { class: "btns" }, pairBtn), pairHint));

  // ---- update Wi-Fi password -------------------------------------------------------------------------------------
  const passIn = el("input", { type: "password", id: "sys-ota-pass", maxLength: 32, placeholder: "8 to 32 characters", autocomplete: "new-password", "aria-label": "Update Wi-Fi password" });
  const passSet = button("Set password", { small: true, id: "sys-ota-set", onClick: () => {
    if (passIn.value.length < 8) { toast("The password needs at least 8 characters", "warn"); return; }
    op.set({ ota_pass: passIn.value }); passIn.value = ""; toast("Update Wi-Fi password set.");
  } });
  const passRemove = armed(button("Remove password", { small: true, id: "sys-ota-remove" }), "Tap again: open update Wi-Fi", () => { op.set({ ota_pass: "" }); toast("Update Wi-Fi password removed: the update Wi-Fi is open."); });
  const wifi = panel("Update Wi-Fi",
    el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Wi-Fi to join for an update")), apEl),
    el("div", { class: "field" }, el("span", { class: "lbl" }, el("b", {}, "Password")), el("div", { class: "sys-inline" }, passIn, passSet),
      el("div", { class: "hint" }, "Optional. With none (the default) the update Wi-Fi is open; it only exists while an update was asked for and closes after 15 min."), el("div", { class: "btns", style: "margin-top:8px" }, passRemove)));

  // ---- update and restart -----------------------------------------------------------------------------------------
  const jobBox = el("div", { class: "job", id: "sys-job", role: "status", "aria-live": "polite", hidden: true });
  job.box = jobBox;
  const old = el("div", { class: "note warn", id: "sys-old-fw", hidden: true });
  const otaBtn = armed(button("Start firmware update", { id: "sys-ota-start" }), "Tap again to start the update Wi-Fi", () => { jobStart("ota"); send("ota"); });
  const rebootBtn = armed(button("Restart", { id: "sys-reboot" }), "Tap again to restart", () => { jobStart("restart"); send("reboot"); });
  const upd = panel("Firmware update and restart",
    el("div", { class: "pad" }, old,
      note("Start firmware update turns the controller's update Wi-Fi on: join it from this phone or a PC, open the page it shows and upload the file ending in -ota.bin. Bluetooth turns off while it runs, and the lights keep working. Restarting drops the lights for about half a second."),
      el("div", { class: "btns", style: "margin-top:10px" }, otaBtn, rebootBtn), jobBox));

  const connected = !S.demo && typeof navigator !== "undefined";
  const flag = connected && !(navigator.bluetooth && navigator.bluetooth.getDevices)
    ? note(`To have this page find the controller by itself every time it opens: in Chrome, open ${FLAG}, set it to Enabled, relaunch Chrome, then Connect here once. After that there is no chooser on a reload, and the page connects when the key comes on.`)
    : null;
  const help = panel("If it will not connect",
    el("div", { class: "pad" },
      note("Add a phone opens pairing for 2 minutes. You can also hold the handlebar button 5 s, or switch the key off and on. A phone that was paired before and is asked to pair again: remove (forget) the controller in the phone's Bluetooth settings, open pairing, and pair once."),
      el("div", { style: "height:8px" }), flag || note("This browser can find the controller again by itself after a reload.")));

  host.append(info, wifi, upd, help);
  const paint = () => {
    const st = S.status || {};
    fwVal.textContent = S.fw ? S.fw.text : "unknown";
    pairHint.textContent = st.pair ? "Pairing is open: pair the new phone now." : "Lets a new phone pair during the next 2 minutes.";
    pairBtn.setAttribute("aria-pressed", String(!!st.pair));
    const oldFw = !!(S.fw && (S.fw.n[0] === 0 && S.fw.n[1] < 5));
    // Not too old, but older than the firmware core this app carries: everything it has works, what is newer is not offered.
    const core = coreVersion().split(".").map(Number);
    const behind = !!(S.fw && !oldFw && (S.fw.n[0] - core[0] || S.fw.n[1] - core[1] || S.fw.n[2] - core[2]) < 0);
    old.hidden = !(oldFw || behind);
    old.className = oldFw ? "note warn" : "note";
    old.textContent = oldFw ? `This controller runs ${S.fw.text}. The app needs 0.5.0 or newer: start the firmware update here, join the Wi-Fi it shows and upload the 0.5.0 -ota.bin file.`
      : behind ? `This controller runs ${S.fw.text} and this app is made for ${coreVersion()}. Everything the controller has works. What came with ${coreVersion()} shows up once it is updated: start the firmware update here and upload the ${coreVersion()} -ota.bin file.` : "";
    if (document.activeElement !== nameIn && S.settings) nameIn.value = S.settings.ble_name;
  };
  paint(); jobPaint();
  const offAp = on("out", (line, dir) => { if (dir === "in") apLine(line); });
  send("info");
  return { update: paint, status: paint, phase: paint, destroy() { offAp(); if (job.box === jobBox) job.box = null; apEl = null; } };
}
