// Links to a controller (spec 4.3): LineAssembler and BleLink ported unchanged in behavior from the 0.4.9 app,
// and DemoLink, a controller simulated on the firmware core itself.
// Every link: open(), openRemembered(ms, signal), send(line) -> Promise, reconnect(), close(), name();
// it calls h.onOut(line) for replies, h.onLive(line) for status lines, h.onDrop() when the link goes away.
import { createController, coreVersion } from "./core.js";
import * as L from "./lights.js";
import { kindDefaults, paletteOf, EFFECTS } from "./fxdata.js";

// ---- protocol (firmware/src/ble.h): one service, three text characteristics ---------------------------
export const SVC = "b6f1e2a0-3c4d-4e5f-8a9b-52434c000000";
export const CMD = "b6f1e2a0-3c4d-4e5f-8a9b-52434c000001";
export const OUT = "b6f1e2a0-3c4d-4e5f-8a9b-52434c000002";
export const LIVE = "b6f1e2a0-3c4d-4e5f-8a9b-52434c000003";
export const MAX_WRITE = 512;
export const DEV_KEY = "rcr.device";   // id of the last controller this page connected to (Chrome keeps the permission)

// Newline framing over notifications (replies are split to the MTU).
export class LineAssembler {
  constructor(onLine) { this.onLine = onLine; this.buf = ""; this.dec = new TextDecoder(); }
  push(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.length) this.onLine(line);
    }
    if (this.buf.length > 16384) this.buf = "";
  }
}
const viewBytes = dv => new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);

