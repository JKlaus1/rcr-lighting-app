// A panel bent round something (0.6.0, spec 5.2): the pure geometry. A matrix is drawn flat (matrix.js design); this
// puts its LEDs where they really are when the panel is wrapped, for example round the rear rack on a printed bracket.
//
// The curve is a profile across the panel's width: a list of pieces like the strip shape builder's (barshape.js):
//   { t: "s", len }                    straight
//   { t: "b", r, deg, dir }            bend: radius, angle (0 to 360), dir 1 curls one way and -1 the other
// A LED at distance s across the panel (its x in the design, from the panel's left edge) sits at the profile's point s;
// its height is unchanged. The panel's middle stays where the flat panel's middle is, tangent to the flat panel there.
// The profile is centered on the panel: the middle of the profile is under the middle of the panel.
//
//   bend = null                                       flat
//   bend = { kind: "wrap", side, radius, rear, bulge }   side leg, 90 degree corner, flat rear, corner, side leg
//   bend = { kind: "custom", pieces, bulge }
//   bulge: "toward" the side the LEDs face (the middle is nearest to whoever looks at the panel), or "away"
//
// All sizes mm. Nothing here touches the DOM or the store.
import { trace, at as pathAt, validPiece } from "./barshape.js";

const RAD = Math.PI / 180;
const r2 = v => Math.round(v * 100) / 100;
export const MAX_BEND_PIECES = 8;
export const WRAP_DEFAULTS = { radius: 37.7, rear: 51 };   // the rear rack's bracket
const TOL = 0.05;                                          // mm a curve may fall short of the panel before it is refused
const num = v => typeof v === "number" && Number.isFinite(v);

// ---- the pieces ------------------------------------------------------------------------------------------------------
// What is left of a panel's width for the two side legs once the two quarter circles and the rear are taken out.
export const wrapSide = (width, radius, rear) => Math.max(0, r2((width - rear - Math.PI * radius) / 2));
export const wrapPieces = ({ side, radius, rear }) => [
  { t: "s", len: side }, { t: "b", r: radius, deg: 90, dir: 1 }, { t: "s", len: rear }, { t: "b", r: radius, deg: 90, dir: 1 }, { t: "s", len: side }];
// A wrap with the rack's own sizes for a panel `width` wide.
export const defaultWrap = (width, bulge = "toward") => ({ kind: "wrap", radius: WRAP_DEFAULTS.radius, rear: WRAP_DEFAULTS.rear, side: wrapSide(width, WRAP_DEFAULTS.radius, WRAP_DEFAULTS.rear), bulge });
export const piecesOf = bend => (!bend ? [] : bend.kind === "wrap" ? wrapPieces(bend) : bend.pieces || []);
export const lengthOf = bend => trace(piecesOf(bend)).length;
// A custom bend with the same shape as the current one (Flat starts from a wrap), so Custom is edited from something.
export const toCustom = (bend, width) => {
  const b = bend || defaultWrap(width);
  return { kind: "custom", pieces: piecesOf(b).map(p => ({ ...p })), bulge: b.bulge || "toward" };
};
export function validBend(b) {
  if (b === null || b === undefined) return true;
  if (!b || typeof b !== "object" || (b.bulge !== "toward" && b.bulge !== "away")) return false;
  if (b.kind === "wrap") return num(b.side) && b.side >= 0 && b.side <= 6000 && num(b.radius) && b.radius >= 2 && b.radius <= 6000 && num(b.rear) && b.rear > 0 && b.rear <= 6000;
  if (b.kind === "custom") return Array.isArray(b.pieces) && b.pieces.length >= 1 && b.pieces.length <= MAX_BEND_PIECES && b.pieces.every(validPiece);
  return false;
}

// ---- what the design allows --------------------------------------------------------------------------------------------
// v1: every strip runs straight up or down one column, so a bend across the panel carries each strip as a whole.
// -> "" or why the panel stays flat
export function checkDesign(design) {
  const eps = 0.3, list = (design && design.strips) || [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (Math.abs(s.x1 - s.x0) > eps) return `Strip ${i + 1} does not run straight up and down. The curve needs every strip to run up and down one column, so the panel stays flat.`;
  }
  return "";
}
// The panel's width: the box the strips fill (as matrix.js designSize): half a strip width, or half an LED pitch for a strip that
// runs across, past the outermost LEDs.
export function widthOf(design) {
  let x0 = Infinity, x1 = -Infinity;
  const pitch = 1000 / (design.den || 60), w = (design.width || 10) / 2, h = pitch / 2;
  for (const s of design.strips || []) {
    const horiz = Math.abs(s.x1 - s.x0) >= Math.abs(s.y1 - s.y0), ax = horiz ? h : w;
    x0 = Math.min(x0, s.x0 - ax, s.x1 - ax); x1 = Math.max(x1, s.x0 + ax, s.x1 + ax);
  }
  return Number.isFinite(x0) ? r2(x1 - x0) : 0;
}
// -> "" or why this bend cannot carry the panel: the panel is `width` wide
export function fitBend(bend, width) {
  if (!bend) return "";
  if (!validBend(bend)) return "That curve has a size that cannot be drawn.";
  const len = lengthOf(bend);
  if (len < width - TOL) return `The curve is ${r2(width - len)} mm shorter than the panel is wide: the LEDs at its ends would have nowhere to go.`;
  return "";
}

