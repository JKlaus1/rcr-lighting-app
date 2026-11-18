// Pure functions on the controller's strip JSON (spec 4.5). No DOM, no store. Every function returns a new
// strip and never changes its argument.
//
// A strip is one output, as `get` returns it: { out, px, chip, timing, rgbw, lpp, sum, order, cap_ma, pct, px_ma,
// turn_style, look, look2?, ord?, seg, lights?, geom?: { pt, panel? } }. A light is a run of the output's pixels.
// A segment belongs to the light that holds its first pixel; path points and color-order zones belong to the light
// whose range holds them. Operations that move or resize lights take those along (the "blocks" below).
import { CHIP_BY, KIND_BY, KINDS, LOOK_EXTRA_DEFAULTS, TAIL_ROLES } from "./fxdata.js";

export const LIMITS = { lights: 8, px: 800, segs: 16, pts: 96, name: 16 };
export const SET_LIMIT = 479;   // longest `set <json>` line, so the line and its newline fit one BLE write
const LOOK_BASE = { mode: "scanner", rgb: [255, 96, 0], speed: 5, rev: false, master: false };   // the firmware's look defaults
const LOOK_KEYS = ["mode", "rgb", "speed", "rev", "master", "pal", "size", "dwell", "show"];
const LIGHT_DEFAULTS = { id: 0, rest: "own", pct: 100, ts: "global", solo: false, chip: "same", ma: 0, den: 0 };
const OPT_KEYS = ["id", "rest", "pct", "ts", "solo", "chip", "ma", "den"];
const SIGNAL = ["turn_l", "turn_r", "brake", "tail", "tail_turn_l", "tail_turn_r"];
const APP_ROLES = ["look", "drl", ...SIGNAL];
const REST_OF_IDLE = { look: "light", off: "dark", drl: "drl" };
const IDLE_OF_REST = { light: "look", dark: "off", drl: "drl" };

const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
const jeq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byteLen = t => new TextEncoder().encode(t).length;
const isObj = v => v && typeof v === "object" && !Array.isArray(v);

// ---- looks ---------------------------------------------------------------------------------------
export function normLook(lk) {
  const o = { ...LOOK_BASE, ...LOOK_EXTRA_DEFAULTS, ...(lk || {}) };
  o.rgb = (o.rgb || [0, 0, 0]).slice(0, 3); o.pal = (o.pal || []).map(c => c.slice(0, 3));
  return Object.fromEntries(LOOK_KEYS.map(k => [k, o[k]]));
}
// The keys of `a` that differ from `b`, as a look patch (null when equal). Missing extras count as their defaults.
export function lookDiff(b, a) {
  const B = normLook(b), A = normLook(a), d = {};
  for (const k of LOOK_KEYS) if (!jeq(A[k], B[k])) d[k] = clone(A[k]);
  return Object.keys(d).length ? d : null;
}

// ---- segments ------------------------------------------------------------------------------------
const segOpt = g => g.slice(4).find(isObj) || null;
const segArrs = g => g.slice(4).filter(Array.isArray);
// The meaning of a segment, in one comparable form (what the firmware would keep after validate).
function normSeg(g) {
  const o = segOpt(g) || {}, role = g[2];
  let idle = o.idle || "off";
  if (role === "look") idle = "look";
  const n = { s: g[0] | 0, n: g[1] | 0, role, rev: !!g[3], idle, pct: o.pct == null ? 100 : o.pct | 0,
    nb: TAIL_ROLES.includes(role) && !!o.nb, rx: (role === "look" || role === "look2") ? (o.rx | 0) & 7 : 0 };
  if (idle === "color") n.rgb = (o.rgb || [0, 0, 255]).slice(0, 3);
  const p = segArrs(g);
  if (p.length >= 2 && p.slice(0, 2).some(q => q.some(v => Number(v) !== 0))) n.p = p.slice(0, 2);
  return n;
}
// A section as the firmware segment the app writes (spec 4.5 mapping).
function segOfSection(start, sec) {
  const g = [start, sec.n | 0, sec.role, !!sec.rev];
  if (sec.role === "look") { if (sec.rx) g.push({ rx: sec.rx & 7 }); return g; }
  if (sec.role === "drl") return g;
  const o = {}, idle = IDLE_OF_REST[sec.rest] || "off";
  if (idle !== "off") o.idle = idle;
  if (sec.nb && TAIL_ROLES.includes(sec.role)) o.nb = true;
  if (Object.keys(o).length) g.push(o);
  return g;
}

