// A strip light drawn by its real dimensions. The shape is a run of pieces counted from the end the LEDs start at:
// straight pieces and bends. Two marks say where the first and the last LED sit on it, and a frame says how the shape
// lies on the bike. From those the app works out where every LED is and writes the light's path points. That is what
// lets an effect travel along a bar that wraps round the fork instead of meeting the whole bar at one place.
//
//   design { v: 1, pieces: [{ t: "s", len } | { t: "b", r, deg, dir }], a, b }   mm; dir 1 bends left, -1 right;
//                                                                              a / b: first LED from the start, last from the end
//   frame  { x, y, z, plane, rot, lean }                                        x y z: the shape's center in bike mm;
//                                                                              rot: the shape turned in its plane, degrees
//
// Shape space: the path starts at the origin heading +x, +y is on its left. Bike axes in mm: x back from the front
// axle, y left (-) / right (+), z up. The design is kept on this device, like a matrix's drawing; the controller holds
// only the path points made from it (lights.js geom).
import { el, clear, button, seg, chips, note, sheet, panel, clamp } from "./ui.js";

const RAD = Math.PI / 180;
export const MAX_PIECES = 12, MIN_R = 2, MAX_LEN = 6000;
const num = v => typeof v === "number" && Number.isFinite(v);
const r2 = v => Math.round(v * 100) / 100;

// ---- the path ------------------------------------------------------------------------------------------------------
export const validPiece = p => !!p && (p.t === "s" ? num(p.len) && p.len > 0 && p.len <= MAX_LEN
  : p.t === "b" && num(p.r) && p.r >= MIN_R && p.r <= MAX_LEN && num(p.deg) && p.deg > 0 && p.deg <= 360 && (p.dir === 1 || p.dir === -1));
export function trace(pieces) {
  let x = 0, y = 0, h = 0, s = 0;
  const runs = [];
  for (const p of pieces) {
    if (p.t === "s") { runs.push({ t: "s", s0: s, len: p.len, x, y, h }); x += p.len * Math.cos(h); y += p.len * Math.sin(h); s += p.len; continue; }
    // a bend: the center is one radius to the left (dir 1) or right (dir -1) of the heading
    const d = p.dir < 0 ? -1 : 1, ang = p.deg * RAD, len = p.r * ang, cx = x - d * p.r * Math.sin(h), cy = y + d * p.r * Math.cos(h);
    runs.push({ t: "b", s0: s, len, x, y, h, r: p.r, d, cx, cy, ang });
    h += d * ang; x = cx + d * p.r * Math.sin(h); y = cy - d * p.r * Math.cos(h); s += len;
  }
  return { runs, length: s, end: { x, y, h } };
}
function onRun(r, u) {
  u = clamp(u, 0, r.len);
  if (r.t === "s") return { x: r.x + u * Math.cos(r.h), y: r.y + u * Math.sin(r.h), h: r.h };
  const hh = r.h + r.d * u / r.r;
  return { x: r.cx + r.d * r.r * Math.sin(hh), y: r.cy - r.d * r.r * Math.cos(hh), h: hh };
}
// The point and heading at a distance s along the path.
export function at(path, s) {
  if (!path.runs.length) return { x: 0, y: 0, h: 0 };
  s = clamp(s, 0, path.length);
  const r = path.runs.find(q => s <= q.s0 + q.len) || path.runs[path.runs.length - 1];
  return onRun(r, s - r.s0);
}
export function validDesign(d) {
  return !!d && Array.isArray(d.pieces) && d.pieces.length >= 1 && d.pieces.length <= MAX_PIECES && d.pieces.every(validPiece)
    && num(d.a) && num(d.b) && d.a >= 0 && d.b >= 0 && d.a + d.b <= trace(d.pieces).length;
}
// Where the LEDs sit along the path: evenly from the first mark to the last.
export function ledArcs(design, n) {
  const lo = design.a, hi = trace(design.pieces).length - design.b;
  if (n <= 1) return n === 1 ? [(lo + hi) / 2] : [];
  return Array.from({ length: n }, (_, i) => lo + (hi - lo) * i / (n - 1));
}
// The path ends where it began (a ring): the first and last LED must not share a spot.
export function isClosed(design) { const p = trace(design.pieces); return p.length > 0 && Math.hypot(p.end.x, p.end.y) < 1; }
// Which LEDs sit on which piece, 1-based and inclusive, or null for a piece that carries none.
export function pieceLeds(design, n) {
  const path = trace(design.pieces), arcs = ledArcs(design, n);
  return path.runs.map((r, k) => {
    const last = k === path.runs.length - 1;
    const on = arcs.map((s, i) => (s >= r.s0 - 1e-6 && (s < r.s0 + r.len - 1e-6 || (last && s <= r.s0 + r.len + 1e-6)) ? i : -1)).filter(i => i >= 0);
    return on.length ? { from: on[0] + 1, to: on[on.length - 1] + 1 } : null;
  });
}
// Everything about the shape in its own space, moved so the middle of its bounding box is the origin:
// parts (one polyline per piece), the LEDs, the box, and for each piece a point just outside it for its label.
export function layout(design, n) {
  const path = trace(design.pieces);
  const parts = path.runs.map(r => {
    const k = r.t === "s" ? 1 : Math.max(2, Math.ceil(r.ang / (5 * RAD)));
    return Array.from({ length: k + 1 }, (_, i) => { const q = onRun(r, r.len * i / k); return [q.x, q.y]; });
  });
  const all = parts.flat();
  if (!all.length) return { path, len: 0, parts: [], leds: [], box: { w: 0, h: 0 }, mids: [] };
  const x0 = Math.min(...all.map(p => p[0])), x1 = Math.max(...all.map(p => p[0])), y0 = Math.min(...all.map(p => p[1])), y1 = Math.max(...all.map(p => p[1]));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, mv = p => [p[0] - cx, p[1] - cy];
  const leds = ledArcs(design, n).map(s => { const q = at(path, s); return mv([q.x, q.y]); });
  const mids = path.runs.map(r => {
    const q = onRun(r, r.len / 2), p = mv([q.x, q.y]), nx = -Math.sin(q.h), ny = Math.cos(q.h);
    const out = (p[0] + nx) ** 2 + (p[1] + ny) ** 2 >= (p[0] - nx) ** 2 + (p[1] - ny) ** 2 ? 1 : -1;   // the side away from the middle
    return { x: p[0], y: p[1], nx: nx * out, ny: ny * out };
  });
  return { path, len: path.length, parts: parts.map(a => a.map(mv)), leds, box: { w: x1 - x0, h: y1 - y0 }, mids };
}

