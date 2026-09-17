/* GramG Ninja — password revealer for the VB-G RAM G portal.
   Unmasks <input type="password"> fields on *.dord.gov.in so the operator can read
   what they type (the portal has no "show password" control). This is a LOCAL,
   visual-only change: it flips the input's type attribute. It NEVER reads, stores,
   logs or transmits the password value anywhere. Toggle it in the settings popup;
   default ON. Submission is unaffected — a type="text" input posts the same value. */
(function () {
  "use strict";
  var ATTR = "data-gn-pw";     // marks fields we unmasked, so we can restore them
  var enabled = true;

  function reveal(root) {
    try {
      var q = (root || document).querySelectorAll('input[type="password"]');
      for (var i = 0; i < q.length; i++) {
        var el = q[i];
        el.setAttribute(ATTR, "1");
        try { el.type = "text"; } catch (e) {}
      }
    } catch (e) {}
  }
  function restore() {
    try {
      var q = document.querySelectorAll('input[' + ATTR + '="1"]');
      for (var i = 0; i < q.length; i++) {
        var el = q[i];
        try { el.type = "password"; } catch (e) {}
        el.removeAttribute(ATTR);
      }
    } catch (e) {}
  }
  function apply() { if (enabled) reveal(document); else restore(); }

  // ASP.NET postbacks re-render the DOM, so keep watching for new password fields.
  var obs = null;
  function watch() {
    if (obs) return;
    try {
      obs = new MutationObserver(function (muts) {
        if (!enabled) return;
        for (var i = 0; i < muts.length; i++) {
          var a = muts[i].addedNodes; if (!a) continue;
          for (var j = 0; j < a.length; j++) {
            var n = a[j]; if (!n || n.nodeType !== 1) continue;
            reveal(n);
          }
        }
      });
      obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
    } catch (e) {}
  }

  function init(on) { enabled = on !== false; apply(); watch(); }

  try { chrome.storage.local.get("vbgRevealPw", function (r) { init(!(r && r.vbgRevealPw === false)); }); }
  catch (e) { init(true); }

  // live toggle from the settings popup
  try {
    chrome.storage.onChanged.addListener(function (ch, area) {
      if (area === "local" && ch.vbgRevealPw) { enabled = ch.vbgRevealPw.newValue !== false; apply(); }
    });
  } catch (e) {}
})();