// ---- lights --------------------------------------------------------------------------------------
function normLight(e, k) {
  const o = isObj(e[4]) ? e[4] : {};
  const L = { k, s: e[0] | 0, n: e[1] | 0, kind: e[2] || "custom", name: e[3] || "" };
  for (const key of OPT_KEYS) L[key] = o[key] == null ? LIGHT_DEFAULTS[key] : o[key];
  if (L.chip === "") L.chip = "same";
  L.look = normLook(o.look);
  return L;
}
export function lightsOf(strip) {
  return ((strip && strip.lights) || []).map((e, k) => normLight(e, k));
}
// The 5th element of a light entry. explicit: every key, so a staged `lti` entry means the same whatever it lands on.
function lightOpts(L, explicit) {
  const o = {};
  for (const key of OPT_KEYS) {
    const v = L[key] == null ? LIGHT_DEFAULTS[key] : L[key];
    if (explicit || !jeq(v, LIGHT_DEFAULTS[key])) o[key] = v;
  }
  o.look = explicit ? normLook(L.look) : compactLook(L.look);
  return o;
}
function compactLook(lk) {
  const n = normLook(lk), o = {};
  for (const k of LOOK_KEYS) if (k in LOOK_BASE || !jeq(n[k], LOOK_EXTRA_DEFAULTS[k])) o[k] = n[k];
  return o;
}
const lightEntry = (L, explicit) => [L.s, L.n, L.kind || "custom", String(L.name || "").slice(0, LIMITS.name), lightOpts(L, explicit)];

export const kindOf = x => KIND_BY[typeof x === "string" ? x : x && x.kind] || KIND_BY.custom;
export const refEq = (a, b) => !!a && !!b && a.out === b.out && a.k === b.k;
// Every light of the bike in wiring order (output 1 first). `out` is the strip index 0..3 (shown as "Output out+1").
export function allLights(settings) {
  const out = [];
  ((settings && settings.strips) || []).forEach((st, i) => lightsOf(st).forEach(L => out.push({ out: i, ...L })));
  return out;
}
export function newLightId(settings) {
  const used = new Set(allLights(settings).map(L => L.id));
  for (let id = 1; id <= 255; id++) if (!used.has(id)) return id;
  return 0;
}
export const isLampOut = st => !!(st && st.out && st.out !== "pixels");

// ---- blocks: a strip cut into consecutive runs (each light, and the pixels in no light) -------------
function toBlocks(strip) {
  const px = strip.px | 0, L = lightsOf(strip), blocks = [];
  let cur = 0;
  for (const l of L) {
    if (l.s > cur) blocks.push({ light: null, n: l.s - cur, at: cur });
    blocks.push({ light: l, entry: strip.lights[l.k], n: l.n, at: l.s });
    cur = l.s + l.n;
  }
  if (px > cur) blocks.push({ light: null, n: px - cur, at: cur });
  for (const b of blocks) { b.segs = []; b.pts = []; b.ord = []; b.panel = null; b.areas = []; }
  const find = p => blocks.find(b => p >= b.at && p < b.at + b.n);
  for (const g of strip.seg || []) {
    const b = find(g[0] | 0); if (!b) continue;
    const c = g.slice(); c[0] = (g[0] | 0) - b.at; b.segs.push(c);
  }
  for (const q of (strip.geom && strip.geom.pt) || []) {
    const b = find(q[0] | 0); if (b) b.pts.push([q[0] - b.at, ...q.slice(1)]);   // [px, x, y, z] or [px, x, y, z, c, r]
  }
  for (const z of strip.ord || []) {   // a zone across two blocks is cut in two
    let s = z[0] | 0; const e = Math.min(px, s + (z[1] | 0));
    while (s < e) { const b = find(s); if (!b) break; const end = Math.min(e, b.at + b.n); b.ord.push([s - b.at, end - s, z[2]]); s = end; }
  }
  for (const a of strip.areas || []) {   // [light index, c0, r0, c1, r1, role, opts?]
    const b = blocks.find(x => x.light && x.light.k === (a[0] | 0)); if (b) b.areas.push(a.slice(1));
  }
  const pan = strip.geom && strip.geom.panel;
  if (pan && pan.length > 5 && pan[0] > 0) { const b = find(pan[5] | 0); if (b) { b.panel = pan.slice(); b.panel[5] -= b.at; } }
  return blocks;
}
function fromBlocks(strip, blocks) {
  const st = clone(strip), seg = [], lights = [], pt = [], ord = [], areas = [];
  let at = 0, panel = null;
  for (const b of blocks) {
    for (const g of b.segs) { const c = g.slice(); c[0] = g[0] + at; c[1] = Math.min(g[1] | 0, b.n - g[0]); if (c[1] > 0) seg.push(c); }
    for (const q of b.pts) if (q[0] >= 0 && q[0] < b.n) pt.push([q[0] + at, ...q.slice(1)]);
    for (const z of b.ord) { const n = Math.min(z[1], b.n - z[0]); if (n > 0) ord.push([z[0] + at, n, z[2]]); }
    if (b.panel && b.panel[5] + b.panel[0] * b.panel[1] <= b.n) { panel = b.panel.slice(); panel[5] += at; }
    if (b.light) { const e = clone(b.entry); e[0] = at; e[1] = b.n; for (const a of b.areas || []) areas.push([lights.length, ...clone(a)]); lights.push(e); }
    at += b.n;
  }
  st.px = at; st.seg = seg;
  if (lights.length) st.lights = lights; else delete st.lights;
  if (ord.length) st.ord = ord; else delete st.ord;
  if (areas.length) st.areas = areas; else delete st.areas;
  const geom = {};
  if (pt.length) geom.pt = pt;
  if (panel) geom.panel = panel;
  if (Object.keys(geom).length) st.geom = geom; else delete st.geom;
  return st;
}
const lightBlock = (blocks, k) => blocks.find(b => b.light && b.light.k === k);

