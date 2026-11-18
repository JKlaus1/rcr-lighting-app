// Pure math for the bike view: no DOM, no three.js. Everything here is tested with hand-worked numbers
// (test/bikeview-math.test.mjs). Bike axes in mm: x back from the front axle, y left (-) / right (+), z up.
// The 3D model's frame (glTF meters): X = x / 1000, Y = z / 1000, Z = -y / 1000.

// ---- frames ------------------------------------------------------------------------------------------
export const bikeToModel = (x, y, z) => [x / 1000, z / 1000, -y / 1000];
export const modelToBike = (X, Y, Z) => [X * 1000, -Z * 1000, Y * 1000];
// a direction (no scaling needed beyond the axis swap)
export const dirToBike = (X, Y, Z) => [X, -Z, Y];

// ---- the flat picture (onyx-rcr-side.jpg, the bike's right side, front on the right) -------------------
export const FLAT = { w: 1150, h: 644, x0: 930, y0: 635, mmPerPx: 1.6522 };
export const flatToImg = (x, z, cal = FLAT) => [cal.x0 - x / cal.mmPerPx, cal.y0 - z / cal.mmPerPx];
export const imgToFlat = (px, py, cal = FLAT) => [(cal.x0 - px) * cal.mmPerPx, (cal.y0 - py) * cal.mmPerPx];
// Fit an image of iw x ih into a box (left, top, width, height), centered: -> { s, ox, oy } with screen = o + img * s.
export function letterbox(iw, ih, box) {
  const s = Math.max(1e-6, Math.min(box.w / iw, box.h / ih));
  return { s, ox: box.x + (box.w - iw * s) / 2, oy: box.y + (box.h - ih * s) / 2 };
}

// ---- vectors -----------------------------------------------------------------------------------------
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = a => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : [0, 0, 0]; };
export const dist = (a, b) => len(sub(a, b));
const P = p => Array.isArray(p) ? p : [p.x, p.y, p.z];
const O = (a, px) => (px == null ? { x: a[0], y: a[1], z: a[2] } : { px, x: a[0], y: a[1], z: a[2] });

// ---- clamping and rounding -----------------------------------------------------------------------------
export const BOX = { x: [-600, 2200], y: [-700, 700], z: [0, 1800] };
const cl = (v, r) => Math.min(r[1], Math.max(r[0], v));
// A point as whole millimeters inside the sane box around the bike. Accepts [x,y,z] or { x, y, z } (px kept).
export function tidyPt(p) {
  const a = P(p);
  const o = { x: Math.round(cl(a[0], BOX.x)), y: Math.round(cl(a[1], BOX.y)), z: Math.round(cl(a[2], BOX.z)) };
  for (const k of ["x", "y", "z"]) if (Object.is(o[k], -0)) o[k] = 0;
  return p && p.px != null ? { px: p.px, ...o } : o;
}
const r4 = v => { const r = Math.round(v * 1e4) / 1e4; return Object.is(r, -0) ? 0 : r; };

// ---- LED dot size --------------------------------------------------------------------------------------
// The size of each dot in mm: 1.5 x the distance to the nearest neighbor of the same light, kept in 5..25 mm.
// pos: x,y,z per LED (NaN = none); ranges: [{ s, n }] runs of LEDs that belong together (one light each).
export const DOT = { k: 1.5, min: 5, max: 25, alone: 12 };
export function dotSizes(pos, ranges, out) {
  for (const { s, n } of ranges) {
    for (let i = s; i < s + n; i++) {
      if (!(pos[i * 3] === pos[i * 3])) { out[i] = 0; continue; }
      let best = Infinity;
      for (const j of [i - 1, i + 1]) {
        if (j < s || j >= s + n || !(pos[j * 3] === pos[j * 3])) continue;
        const d = Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
        if (d > 0.01 && d < best) best = d;
      }
      out[i] = best === Infinity ? (n === 1 ? DOT.alone : DOT.min) : Math.min(DOT.max, Math.max(DOT.min, DOT.k * best));
    }
  }
  return out;
}

