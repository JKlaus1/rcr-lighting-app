// Effect lists, palettes, LED types, light kinds, section roles and the other tables the screens share (spec 4.6).
// Keys are the firmware's own names (core/settings.cpp); tests check every one against the core.

const E = (key, name, group, o = {}) => ({ key, name, group, usesColor: !!o.c, usesPalette: !!o.p, hasDirection: !!o.d, mapped: !!o.m });
export const EFFECTS = [
  E("solid", "Solid", "Effects", { c: 1 }),
  E("breathe", "Breathe", "Effects", { c: 1 }),
  E("rainbow", "Rainbow", "Effects", { d: 1 }),
  E("chase", "Chase", "Effects", { c: 1, d: 1 }),
  E("scanner", "Scanner", "Effects", { c: 1, d: 1 }),
  E("wave", "Wave", "Effects", { c: 1, d: 1, m: 1 }),
  E("sweep", "Sweep", "Effects", { c: 1, d: 1, m: 1 }),
  E("rise", "Rise", "Effects", { c: 1, d: 1, m: 1 }),
  E("rainbow_x", "Rainbow along the bike", "Effects", { d: 1, m: 1 }),
  E("rain", "Rain", "Patterns", { c: 1, d: 1, m: 1 }),
  E("fire", "Fire", "Patterns", { c: 1, m: 1 }),
  E("sparkle", "Sparkle", "Patterns", { c: 1, m: 1 }),
  E("plasma", "Plasma", "Patterns", { d: 1, m: 1 }),
  E("rings", "Rings", "Patterns", { c: 1, d: 1, m: 1 }),
  E("bounce", "Bounce", "Patterns", { c: 1, d: 1, m: 1 }),
  E("diag", "Diagonal", "Patterns", { c: 1, d: 1, m: 1 }),
  E("bulbs", "Steady bulbs", "Light strings", { p: 1 }),
  E("march", "Marching chase", "Light strings", { p: 1, d: 1 }),
  E("alternate", "Alternating flash", "Light strings", { p: 1 }),
  E("theater", "Theater chase", "Light strings", { p: 1, d: 1 }),
  E("wipe", "Color wipe", "Light strings", { p: 1, d: 1 }),
  E("twinkle", "Twinkle", "Light strings", { p: 1 }),
  E("shimmer", "Shimmer", "Light strings", { p: 1 }),
  E("glitter", "Glitter", "Light strings", { p: 1 }),
  E("candle", "Candle flicker", "Light strings", { p: 1 }),
  E("fill", "Random fill", "Light strings", { p: 1 }),
  E("comets", "Comets", "Light strings", { p: 1, d: 1 }),
  E("stack", "Stacking", "Light strings", { p: 1, d: 1 }),
  E("bursts", "Bursts", "Light strings", { p: 1 }),
  E("colorwave", "Color wave", "Light strings", { p: 1, d: 1 }),
  E("fade", "Color fade", "Light strings", { p: 1 }),
  E("show", "Auto show", "Light strings", { p: 1 }),
];
export const EFFECT_BY = Object.fromEntries(EFFECTS.map(e => [e.key, e]));
export const EFFECT_GROUPS = ["Effects", "Patterns", "Light strings"];
export const effectName = key => (EFFECT_BY[key] || { name: key || "" }).name;
// bit n of a look's `show` = this effect takes part in Auto show (0 = all of them)
export const SHOW_EFFECTS = EFFECTS.filter(e => e.group === "Light strings" && e.key !== "show").map(e => e.key);
export const PAL_MAX = 6;
// Keys a look carries beyond mode / rgb / speed / rev / master, with the value the firmware leaves out of its JSON.
export const LOOK_EXTRA_DEFAULTS = { pal: [], size: 1, dwell: 20, show: 0 };