// ---- sections ----------------------------------------------------------------------------------------
// A Dark section (role "none") is a run of LEDs the controller keeps off: LEDs that are hidden, or that should not light.
// The firmware draws nothing on LEDs that are in no segment, so a Dark section is written as no segment at all (it
// takes none of the output's 16), and every gap between a light's segments reads back as one Dark section.
export const DARK = "none";
const darkSection = n => ({ n, role: DARK, rest: "light", rx: 0, nb: false, rev: false });
export const isDark = sec => !!sec && sec.role === DARK;
// Neighboring Dark sections are one section. Returns the merged list and where section `sel` ended up in it.
export function mergeDark(sections, sel = 0) {
  const out = [];
  let at = sel;
  sections.forEach((sec, i) => {
    const prev = out[out.length - 1];
    if (isDark(sec) && isDark(prev)) { prev.n += sec.n | 0; if (i <= sel) at--; } else out.push({ ...sec });
  });
  return { sections: out, sel: Math.max(0, Math.min(out.length - 1, at)) };
}
export function sectionsOf(strip, k) {
  const b = lightBlock(toBlocks(strip), k);
  if (!b) return { clean: false, sections: [] };
  const segs = b.segs.filter(g => g[2] !== DARK && (g[1] | 0) > 0).sort((x, y) => x[0] - y[0]);
  let clean = true, at = 0;
  const sections = [];
  for (const g of segs) {
    const n = normSeg(g);
    if (n.s > at) sections.push({ ...darkSection(n.s - at), at });
    const sec = { n: n.n, role: n.role, rest: REST_OF_IDLE[n.idle] || "dark", rx: n.rx, nb: n.nb, rev: n.rev };
    if (n.role === "look" || n.role === "drl") sec.rest = "light";
    const ok = n.s >= at && APP_ROLES.includes(n.role) && n.pct === 100 && !n.p && n.idle in REST_OF_IDLE && (n.role !== "drl" || n.idle === "off");
    if (!ok) clean = false;
    at = Math.max(at, n.s + n.n);
    sections.push({ ...sec, at: n.s });
  }
  if (at < b.n) sections.push({ ...darkSection(b.n - at), at });
  if (at > b.n) clean = false;
  return { clean, sections: clean ? sections.map(({ at, ...s }) => s) : sections };
}
export function withSections(strip, k, sections) {
  const blocks = toBlocks(strip), b = lightBlock(blocks, k);
  if (!b) return clone(strip);
  let at = 0;
  b.segs = [];
  for (const sec of sections) { if (!isDark(sec)) b.segs.push(segOfSection(at, sec)); at += sec.n | 0; }
  return fromBlocks(strip, blocks);
}
// Layout templates (spec 3.3): front bar turn · DRL · turn (variant "turns": two turn halves, "look": all look),
// rear bar turn+tail · tail · brake · tail · turn+tail (variant "brake": the whole bar brakes), anything else: all look.
// feed = which end of the bar the data wire comes in at (bike-left / bike-right); mid = the LED at the bar's middle.
export function templateSections(kind, n, { mid, feed = "right", variant } = {}) {
  n = n | 0;
  const m = mid == null ? Math.floor(n / 2) : Math.max(0, Math.min(n - 1, mid | 0));
  const look = [{ n, role: "look", rest: "light", rx: 0, nb: false, rev: false }];
  const sec = (cnt, role, rest = "light", nb = false, rev = false) => ({ n: cnt, role, rest, rx: 0, nb, rev });
  const L = feed === "left";
  // Sequential turn styles (fill, comet, wipe) run from a section's first LED to its last. On a bar they must run
  // outward from the middle, so the turn section at the wire end (the bar's first LEDs) is reversed.
  if (kind === "front" && variant !== "look" && n >= 3) {
    const a = L ? "turn_l" : "turn_r", z = L ? "turn_r" : "turn_l";
    if (variant === "turns") { const h = Math.max(1, Math.min(n - 1, m)); return [sec(h, a, "light", false, true), sec(n - h, z)]; }
    const t = Math.max(1, Math.round(n * 0.28)), c = Math.max(1, n - 2 * t);
    const first = Math.max(1, Math.min(n - c - 1, Math.round(m - c / 2 + 0.5)));
    return [sec(first, a, "light", false, true), sec(c, "drl"), sec(n - first - c, z)];
  }
  if (kind === "rear" && n >= 5) {
    const a = L ? "tail_turn_l" : "tail_turn_r", z = L ? "tail_turn_r" : "tail_turn_l";
    const e = Math.max(1, Math.round(n * 0.2));
    if (variant === "brake") return [sec(e, a, "light", false, true), sec(Math.max(1, n - 2 * e), "tail"), sec(n - e - Math.max(1, n - 2 * e), z)].filter(s => s.n > 0);
    const t = Math.max(1, Math.round(n * 0.13)), br = Math.max(1, n - 2 * e - 2 * t);
    // centre the brake on the middle LED; the outer sections take what is left on each side
    const left = Math.max(2, Math.min(n - br - 2, Math.round(m - br / 2 + 0.5)));
    const e1 = Math.max(1, left - t), t1 = left - e1, rest = n - left - br, t2 = Math.min(t, Math.max(0, rest - 1)), e2 = rest - t2;
    return [sec(e1, a, "light", true, true), sec(t1, "tail", "light", true), sec(br, "brake", "dark"), sec(t2, "tail", "light", true), sec(e2, z, "light", true)].filter(s => s.n > 0);
  }
  return look;
}

