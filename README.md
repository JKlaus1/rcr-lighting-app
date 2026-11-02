# Phone control page

`index.html` is the whole app: one static page, no build step, that talks to the controller over Web Bluetooth.
Use it in Chrome on Android (desktop Chrome on Windows, macOS or ChromeOS works too).

- **Live:** the bike's telltales in the top band (turn arrows flash in step with the controller), every output with
  its current against the channel rating and its health (on, lamp out, fault, retrying), and the eight harness inputs.
- **Lights:** hazards, pods, underglow (effect, colour, brightness, speed), turn-signal rate, style and rear colour,
  brake / tail / marker levels.
- **Strips:** LED count, colour order and current cap per output, and the segment list (start, length, job,
  reverse) with a live preview bar.
- **Setup:** headlight table and presets, lamp-out thresholds, button mapping, current calibration against a clamp
  meter, Bluetooth name, update password, save / update / restart / reset.
- **Console:** the same text commands as the USB console.

**Try the demo** runs a simulated controller inside the page with the firmware's defaults and logic; tap the bike
inputs on the Live tab to work the switches.

## Opening it on the phone

Web Bluetooth only runs on a page Chrome treats as secure: `https://`, or `http://localhost`. Any of these work:

- **Host it over https.** Any static host will do. GitHub Pages needs the repo public (or a paid plan for a private
  one); a small public repo holding just this file is enough.
- **Serve it from the phone itself.** In Termux: `pkg install python`, copy `index.html` over, `python -m http.server
  8080`, then open `http://localhost:8080` in Chrome.
- **Serve it from the PC over USB.** `python -m http.server 8080` in this folder, `adb reverse tcp:8080 tcp:8080`,
  then `http://localhost:8080` on the phone.

## Pairing

The controller accepts new phones only for 2 minutes after power-up (or after `pair` on the USB console). Power it,
tap Connect, pick "RCR Lighting", and accept Android's pairing prompt. After that the phone reconnects any time.

## Protocol

Service `b6f1e2a0-3c4d-4e5f-8a9b-52434c000000`; CMD `…01` (write a command line), OUT `…02` (notify, replies),
LIVE `…03` (notify, status JSON every 250 ms). Replies and status are newline-terminated text split to the MTU.
The page sends `get` for the settings, `set {json}` patches (each write ≤ 512 bytes, so strips go one at a time),
and plain commands (`hazard on`, `preset lp6`, `cal low 4.1` …). Details in `../firmware/README.md`.

## Test

`npm install jsdom@24 && node web/test/demo.test.js web/index.html` drives the page through the demo: connect,
switch inputs, presets, sliders, a strip edit, alerts, restart confirmation.
