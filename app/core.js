// The firmware's core compiled to WebAssembly (web/core/rcr-core.wasm, built from firmware/src/core): the demo
// controller and the live preview run the controller's own code. Spec 4.2; the C API is in docs/firmware-v0.5.md.
//
// Every controller gets its own module instance. The core keeps the staged `segi` / `gpt` / `ordi` / `lti` batches
// in file-level statics, so two controllers sharing one instance would mix each other's half-sent lists.

let compiled = null, base = null;
const enc = new TextEncoder(), dec = new TextDecoder();

function instantiate() {
  // The module imports only these three WASI calls (stdio it never really uses).
  const wasi = { fd_write: () => 0, fd_close: () => 0, fd_seek: () => 0 };
  const inst = new WebAssembly.Instance(compiled, { wasi_snapshot_preview1: wasi });
  if (inst.exports._initialize) inst.exports._initialize();
  return inst.exports;
}

export async function initCore({ bytes } = {}) {
  if (compiled) return;
  if (!bytes) {
    const r = await fetch(new URL("../core/rcr-core.wasm", import.meta.url));
    if (!r.ok) throw new Error("rcr-core.wasm: HTTP " + r.status);
    bytes = await r.arrayBuffer();
  }
  compiled = await WebAssembly.compile(bytes);
  base = wrap(instantiate());
}
export const coreReady = () => !!compiled;
export function coreVersion() { return base.version(); }
export function presetName(jsonText) { return base.presetName(jsonText); }

export function createController() {
  if (!compiled) throw new Error("initCore() first");
  return wrap(instantiate());
}

function wrap(ex) {
  // Views are made fresh on every call: the memory can grow and detach the old buffer.
  const u8 = () => new Uint8Array(ex.memory.buffer);
  const str = p => { if (!p) return ""; const m = u8(); let e = p; while (m[e]) e++; return dec.decode(m.subarray(p, e)); };
  const withStr = (s, fn) => {
    const b = enc.encode(String(s) + "\0"), p = ex.rcr_alloc(b.length);
    u8().set(b, p);
    try { return fn(p); } finally { ex.rcr_free(p); }
  };
  const text = v => typeof v === "string" ? v : JSON.stringify(v);
  let h = ex.rcr_create();
  if (h < 0) throw new Error("rcr_create failed");
  return {
    version: () => str(ex.rcr_version()),
    presetName: json => withStr(text(json), p => str(ex.rcr_preset_name(p))),
    defaults: () => str(ex.rcr_defaults(h)),
    load: json => withStr(text(json), p => str(ex.rcr_load(h, p))),
    patch: obj => withStr(text(obj), p => str(ex.rcr_patch(h, p))),
    getText: (redact = false) => str(ex.rcr_get(h, redact ? 1 : 0)),
    get() { return JSON.parse(this.getText()); },
    warnings: () => str(ex.rcr_warnings(h)),
    presetSave: name => withStr(name == null ? "" : name, p => str(ex.rcr_preset_save(h, p))),
    presetApply: json => withStr(text(json), p => str(ex.rcr_preset_apply(h, p))),
    render(nowMs, scene = {}, limit = true) {
      const s = scene || {};
      const flags = (s.valid ? 1 : 0) | (s.running ? 2 : 0) | (s.brake ? 4 : 0) | (s.left ? 8 : 0) | (s.right ? 16 : 0) | (s.blinkOn ? 32 : 0);
      const prog = Math.max(0, Math.min(1000, Math.round((s.progress || 0) * 1000)));
      ex.rcr_render(h, (Math.floor(nowMs) >>> 0), flags, prog, limit ? 1 : 0);
    },
    pxCount: i => ex.rcr_px_count(h, i),
    px(i) { const n = ex.rcr_px_count(h, i), p = ex.rcr_px(h, i); return new Uint8Array(ex.memory.buffer, p, n * 3); },
    cls(i) { const n = ex.rcr_px_count(h, i), p = ex.rcr_cls(h, i); return new Uint8Array(ex.memory.buffer, p, n); },
    pos(i) { const n = ex.rcr_px_count(h, i), p = ex.rcr_pos(h, i); return new Float32Array(ex.memory.buffer, p, n * 3); },
    estMa: i => ex.rcr_est_ma(h, i),
    rawMa: i => ex.rcr_raw_ma(h, i),
    limitPct: i => ex.rcr_limit_pct(h, i),
    worstMa: i => ex.rcr_worst_ma(h, i),
    // 0.6.3: what the last render had the output's brake / tail / turn / DRL LEDs at, and what its cap holds them at
    // whatever is lit (percent; 100 = full). A core older than 0.6.3 has neither: 100.
    safetyPct: i => (ex.rcr_safety_pct ? ex.rcr_safety_pct(h, i) : 100),
    heldPct: i => (ex.rcr_held_pct ? ex.rcr_held_pct(h, i) : 100),
    fullMa: i => ex.rcr_full_ma(h, i),
    lightAt: (i, px) => ex.rcr_light_at(h, i, px),
    destroy() { if (h >= 0) ex.rcr_destroy(h); h = -1; },
  };
}