// ---- areas (0.6.0) ---------------------------------------------------------------------------------------
// An area is a block of a panel's columns x rows (0-based, inclusive, the light's own, counted from its leftmost column and
// its top row) with a job, drawn over the panel's look after the output's sections. The controller keeps them per output:
// strips[i].areas = [[l, c0, r0, c1, r1, "role", {rev?, vert?, nb?}?], ...], l the index of the light on the output. It does
// not re-index l when lights change, so the blocks above carry each light's areas along and fromBlocks numbers them again.
// The app's form: { c0, r0, c1, r1, role, rev, vert, nb }. rev: the animation runs the other way (right to left, or up with
// vert); vert: it runs down the rows instead of across the columns; nb: a tail job that never brightens on the brake.
export const AREA_MAX = 8;
export const AREA_ROLES = ["brake", "tail", "turn_l", "turn_r", "tail_turn_l", "tail_turn_r", "drl"];
function normAreaEntry(g) {
  const o = isObj(g[6]) ? g[6] : {}, role = g[5], a = [g[1] | 0, g[2] | 0, g[3] | 0, g[4] | 0];
  return [g[0] | 0, Math.min(a[0], a[2]), Math.min(a[1], a[3]), Math.max(a[0], a[2]), Math.max(a[1], a[3]), role,
    { rev: !!o.rev, vert: !!o.vert, nb: TAIL_ROLES.includes(role) && !!o.nb }];
}
// the firmware's form: the seventh element only when a flag is set, and only the flags that are true
function areaEntry(n) {
  const g = n.slice(0, 6), o = {};
  if (n[6].rev) o.rev = true;
  if (n[6].vert) o.vert = true;
  if (n[6].nb) o.nb = true;
  if (Object.keys(o).length) g.push(o);
  return g;
}
const areaObj = g => { const n = normAreaEntry([0, ...g]); return { c0: n[1], r0: n[2], c1: n[3], r1: n[4], role: n[5], rev: n[6].rev, vert: n[6].vert, nb: n[6].nb }; };
export function areasOf(strip, k) {
  const b = lightBlock(toBlocks(strip), k);
  return b ? b.areas.map(areaObj) : [];
}
export const areaCount = strip => ((strip && strip.areas) || []).length;
// Replaces light k's areas. Areas of the other lights stay as they are, in their own order.
export function withAreas(strip, k, areas) {
  const blocks = toBlocks(strip), b = lightBlock(blocks, k);
  if (!b) return clone(strip);
  b.areas = (areas || []).filter(a => AREA_ROLES.includes(a.role)).map(a => areaEntry(normAreaEntry([0, a.c0, a.r0, a.c1, a.r1, a.role, { rev: a.rev, vert: a.vert, nb: a.nb }])).slice(1));
  return fromBlocks(strip, blocks);
}
// The cell of every pixel of light k as the controller works it out (spec 1): the rounded linear interpolation by pixel index between
// the last path point at or before it and the first at or after it, when both carry cells; before the first and after the last
// point the nearest point's cell; none when a point has no cell. -> [[c, r] | null, ...] with c, r counted from the light's
// leftmost column and top row (the light's own columns and rows, which is what areas use), and the grid's size.
export function cellGrid(strip, k) {
  const b = lightBlock(toBlocks(strip), k);
  if (!b) return { n: 0, cells: [], cols: 0, rows: 0, has: () => false, count: 0 };
  const pts = b.pts.slice().sort((x, y) => x[0] - y[0]), raw = [];
  for (let p = 0; p < b.n; p++) {
    let A = null, B = null;
    for (const q of pts) { if (q[0] <= p) A = q; if (q[0] >= p && !B) B = q; }
    if (!A) A = B; if (!B) B = A;
    if (!A || A.length < 6 || B.length < 6) { raw.push(null); continue; }
    const t = B[0] === A[0] ? 0 : (p - A[0]) / (B[0] - A[0]);
    raw.push([Math.round(A[4] + (B[4] - A[4]) * t), Math.round(A[5] + (B[5] - A[5]) * t)]);
  }
  const have = raw.filter(Boolean);
  if (!have.length) return { n: b.n, cells: raw, cols: 0, rows: 0, has: () => false, count: 0 };
  const c0 = Math.min(...have.map(q => q[0])), r0 = Math.min(...have.map(q => q[1]));
  const cells = raw.map(q => (q ? [q[0] - c0, q[1] - r0] : null)), set = new Set(cells.filter(Boolean).map(q => q[0] + "," + q[1]));
  return { n: b.n, cells, cols: Math.max(...cells.filter(Boolean).map(q => q[0])) + 1, rows: Math.max(...cells.filter(Boolean).map(q => q[1])) + 1,
    has: (c, r) => set.has(c + "," + r), count: set.size };
}
// Does any section or area of the strip do this job (roles: segment role keys)? Areas count like sections.
export function hasRole(strip, roles) {
  return (strip.seg || []).some(g => roles.includes(g[2])) || (strip.areas || []).some(a => roles.includes(a[5]));
}