// ---- picking ---------------------------------------------------------------------------------------------
// xy: screen x,y per LED (NaN = not drawn). -> the index of the nearest LED within maxPx of (x, y), or -1.
export function nearestLed(xy, x, y, maxPx = 16) {
  let best = -1, bd = maxPx * maxPx;
  for (let i = 0, n = xy.length >> 1; i < n; i++) {
    const dx = xy[i * 2] - x, dy = xy[i * 2 + 1] - y, d = dx * dx + dy * dy;
    if (d <= bd) { bd = d; best = i; }   // NaN compares false: skipped
  }
  return best;
}

// ---- a light's LED positions from its path points -----------------------------------------------------------
// Linear by LED index between points, held at the ends (the firmware's pathPixelPos). pts: [{ px, x, y, z }] ascending.
export function interpLeds(pts, n, out = new Float32Array(n * 3)) {
  const m = pts.length;
  for (let i = 0; i < n; i++) {
    let a, b, f = 0;
    if (!m) { out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = NaN; continue; }
    if (i <= pts[0].px) a = b = pts[0];
    else if (i >= pts[m - 1].px) a = b = pts[m - 1];
    else {
      let k = 0;
      while (k + 1 < m && pts[k + 1].px <= i) k++;
      a = pts[k]; b = pts[k + 1];
      f = b.px > a.px ? (i - a.px) / (b.px - a.px) : 0;
    }
    out[i * 3] = a.x + (b.x - a.x) * f; out[i * 3 + 1] = a.y + (b.y - a.y) * f; out[i * 3 + 2] = a.z + (b.z - a.z) * f;
  }
  return out;
}

// ---- the bar tool ------------------------------------------------------------------------------------------
export const AXES = { y: [0, 1, 0], x: [1, 0, 0], z: [0, 0, 1] };   // across, along, upright
// Real length of a straight light: (n - 1) LED pitches; 300 mm when the spacing is unknown.
export const barLength = (n, den) => (den > 0 ? (Math.max(1, n) - 1) * 1000 / den : 300);
// The two ends of a bar. LED 1 sits on the bike's left (across), at the front (along), at the bottom (upright);
// flip puts it at the other end. centered moves the middle onto the centerline (y = 0).
export function barEnds({ mid, axis = "y", length, flip = false, centered = false }) {
  const m = P(mid).slice();
  if (centered) m[1] = 0;
  const d = mul(AXES[axis] || AXES.y, length / 2);
  const lo = sub(m, d), hi = add(m, d);
  return flip ? [hi, lo] : [lo, hi];
}
// Dragging one end of a bar: free (real length off) just moves it; real length on keeps the far end at `length`
// from the dragged one, on the line from the dragged end toward where the far end was.
export function dragBarEnd(ends, which, to, { length, real, centered }) {
  let a = P(to).slice(), b = ends[1 - which].slice();
  if (real) {
    let d = norm(sub(b, a));
    if (len(d) === 0) d = norm(sub(ends[1 - which], ends[which]));
    b = add(a, mul(d, length));
  }
  if (centered) { const off = (a[1] + b[1]) / 2; a[1] -= off; b[1] -= off; }
  return which === 0 ? [a, b] : [b, a];
}
// The axis a pair of ends runs along, and whether it is flipped from the default direction.
export function barAxisOf(a, b) {
  const d = sub(P(b), P(a));
  const ax = Math.abs(d[1]) >= Math.abs(d[0]) && Math.abs(d[1]) >= Math.abs(d[2]) ? "y" : Math.abs(d[0]) >= Math.abs(d[2]) ? "x" : "z";
  const i = ax === "x" ? 0 : ax === "y" ? 1 : 2;
  return { axis: ax, flip: d[i] < 0 };
}
export const barResult = (a, b, n) => [tidyPt({ px: 0, x: a[0], y: a[1], z: a[2] }), tidyPt({ px: Math.max(1, n - 1), x: b[0], y: b[1], z: b[2] })];