// ---- Web Bluetooth ------------------------------------------------------------------------------------
// A write the controller turns down while the link stays up (Chrome: "GATT operation failed for unknown reason").
// Its Bluetooth stack answers a write with "insufficient resources" when it has no buffer left for the write response
// (NimBLE ble_att_svr_pkt), and a long reply going out (the settings, `info`) can take every buffer for a moment. A write
// that was turned down was not taken, so sending the same line again after a pause is safe. Not for a link that is down
// (the reconnect flow has that) or a refusal that waiting cannot cure (not paired).
const retryable = e => !/security|notsupported|invalidstate|notallowed|type/i.test((e && e.name) || "");
export class BleLink {
  constructor(h) { this.h = h; this.queue = Promise.resolve(); this.enc = new TextEncoder(); this.retried = 0; }
  // Open with Chrome's device chooser (needs the tap that called it).
  async open() {
    this.use(await navigator.bluetooth.requestDevice({ filters: [{ services: [SVC] }], optionalServices: [SVC] }));
    await this.attach();
  }
  // Reconnect to the last controller without the chooser (page load, no tap needed). Needs
  // navigator.bluetooth.getDevices (Chrome's persistent permissions); resolves false when the
  // controller is not in range within `ms` or the permission is gone. ms = 0 waits until the
  // controller is heard (key switched on later) or `signal` aborts.
  async openRemembered(ms, signal) {
    const dev = await BleLink.remembered(ms, signal);
    if (!dev) return false;
    if (signal && signal.aborted) { BleLink.why = "cancelled"; return false; }
    this.use(dev);
    await this.attach();
    return true;
  }
  use(dev) {
    this.dev = dev;
    try { localStorage.setItem(DEV_KEY, dev.id); } catch (e) { /* private mode */ }
    if (!dev.rcrHooked) { dev.rcrHooked = true; dev.addEventListener("gattserverdisconnected", () => this.h.onDrop()); }
  }
  // BleLink.why says why the last remembered() came back empty.
  static async remembered(ms, signal) {
    BleLink.why = "";
    let id = null;
    try { id = localStorage.getItem(DEV_KEY); } catch (e) { BleLink.why = "no storage"; return null; }
    if (!id) { BleLink.why = "no controller remembered yet"; return null; }
    if (!navigator.bluetooth.getDevices) { BleLink.why = "this Chrome does not keep Bluetooth permissions (no getDevices)"; return null; }
    let devs;
    try { devs = await navigator.bluetooth.getDevices(); } catch (e) { BleLink.why = "getDevices failed: " + e.message; return null; }
    const dev = devs.find(d => d.id === id);
    if (!dev) { BleLink.why = "Chrome no longer lists the controller as permitted (" + devs.length + " remembered)"; return null; }
    if (dev.gatt.connected) return dev;
    if (!dev.watchAdvertisements) return dev;  // older Chrome: connect() alone may work
    // Chrome only lets a permitted device connect once it has been heard advertising.
    const ctl = new AbortController();
    const heard = new Promise(res => dev.addEventListener("advertisementreceived", () => res(true), { once: true }));
    const timeout = new Promise(res => {
      if (ms) setTimeout(() => res(false), ms);
      if (signal) signal.addEventListener("abort", () => res(false), { once: true });
    });
    if (signal && signal.aborted) { BleLink.why = "cancelled"; return null; }
    try { await dev.watchAdvertisements({ signal: ctl.signal }); } catch (e) { BleLink.why = "watchAdvertisements failed: " + e.message; return null; }
    const ok = await Promise.race([heard, timeout]);
    ctl.abort();
    if (!ok) BleLink.why = signal && signal.aborted ? "cancelled" : "controller not heard advertising within " + Math.round(ms / 1000) + " s";
    return ok ? dev : null;
  }
  async attach() {
    const gatt = await this.dev.gatt.connect();
    const svc = await gatt.getPrimaryService(SVC);
    this.cmd = await svc.getCharacteristic(CMD);
    const out = await svc.getCharacteristic(OUT);
    const live = await svc.getCharacteristic(LIVE);
    const outLines = new LineAssembler(l => this.h.onOut(l));
    const liveLines = new LineAssembler(l => this.h.onLive(l));
    out.addEventListener("characteristicvaluechanged", e => outLines.push(viewBytes(e.target.value)));
    live.addEventListener("characteristicvaluechanged", e => liveLines.push(viewBytes(e.target.value)));
    await out.startNotifications();   // first encrypted access: Android pairs here if needed
    await live.startNotifications();
  }
  name() { return (this.dev && this.dev.name) || "RCR Lighting"; }
  async write(data) {
    for (let k = 0; ; k++) {
      try { await this.cmd.writeValueWithResponse(data); return; }
      catch (e) {
        const up = !!(this.dev && this.dev.gatt && this.dev.gatt.connected);
        if (k >= BleLink.retryMs.length || !up || !retryable(e)) throw e;
        this.retried++;
        if (this.h.onRetry) this.h.onRetry(this.retried, e);
        await new Promise(r => setTimeout(r, BleLink.retryMs[k]));
      }
    }
  }
  // Lines go out one at a time, in order. When one fails for good, the lines already waiting behind it are not sent
  // either (the rest of a transaction must not go out without its beginning); each of them rejects.
  send(line) {
    const data = this.enc.encode(line + "\n");
    if (data.length > MAX_WRITE) return Promise.reject(new Error("Command too long for one write"));
    this.queue = this.queue.then(() => this.write(data));
    return this.queue.catch(e => { this.queue = Promise.resolve(); throw e; });
  }
  reconnect() { return this.attach(); }
  close() { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); }
}
BleLink.why = "";
BleLink.retryMs = [120, 300, 600, 1000, 1500];   // pauses before sending a turned-down write again (3.5 s in all)

// ---- the demo: a controller simulated on a core instance ------------------------------------------------
const parseVer = t => { const m = /(\d+)\.(\d+)\.(\d+)/.exec(t || ""); return m ? [+m[1], +m[2], +m[3]] : null; };
const verLt = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
const STRING_FX = EFFECTS.filter(e => e.group === "Light strings").map(e => e.key);
const CYCLE = EFFECTS.filter(e => !STRING_FX.includes(e.key)).map(e => e.key);   // `accent next` cycles solid .. diag
const LAMP_A = [3.2, 3.0, 4.1, 0.6];