// ---- adding, removing, moving, resizing --------------------------------------------------------------
const chipFields = c => ({ chip: c.key, timing: c.timing, rgbw: c.rgbw, lpp: c.lpp, sum: c.sum, px_ma: c.px_ma });
// opts.order: a color order for the whole light ("RGB"), or zones within it [[start, n, order], ...] (a matrix).
// opts.geom: the light's path points [{ px, x, y, z }] with px within the light.
export function addLight(strip, light, sections, { order, geom } = {}) {
  let st = clone(strip);
  const blocks = toBlocks(st);
  while (blocks.length && !blocks[blocks.length - 1].light) blocks.pop();   // test LEDs past the last light go
  const n = light.n | 0;
  const L = { ...LIGHT_DEFAULTS, ...light, look: normLook(light.look) };
  const chip = L.chip && L.chip !== "same" ? CHIP_BY[L.chip] : null;
  if (chip && !blocks.some(b => b.light)) { Object.assign(st, chipFields(chip)); L.chip = "same"; }   // the first light sets the output's type
  else if (chip) { if (chip.key === st.chip) L.chip = "same"; else if (!L.ma && chip.px_ma !== st.px_ma) L.ma = chip.px_ma; }
  const b = { light: L, entry: lightEntry({ ...L, s: 0 }, false), n, segs: [], pts: [], ord: [], panel: null, areas: [] };
  let at = 0;
  for (const sec of (sections && sections.length ? sections : templateSections(L.kind, n))) { if (!isDark(sec)) b.segs.push(segOfSection(at, sec)); at += sec.n | 0; }
  b.pts = geomPts(geom, n);
  if (Array.isArray(order)) b.ord = order.filter(z => z[2] !== st.order).map(z => [z[0] | 0, z[1] | 0, z[2]]);
  else if (order && order !== st.order) b.ord = [[0, n, order]];
  blocks.push(b);
  return fromBlocks(st, blocks);
}
export function removeLight(strip, k) {
  const blocks = toBlocks(strip);
  return fromBlocks(strip, blocks.filter(b => !(b.light && b.light.k === k)));
}
export function moveLight(strip, k, dir) {
  const blocks = toBlocks(strip);
  const i = blocks.findIndex(b => b.light && b.light.k === k), j = blocks.findIndex(b => b.light && b.light.k === k + dir);
  if (i < 0 || j < 0) return clone(strip);
  [blocks[i], blocks[j]] = [blocks[j], blocks[i]];
  return fromBlocks(strip, blocks);
}
export function resizeLight(strip, k, n) {
  const blocks = toBlocks(strip), b = lightBlock(blocks, k);
  if (!b || n < 1) return clone(strip);
  const old = b.n;
  b.n = n | 0;
  b.segs = b.segs.filter(g => g[0] < b.n);
  if (b.n > old) {   // growing: the section and the color-order zone that ended at the old end take the new LEDs
    const last = b.segs.reduce((m, g) => (!m || g[0] + g[1] > m[0] + m[1]) ? g : m, null);
    if (last && last[0] + last[1] === old) last[1] += b.n - old;
    for (const z of b.ord) if (z[0] + z[1] === old) z[1] += b.n - old;
  }
  // The light's ends stay where they are on the bike: a path point on the old last LED moves to the new last LED.
  const end = b.pts.find(q => q[0] === old - 1);
  b.pts = b.pts.filter(q => q !== end && q[0] < (end ? b.n - 1 : b.n));
  if (end) b.pts.push([b.n - 1, ...end.slice(1)]);
  return fromBlocks(strip, blocks);
}