// ---- on the bike ---------------------------------------------------------------------------------------------------
// u and v span the plane the shape lies in (u to the right of the drawing, v up), n is the way a lean tips v.
// firsts: where the first LED can be, with the direction the first-to-last line then points (degrees from u toward v).
export const PLANES = {
  flat: { name: "Lies flat", seen: "Seen from above", u: [0, 1, 0], v: [-1, 0, 0], n: [0, 0, 1], edges: ["Front", "Right", "Rear", "Left"],
    firsts: [["right", "Right", 180], ["left", "Left", 0], ["front", "Front", -90], ["rear", "Rear", 90]], lean: "Lean: front edge up (degrees)" },
  across: { name: "Stands across", seen: "Seen from behind", u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0], edges: ["Up", "Right", "Down", "Left"],
    firsts: [["right", "Right", 180], ["left", "Left", 0], ["top", "Top", -90], ["bottom", "Bottom", 90]], lean: "Lean: top toward the rear (degrees)" },
  along: { name: "Stands along", seen: "Seen from the left side", u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], edges: ["Up", "Rear", "Down", "Front"],
    firsts: [["front", "Front", 0], ["rear", "Rear", 180], ["top", "Top", -90], ["bottom", "Bottom", 90]], lean: "Lean: top toward the right (degrees)" },
};
// The frame keeps the shape's own turn (rot), not the side its first LED is on: editing a piece or a mark then leaves
// the rest of the shape exactly where it lies on the bike. The side and the fine turn shown on the Placement tab are
// read off the line from the first LED to the last (sideOf), and picking a side sets rot from it (rotFor).
const wrap180 = d => ((d + 180) % 360 + 360) % 360 - 180;
export function normFrame(f) {
  f = f || {};
  return { x: num(f.x) ? f.x : 0, y: num(f.y) ? f.y : 0, z: num(f.z) ? f.z : 600, plane: PLANES[f.plane] ? f.plane : "flat",
    rot: num(f.rot) ? r2(wrap180(f.rot)) : 0, lean: num(f.lean) ? clamp(f.lean, -89, 89) : 0 };
}
// The direction from the first LED to the last in shape space, degrees. A ring has none: its starting heading stands in.
export function chordDeg(design, n) {
  const leds = layout(design, n).leds, a = leds[0], z = leds[leds.length - 1];
  return a && z && Math.hypot(z[0] - a[0], z[1] - a[1]) > 1 ? Math.atan2(z[1] - a[1], z[0] - a[0]) / RAD : 0;
}
// The turn that puts the first LED on a side of the plane (firsts), plus a fine turn in degrees.
export function rotFor(design, n, plane, first, turn = 0) {
  const P = PLANES[plane] || PLANES.flat, base = (P.firsts.find(q => q[0] === first) || P.firsts[0])[2];
  return r2(wrap180(base + (Number(turn) || 0) - chordDeg(design, n)));
}
// Which side the first LED is on as the shape lies, and how far its first-to-last line is turned from square.
export function sideOf(design, n, frame) {
  const F = normFrame(frame), P = PLANES[F.plane], phi = chordDeg(design, n) + F.rot;
  const best = P.firsts.slice().sort((p, q) => Math.abs(wrap180(phi - p[2])) - Math.abs(wrap180(phi - q[2])))[0];
  return { first: best[0], label: best[1], turn: Math.round(wrap180(phi - best[2]) * 10) / 10 };
}
// The same shape turned over: every bend goes the other way.
export const mirrored = design => ({ ...design, pieces: design.pieces.map(p => (p.t === "b" ? { ...p, dir: p.dir < 0 ? 1 : -1 } : { ...p })) });
// The shape turned the way it lies in its plane: the same parts, LEDs and label points as layout(), in drawing axes (right, up).
export function turned(design, n, frame) {
  const L = layout(design, n), F = normFrame(frame), th = F.rot * RAD, c = Math.cos(th), s = Math.sin(th);
  const rot = p => [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  const mids = L.mids.map(m => { const q = rot([m.x, m.y]), w = rot([m.nx, m.ny]); return { x: q[0], y: q[1], nx: w[0], ny: w[1] }; });
  return { ...L, parts: L.parts.map(q => q.map(rot)), leds: L.leds.map(rot), mids, frame: F };
}
// Every LED in bike mm.
export function placed(design, n, frame) {
  const T = turned(design, n, frame), F = T.frame, P = PLANES[F.plane], a = F.lean * RAD;
  const v = P.v.map((q, i) => q * Math.cos(a) + P.n[i] * Math.sin(a)), o = [F.x, F.y, F.z];
  return T.leds.map(p => [0, 1, 2].map(i => o[i] + p[0] * P.u[i] + p[1] * v[i]));
}
// The fewest path points that keep every LED within tol mm of where the controller will put it. The controller
// spreads the LEDs between two path points evenly by number, so the error of an LED is measured against exactly that.
// room: how many points the light may use; the tolerance grows until they fit.
export function pathPoints(pos, room, tol = 2) {
  const n = pos.length;
  if (n < 2 || room < 2) return [];
  const pick = t => {
    const keep = new Set([0, n - 1]), todo = [[0, n - 1]];
    while (todo.length) {
      const [i0, i1] = todo.pop();
      let worst = 0, wi = -1;
      for (let i = i0 + 1; i < i1; i++) {
        const f = (i - i0) / (i1 - i0), d = Math.hypot(...[0, 1, 2].map(k => pos[i][k] - (pos[i0][k] + (pos[i1][k] - pos[i0][k]) * f)));
        if (d > worst) { worst = d; wi = i; }
      }
      if (worst > t) { keep.add(wi); todo.push([i0, wi], [wi, i1]); }
    }
    return [...keep].sort((a, b) => a - b);
  };
  let t = tol, idx = pick(t);
  for (let k = 0; k < 60 && idx.length > room; k++) { t *= 1.3; idx = pick(t); }
  if (idx.length > room) idx = [0, n - 1];
  return idx.map(i => ({ px: i, x: Math.round(pos[i][0]), y: Math.round(pos[i][1]), z: Math.round(pos[i][2]) }));
}
export const designPoints = (design, n, frame, room, tol) => pathPoints(placed(design, n, frame), room, tol);
// Do these path points (a light's geom) still come from this shape? Every point must sit on its LED.
export function matches(design, n, frame, pts) {
  if (!pts || pts.length < 2 || n < 2) return false;
  const leds = placed(design, n, frame), list = pts.slice().sort((a, b) => a.px - b.px);
  if (list[0].px !== 0 || list[list.length - 1].px !== n - 1) return false;
  return list.every(p => { const q = leds[p.px]; return !!q && Math.abs(q[0] - p.x) <= 1.01 && Math.abs(q[1] - p.y) <= 1.01 && Math.abs(q[2] - p.z) <= 1.01; });
}
// Where a first shape goes: { x, y, z, plane, first }. A light that is already placed keeps its spot: the middle of
// its points, the plane its first-to-last line fits best, and the first LED on the side it is on now.
export function spotFor(pts) {
  const f = { x: 0, y: 0, z: 600, plane: "flat", first: "right" };
  const list = (pts || []).slice().sort((a, b) => a.px - b.px);
  if (!list.length) return f;
  for (const k of ["x", "y", "z"]) f[k] = Math.round((Math.min(...list.map(p => p[k])) + Math.max(...list.map(p => p[k]))) / 2);
  const a = list[0], b = list[list.length - 1], d = [b.x - a.x, b.y - a.y, b.z - a.z];
  if (Math.hypot(...d) < 1) return f;
  f.plane = Math.abs(d[2]) > Math.hypot(d[0], d[1]) ? (Math.abs(d[0]) > Math.abs(d[1]) ? "along" : "across") : "flat";
  const P = PLANES[f.plane], dot = w => d[0] * w[0] + d[1] * w[1] + d[2] * w[2], ang = Math.atan2(dot(P.v), dot(P.u)) / RAD;
  f.first = P.firsts.slice().sort((p, q) => Math.abs(wrap180(ang - p[2])) - Math.abs(wrap180(ang - q[2])))[0][0];
  return f;
}
// The frame that puts a shape on a spot, square to the bike.
export const frameAt = (design, n, spot) => normFrame({ x: spot.x, y: spot.y, z: spot.z, plane: spot.plane, rot: rotFor(design, n, spot.plane, spot.first, 0) });

// ---- starting shapes -----------------------------------------------------------------------------------------------
// "wrap" is the fork bracket (rev 2, docs: fork-tube LED bracket): a 3/4 wrap round each fork tube at the strip's
// 27.2 mm radius, 199.8 mm between the tube centers across the front face. 456 mm in all.
export const PRESETS = [["straight", "Straight"], ["arc", "Curved"], ["wrap", "Wraps round both ends"], ["ring", "Ring"]];
export function presetDesign(key, n, den) {
  const pitch = den > 0 ? 1000 / den : 0, run = pitch && n > 1 ? (n - 1) * pitch : 0;
  const d = { v: 1, pieces: [], a: 0, b: 0 };
  if (key === "straight") d.pieces = [{ t: "s", len: r2(run || 254) }];
  else if (key === "arc") d.pieces = [{ t: "b", r: r2((run || 254) / (60 * RAD)), deg: 60, dir: 1 }];
  else if (key === "ring") {
    const round = pitch && n > 1 ? n * pitch : 320;
    d.pieces = [{ t: "b", r: r2(round / (2 * Math.PI)), deg: 360, dir: 1 }];
    d.b = n > 1 ? r2(trace(d.pieces).length / n) : 0;
  } else if (key === "wrap") {
    d.pieces = [{ t: "b", r: 27.2, deg: 270, dir: 1 }, { t: "s", len: 199.8 }, { t: "b", r: 27.2, deg: 270, dir: 1 }];
    const spare = trace(d.pieces).length - run;
    if (run && spare > 0) d.a = d.b = r2(spare / 2);   // a shorter strip sits in the middle of the bracket
  }
  return d;
}

// ---- kept on this device -------------------------------------------------------------------------------------------
const KEY = k => "rcr.bar." + k, UNIT_KEY = "rcr.barunit";
export const barKey = (light, ref) => (light && light.id ? String(light.id) : `o${ref.out}k${ref.k}`);
export function loadBar(key) {
  try {
    const j = JSON.parse(localStorage.getItem(KEY(key)) || "null");
    return j && validDesign(j.design) ? { design: j.design, frame: normFrame(j.frame) } : null;
  } catch (e) { return null; }
}
export function saveBar(key, data) { try { localStorage.setItem(KEY(key), JSON.stringify({ design: data.design, frame: normFrame(data.frame) })); } catch (e) { /* storage full or off */ } }
export function clearBar(key) { try { localStorage.removeItem(KEY(key)); } catch (e) { /* off */ } }

// ---- units ---------------------------------------------------------------------------------------------------------
// Inches to a hundredth, or millimeters to a tenth: a bracket drawn in CAD is dimensioned in mm.
export const UNITS = { in: { per: 25.4, step: 0.01, dec: 2 }, mm: { per: 1, step: 0.1, dec: 1 } };
// the unit last picked on this device (shared with the curve of a panel, panelcurve.js)
export function unitPref() { try { const u = localStorage.getItem(UNIT_KEY); if (UNITS[u]) return u; } catch (e) { /* off */ } return "in"; }
export function setUnitPref(u) { try { localStorage.setItem(UNIT_KEY, u); } catch (e) { /* off */ } }
export const show = (mm, u) => { const m = 10 ** UNITS[u].dec; return Math.round(mm / UNITS[u].per * m) / m; };
export const sized = (mm, u) => `${show(mm, u)} ${u}`;
// the gap between two LEDs wants one more digit: 0.273 in, 6.94 mm
export const gapped = (mm, u) => { const m = 10 ** (UNITS[u].dec + 1); return `${Math.round(mm / UNITS[u].per * m) / m} ${u}`; };
const fromUnit = (v, u) => r2(v * UNITS[u].per);

// ---- the drawing ---------------------------------------------------------------------------------------------------
const NS = "http://www.w3.org/2000/svg";
function sv(tag, attrs = {}, ...kids) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) e.setAttribute(k, String(v));
  for (const k of kids) if (k != null) e.append(k);
  return e;
}
// g: { parts, leds, mids } from layout() or turned(). opts.labels: one text per piece, set outside it;
// opts.edges: [top, right, bottom, left] words round the drawing; opts.sel: the piece to mark; opts.onPick(i).
// The view is fitted to everything drawn, texts included, so the shape is as large as the box allows.
export function picture(g, opts = {}) {
  const pts = g.parts.flat().concat(g.leds);
  if (!pts.length) return sv("svg", { class: "bs-svg", viewBox: "0 0 100 60", role: "img", "aria-label": "No shape yet" });
  const x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1])), y1 = Math.max(...pts.map(p => p[1]));
  const size = Math.max(x1 - x0, y1 - y0, 20), fs = size / 15, band = clamp(size / 30, 1.5, 14);
  const n = g.leds.length, gap = n > 1 ? Math.hypot(g.leds[1][0] - g.leds[0][0], g.leds[1][1] - g.leds[0][1]) : band;
  const dot = clamp(Math.min(gap * 0.36, band * 0.42), size / 400, band);
  const texts = [];   // { x, y, s, cls, anchor }, y up; each one widens the view by its own size
  let bx0 = x0 - band, bx1 = x1 + band, by0 = y0 - band, by1 = y1 + band;
  const put = (x, y, s, cls, anchor = "middle", wide = 0.56) => {
    const w = String(s).length * fs * wide, l = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
    bx0 = Math.min(bx0, l); bx1 = Math.max(bx1, l + w); by0 = Math.min(by0, y - fs * 0.62); by1 = Math.max(by1, y + fs * 0.62);
    texts.push({ x, y, s, cls, anchor, box: [l, y - fs * 0.62, l + w, y + fs * 0.62] });
  };
  // a piece's size goes just outside its middle, reading away from the shape
  if (opts.labels && g.mids) opts.labels.forEach((s, i) => {
    const m = g.mids[i]; if (!m || !s) return;
    const side = Math.abs(m.nx) > 0.85, k = band + fs * (side ? 0.7 : 1.4);   // beside the piece only when it runs up and down
    put(m.x + m.nx * k, m.y + m.ny * k, s, "bs-dim" + (opts.sel === i ? " sel" : ""), side ? (m.nx > 0 ? "start" : "end") : "middle");
  });
  // The first and last LED carry their numbers. Each goes on the side of its LED that is farthest from the band
  // and from the other texts, so it never lands on the shape.
  const toSeg = (q, a, b) => { const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy, t = l2 ? clamp(((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / l2, 0, 1) : 0; return Math.hypot(q[0] - a[0] - t * vx, q[1] - a[1] - t * vy); };
  const toBox = (q, b) => Math.hypot(Math.max(b[0] - q[0], 0, q[0] - b[2]), Math.max(b[1] - q[1], 0, q[1] - b[3]));
  const free = q => Math.min(...g.parts.map(part => Math.min(...part.slice(1).map((b, k) => toSeg(q, part[k], b)))), ...texts.map(t => toBox(q, t.box) - fs * 0.4));
  const tag = (p, s, cls) => {
    const k = band * 0.6 + fs * 1.1;
    let best = p, bestD = -Infinity;
    for (let i = 0; i < 16; i++) { const q = [p[0] + Math.cos(i * Math.PI / 8) * k, p[1] + Math.sin(i * Math.PI / 8) * k], d = free(q); if (d > bestD + 1e-6) { bestD = d; best = q; } }
    put(best[0], best[1], s, cls);
  };
  if (n) tag(g.leds[0], "1", "bs-num first");
  if (n > 1) tag(g.leds[n - 1], String(n), "bs-num last");
  // the words for the bike's directions sit outside all of that
  if (opts.edges) {
    const [t, r, b, l] = opts.edges, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, T = by1 + fs * 1.1, B = by0 - fs * 1.1, R = bx1 + fs * 0.9, Lx = bx0 - fs * 0.9;
    put(cx, T, t, "bs-edge", "middle", 0.72); put(cx, B, b, "bs-edge", "middle", 0.72); put(R, cy, r, "bs-edge", "start", 0.72); put(Lx, cy, l, "bs-edge", "end", 0.72);
  }
  const m = fs * 0.5, X = p => r2(p[0]), Y = p => r2(-p[1]);   // the drawing's y runs down
  const svg = sv("svg", { class: "bs-svg", viewBox: `${r2(bx0 - m)} ${r2(-by1 - m)} ${r2(bx1 - bx0 + 2 * m)} ${r2(by1 - by0 + 2 * m)}`, role: "img",
    "aria-label": opts.title || "The shape of the light", preserveAspectRatio: "xMidYMid meet" });
  svg.setAttribute("style", `aspect-ratio: ${r2(bx1 - bx0 + 2 * m)} / ${r2(by1 - by0 + 2 * m)}`);   // the box takes the drawing's own proportions
  g.parts.forEach((part, i) => {
    const d = part.map((p, k) => `${k ? "L" : "M"}${X(p)} ${Y(p)}`).join(" ");
    const path = sv("path", { d, class: "bs-band" + (opts.sel === i ? " sel" : ""), "stroke-width": r2(band), "data-part": i });
    if (opts.onPick) { path.setAttribute("style", "cursor: pointer"); path.addEventListener("click", () => opts.onPick(i)); }
    svg.append(path);
  });
  // where one piece ends and the next begins
  g.parts.slice(1).forEach(part => svg.append(sv("circle", { cx: X(part[0]), cy: Y(part[0]), r: r2(band * 0.62), class: "bs-joint" })));
  g.leds.forEach((p, i) => svg.append(sv("circle", { cx: X(p), cy: Y(p), r: r2(i === 0 || i === n - 1 ? Math.max(dot, band * 0.5) : dot),
    class: "bs-led" + (i === 0 ? " first" : i === n - 1 ? " last" : ""), "data-led": i })));
  for (const t of texts) svg.append(sv("text", { x: r2(t.x), y: r2(-t.y), class: t.cls, "font-size": r2(fs), "text-anchor": t.anchor, "dominant-baseline": "middle" }, t.s));
  return svg;
}

// ---- the builder ---------------------------------------------------------------------------------------------------
// Opens in the sheet's place. n: the light's LED count (it can be changed here, up to maxLeds), den: its LEDs per meter
// (0 = unknown). frame: how a shape that is being edited lies on the bike. spot: { plane, first } for a first shape,
// which is then set square with its first LED on that side. The drawing shows the shape the way it lies, and that turn
// is held while pieces and marks change, so the drawing does not swing round under the hand.
// onDone(design, ledCount, rot) when Done is tapped, onCancel() when it is left any other way.
export function openBarShape({ name = "Light", n: n0 = 0, maxLeds = 800, den = 0, design, frame, spot, onDone, onCancel } = {}) {
  const planeKey = PLANES[frame && frame.plane] ? frame.plane : PLANES[spot && spot.plane] ? spot.plane : "flat", plane = PLANES[planeKey];
  const wantFirst = plane.firsts.some(q => q[0] === (spot && spot.first)) ? spot.first : plane.firsts[0][0];
  let n = clamp(Math.round(n0) || 2, 2, Math.max(2, maxLeds));
  let rot = frame && num(frame.rot) ? frame.rot : null;   // null: taken from the first shape that is drawn
  let unit = "in";
  try { const u = localStorage.getItem(UNIT_KEY); if (UNITS[u]) unit = u; } catch (e) { /* off */ }
  const D = design && validDesign(design) ? { v: 1, pieces: design.pieces.map(p => ({ ...p })), a: design.a, b: design.b } : { v: 1, pieces: [], a: 0, b: 0 };
  let sel = -1, finished = false;
  const pitch = den > 0 ? 1000 / den : 0;
  // what the shape was when the builder opened: a back press asks before it throws changes away
  const snap = () => { try { return JSON.stringify([D, n]); } catch (e) { return null; } };
  let first = null;
  const changed = () => { const now = snap(); return now == null || first == null ? D.pieces.length > 0 : now !== first; };
  const sh = sheet({ title: "Shape of " + (name || "this light"), sub: "", over: true, guard: () => (changed() ? "Press back again to discard the changes to this shape" : ""),
    onClose: replaced => { if (!finished && !replaced && onCancel) onCancel(); } });
  sh.el.classList.add("bs-sheet");
  const body = sh.body; body.id = "bsRoot"; body.classList.add("bs");

  const pic = el("div", { class: "bs-pic", id: "bsPic" });
  const seen = el("p", { class: "note", id: "bsSeen" });
  const usable = () => D.pieces.length > 0 && D.pieces.every(validPiece) && D.a >= 0 && D.b >= 0 && D.a + D.b < trace(D.pieces).length;
  // square to the bike, first LED on the side it is on now (or the side asked for, for a first shape)
  const square = () => { rot = usable() ? rotFor(D, n, planeKey, rot == null ? wantFirst : sideOf(D, n, { plane: planeKey, rot }).first, 0) : rot; };
  if (rot == null && usable()) square();
  const status = el("p", { class: "bs-status", id: "bsStatus" }), warn = el("p", { class: "note warn", id: "bsWarn" });
  const rows = el("div", { class: "bs-rows", id: "bsRows" });
  const marks = el("div", { class: "pl-pt bs-marks", id: "bsMarks" }), spacing = el("p", { class: "note", id: "bsSpacing" }), fits = el("div", { class: "bs-fits", id: "bsFits" });
  // how many LEDs there are: the light's own count, which Done changes when another number is typed here
  const countInp = el("input", { type: "number", id: "bsCount", min: 2, max: Math.max(2, maxLeds), step: 1, value: n, inputMode: "numeric", "aria-label": "Number of LEDs" });
  countInp.addEventListener("change", () => { const v = Math.round(Number(countInp.value)); if (countInp.value !== "" && Number.isFinite(v)) n = clamp(v, 2, Math.max(2, maxLeds)); countInp.value = n; refresh(); });
  const countNote = el("p", { class: "note", id: "bsCountNote" });
  const unitSeg = seg([["in", "Inches"], ["mm", "Millimeters"]], unit, v => { unit = v; try { localStorage.setItem(UNIT_KEY, v); } catch (e) { /* off */ } build(); }, { id: "bsUnit" });
  const doneBtn = button("Done", { kind: "primary", id: "bsDone", onClick: finish });

  // A typed size. It is read when the field is left (or Enter): the model changes, the field shows what was kept,
  // and the rest of the screen follows. The rows are only rebuilt when a piece is added, removed or moved.
  function field(label, get, set, id, deg) {
    const val = () => (deg ? r2(get()) : show(get(), unit));
    const inp = el("input", { type: "number", id, inputMode: "decimal", "aria-label": label, min: 0, step: deg ? 1 : UNITS[unit].step, value: val() });
    inp.addEventListener("change", () => { const v = Number(inp.value); if (inp.value !== "" && Number.isFinite(v) && v >= 0) set(deg ? v : fromUnit(v, unit)); inp.value = val(); refresh(); });
    return el("label", { class: "pl-f" }, el("span", {}, label), inp);
  }
  function rowFor(p, i) {
    const pick = el("button", { type: "button", class: "bs-n", "data-pick": i, "aria-pressed": String(sel === i), "aria-label": `Show piece ${i + 1} in the drawing`,
      onclick: () => { sel = sel === i ? -1 : i; refresh(); } }, String(i + 1));
    const head = el("div", { class: "bs-head" }, pick, el("b", {}, p.t === "s" ? "Straight" : "Bend"), el("span", { class: "note", "data-leds": i }),
      button("Up", { small: true, kind: "ghost", id: `bsUp-${i}`, disabled: i === 0, title: "Move this piece one place toward the start", onClick: () => { [D.pieces[i - 1], D.pieces[i]] = [D.pieces[i], D.pieces[i - 1]]; sel = i - 1; build({ focus: i > 1 ? `bsUp-${i - 1}` : `bsDel-${i - 1}` }); } }),
      button("Remove", { small: true, kind: "ghost", id: `bsDel-${i}`, onClick: () => { D.pieces.splice(i, 1); sel = -1; build(); } }));
    const fields = p.t === "s"
      ? [field(`Length (${unit})`, () => p.len, v => { p.len = clamp(v, 0.1, MAX_LEN); }, `bsLen-${i}`)]
      : [field("Angle (degrees)", () => p.deg, v => { p.deg = clamp(v, 1, 360); }, `bsDeg-${i}`, true),
        field(`Radius (${unit})`, () => p.r, v => { p.r = clamp(v, MIN_R, MAX_LEN); }, `bsRad-${i}`),
        el("label", { class: "pl-f" }, el("span", {}, "Bends to the"), seg([[1, "Left"], [-1, "Right"]], p.dir, v => { p.dir = v; refresh(); }, { id: `bsDir-${i}` }).el)];
    return el("div", { class: "pl-pt bs-row", "data-piece": i }, head, ...fields);
  }
  function add(p) {
    if (D.pieces.length >= MAX_PIECES) return;
    D.pieces.push(p); sel = D.pieces.length - 1;
    if (rot == null) square();   // the first piece sets how the drawing lies; later ones leave it alone
    build({ show: true });
  }
  const lastDir = () => { const b = D.pieces.filter(p => p.t === "b").pop(); return b ? b.dir : 1; };
  function fit(kind) {
    const len = trace(D.pieces).length, run = (n - 1) * pitch;
    if (kind === "center") D.a = D.b = r2(Math.max(0, (len - run) / 2));
    else if (kind === "keep") D.b = r2(Math.max(0, len - D.a - run));
    else if (kind === "loop") { D.a = 0; D.b = r2(len / n); }
    // only the two marks changed: their fields take the new values, nothing is rebuilt
    for (const [id, v] of [["bsA", D.a], ["bsB", D.b]]) { const inp = marks.querySelector("#" + id); if (inp) inp.value = show(v, unit); }
    refresh();
  }

  // Everything that depends on the pieces or the unit: the rows and the marks. The sheet stays scrolled where it was
  // and the focus stays on the control that was used (opts.focus names another one); opts.show brings the last row
  // into view instead, for a piece that was just added.
  function build(opts = {}) {
    const top = body.scrollTop, act = document.activeElement, id = opts.focus || (act && body.contains(act) ? act.id : "");
    clear(rows);
    D.pieces.forEach((p, i) => rows.append(rowFor(p, i)));
    if (!D.pieces.length) rows.append(note("No pieces yet. Start from one of the shapes below, or add the first piece."));
    clear(marks);
    marks.append(field(`First LED, from the start (${unit})`, () => D.a, v => { D.a = v; }, "bsA"), field(`Last LED, from the end (${unit})`, () => D.b, v => { D.b = v; }, "bsB"));
    refresh();
    body.scrollTop = top;
    const again = id ? document.getElementById(id) : null;
    if (again && body.contains(again) && !again.disabled) again.focus({ preventScroll: true });
    if (opts.show && rows.lastChild && typeof rows.lastChild.scrollIntoView === "function") rows.lastChild.scrollIntoView({ block: "nearest" });
  }
  // Everything that depends on the numbers: the drawing, the status, the spacing check.
  function refresh() {
    const ok = D.pieces.length > 0 && D.pieces.every(validPiece), len = ok ? trace(D.pieces).length : 0, span = len - D.a - D.b;
    const bad = !D.pieces.length ? "Add a piece to draw the shape." : !ok ? "One of the sizes cannot be right." : span < 0 || (n > 1 && span <= 0) ? "The first and last LED marks leave no room between them." : "";
    // drawn the way it lies; while the marks are wrong the LEDs are left out
    const L = ok ? turned(bad ? { ...D, a: 0, b: 0 } : D, n, { plane: planeKey, rot: rot || 0 }) : null;
    seen.textContent = plane.seen + (ok && !bad ? `, with the first LED at the ${sideOf(D, n, { plane: planeKey, rot: rot || 0 }).label.toLowerCase()}.` : ".")
      + (frame ? "" : " Where it sits on the bike is set on the Placement tab afterwards.");
    clear(pic);
    if (L) {
      const labels = D.pieces.map(p => (p.t === "s" ? sized(p.len, unit) : `${r2(p.deg)}° r ${sized(p.r, unit)}`));
      pic.append(picture(bad ? { ...L, leds: [] } : L, { labels, sel, edges: plane.edges, onPick: i => { sel = sel === i ? -1 : i; refresh(); }, title: `The shape of ${name}, ${plane.seen.toLowerCase()}` }));
    }
    rows.querySelectorAll("[data-pick]").forEach(b => b.setAttribute("aria-pressed", String(Number(b.dataset.pick) === sel)));
    const on = L && !bad ? pieceLeds(D, n) : [];
    rows.querySelectorAll("[data-leds]").forEach(s => { const r = on[Number(s.dataset.leds)]; s.textContent = !L || bad ? "" : r ? (r.from === r.to ? `LED ${r.from}` : `LEDs ${r.from} to ${r.to} (${r.to - r.from + 1})`) : "no LEDs"; });
    const each = n > 1 && !bad ? span / (n - 1) : 0;
    status.textContent = bad || `${sized(len, unit)} long · ${n} LEDs${each ? `, ${gapped(each, unit)} apart` : ""}`;
    status.className = "bs-status" + (bad ? " bad" : "");
    sh.setSub(L ? `${D.pieces.length} ${D.pieces.length === 1 ? "piece" : "pieces"} · ${sized(len, unit)}` : "");
    // the spacing the marks give against the strip's own
    let w = "";
    const closed = L && !bad && isClosed(D);
    if (!bad && pitch && n > 1) {
      const run = (n - 1) * pitch;
      if (run > len + 0.5) w = `${n} LEDs at ${den} per meter are ${sized(run, unit)} from first to last, and the shape is only ${sized(len, unit)} long. Check the sizes or the LED count.`;
      else if (Math.abs(each - pitch) / pitch > 0.03) w = `The marks put the LEDs ${gapped(each, unit)} apart. At ${den} per meter they are ${gapped(pitch, unit)} apart: ${sized(run, unit)} from first to last.`;
    }
    if (closed && n > 1 && D.a + D.b < each * 0.5) w = "The shape closes on itself, so the last LED sits on the first. Space them round the loop, or set the last LED short of the end.";
    warn.textContent = w; warn.hidden = !w;
    spacing.textContent = pitch ? `${n} LEDs at ${den} per meter are ${gapped(pitch, unit)} apart: ${sized(Math.max(0, n - 1) * pitch, unit)} from first to last.`
      : "Set the light's LEDs per meter on the Placement tab to check the spacing here.";
    countNote.textContent = n === n0 ? "The LEDs are spread evenly from the first mark to the last."
      : `The light has ${n0} LEDs now. Done makes it ${n}: its last section takes up the difference.`;
    countNote.className = "note" + (n === n0 ? "" : " warn");
    clear(fits);
    if (L) {
      if (pitch && n > 1 && (n - 1) * pitch <= len + 0.5) fits.append(button("Center the LEDs on the shape", { small: true, id: "bsCenter", onClick: () => fit("center") }),
        button("Keep the first LED, use the strip's spacing", { small: true, id: "bsKeep", onClick: () => fit("keep") }));
      if (L && isClosed(D) && n > 1) fits.append(button("Space the LEDs evenly round the loop", { small: true, id: "bsLoop", onClick: () => fit("loop") }));
    }
    doneBtn.disabled = !!bad;
  }
  function finish() {
    if (doneBtn.disabled) return;
    finished = true;
    const out = { v: 1, pieces: D.pieces.map(p => (p.t === "s" ? { t: "s", len: r2(p.len) } : { t: "b", r: r2(p.r), deg: r2(p.deg), dir: p.dir < 0 ? -1 : 1 })), a: r2(D.a), b: r2(D.b) };
    sh.close();
    if (onDone) onDone(out, n, rot == null ? rotFor(out, n, planeKey, wantFirst, 0) : rot);
  }

  const inchOrMm = (i, m) => (unit === "in" ? i * 25.4 : m);
  // a starting shape replaces the pieces and the marks; the chip does not stay pressed, so the same one can be taken again
  const presetChips = chips(PRESETS, null, k => {
    const side = rot != null && usable() ? sideOf(D, n, { plane: planeKey, rot }).first : wantFirst, p = presetDesign(k, n, den);
    D.pieces = p.pieces; D.a = p.a; D.b = p.b; sel = -1;
    rot = rotFor(D, n, planeKey, side, 0);   // a new shape is set square again, its first LED on the same side
    presetChips.set(null); build();
  }, { id: "bsPresets" });
  body.append(
    el("div", { class: "bs-top" }, pic, seen, status, warn),
    panel("Pieces, from the first LED's end", el("div", { class: "pad bs-pad" }, rows,
      el("div", { class: "bs-add" }, button("Add a straight", { id: "bsAddS", onClick: () => add({ t: "s", len: inchOrMm(4, 100) }) }),
        button("Add a bend", { id: "bsAddB", onClick: () => add({ t: "b", r: inchOrMm(2, 50), deg: 90, dir: lastDir() }) })),
      note("Left and right are as you follow the LEDs from the first one."),
      el("div", { class: "label" }, "Start again from a shape"), presetChips.el)),
    panel("Where the LEDs are", el("div", { class: "pad bs-pad" },
      el("label", { class: "field inline bs-count" }, el("span", { class: "lbl" }, el("b", {}, "How many LEDs")), countInp),
      marks, countNote, spacing, fits)),
    panel("Sizes in", el("div", { class: "pad" }, unitSeg.el)),
    el("div", { class: "bs-end" }, doneBtn, button("Cancel", { kind: "ghost", id: "bsCancel", onClick: () => sh.close() })));
  build();
  first = snap();
  return { close() { sh.close(); }, design: D };
}
