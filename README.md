# RCR Lighting — control app

The Web Bluetooth app for the RCR e-bike lighting controller, published at
**https://jklaus1.github.io/rcr-lighting-app/**. Open it in Chrome on Android (or desktop Chrome), tap *Connect* and pick
the controller; *Try the demo* (or `?demo=1`) runs a simulated controller with no hardware. Add it to the home screen for a
full-screen app that also opens offline.

It needs controller firmware **0.5.0** or newer. A controller still on 0.4.9 gets the firmware update (System › Controller)
and a link to the previous app, kept here as `v049.html`.

The source of truth is `web/` in the firmware repository (JKlaus1/RCR-80v-Lighting, branch `firmware/v0.5`); this repo is a
publish copy for GitHub Pages. To update: bump `CACHE` in `web/sw.js` there, run `bash tools/publish-app.sh`, commit and push here.
