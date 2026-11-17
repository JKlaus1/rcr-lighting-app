// System › Backup: save the setup (settings and the saved looks) to a file, restore from one, start over, factory reset.
import { S, on, send, refresh, tx, restore, fwAtLeast } from "./store.js";
import { coreVersion } from "./core.js";
import { el, button, armed, panel, note } from "./ui.js";
import { stripPatch } from "./system-kit.js";

export const FILE_APP = "rcr-lighting";

// ---- the file --------------------------------------------------------------------------------------------------
// One look as `preset get N` returns it: the next JSON line that is not a settings, status or reply line.
export function fetchLook(n, ms = 3000) {
  return new Promise(resolve => {
    let off = null, timer = 0;
    const done = v => { if (off) off(); clearTimeout(timer); resolve(v); };
    off = on("out", (line, dir) => {
      if (dir !== "in") return;
      if (line[0] !== "{") { if (/^preset \d+ is empty/.test(line)) done(null); return; }
      let j; try { j = JSON.parse(line); } catch (e) { return; }
      if (!j || typeof j !== "object" || "ok" in j || "ch" in j || Array.isArray(j.slots) || (j.head && j.strips)) return;
      done(j);
    });
    timer = setTimeout(() => done(undefined), ms);
    send("preset get " + n);
  });
}
// -> { file, missing: [slot numbers whose look did not come back] }
export async function makeBackup() {
  const settings = structuredClone(S.settings);
  delete settings.ota_pass;                       // the update Wi-Fi password stays out of the file
  const looks = [], missing = [];
  for (let n = 0; n < 8; n++) {
    if (!S.looks.slots[n]) { looks.push(null); continue; }
    const j = await fetchLook(n);
    if (j === undefined) missing.push(n);
    looks.push(j || null);
  }
  return { file: { app: FILE_APP, version: coreVersion(), saved: new Date().toISOString(), settings, looks }, missing };
}
// Validate a file's text: -> { settings, looks } or { err }.
export function parseBackup(text) {
  let j; try { j = JSON.parse(text); } catch (e) { return { err: "That file is not a setup file (it is not JSON)." }; }
  if (!j || typeof j !== "object" || j.app !== FILE_APP) return { err: "That file is not an RCR Lighting setup file." };
  if (!j.settings || typeof j.settings !== "object" || !Array.isArray(j.settings.strips) || j.settings.strips.length !== 4) return { err: "That setup file does not hold the settings of four outputs." };
  if (!Array.isArray(j.looks) || j.looks.length !== 8 || !j.looks.every(l => l == null || typeof l === "object" || typeof l === "string")) return { err: "That setup file does not hold the eight look slots." };
  return { settings: j.settings, looks: j.looks };
}
// A temporary link with the download attribute (no pop-up). Where object URLs do not exist, a data: URL does the same.
export function saveFile(name, text) {
  let url, revoke = false;
  try { url = URL.createObjectURL(new Blob([text], { type: "application/json" })); revoke = true; }
  catch (e) { url = "data:application/json;charset=utf-8," + encodeURIComponent(text); }
  const a = el("a", { href: url, download: name, style: "display:none" });
  document.body.append(a); a.click(); a.remove();
  if (revoke) setTimeout(() => URL.revokeObjectURL(url), 2000);
}
// Everything off the bike: every output empty (`px 0 nseg 0 nlt 0 ngpt 0 nord 0`), accent "every light" off, the looks erased.
export function startOver() {
  const patches = [0, 1, 2, 3].map(i => stripPatch(i, { px: 0, nseg: 0, nlt: 0, ngpt: 0, nord: 0 }));
  tx([...patches, { accent: { all: false } }]);
  for (let n = 0; n < 8; n++) if (S.looks.slots[n]) send(`preset del ${n}`);
  send("preset list");
}

