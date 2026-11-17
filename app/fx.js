// The effect editor (spec 3.4): one component for a light's own look and for the bike effect.
//   fxEditor(container, { get, set, kind, preview, rev }) -> { update(), destroy() }
//   get() -> a look-like object (mode rgb speed rev pal size dwell show; missing keys count as the firmware's defaults)
//   set(fields, { key, ms }) is called with only the keys that changed; a slider drag or a color drag carries a key and ms
//   so the store coalesces it into one line.
//   preview: undefined = the bike effect gets its own private preview, a light gets none; false = none;
//            { draw(ledStrip) } = the caller draws its LEDs into the strip on every frame.
//   rev: false hides the Reverse switch (the bike-effect sheet has its own under "How it is laid out").
// Also exported: attachBikePreview(), the one private preview controller Ride's bike-effect card and the sheet share.
import { on } from "./store.js";
import { createController } from "./core.js";
import { addLight, stripPatches, normLook } from "./lights.js";
import { EFFECTS, EFFECT_BY, EFFECT_GROUPS, effectName, SHOW_EFFECTS, PAL_MAX, PALETTES, paletteOf } from "./fxdata.js";
import { el, clear, seg, chips, slider, numRow, button, toast, ledStrip, hex, unhex } from "./ui.js";

const SWATCHES = [["Amber", [255, 96, 0]], ["White", [255, 255, 255]], ["Blue", [59, 130, 255]],
  ["Green", [47, 191, 104]], ["Purple", [138, 63, 252]], ["Red", [255, 0, 0]]];
const FIRE_RGB = [255, 80, 0];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const groupOf = mode => (EFFECT_BY[mode] || EFFECTS[0]).group;

// ---- the private preview controller ------------------------------------------------------------------
// The core allows four controllers at all (the mirror, the demo, the bike view ...), so Ride's card and the bike-effect
// sheet share one: 72 LEDs on one output in one look section, the bike effect copied onto it.
const PREVIEW_LEDS = 72;
const PREVIEW_SCENE = { valid: true, running: false, brake: false, left: false, right: false, blinkOn: false, progress: 0 };
let shared = null;   // { ctl, users, key, t0 }
function makePreviewCtl() {
  const ctl = createController();
  const before = ctl.get().strips[0];
  const sec = [{ n: PREVIEW_LEDS, role: "look", rest: "light", rx: 0, nb: false, rev: false }];
  const after = addLight(before, { n: PREVIEW_LEDS, kind: "glow", name: "Preview", id: 1, rest: "own" }, sec);
  for (const p of stripPatches(0, before, after)) ctl.patch(p);
  return ctl;
}
// Draws the effect `getLook()` returns into `strip` on every frame; the returned function stops it.
export function attachBikePreview(strip, getLook) {
  if (!shared) {
    try { shared = { ctl: makePreviewCtl(), users: 0, key: "", t0: Date.now() }; } catch (e) { return () => {}; }
  }
  const me = shared;
  me.users++;
  const off = on("frame", () => {
    const look = { ...normLook(getLook()), master: false };   // master false: it shows whatever the Accent switch says
    const key = JSON.stringify(look);
    if (key !== me.key) { me.key = key; me.ctl.patch({ strips: [{ lt: [{ look }] }] }); }
    me.ctl.render(Date.now() - me.t0, PREVIEW_SCENE, false);
    strip.draw(me.ctl.px(0), 0, PREVIEW_LEDS);
  });
  let gone = false;
  return () => {
    if (gone) return;
    gone = true; off();
    if (--me.users <= 0) { me.ctl.destroy(); if (shared === me) shared = null; }
  };
}