// ---- the curve tool ------------------------------------------------------------------------------------------
// Points tapped from the first LED to the last -> path points with px spread by the length along the path:
// first 0, last n - 1, whole numbers, strictly increasing (a point that would repeat a px is dropped; the last stays).
// fixed (optional, one entry per point): the LED number a point keeps, or null for a point that is spread by length
// between its fixed neighbors. A fixed number that leaves no LED for its neighbors is spread as well: a number at or
// behind the fixed one before it, and, when the last point is not fixed, a number on the light's last LED.
export function spreadPx(points, n, fixed) {
  // Lengths are taken between the points as they are kept (whole millimeters inside the box), so the numbers a drawing
  // gets are exactly the ones its stored points give again (followsDrawing).
  const p = points.map(q => { const t = tidyPt(P(q)); return [t.x, t.y, t.z]; });
  if (p.length < 2 || n < 2) return null;
  const cum = [0];
  for (let i = 1; i < p.length; i++) cum.push(cum[i - 1] + dist(p[i], p[i - 1]));
  const K = p.length - 1;
  if (!(cum[K] > 0)) return null;
  const fx = i => { const v = fixed ? fixed[i] : null; return v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(n - 1, Math.round(Number(v)))); };
  // the anchors: the fixed points that fit, the first point (LED 1 unless fixed) and the last (the last LED unless fixed)
  const anc = [];
  for (let i = 0; i <= K; i++) {
    let px = fx(i);
    const free = px == null;
    if (free && i > 0 && i < K) continue;
    if (free) px = i === 0 ? 0 : n - 1;
    if (i === K && free) while (anc.length > 1 && anc[anc.length - 1].px >= px) anc.pop();
    if (anc.length && anc[anc.length - 1].px >= px) { if (i === K) return null; continue; }
    anc.push({ i, px });
  }
  if (anc.length < 2 || anc[anc.length - 1].i !== K) return null;
  const out = [];
  for (let a = 0; a + 1 < anc.length; a++) {
    const A = anc[a], B = anc[a + 1], span = cum[B.i] - cum[A.i];
    out.push(tidyPt(O(p[A.i], A.px)));
    for (let i = A.i + 1; i < B.i; i++) {
      if (!(span > 0)) continue;
      const px = A.px + Math.round((cum[i] - cum[A.i]) / span * (B.px - A.px));
      if (px <= out[out.length - 1].px || px >= B.px) continue;
      out.push(tidyPt(O(p[i], px)));
    }
  }
  const Z = anc[anc.length - 1];
  out.push(tidyPt(O(p[Z.i], Z.px)));
  return out.length >= 2 ? out : null;
}

