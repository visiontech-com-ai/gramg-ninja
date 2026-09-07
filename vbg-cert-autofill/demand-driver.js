/* =====================================================================
   demand-driver.js  —  VB-G RAM G Work Demand bulk autofill (ENGINE)

   Runs in the PAGE (MAIN) world at document_start on demand_new.aspx so it
   can (a) override the blocking confirm/alert before the portal fires them,
   and (b) survive the FULL page reload that clicking "Proceed" causes and
   auto-continue the run.

   State lives in the portal-origin localStorage under "dxwd_run" and is
   shared with the UI content script (demand-autofill.js). One registration
   = one Proceed = one full reload; the next registration continues on the
   next page load.
   ===================================================================== */
(function () {
  "use strict";
  if (window.__DXWD_DRV) return;
  window.__DXWD_DRV = true;

  var LS_RUN = "dxwd_run";
  var LS_ALERT = "dxwd_lastAlert";
  var PFX = "ctl00_ContentPlaceHolder1_";
  var UPFX = "ctl00$ContentPlaceHolder1$";
  var IDS = {
    village: PFX + "DDL_Village",
    reg: PFX + "DDL_Registration",
    grid: PFX + "gvData",
    proceed: PFX + "btnProceed"
  };
  var UNAME = {
    village: UPFX + "DDL_Village",
    reg: UPFX + "DDL_Registration"
  };

  var STEP_TIMEOUT = 90000;   // wait up to 90s per async postback (govt portal is slow)
  var PROCEED_WAIT = 12000;   // if no reload within 12s after Proceed, treat as blocked
  var PACE = 500;             // small pause between async steps
  var GROUP_RETRIES = 2;      // attempts per registration before giving up
  var MAX_CONSEC_FAIL = 4;    // circuit breaker
  var NAME_THRESHOLD = 0.82;

  /* ---------------------- dialog overrides ---------------------- */
  var origAlert = window.alert, origConfirm = window.confirm, overridden = false;
  function overrideDialogs() {
    if (overridden) return; overridden = true;
    window.alert = function (m) {
      try { localStorage.setItem(LS_ALERT, JSON.stringify({ t: Date.now(), msg: String(m == null ? "" : m) })); } catch (e) {}
    };
    window.confirm = function () { return true; };
  }
  function restoreDialogs() {
    if (!overridden) return; overridden = false;
    window.alert = origAlert; window.confirm = origConfirm;
  }
  function readLastAlert() { try { return JSON.parse(localStorage.getItem(LS_ALERT) || "null"); } catch (e) { return null; } }
  function clearLastAlert() { try { localStorage.removeItem(LS_ALERT); } catch (e) {} }

  /* ---------------------- run state (localStorage) ---------------------- */
  function loadRun() { try { return JSON.parse(localStorage.getItem(LS_RUN) || "null"); } catch (e) { return null; } }
  function saveRun(r) {
    try { r.updatedAt = Date.now(); localStorage.setItem(LS_RUN, JSON.stringify(r)); } catch (e) {}
    notifyUI();
  }
  function notifyUI() { try { window.postMessage({ source: "DXWD_DRV", type: "sync" }, "*"); } catch (e) {} }
  function log(r, level, text) {
    (r.log = r.log || []).push({ t: Date.now(), level: level, text: text });
    if (r.log.length > 400) r.log = r.log.slice(-400);
  }

  /* ---------------------- small helpers ---------------------- */
  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function prmReady() { return !!(window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager && Sys.WebForms.PageRequestManager.getInstance); }
  function prm() { return Sys.WebForms.PageRequestManager.getInstance(); }

  function waitFor(cond, timeout, interval) {
    interval = interval || 150;
    return new Promise(function (res) {
      var t0 = Date.now();
      (function tick() {
        var v; try { v = cond(); } catch (e) { v = false; }
        if (v) return res(v);
        if (Date.now() - t0 > timeout) return res(false);
        setTimeout(tick, interval);
      })();
    });
  }

  function setNative(el, val) {
    if (!el) return false;
    try {
      var proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype
        : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, val);
    } catch (e) { try { el.value = val; } catch (e2) { return false; } }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Await a single async UpdatePanel postback started by triggerFn().
  function awaitAsync(triggerFn, timeoutMs) {
    return new Promise(function (resolve) {
      if (!prmReady()) { try { triggerFn(); } catch (e) {} return resolve({ error: "ajax runtime not ready" }); }
      var p = prm(), done = false, to;
      function end(sender, args) {
        if (done) return; done = true;
        try { p.remove_endRequest(end); } catch (e) {}
        clearTimeout(to);
        var err = null; try { err = args && args.get_error && args.get_error(); } catch (e) {}
        if (err) { try { args.set_errorHandled(true); } catch (e) {} return resolve({ error: err.message || String(err) }); }
        resolve({ ok: true });
      }
      try { p.add_endRequest(end); } catch (e) { return resolve({ error: "cannot hook postback" }); }
      to = setTimeout(function () {
        if (done) return; done = true;
        try { p.remove_endRequest(end); } catch (e) {}
        resolve({ timeout: true });
      }, timeoutMs);
      try { triggerFn(); } catch (e) {
        if (!done) { done = true; try { p.remove_endRequest(end); } catch (e2) {} clearTimeout(to); resolve({ error: String(e) }); }
      }
    });
  }

  /* ---------------------- name matching (self-contained) ---------------------- */
  function normName(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
  function tokenSort(s) { return s.split(" ").filter(Boolean).sort().join(" "); }
  function lev(a, b) {
    a = a || ""; b = b || ""; var m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    var prev = [], cur = [], i, j; for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }
  function sim(a, b) { if (!a && !b) return 1; var mx = Math.max(a.length, b.length); return mx ? 1 - lev(a, b) / mx : 1; }
  function nameScore(a, b) {
    var na = normName(a), nb = normName(b); if (na === nb) return 1;
    var sa = tokenSort(na), sb = tokenSort(nb); if (sa === sb) return 0.99;
    return Math.max(sim(na, nb), sim(sa, sb));
  }

  /* ---------------------- page inspection ---------------------- */
  function loggedOut() {
    // If the demand form's core controls have vanished, the session likely expired / redirected.
    return !$(IDS.village) && !$(IDS.reg) && !$(IDS.grid);
  }
  function currentVillage() { var el = $(IDS.village); return el ? String(el.value) : ""; }
  function currentReg() { var el = $(IDS.reg); return el ? String(el.value) : ""; }
  function findVillageOption(code) {
    var el = $(IDS.village); if (!el) return null;
    for (var i = 0; i < el.options.length; i++) if (String(el.options[i].value) === code) return el.options[i].value;
    return null;
  }
  function findRegOption(regNo) {
    var el = $(IDS.reg); if (!el) return null;
    for (var i = 0; i < el.options.length; i++) if (String(el.options[i].value).split(":")[0] === regNo) return el.options[i].value;
    return null;
  }
  // Collect grid data rows -> [{pfx, name}]
  function gridRows() {
    var grid = $(IDS.grid); if (!grid) return [];
    var out = [], spans = grid.querySelectorAll('span[id$="_job"]');
    for (var i = 0; i < spans.length; i++) {
      var id = spans[i].id;                    // ..._gvData_ctl02_job
      var pfx = id.replace(/_job$/, "");        // ..._gvData_ctl02
      if ($(pfx + "_dt_from")) out.push({ pfx: pfx, name: (spans[i].textContent || "").trim() });
    }
    return out;
  }
  function findWorkerRow(applicant) {
    var rows = gridRows(), best = null, bestScore = 0;
    for (var i = 0; i < rows.length; i++) {
      var s = nameScore(applicant, rows[i].name);
      if (s > bestScore) { bestScore = s; best = rows[i]; }
    }
    return (best && bestScore >= NAME_THRESHOLD) ? best : null;
  }

  /* ---------------------- actions ---------------------- */
  function selectDDL(id, uniqueName, value) {
    var el = $(id); if (!el) return Promise.resolve({ error: "control missing: " + id });
    setNative(el, value);
    return awaitAsync(function () {
      if (typeof window.__doPostBack === "function") window.__doPostBack(uniqueName, "");
    }, STEP_TIMEOUT);
  }

  // Fill one grid text field and await its async postback. Re-query the id
  // each call — the grid DOM is replaced by every UpdatePanel refresh.
  function fillField(fieldId, uniqueName, value) {
    var el = $(fieldId); if (!el) return Promise.resolve({ error: "field missing: " + fieldId });
    setNative(el, value);
    return awaitAsync(function () {
      if (typeof window.__doPostBack === "function") window.__doPostBack(uniqueName, "");
    }, STEP_TIMEOUT);
  }

  // Click Proceed (full postback). Resolves {submitted:true} when the page
  // starts unloading, or {blocked:true} if no reload happened in time
  // (client validation blocked it).
  function clickProceed() {
    return new Promise(function (resolve) {
      var done = false;
      function onUnload() { if (done) return; done = true; resolve({ submitted: true }); }
      window.addEventListener("beforeunload", onUnload, { once: true });
      window.addEventListener("unload", onUnload, { once: true });
      try { var b = $(IDS.proceed); if (b) b.click(); else { done = true; return resolve({ blocked: true, reason: "Proceed button missing" }); } } catch (e) {}
      setTimeout(function () {
        if (done) return; done = true;
        try { window.removeEventListener("beforeunload", onUnload); } catch (e) {}
        resolve({ blocked: true, reason: "no submit (validation?)", alert: readLastAlert() });
      }, PROCEED_WAIT);
    });
  }

  /* ---------------------- run bookkeeping ---------------------- */
  function pendingWorkers(g) { return (g.workers || []).filter(function (w) { return w.status !== "done"; }); }
  function nextGroup(r) {
    for (var i = 0; i < r.groups.length; i++) {
      var g = r.groups[i];
      if (pendingWorkers(g).length && (g.attempts || 0) <= GROUP_RETRIES) { g.idx = i; return g; }
    }
    return null;
  }
  function markGroupWorkers(g, status, message) {
    (g.workers || []).forEach(function (w) { if (w.status !== "done") { w.status = status; w.message = message; w.at = Date.now(); } });
  }
  function finish(r) {
    var ok = 0, err = 0;
    r.groups.forEach(function (g) { (g.workers || []).forEach(function (w) { if (w.status === "done") ok++; else err++; }); });
    r.active = false; r.stopRequested = false; r.pendingProceed = null;
    log(r, err ? "warn" : "ok", "Finished — " + ok + " submitted" + (err ? ", " + err + " not done" : "") + ".");
    saveRun(r); restoreDialogs();
  }
  function halt(r, reason) {
    r.active = false; r.pendingProceed = null;
    log(r, "err", reason);
    saveRun(r); restoreDialogs();
  }

  // After a Proceed reload, record the result of the group we had submitted.
  function resolveProceed(r) {
    var pp = r.pendingProceed; if (!pp) return;
    var g = r.groups[pp.groupIdx]; r.pendingProceed = null;
    if (!g) { saveRun(r); return; }
    var a = readLastAlert(); clearLastAlert();
    var msg = a ? a.msg : "";
    var isErr = a ? /invalid|error|not\s|fail|wrong|already|exist|duplicate|please\s/i.test(msg) : false;
    var submitted = pp.workerKeys || [];
    (g.workers || []).forEach(function (w) {
      if (submitted.indexOf(w.applicant) < 0) return;
      w.status = isErr ? "error" : "done";
      w.message = msg || (isErr ? "portal reported an error" : "submitted");
      w.at = Date.now();
    });
    if (isErr) { r.consecFail = (r.consecFail || 0) + 1; log(r, "err", g.regNo + ": " + (msg || "error")); }
    else { r.consecFail = 0; log(r, "ok", g.regNo + ": " + (msg || "submitted")); }
    saveRun(r);
  }

  /* ---------------------- drive one registration ---------------------- */
  // returns {reloaded:true} if Proceed was clicked (page is navigating away)
  async function driveGroup(r, g) {
    g.attempts = (g.attempts || 0) + 1; saveRun(r);
    try {
      if (loggedOut()) { halt(r, "Portal session/page changed — log in, reopen the Work Demand page, then click Resume."); return { reloaded: false, halted: true }; }

      // -- village (skip if already selected) --
      if (g.village) {
        var vopt = findVillageOption(g.village);
        if (!vopt) { markGroupWorkers(g, "error", "village " + g.village + " not in list — select the village manually, then Resume"); log(r, "warn", g.regNo + ": village not found (" + g.village + ")"); saveRun(r); return { reloaded: false }; }
        if (currentVillage() !== g.village) {
          var vr = await selectDDL(IDS.village, UNAME.village, g.village);
          if (vr.timeout || vr.error) throw new Error("village select " + (vr.timeout ? "timed out" : vr.error));
          await sleep(PACE);
        }
      }

      // -- registration (skip if already selected) --
      var ropt = findRegOption(g.regNo);
      if (!ropt) { markGroupWorkers(g, "error", "registration " + g.regNo + " not found in the list"); log(r, "warn", g.regNo + ": registration not found"); saveRun(r); return { reloaded: false }; }
      if (currentReg() !== ropt) {
        var rr = await selectDDL(IDS.reg, UNAME.reg, ropt);
        if (rr.timeout || rr.error) throw new Error("registration select " + (rr.timeout ? "timed out" : rr.error));
        await sleep(PACE);
      }

      // -- fill each pending worker --
      var submitted = [];
      var pend = pendingWorkers(g);
      for (var i = 0; i < pend.length; i++) {
        var w = pend[i];
        var row = findWorkerRow(w.applicant);
        if (!row) { w.status = "error"; w.message = "name not found in this registration's grid"; w.at = Date.now(); saveRun(r); continue; }
        // row.pfx = ctl00_ContentPlaceHolder1_gvData_ctl02  ->  unique-name base ctl00$ContentPlaceHolder1$gvData$ctl02
        var base = UPFX + row.pfx.substring(PFX.length).replace(/_/g, "$");

        var a1 = await fillField(row.pfx + "_dt_app", base + "$dt_app", w.appDate);
        if (a1.timeout || a1.error) throw new Error("date-of-application " + (a1.timeout ? "timed out" : a1.error));
        await sleep(PACE);

        var a2 = await fillField(row.pfx + "_dt_from", base + "$dt_from", w.from);
        if (a2.timeout || a2.error) throw new Error("work-from " + (a2.timeout ? "timed out" : a2.error));
        await sleep(PACE);

        var a3 = await fillField(row.pfx + "_d3", base + "$d3", String(w.days));
        if (a3.timeout || a3.error) throw new Error("no-of-days " + (a3.timeout ? "timed out" : a3.error));
        await sleep(PACE);

        var toEl = $(row.pfx + "_dt_to");
        if (toEl && !String(toEl.value).trim()) { w.message = "warning: 'Work Demand To' did not auto-fill"; }
        submitted.push(w.applicant);
        w.status = "filled"; w.at = Date.now(); saveRun(r);
      }

      if (!submitted.length) { log(r, "warn", g.regNo + ": no matching worker filled"); saveRun(r); return { reloaded: false }; }

      // -- Proceed (full reload) --
      r.pendingProceed = { groupIdx: g.idx, workerKeys: submitted, at: Date.now() };
      clearLastAlert(); saveRun(r);
      log(r, "info", g.regNo + ": submitting " + submitted.length + " worker(s)…"); saveRun(r);

      var out = await clickProceed();
      if (out.submitted) return { reloaded: true };

      // blocked by validation — undo pending, mark error
      r.pendingProceed = null;
      var am = out.alert ? out.alert.msg : (out.reason || "submit blocked");
      markGroupWorkers(g, "error", am);
      r.consecFail = (r.consecFail || 0) + 1;
      log(r, "err", g.regNo + ": " + am);
      saveRun(r);
      return { reloaded: false };
    } catch (e) {
      r.consecFail = (r.consecFail || 0) + 1;
      log(r, "err", g.regNo + ": " + (e && e.message ? e.message : String(e)) + " (attempt " + g.attempts + ")");
      if ((g.attempts || 0) > GROUP_RETRIES) markGroupWorkers(g, "error", "gave up after retries: " + (e && e.message ? e.message : e));
      saveRun(r);
      return { reloaded: false };
    }
  }

  /* ---------------------- main loop ---------------------- */
  async function runLoop() {
    var r = loadRun();
    if (!r || !r.active) { restoreDialogs(); return; }
    overrideDialogs();

    await waitFor(function () { return document.readyState !== "loading" && prmReady() && ($(IDS.village) || loggedOut()); }, 30000);

    r = loadRun(); if (!r || !r.active) { restoreDialogs(); return; }

    if (r.pendingProceed) { resolveProceed(r); await sleep(200); r = loadRun(); }

    while (true) {
      r = loadRun();
      if (!r || !r.active) { restoreDialogs(); return; }
      if (r.stopRequested) { r.active = false; log(r, "warn", "Stopped by user."); saveRun(r); restoreDialogs(); return; }
      if ((r.consecFail || 0) >= MAX_CONSEC_FAIL) { halt(r, "Stopped after " + r.consecFail + " consecutive failures — check the portal, then click Resume."); return; }

      var g = nextGroup(r);
      if (!g) { finish(r); return; }

      var res = await driveGroup(r, g);
      if (res.reloaded || res.halted) return; // navigating away, or halted
      await sleep(PACE);
    }
  }

  /* ---------------------- boot ---------------------- */
  // Install overrides ASAP so the post-submit alert on this load is captured.
  (function boot() {
    var r = loadRun();
    if (r && r.active) overrideDialogs();
    // Kick from the UI's "start" as well (first run in a load where active was just set).
    window.addEventListener("message", function (ev) {
      if (ev.source !== window || !ev.data || ev.data.source !== "DXWD_UI") return;
      if (ev.data.type === "start") { overrideDialogs(); runLoop(); }
      else if (ev.data.type === "stop") {
        var rr = loadRun(); if (rr) { rr.stopRequested = true; rr.active = false; saveRun(rr); }
        restoreDialogs();
      }
    });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", runLoop);
    else runLoop();
  })();
})();
