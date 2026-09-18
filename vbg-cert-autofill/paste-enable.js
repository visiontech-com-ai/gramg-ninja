/* GramG Ninja — re-enable copy/paste on the VB-G RAM G portal.
   Some portal fields block paste (and copy / cut / right-click) via onpaste="return false",
   capture-phase listeners, etc. This restores normal clipboard use so operators can paste
   Reg Nos, dates, OTPs, etc. Purely local: it only stops the page's own blockers and clears
   the blocking inline attributes — it never reads, stores, logs or sends clipboard data.
   Runs at document_start so our capture-phase handler is registered before the page's. */
(function () {
  "use strict";
  var enabled = true;   // default ON; a settings toggle can turn it off
  var EVENTS = ["paste", "copy", "cut", "contextmenu", "drop", "dragstart",
                "selectstart", "beforecopy", "beforecut", "beforepaste"];

  // Capture-phase, registered first → runs before the page's blocker and halts it, while
  // leaving the browser's default action (the actual paste/copy) to proceed.
  function stopper(e) { if (enabled) { try { e.stopImmediatePropagation(); } catch (x) {} } }
  EVENTS.forEach(function (t) {
    try { window.addEventListener(t, stopper, true); } catch (e) {}
    try { document.addEventListener(t, stopper, true); } catch (e) {}
  });

  // Also clear inline blocker attributes on fields as they appear.
  var ATTRS = ["onpaste", "oncopy", "oncut", "oncontextmenu", "ondrop", "ondragstart", "onselectstart"];
  function clean(root) {
    if (!enabled) return;
    try {
      var els = (root || document).querySelectorAll("input,textarea,[onpaste],[oncopy],[oncut],[oncontextmenu],[onselectstart]");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        for (var j = 0; j < ATTRS.length; j++) {
          if (el.hasAttribute && el.hasAttribute(ATTRS[j])) { try { el[ATTRS[j]] = null; } catch (e) {} el.removeAttribute(ATTRS[j]); }
        }
      }
    } catch (e) {}
  }
  function sweep() { clean(document); }
  if (document.readyState !== "loading") sweep();
  document.addEventListener("DOMContentLoaded", sweep);
  try {
    var mo = new MutationObserver(function (muts) {
      if (!enabled) return;
      for (var i = 0; i < muts.length; i++) {
        var a = muts[i].addedNodes; if (!a) continue;
        for (var j = 0; j < a.length; j++) { var n = a[j]; if (n && n.nodeType === 1) clean(n); }
      }
    });
    mo.observe(document.documentElement || document, { childList: true, subtree: true });
  } catch (e) {}

  // setting (default ON) + live toggle from the settings popup
  try { chrome.storage.local.get("vbgEnablePaste", function (r) { enabled = !(r && r.vbgEnablePaste === false); if (enabled) sweep(); }); } catch (e) {}
  try { chrome.storage.onChanged.addListener(function (ch, area) { if (area === "local" && ch.vbgEnablePaste) { enabled = ch.vbgEnablePaste.newValue !== false; if (enabled) sweep(); } }); } catch (e) {}
})();