// ---- the profile -----------------------------------------------------------------------------------------------------------
// -> f(x): where the point at distance x across the panel (x from its left edge, `width` wide) sits:
//    { x, w, nu, nw }  x: across, w: out toward whoever looks at the LEDs (0 at the middle), (nu, nw): the unit normal toward the LED side.
// A flat panel (bend null) is x, 0, (0, 1).
export function profile(bend, width) {
  if (!bend) return x => ({ x, w: 0, nu: 0, nw: 1 });
  const path = trace(piecesOf(bend)), mid = path.length / 2, M = pathAt(path, mid), ch = Math.cos(M.h), sh = Math.sin(M.h);
  const flip = bend.bulge === "away" ? 1 : -1;   // the pieces as traced put the middle farthest from the viewer; "toward" turns that over
  return x => {
    const s = Math.max(0, Math.min(path.length, mid + (x - width / 2)));
    const p = pathAt(path, s), dx = p.x - M.x, dy = p.y - M.y;
    const u = dx * ch + dy * sh, w = (-dx * sh + dy * ch) * flip, h = (p.h - M.h) * flip;
    return { x: width / 2 + u, w, nu: -Math.sin(h), nw: Math.cos(h) };
  };
}

// ---- cells ---------------------------------------------------------------------------------------------------------------
// Each LED's column (from the leftmost LED column) and row (from the top row), in LED pitches, rounded.
export function cellFn(design) {
  const pitch = 1000 / (design.den || 60);
  let x0 = Infinity, y1 = -Infinity;
  for (const s of design.strips || []) { x0 = Math.min(x0, s.x0, s.x1); y1 = Math.max(y1, s.y0, s.y1); }
  return (x, y) => ({ c: Math.max(0, Math.min(254, Math.round((x - x0) / pitch))), r: Math.max(0, Math.min(254, Math.round((y1 - y) / pitch))) });
}
// The grid of the panel: columns x rows, and which cells hold an LED (a strip's LEDs fall on the cells between its ends).
export function gridOf(design) {
  const cell = cellFn(design), cells = new Map();
  let cols = 0, rows = 0;
  for (const s of design.strips || []) {
    const a = cell(s.x0, s.y0), b = cell(s.x1, s.y1), n = Math.max(1, s.n | 0);
    for (let i = 0; i < n; i++) {
      const t = n > 1 ? i / (n - 1) : 0, c = Math.round(a.c + (b.c - a.c) * t), r = Math.round(a.r + (b.r - a.r) * t);
      cells.set(c + "," + r, (cells.get(c + "," + r) || 0) + 1);
      cols = Math.max(cols, c + 1); rows = Math.max(rows, r + 1);
    }
  }
  return { cols, rows, has: (c, r) => cells.has(c + "," + r), count: cells.size };
}

// ---- the points ------------------------------------------------------------------------------------------------------------
// frame = { o, u, v } as matrix.js designPoints. Two path points per strip (its first and last LED), as designPoints,
// with the profile applied and, with opts.cells, the cell of each point. -> [{ px, x, y, z, c?, r? }]
// The back face of the plate sits `thick` behind the front face along the profile's own normal.
export function points(design, frame, bend, { cells = false, width } = {}) {
  const { o, u, v } = frame;
  let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
  const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
  const f = profile(bend, width != null ? width : widthOf(design)), cell = cellFn(design), pts = [];
  let first = 0;
  for (const s of design.strips || []) {
    const back = s.face === "back" ? (design.thick || 0) : 0;
    const at = (px, x, y) => {
      const q = f(x), a = q.x - back * q.nu, b = q.w - back * q.nw;   // a across, b out toward the viewer
      const p = { px, x: Math.round(o[0] + u[0] * a + v[0] * y + nx * b), y: Math.round(o[1] + u[1] * a + v[1] * y + ny * b), z: Math.round(o[2] + u[2] * a + v[2] * y + nz * b) };
      if (cells) Object.assign(p, cell(x, y));
      pts.push(p);
    };
    at(first, s.x0, s.y0);
    if (s.n > 1) at(first + s.n - 1, s.x1, s.y1);
    first += s.n;
  }
  return pts;
}

// ---- the top view ---------------------------------------------------------------------------------------------------------
// The profile and the LED columns seen from above, in the profile's own axes (across, out toward the viewer; mm), for drawing.
// -> { line: [[x, w]...], dots: [[x, w]...] (one per column), box }
export function topView(design, bend, width) {
  const f = profile(bend, width), line = [], xs = [...new Set((design.strips || []).map(s => r2(s.x0)))].sort((a, b) => a - b);
  const steps = Math.max(24, Math.min(200, Math.round(width / 2)));
  for (let i = 0; i <= steps; i++) { const q = f(width * i / steps); line.push([q.x, q.w]); }
  const dots = xs.map(x => { const q = f(x); return [q.x, q.w]; });
  const all = line.concat(dots);
  const box = { x0: Math.min(...all.map(p => p[0])), x1: Math.max(...all.map(p => p[0])), w0: Math.min(...all.map(p => p[1])), w1: Math.max(...all.map(p => p[1])) };
  return { line, dots, box };
}