// The sample bike the demo starts with, built with the same operations the app uses (spec, FOUNDATION brief).
export function buildDemoBike(ctl) {
  const s = ctl.get();
  const apply = (i, after) => L.stripPatches(i, ctl.get().strips[i], after).forEach(p => ctl.patch(p));
  const free = st => { const o = structuredClone(st); o.px = 0; o.seg = []; delete o.lights; delete o.geom; delete o.ord; return o; };
  for (let i = 0; i < 4; i++) apply(i, free(s.strips[i]));
  // Every demo light is placed (bike mm: x back from the front axle, y left - / right +, z up), so the bike view
  // and the effects that run across the bike have something to show.
  const bar = (n, x, z, first) => { const half = (n - 1) * 1000 / 144 / 2; return [{ px: 0, x, y: first * half, z }, { px: n - 1, x, y: -first * half, z }]; };
  let a = ctl.get().strips[0];
  a = L.addLight(a, { n: 57, kind: "front", name: "Front bar", id: 1, den: 144, ...kindDefaults("front") }, L.templateSections("front", 57, { feed: "right" }),
    { geom: bar(57, 95, 603, 1) });
  const str = kindDefaults("string");
  str.look = { ...str.look, mode: "twinkle", pal: paletteOf("classic") };
  a = L.addLight(a, { n: 50, kind: "string", name: "Light string", id: 2, chip: "ws2811_12v", den: 16, ...str }, null, { order: "RGB", geom: DEMO_STRING(50) });
  apply(0, a);
  let d = ctl.get().strips[3];
  d = L.addLight(d, { n: 61, kind: "rear", name: "Rear bar", id: 3, den: 144, ...kindDefaults("rear") }, L.templateSections("rear", 61, { feed: "left" }),
    { geom: bar(61, 1404, 719, -1) });
  apply(3, d);
}
// The demo's light string: around the left side of the body, across the front, back around the right side.
function DEMO_STRING(n) {
  const side = [[345, 835], [755, 846], [826, 698], [640, 478], [450, 455], [300, 660]];
  const path = [...side.map(([x, z]) => [x, -80, z]), ...side.slice().reverse().map(([x, z]) => [x, 80, z])];
  const len = [0];
  for (let i = 1; i < path.length; i++) len.push(len[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1], path[i][2] - path[i - 1][2]));
  return path.map(([x, y, z], i) => ({ px: Math.round(len[i] / len[len.length - 1] * (n - 1)), x, y, z }));
}

export class DemoLink {
  // opts.fw: the firmware version the demo plays (the app's own core version; ?demofw=0.4.9 on the page address shows
  // the update state, ?demofw=0.5.0 a controller one release behind)
  constructor(h, { fw } = {}) {
    this.h = h;
    let q = null;
    try { q = new URLSearchParams(location.search).get("demofw"); } catch (e) { /* no location */ }
    this.fw = fw || q || coreVersion();
    this.old = verLt(parseVer(this.fw) || [0, 5, 0], [0, 5, 0]);
    this.ctl = createController();
    buildDemoBike(this.ctl);
    // The demo opens with its lights alive; its bike effect runs front to rear, so "Every light" shows one effect
    // crossing the whole bike.
    this.ctl.patch({ accent: { on: true, mode: "wave", rgb: [59, 130, 255], pct: 70, span: "x" } });
    this.slots = Array(8).fill(null);
    this.slots[0] = this.ctl.presetSave("Cruise");
    const cruise = this.ctl.getText();
    this.ctl.patch({ accent: { on: true, mode: "rainbow", pct: 100, all: true } });
    this.slots[1] = this.ctl.presetSave("Show");
    this.ctl.load(cruise);
    this.pre = 0; this.dirty = false;
    this.inputs = 0; this.haz = false; this.aux = false; this.strobe = false; this.accRam = null; this.allRam = null;
    this.findAt = null; this.force = {}; this.fillc = [null, null, null, null]; this.pairUntil = 0;
    this.edges = Array(8).fill(0); this.bn = 0; this.blinkStart = 0; this.turning = false;
    this.tx = null;           // { snap, timer } while a transaction is open
    this.lines = [];          // every line received (tests read it)
    this.test = { failSend: 0, dropReply: 0 };   // tests: turn the next N lines down / lose the next N replies
    this.t0 = Date.now();
  }
  async open() {
    if (this.closed) throw new Error("demo closed");
    clearInterval(this.timer);
    this.timer = setInterval(() => this.h.onLive(JSON.stringify(this.status())), 250);
  }
  openRemembered() { return this.open().then(() => true); }
  name() { return "Demo controller"; }
  close() { clearInterval(this.timer); this.timer = null; this.closed = true; if (this.tx) this.txEnd(false); }
  reconnect() { this.closed = false; return this.open(); }
  // Inputs as bits (firmware rcr::In): 0 brake, 1 left, 2 right, 3 low, 4 high, 5 button, 6 lights on, 7 tail running.
  setInput(bit, on) {
    const was = (this.inputs >> bit) & 1;
    if (!!was === !!on) return;
    this.inputs ^= 1 << bit; this.edges[bit]++;
    this.h.onLive(JSON.stringify(this.status()));
  }
  out(text) {
    if (this.test.dropReply > 0) { this.test.dropReply--; return; }
    for (const l of String(text).split("\n")) if (l) setTimeout(() => { if (!this.closed) this.h.onOut(l); }, 20);
  }