export const PALETTES = [
  { key: "classic", name: "Classic multicolor", colors: [[255, 0, 0], [0, 170, 0], [0, 60, 255], [255, 120, 0], [190, 0, 255]] },
  { key: "red_green", name: "Red and green", colors: [[255, 0, 0], [0, 170, 0]] },
  { key: "rgw", name: "Red, green and white", colors: [[255, 0, 0], [0, 170, 0], [255, 180, 90]] },
  { key: "candy", name: "Candy cane", colors: [[255, 0, 0], [255, 255, 255]] },
  { key: "warm", name: "Warm white", colors: [[255, 147, 41]] },
  { key: "ice", name: "Ice", colors: [[160, 200, 255], [0, 60, 255]] },
  { key: "blue_white", name: "Blue and white", colors: [[0, 60, 255], [255, 255, 255]] },
  { key: "gold_red", name: "Gold and red", colors: [[255, 170, 0], [255, 0, 0]] },
];
export const paletteOf = key => (PALETTES.find(p => p.key === key) || PALETTES[0]).colors.map(c => c.slice());

// LED types: the firmware's chip table. Sending `chip` applies timing / rgbw / lpp / sum / px_ma.
const C = (key, label, timing, rgbw, lpp, sum, px_ma) => ({ key, label, timing, rgbw, lpp, sum, px_ma });
export const CHIPS = [
  C("ws2815", "WS2815 12 V", "800k", false, 1, false, 18),
  C("gs8208", "GS8208 12 V", "800k", false, 1, false, 18),
  C("ws2812b_12v_2", "WS2812B 12 V, 2 LEDs per pixel", "800k", false, 2, true, 40),
  C("ws2812b_12v_3", "WS2812B 12 V, 3 LEDs per pixel", "800k", false, 3, true, 60),
  C("ws2811_12v", "WS2811 12 V", "800k", false, 3, true, 60),
  C("ws2811_12v_slow", "WS2811 12 V, 400 kHz", "400k", false, 3, true, 60),
  C("ws2812b_5v", "WS2812B 5 V (behind a buck)", "800k", false, 1, true, 28),
  C("sk6812_rgbw_5v", "SK6812 RGBW 5 V (behind a buck)", "800k", true, 1, true, 38),
];
export const CHIP_BY = Object.fromEntries(CHIPS.map(c => [c.key, c]));
export const chipLabel = key => (CHIP_BY[key] || { label: key === "custom" ? "Custom LED type" : key || "" }).label;
export const ORDERS = ["GRB", "RGB", "BRG", "RBG", "GBR", "BGR"];