// ---- the segments of a drawn light: the stretch from one path point to the next ---------------------------------
// pts: a light's path points [{ px, x, y, z }], ascending; n: its LEDs. Segment i runs from point i to point i + 1 and
// holds the LEDs from point i's up to the one before point i + 1's; the last segment holds its end point's LED as well.
// -> [{ i, a (first LED, from 0), count, len (mm as drawn), last }]
export function segmentsOf(pts, n) {
  const out = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const last = i === pts.length - 2;
    out.push({ i, a: pts[i].px, count: pts[i + 1].px - pts[i].px + (last ? 1 : 0), len: dist(P(pts[i]), P(pts[i + 1])), last });
  }
  return out;
}
// The LED number of point i set to px: only that point moves, so the segment before it and the one after it trade
// LEDs. Kept between its neighbors' numbers. -> the new points
export function setPointLed(pts, n, i, px) {
  if (!(i >= 0 && i < pts.length)) return pts.map(q => ({ ...q }));
  const lo = i > 0 ? pts[i - 1].px + 1 : 0, hi = i < pts.length - 1 ? pts[i + 1].px - 1 : n - 1;
  const v = Math.max(lo, Math.min(hi, Math.round(Number(px)) || 0));
  return pts.map((q, j) => (j === i ? { ...q, px: v } : { ...q }));
}
// The LED count of segment j set to count. The segments after it keep their counts and move along the light; the last
// point stays on its LED, so the last segment takes up the difference, and when that is used up the ones before it give
// way, last first, down to one LED each. On the last segment the count moves its own first LED instead. -> the new points
export function setSegmentCount(pts, n, j, count) {
  const out = pts.map(q => ({ ...q })), K = out.length - 1;
  if (!(j >= 0 && j < K)) return out;
  let c = Math.round(Number(count)) || 0;
  if (j === K - 1) {   // the last segment: its end stays, its start moves
    const lo = j > 0 ? out[j - 1].px + 1 : 0;
    out[j].px = Math.max(lo, Math.min(out[K].px - 1, out[K].px + 1 - c));
    return out;
  }
  c = Math.max(1, Math.min(out[K].px - (K - 1 - j) - out[j].px, c));
  const d = out[j].px + c - out[j + 1].px;
  for (let i = j + 1; i < K; i++) out[i].px += d;
  for (let i = K - 1; i > j; i--) out[i].px = Math.min(out[i].px, out[i + 1].px - 1);
  return out;
}
// Whether the LED numbers are the ones the drawing gives by its lengths alone (nothing set by hand since).
export function followsDrawing(pts, n) {
  const s = spreadPx(pts, n);
  return !!s && s.length === pts.length && s.every((q, i) => q.px === pts[i].px);
}

// ---- the matrix tool ----------------------------------------------------------------------------------------
export const FACINGS = { front: [-1, 0, 0], rear: [1, 0, 0], left: [0, -1, 0], right: [0, 1, 0], up: [0, 0, 1] };
// The facing whose normal is closest to a surface normal (bike axes); front when there is none.
export function facingOf(n) {
  if (!n || !(len(n) > 0)) return "front";
  let best = "front", bd = -Infinity;
  for (const [k, f] of Object.entries(FACINGS)) { const d = dot(norm(n), f); if (d > bd + 1e-9) { bd = d; best = k; } }
  return best;
}
// A panel width x height (mm), centered on `center`, facing `facing`, tilted back by `lean` degrees about its own
// across-axis. -> { o (lower-left corner seen from the front), u (unit, across to the viewer's right), v (unit, up the panel) }
// with the front normal n = u x v. v = world up projected into the panel's plane (level panel: toward the front).
export function matrixFrame({ center, facing = "front", lean = 0, width, height, centered = false }) {
  const n0 = FACINGS[facing] || FACINGS.front;
  let v0 = facing === "up" ? [-1, 0, 0] : norm(sub([0, 0, 1], mul(n0, dot([0, 0, 1], n0))));
  const a = (lean || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const v = norm(sub(mul(v0, c), mul(n0, s)));         // leaning back: the top goes away from the viewer
  const n = norm(add(mul(n0, c), mul(v0, s)));
  const u = norm(cross(v, n));
  const m = P(center).slice();
  if (centered) m[1] = 0;
  // never into the ground: a tap on the floor lifts the panel until its lowest corner sits at z = 0
  const low = Math.min(...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => m[2] + u[2] * a * width / 2 + v[2] * b * height / 2));
  if (low < 0) m[2] -= low;
  const o = sub(sub(m, mul(u, width / 2)), mul(v, height / 2));
  return { o: [Math.round(o[0]), Math.round(o[1]), Math.round(o[2])].map(x => (Object.is(x, -0) ? 0 : x)), u: u.map(r4), v: v.map(r4), n: n.map(r4), center: m };
}
export const matrixCenter = (f, width, height) => add(add(f.o, mul(f.u, width / 2)), mul(f.v, height / 2));
// The four corners (lower-left, lower-right, upper-right, upper-left) of a frame of that size.
export function matrixCorners(f, width, height) {
  const o = f.o, U = mul(f.u, width), V = mul(f.v, height);
  return [o, add(o, U), add(add(o, U), V), add(o, V)];
}
// LEDs of a panel when its shape is unknown: a serpentine grid filling the rectangle (preview only).
export function gridPoints(f, width, height, n) {
  const cols = Math.max(1, Math.round(Math.sqrt(n * width / Math.max(1, height)))), rows = Math.max(1, Math.ceil(n / cols));
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c0 = i % cols, c = r % 2 ? cols - 1 - c0 : c0;
    const fu = cols > 1 ? c / (cols - 1) : 0.5, fv = rows > 1 ? r / (rows - 1) : 0.5;
    out.push(add(add(f.o, mul(f.u, fu * width)), mul(f.v, fv * height)));
  }
  return out;
}