  // ---- transactions: between begin and commit the stored settings change, a commit switches over at once ----
  txTouch() {
    if (!this.tx) return;
    clearTimeout(this.tx.timer);
    this.tx.timer = setTimeout(() => { if (this.tx) { this.txEnd(false); this.out("tx aborted (timeout)"); } }, 5000);
  }
  txEnd(commit) {
    const t = this.tx; this.tx = null;
    clearTimeout(t.timer);
    if (!commit) this.ctl.load(t.snap);
  }

  send(line) {
    if (this.test.failSend > 0) { this.test.failSend--; const e = new Error("GATT operation failed for unknown reason."); e.name = "NetworkError"; return Promise.reject(e); }
    this.lines.push(line);
    const t = String(line).trim(), sp = t.indexOf(" ");
    const cmd = sp < 0 ? t : t.slice(0, sp), args = sp < 0 ? "" : t.slice(sp + 1).trim();
    const onoff = args === "on" ? 1 : args === "off" ? 0 : -1;
    this.txTouch();
    const s = () => this.ctl.get();
    switch (cmd) {
      case "get": this.out(this.ctl.getText(true)); break;
      case "status": this.out(JSON.stringify(this.status())); break;
      case "set": {
        let n = this.ctl.patch(args);
        const bad = n.startsWith("!");
        if (bad) n = n.slice(1);
        else if (this.pre >= 0) this.dirty = true;
        const w = this.ctl.warnings();
        if (!bad && w) n = (n ? n + "; " : "") + "WARNING: " + w;   // the firmware appends its setup warnings to every reply
        this.out(JSON.stringify({ ok: !bad, notes: n }));
        break;
      }
      case "tx":
        if (this.old) { this.out(`unknown command '${cmd}' (try help)`); break; }
        if (args === "begin") { if (this.tx) this.out("tx already open"); else { this.tx = { snap: this.ctl.getText() }; this.txTouch(); this.out("tx open"); } }
        else if (args === "commit") { if (!this.tx) this.out("no tx open"); else { this.txEnd(true); this.out("tx committed"); } }
        else if (args === "abort") { if (!this.tx) this.out("no tx open"); else { this.txEnd(false); this.out("tx aborted"); } }
        else this.out("usage: tx begin | tx commit | tx abort");
        break;
      case "preset": {
        if (["two_feed", "two_feed_both", "lp6"].includes(args)) { this.ctl.patch({ head: { preset: args } }); this.out("headlight preset " + args); break; }
        this.out(this.presetCmd(args));
        break;
      }
      case "hazard":
        if (args === "toggle") this.haz = !this.haz; else if (onoff >= 0) this.haz = !!onoff; else { this.out("hazard is " + (this.haz ? "on" : "off")); break; }
        this.out("hazard " + (args === "toggle" ? "toggle" : args)); break;
      case "aux": if (onoff >= 0) { this.aux = !!onoff; this.out("aux " + args); } else this.out("aux is " + (this.aux ? "on" : "off")); break;
      case "strobe":
        if (args === "toggle") this.strobe = !this.strobe; else if (onoff >= 0) this.strobe = !!onoff; else { this.out("strobe is " + (this.strobe ? "on" : "off")); break; }
        this.out("strobe " + (args === "toggle" ? "toggle" : args)); break;
      case "accent": {
        const st = s();
        if (/^all\b/.test(args) && !this.old) {
          const a2 = args.slice(3).trim(), cur = this.allRam != null ? this.allRam : !!st.accent.all;
          if (a2 === "toggle") { this.allRam = !cur; this.out("accent all toggle"); }
          else if (a2 === "on" || a2 === "off") { this.allRam = a2 === "on"; this.out("accent all " + a2); }
          else this.out("accent all is " + (cur ? "on" : "off"));
        } else if (args === "next") {
          const i = CYCLE.indexOf(st.accent.mode);
          this.ctl.patch({ accent: { mode: CYCLE[(i + 1) % CYCLE.length] } }); this.accRam = true; this.out("accent next");
        } else if (onoff >= 0) { this.accRam = !!onoff; this.out("accent " + args); }
        else this.out(`accent ${this.accOn() ? "on" : "off"}, ${st.accent.mode}`);
        break;
      }
      case "find": {
        const m = /^([1-4])\s+(\d+)(?:\s+(\d+)(?:\s+(\d+)\s+(\d+)\s+(\d+))?)?$/.exec(args);
        if (args === "off") { this.findAt = null; this.out("find off"); }
        else if (m && +m[2] < this.ctl.pxCount(m[1] - 1)) {
          const cnt = m[3] == null ? 1 : +m[3], rgb = m[4] == null ? [255, 255, 255] : [+m[4], +m[5], +m[6]];
          this.findAt = { strip: m[1] - 1, px: +m[2], count: cnt, rgb };
          this.out(m[3] == null ? `find ${m[1]} ${m[2]}` : `find ${m[1]} ${m[2]} ${cnt} ${rgb.join(" ")}`);
        } else this.out("usage: find <strip 1-4> <pixel> [count [r g b]] | off (pixel must be inside the strip)");
        break;
      }
      case "bench":
        if (args === "off") { this.findAt = null; this.force = {}; this.fillc = [null, null, null, null]; this.out("bench overrides cleared"); }
        else this.out("bench " + (this.benchOn() ? "active" : "inactive"));
        break;
      case "out": {
        const m = /^(low|high|aux|drl|s[1-4])\s+(on|off|auto)$/.exec(args);
        if (!m) { this.out("usage: out low|high|aux|drl|s1|s2|s3|s4 on|off|auto"); break; }
        if (m[2] === "auto") delete this.force[m[1]]; else this.force[m[1]] = m[2] === "on" ? 1 : 0;
        this.out(`out ${m[1]} ${m[2]}`); break;
      }
      case "fill": {
        const m = /^([1-4])\s+(off|\d+\s+\d+\s+\d+)$/.exec(args);
        if (!m) { this.out("usage: fill N R G B | fill N off   (N = 1..4)"); break; }
        this.fillc[m[1] - 1] = m[2] === "off" ? null : m[2].split(/\s+/).map(Number);
        this.out(`fill ${m[1]} ${m[2]}`); break;
      }
      case "info": {
        const st = s();
        const lights = st.strips.map((x, i) => `s${i + 1} ${(x.lights || []).length} (${x.px} px)`).join(", ");
        this.out(`RCR Lighting demo (simulated in this page) firmware ${this.fw}\nuptime ${Math.round((Date.now() - this.t0) / 1000)} s\n`
          + (this.old ? "" : `lights: ${lights}\n`) + `OTA access point: Wi-Fi "RCR-Lighting-DEMO" (open, no password)\nno board connected: settings reset when the page reloads`);
        break;
      }
      case "pair": this.pairUntil = Date.now() + 120000; this.out("BLE pairing open for 2 minutes"); break;
      case "sense": { const a = this.status().a; this.out(["low", "high", "aux", "drl", "s1", "s2", "s3", "s4", "acc1", "acc2"].map((k, i) => `${k.padEnd(6)} ${a[i].toFixed(2)} A`).join("\n")); break; }
      case "cal": this.out("cal: simulated, nothing to calibrate"); break;
      case "counters":
        if (args === "reset") { this.edges.fill(0); this.bn = 0; this.out("counters reset"); }
        else this.out("input changes: " + ["brake", "l", "r", "low", "high", "btn", "run", "spare"].map((k, i) => `${k}=${this.edges[i]}`).join(" ") + `\nbutton: released, ${this.bn} presses`);
        break;
      case "bonds": this.out("BLE 1 bond: aa:bb:cc:dd:ee:ff (slots: 3)"); break;
      case "save": this.out(this.tx ? "tx open: commit or abort first" : "saved"); break;
      case "ota":
        this.out("OTA starting: Wi-Fi \"RCR-Lighting-DEMO\" (open, no password), page http://192.168.4.1");
        this.out("Bluetooth turns off in about 2 s (not enough memory for both) and stays off until the controller restarts: after the update, or 15 min with no update once the lights are off.");
        if (DemoLink.sim) DemoLink.sim("ota", this);
        break;
      case "reboot":
        this.out(`restarting: firmware ${this.fw}, up ${Math.round((Date.now() - this.t0) / 1000)} s; back in about 5 s`);
        if (DemoLink.sim) DemoLink.sim("reboot", this);
        break;
      case "defaults":
        // as on the controller: the settings go back to their defaults, the saved looks stay in their slots
        if (args === "yes") { this.ctl.defaults(); this.pre = -1; this.dirty = false; this.out("settings reset to defaults (saved in 3 s)"); }
        else this.out("type `defaults yes` to reset every setting");
        break;
      case "help": this.out("status, sense, info, get, set {json}, tx begin|commit|abort, preset list|save N [name]|N|next|del N|get N, hazard on|off|toggle, aux on|off, strobe on|off|toggle, accent on|off|next|all on|off|toggle, find STRIP PIXEL [COUNT [R G B]]|off, out CH on|off|auto, fill N R G B|off, bench off, cal CH AMPS, counters [reset], bonds, save, defaults yes, ota, reboot, pair"); break;
      default: this.out(`unknown command '${cmd}' (try help)`);
    }
    return Promise.resolve();
  }
  presetCmd(args) {
    const m = /^(\S+)\s*(.*)$/.exec(args) || [null, "list", ""], sub = m[1] || "list", rest = m[2];
    const slotOf = t => /^[0-7]$/.test(t) ? +t : -1;
    const nameOf = n => this.ctl.presetName ? JSON.parse(this.slots[n]).name : "";
    const w = () => { const t = this.ctl.warnings(); return t ? "\nwarning: " + t : ""; };
    if (sub === "list") return JSON.stringify({ pre: this.pre, prem: this.pre >= 0 && this.dirty ? 1 : 0, slots: this.slots.map((x, n) => x ? nameOf(n) : null) });
    if (sub === "save") {
      const m2 = /^(\S+)\s*(.*)$/.exec(rest) || [null, "", ""], n = slotOf(m2[1]);
      if (n < 0) return "usage: preset save N [name]   (N = 0..7)";
      const name = m2[2].replace(/[^\x20-\x7e]/g, "?").slice(0, 24) || (this.slots[n] ? nameOf(n) : "Preset " + (n + 1));
      this.slots[n] = this.ctl.presetSave(name); this.pre = n; this.dirty = false;
      return `preset ${n} saved as "${name}"` + w();
    }
    if (sub === "next" || sub === "load" || slotOf(sub) >= 0) {
      let n = sub === "load" ? slotOf(rest) : slotOf(sub);
      if (sub === "next") { n = -1; for (let k = 1; k <= 8; k++) { const j = ((this.pre < 0 ? -1 : this.pre) + k + 8) % 8; if (this.slots[j]) { n = j; break; } } if (n < 0) return "no presets saved"; }
      if (n < 0) return "usage: preset load N   (N = 0..7)";
      if (!this.slots[n]) return `preset ${n} is empty`;
      const notes = this.ctl.presetApply(this.slots[n]);
      if (notes.startsWith("!")) return `preset ${n}: ${notes.slice(1)}`;   // as commands.cpp words it
      this.pre = n; this.dirty = false; this.allRam = null;
      return `preset ${n} "${nameOf(n)}" applied` + (notes ? "\nskipped: " + notes : "") + w();
    }
    if (sub === "del") { const n = slotOf(rest); if (n < 0) return "usage: preset del N   (N = 0..7)"; this.slots[n] = null; if (this.pre === n) this.pre = -1; return `preset ${n} erased`; }
    if (sub === "get") { const n = slotOf(rest); if (n < 0) return "usage: preset get N   (N = 0..7)"; return this.slots[n] || `preset ${n} is empty`; }
    return "usage: preset two_feed | two_feed_both | lp6 | list | save N [name] | N | load N | next | del N | get N";
  }
  accOn() { return this.accRam != null ? this.accRam : !!this.ctl.get().accent.on; }
  benchOn() { return !!(this.findAt || Object.keys(this.force).length || this.fillc.some(Boolean)); }
  status() {
    const st = this.ctl.get(), now = Date.now(), b = n => (this.inputs >> n) & 1;
    const runIn = b(6) || (st.spare_as_run && b(7));
    const head = b(3) ? "low" : b(4) ? "high" : runIn ? "running" : "off";
    const Lf = !!b(1), Rf = !!b(2), hz = this.haz || (Lf && Rf), turning = Lf || Rf || hz;
    if (turning && !this.turning) this.blinkStart = now;
    this.turning = turning;
    const period = 60000 / st.blink.fpm, ph = turning ? ((now - this.blinkStart) % period) / period : 0;
    const blk = turning && ph < st.blink.duty / 100;
    const scene = { valid: true, running: head !== "off", brake: !!b(0), left: Lf || hz, right: Rf || hz, blinkOn: blk, progress: blk ? ph / (st.blink.duty / 100) : 0 };
    this.ctl.render(now - this.t0, scene, true);
    const hb = { off: "O", running: "R", low: "L", high: "H" }[head];
    const en = ["low", "high", "aux", "drl"].map(l => st.head[l].includes(hb) ? 1 : 0);
    // the extra switch lights the outputs in head.extra (the AUX output alone unless the settings say otherwise)
    const extra = Array.isArray(st.head.extra) ? st.head.extra : ["aux"];
    if (this.aux && head !== "off") ["low", "high", "aux", "drl"].forEach((l, i) => { if (extra.includes(l)) en[i] = 1; });
    ["low", "high", "aux", "drl"].forEach((l, i) => { if (l in this.force) en[i] = this.force[l]; });
    const sma = st.strips.map((x, i) => x.out === "pixels" ? this.ctl.estMa(i) : 0);
    const lit = st.strips.map((x, i) => ("s" + (i + 1)) in this.force ? !!this.force["s" + (i + 1)]
      : x.out === "pixels" ? sma[i] > x.px + 1 || !!this.fillc[i]
      : !!({ turn_l: scene.left && blk, turn_r: scene.right && blk, brake: scene.brake, running: head !== "off", always: true }[x.out]));
    en.push(...lit.map(v => v ? 1 : 0));
    const a = [];
    for (let i = 0; i < 4; i++) a.push(en[i] ? LAMP_A[i] : 0);
    for (let i = 0; i < 4; i++) a.push(en[4 + i] ? (st.strips[i].out !== "pixels" ? 1.75 : sma[i] / 1000) : 0);
    a.push(0.8, 0);
    const tot = sma.reduce((m, v) => m + v, 0);
    const budget = head === "low" || head === "high" ? st.budget.lit_ma : st.budget.dark_ma;
    const warn = this.ctl.warnings();
    const o = { t: now - this.t0, v: 1, in: this.inputs, raw: this.inputs, head, brk: b(0), l: scene.left ? 1 : 0, r: scene.right ? 1 : 0,
      hz: hz ? 1 : 0, blk: blk ? 1 : 0, aux: this.aux ? 1 : 0, sb: this.strobe ? 1 : 0, duty: en.slice(0, 4).map(e => e ? 1000 : 0),
      en, rt: [0, 0, 0, 0, 0, 0, 0, 0], lk: "........", ch: a.map(v => v > 0 ? "o" : ".").join(""), a: a.map(v => Math.round(v * 100) / 100),
      sma, tot, bud: tot > budget ? Math.floor(budget / tot * 100) : 100, ssc: [100, 100, 100, 100],
      acc: this.accOn() ? 1 : 0, bench: this.benchOn() ? 1 : 0, ovr: 0, ble: 1, pair: this.pairUntil > now ? 1 : 0, ota: 0,
      edges: this.edges.slice(), dip: [0, 0, 0, 0], dipms: [0, 0, 0, 0], rl: [0, 0, 0, 0],
      pre: this.pre, prem: this.pre >= 0 && this.dirty ? 1 : 0, btn: b(5), bn: this.bn };
    if (!this.old) o.all = (this.allRam != null ? this.allRam : !!st.accent.all) ? 1 : 0;
    if (this.tx) o.tx = 1;
    if (this.r32) o.r32 = 1;   // a board with R32 fitted (tests set it; the demo has no board)
    if (warn) o.warn = warn;
    return o;
  }
}
DemoLink.sim = null;   // tests hook restart / update here