// What a light is. `key` is the firmware's light kind, except "lamp" (a 12 V lamp output, not a light).
// `tile` groups the kinds into the wizard's first step (both bars are one "Light bar" tile).
export const KINDS = [
  { key: "front", name: "Front light bar", tile: "bar", description: "Turn signals at both ends, DRL or a look in the middle", icon: "M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4" },
  { key: "rear", name: "Rear light bar", tile: "bar", description: "Tail, brake and both turn signals", icon: "M4 9h16v6H4zM9 9v6M15 9v6" },
  { key: "glow", name: "Strip", tile: "strip", description: "A plain LED strip, for example under the frame", icon: "M3 8h18M6 13v3M12 13v5M18 13v3" },
  { key: "ring", name: "Ring", tile: "ring", description: "A ring of LEDs, for example around a fork tube", icon: "M12 5a7 7 0 1 0 0 14a7 7 0 1 0 0-14M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6" },
  { key: "matrix", name: "Matrix", tile: "matrix", description: "Several strips wired as one panel", icon: "M5 4v16M10 4v16M15 4v16M20 4v16M3 8h18M3 16h18" },
  { key: "string", name: "Light string", tile: "string", description: "Bullet-pixel or fairy-light string with its own effects", icon: "M3 7c3 5 6 5 9 0s6-5 9 0M6 12v3M12 12v4M18 12v3M5 17h2M11 18h2M17 17h2" },
  { key: "custom", name: "Light", tile: null, description: "Any other light", icon: "M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4" },
  { key: "lamp", name: "12 V lamp", tile: "lamp", lamp: true, description: "A plain 12 V bulb or lamp on its own output", icon: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5V15h8v-1.5A6 6 0 0 0 12 3" },
];
export const KIND_BY = Object.fromEntries(KINDS.map(k => [k.key, k]));
export const WIZARD_TILES = [["bar", "Light bar"], ["strip", "Strip"], ["ring", "Ring"], ["matrix", "Matrix"], ["string", "Light string"], ["lamp", "12 V lamp"]];

export const AMBER = [255, 164, 27];
export const RED = [255, 0, 0];
const look = (mode, rgb, extra = {}) => ({ mode, rgb, speed: 5, rev: false, master: true, ...extra });
// What a new light starts with (spec 3.5). `master` true: it follows the Accent lights switch.
export const KIND_DEFAULTS = {
  front: { rest: "own", ts: "sweep", look: look("scanner", AMBER) },
  rear: { rest: "own", look: look("scanner", RED) },
  glow: { rest: "bike", look: look("solid", [59, 130, 255]) },
  ring: { rest: "bike", look: look("solid", [59, 130, 255]) },
  matrix: { rest: "own", look: look("rain", [138, 63, 252]) },
  string: { rest: "own", look: look("bulbs", [255, 147, 41], { pal: paletteOf("classic") }) },
  custom: { rest: "bike", look: look("solid", [59, 130, 255]) },
};
export const kindDefaults = kind => structuredClone(KIND_DEFAULTS[kind] || KIND_DEFAULTS.custom);

// Section roles (spec 3.3): what a section does. Colors are for the section bar.
export const ROLES = [
  { key: "look", name: "Look only", color: "#3b82ff" },
  { key: "turn_l", name: "Turn L", color: "#ffa41b" },
  { key: "turn_r", name: "Turn R", color: "#ffa41b" },
  { key: "brake", name: "Brake", color: "#e8352b" },
  { key: "tail", name: "Tail", color: "#8f2019" },
  { key: "tail_turn_l", name: "Tail + turn L", color: "#ffa41b" },
  { key: "tail_turn_r", name: "Tail + turn R", color: "#ffa41b" },
  { key: "drl", name: "DRL", color: "#f2f4f6" },
  { key: "none", name: "Dark", color: "#1b1f25" },   // LEDs the controller keeps off (lights.js DARK)
];
export const ROLE_BY = Object.fromEntries(ROLES.map(r => [r.key, r]));
export const TAIL_ROLES = ["tail", "tail_turn_l", "tail_turn_r"];
export const TURN_ROLES = ["turn_l", "turn_r", "tail_turn_l", "tail_turn_r"];
export const SIGNAL_ROLES = ["turn_l", "turn_r", "brake", "tail", "tail_turn_l", "tail_turn_r"];
// What a signal section shows when it is not signaling
export const SECTION_RESTS = [["light", "Same as the light"], ["dark", "Dark"], ["drl", "DRL color"]];
export const RX_BITS = { brake: 1, left: 2, right: 4 };

export const SPANS = [["light", "Each light on its own"], ["x", "Front to rear"], ["y", "Left to right"], ["z", "Bottom to top"], ["wire", "Along the wiring"]];
export const RESTS = [["bike", "Bike effect"], ["own", "Its own look"], ["off", "Off"]];
// "global" is a light's or an output's "same as the bike"; the bike-wide `turn.style` takes the other four.
export const TURN_STYLES = [["global", "Same as the bike"], ["flash", "Flash"], ["sweep", "Sequential fill"], ["drain", "Sequential empty"], ["arrow", "Arrows"], ["comet", "Comet"], ["wipe", "Wipe"]];
// "drain" came with controller firmware 0.5.1: an older controller is not offered it. fw051 = fwAtLeast(0, 5, 1).
// "arrow" came with 0.6.0 (fw060 = fwAtLeast(0, 6, 0)); an older controller does not know it and is never sent it.
export const turnStyles = (fw051, withGlobal = true, fw060 = false) => TURN_STYLES.filter(t => (withGlobal || t[0] !== "global") && (fw051 || t[0] !== "drain") && (fw060 || t[0] !== "arrow"));
export const BTN_ACTIONS = [["none", "Nothing"], ["accent_toggle", "Accent lights on/off"], ["accent_next", "Next bike effect"],
  ["hazard", "Hazards on/off"], ["aux_toggle", "Extra lights on/off"], ["preset_next", "Next look"], ["strobe_toggle", "Strobe on/off"],
  ["accent_all", "Bike effect on every light"]];
export const OUT_MODES = [["pixels", "LED lights"], ["turn_l", "12 V lamp: left turn"], ["turn_r", "12 V lamp: right turn"],
  ["brake", "12 V lamp: brake"], ["running", "12 V lamp: running"], ["always", "12 V lamp: always on"]];
export const JACKS = ["J3", "J4", "J5", "J15"];
