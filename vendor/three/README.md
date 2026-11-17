# three.js, vendored

`three.bundle.js` is three.js **0.187.0** (r187) with `GLTFLoader` and `OrbitControls`, bundled into one minified ES module
(815264 bytes, about 207 KB gzipped). Everything `three` exports is exported, plus `GLTFLoader` and `OrbitControls`:

```js
import * as THREE from "../vendor/three/three.bundle.js";      // from web/app/*.js
const { GLTFLoader, OrbitControls } = THREE;
```

Made with `bash tools/vendor-three.sh` (npm `three` + `esbuild --bundle --format=esm --minify`). Do not edit it by hand; rerun the script to change the version.
License: MIT, see `LICENSE` (the three.js authors).
