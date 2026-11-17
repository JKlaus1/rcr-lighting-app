// The bike view's 3D renderer: the model in a dark studio and every LED as one THREE.Points draw call.
// three.js is imported inside create3d() only, so this module loads in tests and in browsers without WebGL.
// The shared parts (dots data, overlay, labels, handles, tools) live in bikeview.js; this file only draws and
// answers geometry questions (project, pick, camera).
import { bikeToModel, modelToBike, dirToBike, fitDistance, fitView, boxCorners, norm } from "./bikeview-math.js";

export const VIEWS = {
  "3d": [-0.52, 0.3, -0.8],     // three-quarter from the front right (model axes: X back, Y up, Z = bike left)
  side: [0, 0.05, -1],
  front: [-1, 0.1, 0],
  rear: [1, 0.1, 0],
  top: [0, 1, -0.02],
};
const FOV = 26;   // a long lens: little perspective, so the far wheel is not dwarfed by the near one
const MODEL_URL = () => new URL("../bikes/onyx-rcr.glb", import.meta.url).href;

// V: the shared dots data ({ N, pos (bike mm, NaN = none), col (u8 display rgb), size (mm, 0 = not drawn) })
// host: the element the canvas goes into. hooks: { changed() (camera moved: re-render), lost() (context gone) }
// -> a renderer, once the model has loaded; throws when WebGL or the model is not available.
export async function create3d(host, V, hooks) {
  const THREE = await import("../vendor/three/three.bundle.js");
  const canvas = document.createElement("canvas");
  canvas.className = "bv-gl";
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
  } catch (e) { throw new Error("no WebGL: " + e.message); }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const v3Tmp = new THREE.Vector3();
  const gltf = await new Promise((res, rej) => new THREE.GLTFLoader().load(MODEL_URL(), res, undefined, rej))
    .catch(e => { renderer.dispose(); throw new Error("model: " + (e && e.message || e)); });

  const scene = new THREE.Scene();
  const model = gltf.scene;
  const meshes = [];
  // Dark, low and neutral: the LEDs carry the picture. No environment map, so metals are kept mostly dielectric
  // (a metal with nothing to reflect renders black and loses its shape).
  model.traverse(o => {
    if (!o.isMesh) return;
    meshes.push(o);
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const dark = mats.map(m0 => {
      const m = m0.clone();
      if (m.color) m.color.multiplyScalar(0.34);
      if ("metalness" in m) m.metalness = Math.min(m.metalness, 0.25);
      if ("roughness" in m) m.roughness = Math.max(m.roughness, 0.45);
      if (m.emissive) m.emissive.setRGB(0, 0, 0);
      return m;
    });
    o.material = Array.isArray(o.material) ? dark : dark[0];
  });
  scene.add(model);
  scene.add(new THREE.HemisphereLight(0xc4ccd8, 0x1a1e24, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(-2, 3, -2.5); scene.add(key);
  const fill = new THREE.DirectionalLight(0xdfe6f0, 0.55); fill.position.set(2.5, 1.5, 2.5); scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.7); rim.position.set(3, 2.5, -0.5); scene.add(rim);

  const mbox = new THREE.Box3().setFromObject(model);
  // a few thousand of the model's own vertices: the default view fits the bike itself, not its box
  const samples = [];
  model.updateMatrixWorld(true);
  let total = 0; meshes.forEach(o => { total += o.geometry.attributes.position.count; });
  const stride = Math.max(1, Math.ceil(total / 3000));
  for (const o of meshes) {
    const a = o.geometry.attributes.position;
    for (let i = 0; i < a.count; i += stride) { v3Tmp.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld); samples.push(v3Tmp.toArray()); }
  }
  if (mbox.isEmpty()) mbox.set(new THREE.Vector3(-0.3, 0, -0.4), new THREE.Vector3(1.45, 1.05, 0.4));
  const mcenter = mbox.getCenter(new THREE.Vector3()), msize = mbox.getSize(new THREE.Vector3());

  // the ground: a soft disc with a faint grid, fading out at its edge
  const R = Math.max(msize.x, msize.z) * 0.78;
  const ground = new THREE.Mesh(new THREE.CircleGeometry(R, 64), new THREE.ShaderMaterial({
    transparent: true, depthWrite: false,
    uniforms: { R: { value: R } },
    vertexShader: "varying vec2 p; void main(){ p = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
    fragmentShader: `uniform float R; varying vec2 p;
      void main(){
        float r = length(p) / R;
        float disc = (1.0 - smoothstep(0.35, 1.0, r)) * 0.55;
        vec2 g = abs(fract(p / 0.1 - 0.5) - 0.5) / fwidth(p / 0.1);
        float line = (1.0 - min(min(g.x, g.y), 1.0)) * (1.0 - smoothstep(0.2, 0.9, r)) * 0.22;
        gl_FragColor = vec4(vec3(0.62, 0.68, 0.76), disc * 0.32 + line);
      }`,
  }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(mcenter.x, mbox.min.y - 0.002, mcenter.z);
  ground.renderOrder = -1;
  scene.add(ground);

  // ---- the LEDs: one Points object, buffers shared with V and updated in place ---------------------------
  const N = V.N;
  const gpos = new Float32Array(N * 3);
  const geo = new THREE.BufferGeometry();
  const aPos = new THREE.BufferAttribute(gpos, 3).setUsage(THREE.DynamicDrawUsage);
  const aCol = new THREE.BufferAttribute(V.col, 3, true).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.BufferAttribute(V.size, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute("position", aPos); geo.setAttribute("rgb", aCol); geo.setAttribute("size", aSize);
  const uni = { scale: { value: 1 }, minPx: { value: 2 } };
  const dots = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false,
    // light adds up; alpha = the brightest channel so the dots stay correct over the transparent (CSS backdrop) canvas
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor, premultipliedAlpha: true,
    vertexShader: `attribute float size; attribute vec3 rgb; uniform float scale; uniform float minPx;
      varying vec3 vCol; varying float vOff;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        if (size <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
        gl_Position = projectionMatrix * mv;
        float px = max(size * 0.001 * scale / -mv.z, minPx);
        vOff = max(rgb.r, max(rgb.g, rgb.b)) < 0.008 ? 1.0 : 0.0;
        vCol = rgb;
        gl_PointSize = vOff > 0.5 ? max(px * 0.75, minPx) : min(px * 3.0, 160.0);
      }`,
    fragmentShader: `varying vec3 vCol; varying float vOff;
      void main(){
        float r = length(gl_PointCoord * 2.0 - 1.0);
        if (r > 1.0) discard;
        if (vOff > 0.5) { float a = 1.0 - smoothstep(0.55, 1.0, r); gl_FragColor = vec4(vec3(0.19, 0.21, 0.24) * a, 0.24 * a); return; }
        float core = 1.0 - smoothstep(0.24, 0.36, r);
        float halo = pow(1.0 - r, 2.2) * 0.5;
        vec3 c = vCol * (core * 0.95 + halo) + vec3(core * 0.18) * vCol;
        c = min(c, vec3(1.0));
        gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
      }`,
  }));
  dots.frustumCulled = false;
  dots.renderOrder = 2;
  scene.add(dots);

  // ---- camera and controls ----------------------------------------------------------------------------
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.03, 60);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.12;
  controls.minDistance = 0.3; controls.maxDistance = 9;
  controls.maxPolarAngle = Math.PI / 2 + 0.02;
  controls.screenSpacePanning = true;
  controls.zoomToCursor = true;
  let W = 1, H = 1, insets = { top: 0, bottom: 0 };
  let anim = null;   // { t0, ms, p0, p1, t0v, t1v }
  const lim = mbox.clone().expandByScalar(0.6);
  controls.addEventListener("change", () => hooks.changed());
  // While the user has not moved the camera, a resize keeps the current view framed.
  let curView = "3d", custom = false;
  controls.addEventListener("start", () => { custom = true; });

  const ray = new THREE.Raycaster();
  const v3 = new THREE.Vector3(), m4 = new THREE.Matrix4();

  // the bike plus every LED drawn, in model meters
  function fitPoints() {
    const pts = samples.slice();
    for (let i = 0; i < N; i += 2) {
      if (!(V.size[i] > 0)) continue;
      pts.push(bikeToModel(V.pos[i * 3], V.pos[i * 3 + 1], V.pos[i * 3 + 2]));
    }
    return pts;
  }
  // Where the camera goes for a view: the bike and its LEDs fit the free part of the stage with a small margin.
  function framing(name) {
    const dir = norm(VIEWS[name] || VIEWS["3d"]);
    const free = Math.max(0.3, (H - insets.top - insets.bottom) / H);
    const f = fitView(fitPoints(), dir, FOV * Math.PI / 180, W / H, [0.92, 0.92 * free]);
    const c = new THREE.Vector3(...f.target);
    return { target: c, pos: c.clone().add(new THREE.Vector3(...dir).multiplyScalar(f.distance)) };
  }
  function go(fr, ms = 450) {
    if (!ms) { camera.position.copy(fr.pos); controls.target.copy(fr.target); controls.update(); anim = null; hooks.changed(); return; }
    anim = { t0: performance.now(), ms, p0: camera.position.clone(), p1: fr.pos, q0: controls.target.clone(), q1: fr.target };
    hooks.changed();
  }
  function applyInsets() {
    // shift the picture so the box is centered in the part of the stage the buttons and the dock leave free
    const dy = (insets.top - insets.bottom) / 2;
    if (dy) camera.setViewOffset(W, H, 0, -dy, W, H); else camera.clearViewOffset();
    camera.aspect = W / H;
    camera.updateProjectionMatrix();
    uni.scale.value = renderer.getPixelRatio() * H / (2 * Math.tan(FOV * Math.PI / 360));
    uni.minPx.value = 2.2 * renderer.getPixelRatio();
  }

  let lostFlag = false;
  canvas.addEventListener("webglcontextlost", e => { e.preventDefault(); lostFlag = true; hooks.lost(); });

  const me = {
    kind: "3d", el: canvas, controls,
    resize(w, h, ins) {
      const first = W === 1 && H === 1;
      W = Math.max(1, w); H = Math.max(1, h); if (ins) insets = ins;
      renderer.setSize(W, H, false);
      canvas.style.width = W + "px"; canvas.style.height = H + "px";
      applyInsets();
      if (first || !custom) go(framing(curView), 0);
    },
    setInsets(ins) { insets = ins; applyInsets(); if (!custom) go(framing(curView), 0); },
    posChanged() {
      for (let i = 0; i < N; i++) {
        const m = V.size[i] > 0 ? bikeToModel(V.pos[i * 3], V.pos[i * 3 + 1], V.pos[i * 3 + 2]) : [0, 0, 0];
        gpos[i * 3] = m[0]; gpos[i * 3 + 1] = m[1]; gpos[i * 3 + 2] = m[2];
      }
      aPos.needsUpdate = true; aSize.needsUpdate = true;
    },
    colChanged() { aCol.needsUpdate = true; },
    // -> true while the camera is still moving (another frame is wanted)
    render() {
      if (lostFlag) return false;
      let moving = false;
      if (anim) {
        const t = Math.min(1, (performance.now() - anim.t0) / anim.ms), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        camera.position.lerpVectors(anim.p0, anim.p1, e); controls.target.lerpVectors(anim.q0, anim.q1, e);
        if (t >= 1) anim = null; else moving = true;
        camera.lookAt(controls.target);
      } else moving = controls.update();
      // never under the ground, never away from the bike
      controls.target.clamp(lim.min, lim.max);
      if (camera.position.y < 0.03) { camera.position.y = 0.03; camera.lookAt(controls.target); }
      renderer.render(scene, camera);
      return moving;
    },
    // screen x,y (CSS px in the canvas) of every drawn LED; NaN for the others
    projectAll(out) {
      camera.updateMatrixWorld();
      m4.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const e = m4.elements;
      for (let i = 0; i < N; i++) {
        if (!(V.size[i] > 0)) { out[i * 2] = out[i * 2 + 1] = NaN; continue; }
        const x = gpos[i * 3], y = gpos[i * 3 + 1], z = gpos[i * 3 + 2];
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 1e-6) { out[i * 2] = out[i * 2 + 1] = NaN; continue; }
        out[i * 2] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) / 2 * W;
        out[i * 2 + 1] = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) / 2 * H;
      }
      return out;
    },
    // one bike point (mm) -> [x, y] CSS px in the canvas, or null behind the camera
    project(p) {
      const m = bikeToModel(p[0], p[1], p[2]);
      v3.set(m[0], m[1], m[2]).applyMatrix4(camera.matrixWorldInverse);
      if (v3.z > -1e-4) return null;
      v3.applyMatrix4(camera.projectionMatrix);
      return [(v3.x + 1) / 2 * W, (1 - v3.y) / 2 * H];
    },
    // A point under the screen position: the model's surface (3 mm off it, along the normal) or, where the ray misses,
    // the plane { p, n } (bike mm / direction) or the bike's center plane y = 0. -> { p, n, surf } in bike mm, or null.
    pick(sx, sy, { plane, surface = true } = {}) {
      ray.setFromCamera({ x: sx / W * 2 - 1, y: 1 - sy / H * 2 }, camera);
      if (surface) {
        const hit = ray.intersectObjects(meshes, false)[0];
        if (hit) {
          const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : ray.ray.direction.clone().negate();
          if (n.dot(ray.ray.direction) > 0) n.negate();
          const q = hit.point.clone().addScaledVector(n, 0.003);
          return { p: modelToBike(q.x, q.y, q.z), n: dirToBike(n.x, n.y, n.z), surf: true };
        }
      }
      const pl = plane && plane.p ? plane : { p: [0, 0, 0], n: [0, 1, 0] };
      const pm = bikeToModel(...pl.p), nm = bikeToModel(...pl.n).map(v => v * 1000);
      const P3 = new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(...nm).normalize(), new THREE.Vector3(...pm));
      const q = ray.ray.intersectPlane(P3, new THREE.Vector3());
      if (!q) return null;
      return { p: modelToBike(q.x, q.y, q.z), n: null, surf: false };
    },
    // the direction the camera looks along, in bike axes (for planes that face the camera)
    camDir() { camera.getWorldDirection(v3); return dirToBike(v3.x, v3.y, v3.z); },
    view(name, ms = 450) { curView = VIEWS[name] ? name : "3d"; custom = false; go(framing(curView), ms); },
    // Bring these bike points into view, only if they are off-screen or tiny.
    ensureVisible(pts) {
      if (!pts.length) return;
      camera.updateMatrixWorld();
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, off = false;
      for (const p of pts) {
        const s = me.project(p);
        if (!s) { off = true; continue; }
        x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]);
      }
      if (x0 < 0 || x1 > W || y0 < insets.top || y1 > H - insets.bottom) off = true;
      const tiny = Math.max(x1 - x0, y1 - y0) < 14;
      if (!off && !tiny) return;
      const b = new THREE.Box3();
      for (const p of pts) { const m = bikeToModel(...p); b.expandByPoint(v3.set(m[0], m[1], m[2])); }
      b.expandByScalar(0.25);
      const dir = camera.position.clone().sub(controls.target).normalize().toArray();
      const c = b.getCenter(new THREE.Vector3());
      const free = Math.max(0.3, (H - insets.top - insets.bottom) / H);
      const d = fitDistance(boxCorners(b.min.toArray(), b.max.toArray()), c.toArray(), dir, FOV * Math.PI / 180, W / H, [0.8, 0.8 * free]);
      custom = true;
      go({ target: c, pos: c.clone().add(new THREE.Vector3(...dir).multiplyScalar(Math.max(d, controls.minDistance))) });
    },
    setOrbit(on) { controls.enabled = !!on; },
    camState: () => ({ pos: camera.position.toArray().map(v => +v.toFixed(3)), target: controls.target.toArray().map(v => +v.toFixed(3)), view: curView, custom }),
    destroy() {
      controls.dispose();
      geo.dispose(); dots.material.dispose(); ground.geometry.dispose(); ground.material.dispose();
      model.traverse(o => { if (o.isMesh) { o.geometry.dispose(); (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); } });
      renderer.dispose();
      canvas.remove();
    },
  };
  return me;
}