// ---- positions and color order ---------------------------------------------------------------------
function geomPts(pts, n) {
  const out = [];
  for (const p of (pts || []).slice().sort((a, b) => a.px - b.px)) {
    const px = Math.max(0, Math.min(n - 1, Math.round(p.px)));
    if (out.length && px <= out[out.length - 1][0]) continue;   // the firmware wants strictly ascending points
    const q = [px, Math.round(p.x), Math.round(p.y), Math.round(p.z)];
    if (isCell(p.c) && isCell(p.r)) q.push(p.c, p.r);   // a cell: the point's column and row on a panel (0.6.0)
    out.push(q);
  }
  return out;
}
const isCell = v => Number.isInteger(v) && v >= 0 && v <= 254;
export function geomOf(strip, k) {
  const b = lightBlock(toBlocks(strip), k);
  return b ? b.pts.map(q => (q.length >= 6 ? { px: q[0], x: q[1], y: q[2], z: q[3], c: q[4], r: q[5] } : { px: q[0], x: q[1], y: q[2], z: q[3] })) : [];
}
// The same points without their cells: what a controller older than 0.6.0 is sent.
export const withoutCells = pts => (pts || []).map(({ c, r, ...p }) => p);
export function withGeom(strip, k, pts) {
  const blocks = toBlocks(strip), b = lightBlock(blocks, k);
  if (!b) return clone(strip);
  b.pts = geomPts(pts, b.n);
  return fromBlocks(strip, blocks);
}
// How many path points light k may hold: the output's limit (96, shared by all its lights) less what the other
// lights on the output use, and never more than one point per LED.
export function ptsRoom(strip, k) {
  const L = lightsOf(strip)[k];
  if (!L) return 0;
  const all = ((strip.geom && strip.geom.pt) || []).length, own = geomOf(strip, k).length;
  return Math.max(0, Math.min(L.n, LIMITS.pts - (all - own)));
}
export function orderOf(strip, k) {
  const b = lightBlock(toBlocks(strip), k);
  const z = b && b.ord.find(z => z[0] === 0 && z[1] === b.n);
  return z ? String(z[2]).toUpperCase() : strip.order;
}
export function withOrder(strip, k, order) {
  const blocks = toBlocks(strip), b = lightBlock(blocks, k);
  if (!b) return clone(strip);
  b.ord = order && order !== strip.order ? [[0, b.n, order]] : [];
  return fromBlocks(strip, blocks);
}

// ---- checks and numbers ------------------------------------------------------------------------------
export const usedOf = strip => { const L = lightsOf(strip); return L.length ? L[L.length - 1].s + L[L.length - 1].n : 0; };
// Can a light of `n` LEDs with `sections` sections and LED type `chip` go at the end of this output's chain?
export function canAdd(strip, { chip, n, sections } = {}) {
  if (isLampOut(strip)) return { ok: false, why: "This output drives a 12 V lamp" };
  const L = lightsOf(strip);
  if (!L.length && ((strip.px | 0) > 0 || (strip.seg || []).length)) return { ok: false, why: "Set up before this version: clear this output first" };
  if (L.length >= LIMITS.lights) return { ok: false, why: `Already ${LIMITS.lights} lights on this output` };
  const used = usedOf(strip);
  if (used >= LIMITS.px || (n != null && used + n > LIMITS.px)) return { ok: false, why: `Only ${Math.max(0, LIMITS.px - used)} of ${LIMITS.px} LEDs left on this output` };
  const segs = toBlocks(strip).filter(b => b.light).reduce((m, b) => m + b.segs.length, 0);
  const need = sections == null ? 1 : Array.isArray(sections) ? sections.length : sections | 0;
  if (segs + need > LIMITS.segs) return { ok: false, why: `Only ${Math.max(0, LIMITS.segs - segs)} of ${LIMITS.segs} sections left on this output` };
  const c = chip && chip !== "same" ? CHIP_BY[chip] : null;
  if (c && L.length && (c.timing !== strip.timing || !!c.rgbw !== !!strip.rgbw))
    return { ok: false, why: c.timing !== strip.timing ? "Different data speed from the lights already on this output" : "Different bytes per LED from the lights already on this output" };
  return { ok: true, why: "" };
}
// fullMa: every LED at full white at its own light's current (else the output's px_ma), plus 1 mA idle per LED.
// Everything at full white. LEDs in a Dark section never light: they count with their standby milliamp only.
export function loadOf(strip) {
  if (isLampOut(strip)) return { leds: 0, fullMa: 0, capMa: strip.cap_ma | 0, over: false };
  const px = strip.px | 0, L = lightsOf(strip);
  const dark = new Uint8Array(px);
  for (const l of L) {
    let at = l.s;
    for (const sec of sectionsOf(strip, l.k).sections) {
      const from = sec.at != null ? l.s + sec.at : at;
      if (isDark(sec)) dark.fill(1, Math.min(px, from), Math.min(px, from + sec.n));
      at = from + sec.n;
    }
  }
  let ma = 0;
  for (let p = 0; p < px; p++) { const l = L.find(l => p >= l.s && p < l.s + l.n); ma += (dark[p] ? 0 : (l && l.ma ? l.ma : strip.px_ma)) + 1; }
  return { leds: px, fullMa: ma, capMa: strip.cap_ma | 0, over: ma > (strip.cap_ma | 0) };
}