// ---- the camera ----------------------------------------------------------------------------------------------
// Distance from `target` along the unit direction `dir` (target -> camera) that fits every corner into a perspective
// view of vertical field fovY (radians) and aspect w/h, using only the fraction `fill` of each axis.
// fill: one fraction, or [across, up] when part of the view is covered (the buttons, the dock).
export function fitDistance(corners, target, dir, fovY, aspect, fill = 0.9, up = [0, 1, 0]) {
  const [fx, fy] = Array.isArray(fill) ? fill : [fill, fill];
  const f = mul(norm(dir), -1);
  let r = norm(cross(f, up));
  if (len(r) === 0) r = [1, 0, 0];
  const u = cross(r, f);
  const tv = Math.tan(fovY / 2) * fy, th = Math.tan(fovY / 2) * aspect * fx;
  let D = 0;
  for (const c of corners) {
    const d = sub(c, target);
    const x = Math.abs(dot(d, r)), y = Math.abs(dot(d, u)), z = dot(d, norm(dir));
    D = Math.max(D, z + x / th, z + y / tv);
  }
  return D;
}
// The camera for a view direction that fits these points (model meters) with the given fill: the target is moved
// so the points' picture is centered, not just their box. -> { target, distance }
export function fitView(points, dir, fovY, aspect, fill = 0.9) {
  const d0 = norm(dir), f = mul(d0, -1);
  let r = norm(cross(f, [0, 1, 0])); if (len(r) === 0) r = [1, 0, 0];
  const u = cross(r, f);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); }
  let c = mul(add(lo, hi), 0.5), D = 1;
  for (let it = 0; it < 4; it++) {
    D = fitDistance(points, c, d0, fovY, aspect, fill);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of points) {
      const q = sub(p, c), depth = D - dot(q, d0);
      const sx = dot(q, r) / depth, sy = dot(q, u) / depth;
      x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy);
    }
    c = add(c, add(mul(r, (x0 + x1) / 2 * D), mul(u, (y0 + y1) / 2 * D)));
  }
  return { target: c, distance: fitDistance(points, c, d0, fovY, aspect, fill) };
}
export const boxCorners = (lo, hi) => [0, 1, 2, 3, 4, 5, 6, 7].map(i => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]]);

// ---- labels ---------------------------------------------------------------------------------------------------
// rects in priority order ({ x, y, w, h }, x/y the top-left) -> visible flags: a label that overlaps one already shown hides.
export function labelsShown(rects, pad = 2) {
  const shown = [], vis = [];
  for (const r of rects) {
    const hit = !r || shown.some(s => r.x < s.x + s.w + pad && s.x < r.x + r.w + pad && r.y < s.y + s.h + pad && s.y < r.y + r.h + pad);
    vis.push(!hit);
    if (!hit) shown.push(r);
  }
  return vis;
}

// ---- tap or drag ------------------------------------------------------------------------------------------------
export const isTap = (dx, dy, ms) => Math.hypot(dx, dy) < 6 && ms < 400;
