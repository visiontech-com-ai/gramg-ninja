/* Welcome page: fill in the version and wire the close button.
   (Inline scripts are blocked by the MV3 CSP, so this lives in its own file.) */
(function () {
  "use strict";
  try {
    var v = document.getElementById("verSpan");
    if (v && chrome.runtime && chrome.runtime.getManifest) v.textContent = chrome.runtime.getManifest().version;
  } catch (e) {}
  var close = document.getElementById("closeBtn");
  if (close) close.addEventListener("click", function () {
    try { chrome.tabs.getCurrent(function (t) { if (t && t.id != null) chrome.tabs.remove(t.id); else window.close(); }); }
    catch (e) { window.close(); }
  });
})();
