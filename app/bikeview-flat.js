// The bike view's flat renderer: the side picture on a 2D canvas, LEDs at their (x, z) projection.
// Used where WebGL is missing, the model did not load or the context was lost. Same questions answered as the
// 3D renderer (project, pick), no orbit. Where the canvas has no 2D context (tests) it draws nothing.
import { FLAT, flatToImg, imgToFlat, letterbox } from "./bikeview-math.js";

const IMG_URL = () => new URL("../bikes/onyx-rcr-side.jpg", import.meta.url).href;
// Tests hand the canvas a recording fake: setContextFactory(canvas => fakeCtx).
let factory = null;
export function setContextFactory(fn) { factory = fn; }
export function contextOf(c) {
  if (factory) return factory(c);
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "")) return null;   // jsdom logs "not implemented"
  try { return c.getContext("2d"); } catch (e) { return null; }
}

// V: the shared dots data. hooks: { changed() }. -> renderer (synchronous)
export function createFlat(host, V, hooks) {
  const canvas = document.createElement("canvas");
  canvas.className = "bv-flat";
  const ctx = contextOf(canvas);
  let W = 390, H = 300, dpr = 1, insets = { top: 0, bottom: 0 }, lb = { s: 1, ox: 0, oy: 0 };
  let img = null, shaded = null;
  if (typeof Image !== "undefined" && ctx) {
    const im = new Image();
    im.onload = () => { img = im; shaded = null; hooks.changed(); };
    im.src = IMG_URL();
  }
  const N = V.N;
  const order = [];   // far side first
  let orderDirty = true;

  function layout() {
    lb = letterbox(FLAT.w, FLAT.h, { x: 8, y: insets.top + 4, w: W - 16, h: Math.max(40, H - insets.top - insets.bottom - 8) });
    shaded = null;
  }
  // The picture darkened once per size, so the LEDs carry the view.
  function shadedImage() {
    if (shaded || !img) return shaded;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(FLAT.w * lb.s * dpr)); c.height = Math.max(1, Math.round(FLAT.h * lb.s * dpr));
    const g = c.getContext("2d");
    if (!g) return null;
    g.filter = "grayscale(0.4) brightness(0.3) contrast(1.2)";
    g.drawImage(img, 0, 0, c.width, c.height);
    shaded = c;
    return shaded;
  }
  const toScreen = (x, z) => { const [ix, iy] = flatToImg(x, z); return [lb.ox + ix * lb.s, lb.oy + iy * lb.s]; };
  const mmPx = () => lb.s / FLAT.mmPerPx;   // screen px per mm

  const me = {
    kind: "flat", el: canvas, sideY: 0,
    resize(w, h, ins) {
      W = Math.max(1, w); H = Math.max(1, h); if (ins) insets = ins;
      dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      layout();
    },
    setInsets(ins) { insets = ins; layout(); },
    posChanged() { orderDirty = true; },
    colChanged() {},
    render() {
      if (!ctx) return false;
      if (orderDirty) {
        order.length = 0;
        for (let i = 0; i < N; i++) if (V.size[i] > 0) order.push(i);
        order.sort((a, b) => V.pos[a * 3 + 1] - V.pos[b * 3 + 1]);   // y < 0 (the far side) first
        orderDirty = false;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, W, H);
      const im = shadedImage();
      if (im) ctx.drawImage(im, lb.ox, lb.oy, FLAT.w * lb.s, FLAT.h * lb.s);
      ctx.globalCompositeOperation = "lighter";
      const k = mmPx();
      for (const i of order) {
        const [x, y] = toScreen(V.pos[i * 3], V.pos[i * 3 + 2]);
        const r = Math.max(1.1, V.size[i] * k / 2);
        const far = V.pos[i * 3 + 1] < 0 ? 0.62 : 1;
        const R = V.col[i * 3], G = V.col[i * 3 + 1], B = V.col[i * 3 + 2];
        if (R < 2 && G < 2 && B < 2) {
          ctx.fillStyle = `rgba(52,58,66,${far})`;
          ctx.beginPath(); ctx.arc(x, y, r * 0.75, 0, 7); ctx.fill();
          continue;
        }
        ctx.fillStyle = `rgba(${R},${G},${B},${0.28 * far})`;
        ctx.beginPath(); ctx.arc(x, y, r * 2.4, 0, 7); ctx.fill();
        ctx.fillStyle = `rgba(${R},${G},${B},${far})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      return false;
    },
    projectAll(out) {
      for (let i = 0; i < N; i++) {
        if (!(V.size[i] > 0)) { out[i * 2] = out[i * 2 + 1] = NaN; continue; }
        const s = toScreen(V.pos[i * 3], V.pos[i * 3 + 2]);
        out[i * 2] = s[0]; out[i * 2 + 1] = s[1];
      }
      return out;
    },
    project(p) { return toScreen(p[0], p[2]); },
    // A tap on the picture: x and z from the picture, y from the side chip (or the plane's point when dragging).
    pick(sx, sy, { plane, y } = {}) {
      const [ix, iy] = [(sx - lb.ox) / lb.s, (sy - lb.oy) / lb.s];
      const [x, z] = imgToFlat(ix, iy);
      const yy = y != null ? y : plane && plane.p ? plane.p[1] : me.sideY;
      return { p: [x, yy, z], n: null, surf: false };
    },
    camDir() { return [0, -1, 0]; },   // looking at the bike's right side
    view() {}, ensureVisible() {}, setOrbit() {},
    // half the model's width: the Left side / Right side chips put a light there
    halfWidth: 390,
    destroy() { canvas.remove(); },
  };
  return me;
}