// ---- patches: the smallest list of `set` objects from one state to another ---------------------------
// A canonical form for comparing two strips by meaning (the firmware writes defaults and option objects its own way).
export function normStrip(st) {
  if (!st) return null;
  const sc = {};
  for (const k of STRIP_SCALARS) if (k in st) sc[k] = st[k];
  return { ...sc, px: st.px | 0, look: normLook(st.look), look2: st.look2 ? normLook({ ...LOOK2_BASE, ...st.look2 }) : null,
    seg: (st.seg || []).map(normSeg), lights: lightsOf(st).map(({ k, ...L }) => L),
    pt: ((st.geom && st.geom.pt) || []).map(q => q.slice(0, 6)), areas: (st.areas || []).map(normAreaEntry), panel: (st.geom && st.geom.panel && st.geom.panel[0] ? st.geom.panel : null),
    ord: (st.ord || []).map(z => [z[0], z[1], String(z[2]).toUpperCase()]) };
}
const LOOK2_BASE = { mode: "bulbs", rgb: [255, 147, 41], speed: 5, rev: false, master: false };
const STRIP_SCALARS = ["out", "lamp_min_ma", "chip", "timing", "rgbw", "lpp", "sum", "order", "cap_ma", "pct", "px_ma", "turn_style"];
const wrap = (i, o) => ({ strips: [...Array(i).fill(null), o] });
const fits = o => byteLen("set " + JSON.stringify(o)) <= SET_LIMIT;
// Staged list (`segi`+`nseg` and friends): the entries from the first one that differs, in chunks, then the commit.
function staged(i, stageKey, countKey, beforeKeys, afterKeys, afterEntries) {
  let d = 0;
  while (d < beforeKeys.length && d < afterKeys.length && beforeKeys[d] === afterKeys[d]) d++;
  if (d === beforeKeys.length && d === afterKeys.length) return [];
  if (d === afterKeys.length) return [wrap(i, { [countKey]: afterKeys.length })];   // a plain cut: nothing to stage
  const out = []; let cur = [];
  for (let j = d; j < afterEntries.length; j++) {
    const e = [j, ...afterEntries[j]];
    if (cur.length && !fits(wrap(i, { [stageKey]: [...cur, e] }))) { out.push(wrap(i, { [stageKey]: cur })); cur = []; }
    cur.push(e);
  }
  const last = wrap(i, { [stageKey]: cur, [countKey]: afterEntries.length });
  if (fits(last)) out.push(last); else { out.push(wrap(i, { [stageKey]: cur })); out.push(wrap(i, { [countKey]: afterEntries.length })); }
  return out;
}
function ltPatches(i, diffs) {   // diffs: [index, object] -> `lt` arrays with nulls, chunked
  const out = []; let cur = [];
  const make = list => { const a = []; for (const [j, o] of list) a[j] = o; for (let j = 0; j < a.length; j++) if (a[j] === undefined) a[j] = null; return wrap(i, { lt: a }); };
  for (const d of diffs) {
    if (cur.length && !fits(make([...cur, d]))) { out.push(make(cur)); cur = []; }
    cur.push(d);
  }
  if (cur.length) out.push(make(cur));
  return out;
}
export function stripPatches(i, before, after) {
  const B = normStrip(before), A = normStrip(after), out = [];
  if (!A) return out;
  if (!B) return [wrap(i, clone(after))];
  // plain keys; the LED type first, because `chip` sets timing / rgbw / lpp / sum / px_ma
  const eff = { ...B };
  if (A.chip !== B.chip && A.chip) {
    out.push(wrap(i, { chip: A.chip }));
    if (CHIP_BY[A.chip]) Object.assign(eff, chipFields(CHIP_BY[A.chip]));
    eff.chip = A.chip;
  }
  const sc = {};
  for (const k of STRIP_SCALARS) if (k in A && !jeq(A[k], eff[k])) sc[k] = A[k];
  const ld = lookDiff(B.look, A.look); if (ld) sc.look = ld;
  if (A.look2 && !jeq(A.look2, B.look2)) sc.look2 = lookDiff(B.look2 || LOOK2_BASE, A.look2) || {};
  if (Object.keys(sc).length) {   // one line when it fits, else one per key
    if (fits(wrap(i, sc))) out.push(wrap(i, sc));
    else for (const [k, v] of Object.entries(sc)) out.push(wrap(i, { [k]: v }));
  }
  if (A.px > B.px) out.push(wrap(i, { px: A.px }));
  // lights: ranges, kinds and names staged (`lti` / `nlt`); option changes of lights that stay put as `lt`
  const shape = L => JSON.stringify([L.s, L.n, L.kind, L.name]);
  const bl = B.lights, al = A.lights, aEntries = al.map(L => lightEntry(L, true).slice(0));
  let d = 0;
  while (d < bl.length && d < al.length && shape(bl[d]) === shape(al[d])) d++;
  const lightLines = staged(i, "lti", "nlt", bl.map(shape), al.map(shape), aEntries);
  out.push(...lightLines);
  const ltd = [];
  for (let j = 0; j < Math.min(d, al.length); j++) {
    const b = bl[j], a = al[j], o = {};
    for (const key of OPT_KEYS) if (!jeq(a[key], b[key])) o[key] = a[key];
    const lk = lookDiff(b.look, a.look); if (lk) o.look = lk;
    if (Object.keys(o).length) ltd.push([j, o]);
  }
  out.push(...ltPatches(i, ltd));
  // segments, path points, color-order zones
  const segOut = g => g.slice(0, 4).concat(g.slice(4).filter(x => isObj(x) || Array.isArray(x)));
  out.push(...staged(i, "segi", "nseg", B.seg.map(s => JSON.stringify(s)), A.seg.map(s => JSON.stringify(s)), (after.seg || []).map(segOut)));
  out.push(...staged(i, "gpt", "ngpt", B.pt.map(q => JSON.stringify(q)), A.pt.map(q => JSON.stringify(q)), A.pt));
  out.push(...staged(i, "ordi", "nord", B.ord.map(z => JSON.stringify(z)), A.ord.map(z => JSON.stringify(z)), A.ord));
  // areas name lights by index and replace the whole list at once: after the lights are in place
  if (!jeq(A.areas, B.areas)) out.push(wrap(i, { areas: (after.areas || []).map(a => areaEntry(normAreaEntry(a))) }));
  if (!jeq(A.panel, B.panel)) out.push(wrap(i, { panel: A.panel || [0, 0] }));
  if (A.px < B.px) out.push(wrap(i, { px: A.px }));
  // validate() raises cap_ma to the safety worst case and never lowers it: a half-sent layout (new lights, old
  // segments) can raise it on the way. Ending with the intended cap puts it back (raised again only if really needed).
  if ((lightLines.length || out.some(p => p.strips[i].segi || p.strips[i].nseg != null)) && A.cap_ma != null)
    out.push(wrap(i, { cap_ma: A.cap_ma }));
  return out;
}