export function buildBackup(host) {
  const status = el("p", { class: "note", id: "sys-backup-status", role: "status" }, "");
  const say = (t, kind) => { status.textContent = t; status.className = "note" + (kind ? " " + kind : ""); };
  const saveBtn = button("Save the setup to a file", { kind: "primary", id: "sys-backup-save", onClick: async () => {
    saveBtn.disabled = true; say("Reading the saved looks from the controller…");
    try {
      const { file, missing } = await makeBackup();
      saveFile(`rcr-setup-${file.saved.slice(0, 10)}.json`, JSON.stringify(file, null, 1));
      const n = file.looks.filter(Boolean).length;
      say(`Saved the settings and ${n} ${n === 1 ? "look" : "looks"}.` + (missing.length ? ` Look ${missing.map(m => m + 1).join(", ")} did not come back from the controller and is not in the file.` : ""), missing.length ? "warn" : "");
    } finally { saveBtn.disabled = false; }
  } });
  const fileIn = el("input", { type: "file", id: "sys-restore-file", accept: ".json,application/json", "aria-label": "Setup file to restore",
    onchange: () => { const f = fileIn.files && fileIn.files[0]; if (!f) return; readText(f).then(doRestore, () => say("That file could not be read.", "bad")); fileIn.value = ""; } });
  function readText(f) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsText(f); }); }
  async function doRestore(text) {
    const r = parseBackup(text);
    if (r.err) { say(r.err, "bad"); return; }
    const nLooks = r.looks.filter(Boolean).length, notes = [];
    const off = on("note", t => notes.push(t));
    say(`Restoring ${nLooks} ${nLooks === 1 ? "look" : "looks"} and the settings…`);
    restore(r.settings, r.looks);
    await new Promise(res => { const o2 = on("settings", () => { clearTimeout(t); o2(); setTimeout(res, 150); }); const t = setTimeout(() => { o2(); res(); }, 2500); });
    off();
    say(`Restored ${nLooks} ${nLooks === 1 ? "look" : "looks"} and the settings.` + (notes.length ? " Notes from the controller: " + notes.join("; ") : ""), notes.length ? "warn" : "");
  }
  const restoreLabel = el("label", { class: "btn", id: "sys-restore-label" }, "Restore from a file", fileIn);

  const overBtn = armed(button("Start over: clear every light and look", { kind: "danger", id: "sys-start-over" }), "Tap again to clear everything", () => {
    startOver(); say("Every output is empty and the looks are erased. Headlight pods, the handlebar button and calibration are unchanged.");
  });
  // The controller refuses `defaults` from a phone while the lights are on, so the page waits for what it answers.
  // A reset controller comes back with the firmware's sample strips on outputs 1 to 3; those are cleared too, so the
  // bike is empty and ready for Add a light.
  const factoryBtn = armed(button("Reset everything to factory settings", { kind: "danger", id: "sys-factory" }), "Tap again to reset everything", () => {
    let off = null;
    const timer = setTimeout(() => { if (off) off(); say("The controller did not answer. Nothing was changed as far as this page knows.", "warn"); }, 4000);
    off = on("out", (line, dir) => {
      if (dir !== "in") return;
      if (/^defaults: /.test(line)) { clearTimeout(timer); off(); say("Not reset: " + line.replace(/^defaults: /, "") + ".", "warn"); return; }
      if (!/^settings reset to defaults/.test(line)) return;
      clearTimeout(timer); off();
      const o2 = on("settings", () => {
        o2();
        if (!fwAtLeast(0, 5, 0)) { say("Every setting is back to its factory value."); return; }   // older firmware has no lights to clear
        startOver(); say("Every setting is back to its factory value and every output is empty.");
      });
      refresh();
    });
    say("Resetting…");
    send("defaults yes");
  });
  // Restoring and starting over write lights, which firmware before 0.5.0 does not know.
  if (!fwAtLeast(0, 5, 0)) {
    overBtn.disabled = true; fileIn.disabled = true; restoreLabel.classList.add("disabled"); restoreLabel.setAttribute("aria-disabled", "true");
    host.append(note("Restore and Start over need controller firmware 0.5.0: update it in System › Controller first. Saving the setup to a file works now.", "warn"));
  }
  host.append(
    panel("Save and restore",
      el("div", { class: "pad" },
        note("The file holds every setting (the update Wi-Fi password is left out) and the saved looks. Keep it somewhere safe: it is the way back after a reset or a new controller."),
        el("div", { class: "btns", style: "margin-top:10px" }, saveBtn, restoreLabel), status)),
    panel("Start over",
      el("div", { class: "pad" },
        note("Start over removes every light, section, position and look, so you can set the bike up again. Headlight pods, the handlebar button, power and calibration stay as they are."),
        el("div", { class: "btns", style: "margin-top:10px" }, overBtn),
        el("div", { style: "height:14px" }),
        note("Reset everything puts every setting back to the factory value, including the Bluetooth name, calibration and the pods."),
        el("div", { class: "btns", style: "margin-top:10px" }, factoryBtn))));
  return {};
}