// ---- the editor ---------------------------------------------------------------------------------------
export function fxEditor(container, { get, set, kind = "light", preview, rev = true } = {}) {
  const root = el("div", { class: "fx", "data-kind": kind });
  container.append(root);
  const look = () => normLook(get());
  const subs = [];
  let cur = look(), shownGroup = groupOf(cur.mode), dead = false;

  // live preview
  let pv = null;
  if (preview !== false && (preview || kind === "bike")) {
    pv = ledStrip({ wide: true });
    root.append(el("div", { class: "fx-preview" }, pv.el));
    if (preview && preview.draw) subs.push(on("frame", () => preview.draw(pv)));
    else subs.push(attachBikePreview(pv, look));
  }

  // effect: three groups, the group's effects as chips
  const group = seg(EFFECT_GROUPS.map(g => [g, g]), shownGroup, g => { shownGroup = g; paintModes(); }, { id: "fx-group" });
  const modesBox = el("div", { class: "fx-modes" });
  let modes = null;
  function paintModes() {
    modes = chips(EFFECTS.filter(e => e.group === shownGroup).map(e => [e.key, e.name]), cur.mode, pick, { id: "fx-modes" });
    clear(modesBox).append(modes.el);
    group.set(shownGroup);
  }
  function pick(mode) {
    const fields = { mode }, now = look();
    // Fire on the default white would be a white blaze: start it orange. A light-string effect with no colors picks Classic.
    if (mode === "fire" && same(now.rgb, [255, 255, 255])) fields.rgb = FIRE_RGB.slice();
    if (EFFECT_BY[mode] && EFFECT_BY[mode].usesPalette && !now.pal.length) fields.pal = paletteOf("classic");
    set(fields);
  }
  root.append(el("div", { class: "label" }, "Effect"), group.el, modesBox);
  paintModes();

  // color
  const colorBox = el("div", { class: "fx-color" }, el("div", { class: "label" }, "Color"));
  const swatchBtns = SWATCHES.map(([name, rgb]) => el("button", { type: "button", class: "swatch", "data-color": name.toLowerCase(), "aria-label": name,
    "aria-pressed": "false", onclick: () => { lastRgb = hex(rgb); set({ rgb: rgb.slice() }); } }, el("span", { style: { background: hex(rgb) } })));
  let lastRgb = "";
  const colorIn = el("input", { type: "color", id: "fx-color", class: "swatch-input", "aria-label": "Pick a color", value: hex(cur.rgb) });
  const sendRgb = (final, key) => {
    if (colorIn.value === lastRgb) return;
    lastRgb = colorIn.value;
    set({ rgb: unhex(colorIn.value) }, key ? { key: "rgb", ms: 150 } : undefined);
  };
  colorIn.addEventListener("input", () => sendRgb(false, true));
  colorIn.addEventListener("change", () => sendRgb(true, false));
  colorBox.append(el("div", { class: "swatches" }, swatchBtns, colorIn));
  root.append(colorBox);

  // palette (light-string effects)
  const palBox = el("div", { class: "fx-pal" }, el("div", { class: "label" }, "Bulb colors"));
  const palPresets = chips(PALETTES.map(p => [p.key, p.name]), "", k => set({ pal: paletteOf(k) }), { id: "fx-pal-presets" });
  for (const b of palPresets.el.children) b.dataset.palPreset = b.dataset.value;
  const palList = el("div", { class: "pal-list" });
  const palNote = el("p", { class: "note" }, "No colors picked: every bulb uses the single color of the effect. Tap a set or Add color.");
  const sizeRow = numRow("Bulbs per color", cur.size, { min: 1, max: 20, step: 1, id: "fx-size", onCommit: v => set({ size: v }) });
  const dwellRow = numRow("Seconds per effect", cur.dwell, { min: 5, max: 120, step: 1, id: "fx-dwell", onCommit: v => set({ dwell: v }) });
  const showList = el("div", { class: "pal-show", id: "fx-show" });
  const showBox = el("div", { class: "fx-show" }, dwellRow.el, el("div", { class: "label" }, "Effects in the show"), showList);
  palBox.append(palPresets.el, palList, palNote, sizeRow.el, showBox);
  root.append(palBox);
  let palSig = null, showSig = null;

  const FULL = (1 << SHOW_EFFECTS.length) - 1;
  const showOn = (mask, n) => !mask || ((mask >> n) & 1);
  function paintPalette() {
    const pal = cur.pal;
    clear(palList);
    pal.forEach((c, k) => {
      const inp = el("input", { type: "color", value: hex(c), "aria-label": `Bulb color ${k + 1}`, "data-pal-sw": k });
      let last = hex(c);
      const send = key => {
        if (inp.value === last) return;
        last = inp.value;
        set({ pal: look().pal.map((q, j) => j === k ? unhex(inp.value) : q.slice()) }, key ? { key: "pal", ms: 150 } : undefined);
      };
      inp.addEventListener("input", () => send(true));
      inp.addEventListener("change", () => send(false));
      const rm = el("button", { type: "button", class: "btn small x", "aria-label": `Remove bulb color ${k + 1}`, "data-pal-rm": k,
        onclick: () => set({ pal: look().pal.filter((_, j) => j !== k).map(q => q.slice()) }) }, "×");
      palList.append(el("span", { class: "pal-one" }, inp, rm));
    });
    if (pal.length < PAL_MAX) palList.append(button("Add color", { small: true, data: { palAdd: "1" },
      onClick: () => { const p = look().pal; set({ pal: [...p.map(q => q.slice()), p.length ? p[p.length - 1].slice() : [255, 255, 255]] }); } }));
  }
  function paintShow() {
    clear(showList);
    SHOW_EFFECTS.forEach((key, n) => {
      const c = el("input", { type: "checkbox", checked: !!showOn(cur.show, n), "data-pal-show": n, "aria-label": effectName(key) });
      c.addEventListener("change", () => {
        const mask = look().show;
        let m = 0;
        for (let j = 0; j < SHOW_EFFECTS.length; j++) if (j === n ? c.checked : showOn(mask, j)) m |= 1 << j;
        if (!m) { c.checked = true; toast("Keep at least one effect ticked", "warn"); return; }
        set({ show: m === FULL ? 0 : m });
      });
      showList.append(el("label", { class: "show-one" }, c, " " + effectName(key)));
    });
  }

  // speed and direction
  const speed = slider("Speed", cur.speed, { min: 1, max: 10, step: 1, unit: "of 10", id: "fx-speed", onInput: v => set({ speed: v }, { key: "speed", ms: 150 }) });
  const revBtn = el("button", { type: "button", class: "toggle", id: "fx-rev", "aria-pressed": String(!!cur.rev),
    onclick: () => { const v = revBtn.getAttribute("aria-pressed") !== "true"; revBtn.setAttribute("aria-pressed", String(v)); set({ rev: v }); } },
    el("span", { class: "txt" }, el("b", {}, "Reverse"), el("small", {}, "Run the other way")), el("span", { class: "switch", "aria-hidden": "true" }));
  root.append(speed.el);
  if (rev !== false) root.append(revBtn);

  // what the current effect shows
  function paintVisibility() {
    const e = EFFECT_BY[cur.mode] || {};
    colorBox.hidden = !e.usesColor;
    palBox.hidden = !e.usesPalette;
    showBox.hidden = cur.mode !== "show";
    palNote.hidden = cur.pal.length > 0;
    speed.el.hidden = cur.mode === "solid";
    revBtn.hidden = !e.hasDirection;
  }
  function paintValues(first) {
    swatchBtns.forEach((b, i) => b.setAttribute("aria-pressed", String(same(cur.rgb, SWATCHES[i][1]))));
    if (document.activeElement !== colorIn) { colorIn.value = hex(cur.rgb); }
    lastRgb = hex(cur.rgb);
    palPresets.set(PALETTES.find(p => same(p.colors, cur.pal))?.key || "");
    const sig = JSON.stringify(cur.pal);
    // a color being picked in a native dialog keeps its element: only rebuild what no one is using
    if (sig !== palSig && !(palSig && palList.contains(document.activeElement))) { palSig = sig; paintPalette(); }
    const ssig = String(cur.show);
    if (ssig !== showSig || first) { showSig = ssig; paintShow(); }
    sizeRow.set(cur.size); dwellRow.set(cur.dwell);
    speed.set(cur.speed);
    revBtn.setAttribute("aria-pressed", String(!!cur.rev));
    paintVisibility();
  }
  paintValues(true);

  return {
    update() {
      if (dead) return;
      const was = cur.mode;
      cur = look();
      if (cur.mode !== was) { shownGroup = groupOf(cur.mode); paintModes(); } else modes.set(cur.mode);
      paintValues(false);
    },
    destroy() { dead = true; subs.forEach(f => f()); subs.length = 0; root.remove(); },
  };
}