// The same for a whole settings object (Backup › Restore). `preset` and a redacted password are never sent.
const SKIP = ["strips", "preset"];
const OBJ_DEFAULTS = { accent: { ...LOOK_EXTRA_DEFAULTS, span: "light", rev: false, pitch: 50, all: false }, head: { extra: ["aux"] } };
// whole top-level keys the controller leaves out while they are at their default (0.5.2: the names of the lamp outputs)
const TOP_DEFAULTS = { lamp_label: { low: "", high: "", aux: "", drl: "" } };
function objDiff(b, a, defaults) {
  if (!isObj(a) || !isObj(b)) return jeq(a, b) ? undefined : clone(a);
  const d = {};
  for (const k of Object.keys(a)) { const v = objDiff(b[k], a[k], null); if (v !== undefined) d[k] = v; }
  for (const k of Object.keys(b)) if (!(k in a) && defaults && k in defaults && !jeq(b[k], defaults[k])) d[k] = clone(defaults[k]);
  return Object.keys(d).length ? d : undefined;
}
function splitPatch(o) {   // one key per line when the whole object is too long, deeper when one key still is
  if (fits(o)) return [o];
  const out = [];
  const go = (path, v) => {
    const wrapPath = x => path.reduceRight((acc, k) => ({ [k]: acc }), x);
    if (fits(wrapPath(v)) || !isObj(v)) { out.push(wrapPath(v)); return; }
    for (const [k, x] of Object.entries(v)) go([...path, k], x);
  };
  for (const [k, v] of Object.entries(o)) go([k], v);
  return out;
}
export function settingsPatches(before, after) {
  const out = [], top = {};
  for (const k of Object.keys(after || {})) {
    if (SKIP.includes(k) || (k === "ota_pass" && /^\*+$/.test(after[k]))) continue;
    const v = objDiff((before || {})[k], after[k], OBJ_DEFAULTS[k]);
    if (v !== undefined) top[k] = v;
  }
  for (const [k, d] of Object.entries(TOP_DEFAULTS)) if (after && !(k in after) && before && k in before && !jeq(before[k], d)) top[k] = clone(d);
  if (Object.keys(top).length) out.push(...splitPatch(top));
  ((after && after.strips) || []).forEach((st, i) => out.push(...stripPatches(i, before && before.strips && before.strips[i], st)));
  return out;
}
// Settings saved from a 0.6.0 controller, as an older controller may be sent them (Backup › Restore): no areas, no cells, and
// the turn style Arrows becomes "flash" (the bike's) or "global" (a light's or output's own).
export function withoutV060(settings) {
  const o = clone(settings);
  if (o && o.turn && o.turn.style === "arrow") o.turn.style = "flash";
  for (const st of (o && o.strips) || []) {
    if (!st) continue;
    delete st.areas;
    if (st.turn_style === "arrow") st.turn_style = "global";
    if (st.geom && st.geom.pt) st.geom.pt = st.geom.pt.map(q => q.slice(0, 4));
    for (const e of st.lights || []) if (isObj(e[4]) && e[4].ts === "arrow") e[4].ts = "global";
  }
  return o;
}
export { KINDS };
