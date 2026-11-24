// The phone's back button (Android back, back gesture, browser back) steps back inside the app: sheet, System page, tab, then home.
// Chrome's "history manipulation intervention": an entry added by script without a user gesture makes the entry before it
// skippable by the back button, and each script-added entry needs its own gesture. So: never push from inside popstate,
// push at most ONE entry per user gesture, and never assume one back press moved one entry. The stack is kept as deep as the
// app is ("logical depth", plus one exit guard entry); one popstate is one logical step back, however far the browser went.
// No imports from main.js (it injects everything); no DOM access at module top level.
export const KEY = "rcrBack";
const depthOf = st => (st && st[KEY]) | 0;
// What the browser counts as a user gesture. Not touchend: it also ends a scroll, which is no gesture to Chrome (a touch
// that scrolls ends in pointercancel, so pointerup is safe).
const GESTURES = ["pointerup", "mousedown", "keydown", "click"];

// inApp() -> boolean, layers() -> how many steps back the app has, stepBack() -> true when it stepped back (false at home),
// onHome() -> a back press found nothing to step back from.
// trustAll: count events made by script as gestures too (the tests under jsdom, where every event is made by script).
export function initBack({ inApp, layers, stepBack, onHome, win = window, trustAll = false } = {}) {
  let depth = 0, armed = false, hold = false, pend = null, timer = 0, dead = false, inPop = false;
  try { depth = depthOf(win.history.state); } catch (e) { depth = 0; }
  const want = () => (inApp() ? layers() + (hold ? 0 : 1) : 0);   // the +1 is the exit guard entry
  function sync() {
    if (dead || pend || !win.history) return;
    // Where the history really is (the entry's own number): the counter can never drift from it, whatever went wrong before.
    try { depth = depthOf(win.history.state); } catch (e) { return; }
    const w = want();
    try {
      if (w < depth) {
        pend = { to: w };
        win.history.go(w - depth);
        // the traversal may never report (page hidden, entries gone): look at where we really are
        timer = win.setTimeout(() => { timer = 0; if (!pend) return; pend = null; try { depth = depthOf(win.history.state); } catch (e) { /* none */ } sync(); }, 700);
      } else if (w > depth && armed) {
        armed = false;
        win.history.pushState({ [KEY]: depth + 1 }, "");
        depth += 1;   // only once the entry exists
      }
    } catch (e) { pend = null; }
  }
  // Only a real gesture may arm a push. A click() made by script is none (isTrusted false), and neither is anything that
  // happens while a back press is being handled: stepBack clicks the sheet's back arrow, and a push from there would be the
  // push from inside popstate that makes Chrome skip the app's entries on the next press.
  const gesture = ev => {
    if (inPop || (!trustAll && ev && ev.isTrusted === false) || (ev && ev.type === "keydown" && ev.key === "Escape")) return;
    armed = true; hold = false;
  };
  const clicked = () => { if (!inPop) sync(); };   // bubble phase: the app's own click handlers have run
  const popped = ev => {
    if (dead) return;
    const to = depthOf(ev && ev.state);
    if (pend && to === pend.to) { if (timer) win.clearTimeout(timer); timer = 0; pend = null; depth = to; sync(); return; }
    if (pend && timer) win.clearTimeout(timer);
    timer = 0; pend = null;
    const from = depth; depth = to;
    if (to > from || !inApp()) { sync(); return; }   // forward button: nothing is reopened, sync unwinds the surplus
    let stepped = false;
    inPop = true;
    try { stepped = !!stepBack(); } catch (e) { console.error(e); } finally { inPop = false; }
    if (stepped) { sync(); return; }
    hold = true;
    try { onHome(); } catch (e) { console.error(e); }
    sync();   // unwinds whatever entries are left to 0; the next back press then leaves natively
  };
  if (win.addEventListener) {
    GESTURES.forEach(t => win.addEventListener(t, gesture, true));
    win.addEventListener("click", clicked, false);
    win.addEventListener("popstate", popped);
  }
  return {
    sync,
    destroy() {
      dead = true;
      if (timer) win.clearTimeout(timer); timer = 0; pend = null;
      if (win.removeEventListener) {
        GESTURES.forEach(t => win.removeEventListener(t, gesture, true));
        win.removeEventListener("click", clicked, false);
        win.removeEventListener("popstate", popped);
      }
    },
    state: () => ({ depth, armed, hold, pending: !!pend }),
  };
}
