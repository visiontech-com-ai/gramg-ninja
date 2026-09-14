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
  var PROCEED_WAIT = 90000;   // wait this long for the portal's confirmation after Proceed (it can take ~60s)
  var PACE = 500;             // small pause between async steps
  var APPLICANT_RETRIES = 2;  // extra retries per applicant before giving up (so up to 3 tries), then skip that applicant
  var NAME_THRESHOLD = 0.82;

  /* ---------------------- dialog overrides ---------------------- */
  var origAlert = window.alert, origConfirm = window.confirm, overridden = false;
  function overrideDialogs() {
    if (overridden) return; overridden = true;
    window.alert = function (m) {
      try { localStorage.setItem(LS_ALERT, JSON.stringify({ t: nowMs(), msg: String(m == null ? "" : m) })); } catch (e) {}
    };
    window.confirm = function () { return true; };
  }
  function restoreDialogs() {
    if (!overridden) return; overridden = false;
    window.alert = origAlert; window.confirm = origConfirm;
  }
  function readLastAlert() { try { return JSON.parse(localStorage.getItem(LS_ALERT) || "null"); } catch (e) { return null; } }
  function clearLastAlert() { try { localStorage.removeItem(LS_ALERT); } catch (e) {} }

  // This portal shows SUCCESS as a JS alert ("Data Entered Successfully"), but errors and the
  // duplicate notice as an ON-SCREEN LINE only (no alert), e.g.
  //   "Demand of Saraswati Mandi for period 08/09/2026-12/09/2026 is already there ."
  // That element has no stable id/class, so match the portal's demand-result text. Leaf nodes only.
  var INLINE_RE = /Demand of .+? for period|is already there|already exists|Data Entered Successfully|entered successfully/i;
  // Classify a portal message. "already there"/"duplicate" mean the demand IS present → success.
  var OK_RE = /success|saved|entered|accept|complete|generat|already|duplicate/i;
  var ERR_RE = /invalid|\berror\b|fail|wrong|cannot|not\s+(allowed|valid|found|entered)|please\s/i;
  function readInlineResult() {
    try {
      var els = document.querySelectorAll("font, b, span, td, label, div, p");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children && el.children.length) continue;
        var t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 240 && INLINE_RE.test(t)) return t;
      }
    } catch (e) {}
    return "";
  }
  // Blank any existing result line so that, after Proceed, only the NEW message is read.
  function clearInlineResult() {
    try {
      var els = document.querySelectorAll("font, b, span, td, label, div, p");
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.children && el.children.length) continue;
        if (INLINE_RE.test(el.textContent || "")) el.textContent = "";
      }
    } catch (e) {}
  }

  /* ---------------------- run state (localStorage) ---------------------- */
  function loadRun() { try { return JSON.parse(localStorage.getItem(LS_RUN) || "null"); } catch (e) { return null; } }
  function saveRun(r) {
    try { r.updatedAt = nowMs(); localStorage.setItem(LS_RUN, JSON.stringify(r)); } catch (e) {}
    notifyUI();
  }
  function notifyUI() { try { window.postMessage({ source: "DXWD_DRV", type: "sync" }, "*"); } catch (e) {} }
  function log(r, level, text) {
    (r.log = r.log || []).push({ t: nowMs(), level: level, text: text });
    if (r.log.length > 2000) r.log = r.log.slice(-2000);
  }

  /* ---------------------- small helpers ---------------------- */
  function $(id) { return document.getElementById(id); }
  // This portal BREAKS the whole Date object in the page (MAIN) world — new Date(), getTime(),
  // Date.now all throw "...reading 'keyCode'". performance.* is unaffected, so base time on it.
  function nowMs() { try { return Math.round((performance.timeOrigin || 0) + performance.now()); } catch (e) { return 0; } }
  // Debug logging — on by default; disable with localStorage.setItem('dxwd_debug','0').
  var DEBUG = (function () { try { return localStorage.getItem("dxwd_debug") !== "0"; } catch (e) { return true; } })();
  function dbg() { if (!DEBUG) return; try { console.log.apply(console, ["%c[GramG-WD/drv]", "color:#137333;font-weight:bold"].concat([].slice.call(arguments))); } catch (e) {} }
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function prmReady() { return !!(window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager && Sys.WebForms.PageRequestManager.getInstance); }
  function prm() { return Sys.WebForms.PageRequestManager.getInstance(); }

  function stopSignal() { var e = new Error("stopped by user"); e.__stop = true; return e; }
  function waitFor(cond, timeout, interval) {
    interval = interval || 150;
    return new Promise(function (res, reject) {
      var t0 = nowMs();
      (function tick() {
        if (stopping()) return reject(stopSignal());   // abort promptly on Stop
        var v; try { v = cond(); } catch (e) { v = false; }
        if (v) return res(v);
        if (nowMs() - t0 > timeout) return res(false);
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
    return new Promise(function (resolve, reject) {
      if (!prmReady()) { try { triggerFn(); } catch (e) {} return resolve({ error: "ajax runtime not ready" }); }
      var p = prm(), done = false, to, sp;
      function cleanup() { try { p.remove_endRequest(end); } catch (e) {} clearTimeout(to); clearInterval(sp); }
      function end(sender, args) {
        if (done) return; done = true; cleanup();
        var err = null; try { err = args && args.get_error && args.get_error(); } catch (e) {}
        if (err) { try { args.set_errorHandled(true); } catch (e) {} return resolve({ error: err.message || String(err) }); }
        resolve({ ok: true });
      }
      try { p.add_endRequest(end); } catch (e) { return resolve({ error: "cannot hook postback" }); }
      to = setTimeout(function () {
        if (done) return; done = true; cleanup();
        resolve({ timeout: true });
      }, timeoutMs);
      // Abort the wait promptly if Stop is requested mid-postback (the postback may finish server-side;
      // we just stop waiting and let the caller bail — nothing was submitted).
      sp = setInterval(function () {
        if (done) return;
        if (stopping()) { done = true; cleanup(); reject(stopSignal()); }
      }, 250);
      try { triggerFn(); } catch (e) {
        if (!done) { done = true; cleanup(); resolve({ error: String(e) }); }
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

  // Click Proceed and WAIT for the portal's definitive response:
  //   • SUCCESS  -> a JS alert ("Data Entered Successfully")  (captured via readLastAlert)
  //   • ERROR / duplicate -> an on-screen line only, no alert (captured via readInlineResult)
  //   • rarely   -> a full page reload
  // The portal can take up to ~60s, so we keep polling until one appears or PROCEED_WAIT elapses.
  // {responded:true} means we got a real answer (alert or on-screen line) → the caller must NOT retry.
  // {responded:false} (timeout) means no answer at all → the caller may retry (transient hang).
  // (readLastAlert must have been cleared and the on-screen line blanked before calling.)
  function clickProceed() {
    return new Promise(function (resolve) {
      var done = false, timer = null;
      function finish(res) {
        if (done) return; done = true;
        try { window.removeEventListener("beforeunload", onUnload); } catch (e) {}
        try { window.removeEventListener("unload", onUnload); } catch (e) {}
        if (timer) clearTimeout(timer);
        resolve(res);
      }
      function onUnload() { finish({ submitted: true, reloaded: true, responded: true }); }
      window.addEventListener("beforeunload", onUnload, { once: true });
      window.addEventListener("unload", onUnload, { once: true });
      try { var b = $(IDS.proceed); if (!b) return finish({ blocked: true, responded: false, reason: "Proceed button missing" }); b.click(); } catch (e) { return finish({ blocked: true, responded: false, reason: String(e) }); }
      var t0 = nowMs();
      (function tick() {
        if (done) return;
        var a = readLastAlert();
        if (a && a.msg) return finish({ submitted: true, responded: true, msg: a.msg, via: "alert" });
        var im = readInlineResult();
        if (im) return finish({ submitted: true, responded: true, msg: im, via: "onscreen" });
        if (stopping()) return finish({ stopped: true });   // Stop clicked mid-wait → abort promptly
        if (nowMs() - t0 > PROCEED_WAIT) {
          return finish({ blocked: true, responded: false, reason: "no confirmation after " + Math.round(PROCEED_WAIT / 1000) + "s" });
        }
        timer = setTimeout(tick, 300);
      })();
    });
  }

  /* ---------------------- run bookkeeping ---------------------- */
  function pendingWorkers(g) { return (g.workers || []).filter(function (w) { return w.status !== "done" && w.status !== "error" && w.status !== "skipped"; }); }
  // A worker has usable Aadhaar data when Is_Aadhaar_Auth = "Y" (or a Whether-Aadhaar radio is
  // selected). "N" / blank+unselected means the portal would demand the Aadhaar choice, so we skip.
  function hasAadhaar(pfx) {
    var a = $(pfx + "_Is_Aadhaar_Auth");
    var v = a ? String(a.value).trim().toUpperCase() : null;
    if (v === "Y") return true;
    if (v === "N") return false;
    var base = UPFX + pfx.substring(PFX.length).replace(/_/g, "$");
    try { return !!document.querySelector('input[type="radio"][name="' + base + '$rbnAadhar"]:checked'); } catch (e) { return true; }
  }
  // Paranoia backstop so a pathological portal can never loop a registration forever:
  // (workers + 1) submit rounds per allowed applicant-retry, plus a little slack.
  function driveCap(g) { return ((g.workers || []).length + 1) * (APPLICANT_RETRIES + 1) + 3; }
  function nextGroup(r) {
    for (var i = 0; i < r.groups.length; i++) {
      var g = r.groups[i];
      if (!pendingWorkers(g).length) continue;
      if ((g.drives || 0) >= driveCap(g)) {
        // stuck — terminate whatever is still pending so the run moves on
        pendingWorkers(g).forEach(function (w) {
          w.status = "error"; w.message = w.message || "gave up (max attempts reached)"; w.at = nowMs();
        });
        log(r, "err", g.regNo + ": stopped after " + g.drives + " submit rounds — remaining applicant(s) marked error");
        continue;
      }
      g.idx = i; return g;
    }
    return null;
  }
  function markGroupWorkers(g, status, message) {
    (g.workers || []).forEach(function (w) { if (w.status !== "done") { w.status = status; w.message = message; w.at = nowMs(); } });
  }
  // Record one failed submit against a single applicant. Retry up to APPLICANT_RETRIES more
  // times (leave pending so the registration re-submits it), then mark it error and exclude it.
  function bumpFail(r, g, w, msg, fallbackReason) {
    w.attempts = (w.attempts || 0) + 1;
    var text = msg || fallbackReason || "portal reported an error";
    if (w.attempts > APPLICANT_RETRIES) {
      w.status = "error"; w.message = text; w.at = nowMs();
      log(r, "err", g.regNo + " · " + w.applicant + ": " + text + " — giving up after " + w.attempts + " attempt(s)");
    } else {
      w.message = text; w.at = nowMs();   // keep the latest portal message on the (still pending) row
      log(r, "warn", g.regNo + " · " + w.applicant + ": " + text +
        " — will retry (" + w.attempts + " of " + (APPLICANT_RETRIES + 1) + ")");
    }
  }
  // DEFINITIVE response (the portal answered with a success alert or an on-screen line): record it
  // and DO NOT retry — a shown message is the portal's final word for this submit.
  //   ok  -> every submitted applicant is done.
  //   !ok -> every submitted applicant is error (the on-screen line is the reason). No retry: if the
  //          portal actually saved some of them, a manual re-run shows "already there" = done.
  function finalizeProceed(r, g, filled, ok, msg) {
    var fw = (g.workers || []).filter(function (w) { return filled.indexOf(w.applicant) >= 0; });
    fw.forEach(function (w) {
      w.status = ok ? "done" : "error";
      w.message = msg || (ok ? "submitted" : "portal reported an error");
      w.at = nowMs();
    });
    log(r, ok ? "ok" : "err", g.regNo + ": " + (msg || (ok ? "submitted" : "error")) +
      " (" + fw.length + " applicant" + (fw.length !== 1 ? "s" : "") + ")");
  }
  // NO response at all (Proceed timed out with neither an alert nor an on-screen line): treat as a
  // transient portal hang and retry per applicant (up to APPLICANT_RETRIES), then give up on them.
  function retryProceed(r, g, filled, reason) {
    var fw = (g.workers || []).filter(function (w) { return filled.indexOf(w.applicant) >= 0; });
    fw.forEach(function (w) { bumpFail(r, g, w, null, reason); });
  }
  function finish(r) {
    var ok = 0, err = 0;
    r.groups.forEach(function (g) { (g.workers || []).forEach(function (w) { if (w.status === "done") ok++; else err++; }); });
    r.active = false; r.stopRequested = false; r.pendingProceed = null;
    dbg("FINISHED", { submitted: ok, notDone: err });
    log(r, err ? "warn" : "ok", "Finished — " + ok + " submitted" + (err ? ", " + err + " not done" : "") + ".");
    saveRun(r); restoreDialogs();
  }
  function halt(r, reason) {
    r.active = false; r.pendingProceed = null;
    log(r, "err", reason);
    saveRun(r); restoreDialogs();
  }

  // After a Proceed that caused a FULL reload (rare on this portal), record the result. A reload is a
  // definitive outcome; read whatever message is present and finalize (no retry).
  function resolveProceed(r) {
    var pp = r.pendingProceed; if (!pp) return;
    var g = r.groups[pp.groupIdx]; r.pendingProceed = null;
    if (!g) { saveRun(r); return; }
    var a = readLastAlert(); clearLastAlert();
    var msg = (a && a.msg) || readInlineResult() || "";
    var isOk = OK_RE.test(msg);
    var done = isOk || !ERR_RE.test(msg);   // default to success when reloaded with no explicit error
    finalizeProceed(r, g, pp.workerKeys || [], done, msg || (done ? "submitted" : "portal reported an error"));
    saveRun(r);
  }

  /* ---------------------- drive one registration ---------------------- */
  // Stop is requested from the UI by writing stopRequested/active=false to the shared run.
  // Re-read it (localStorage) at each checkpoint so a Stop takes effect mid-registration —
  // especially BEFORE Proceed, so a pending registration is never submitted after Stop.
  function stopping() { var rr = loadRun(); return !rr || rr.stopRequested || !rr.active; }

  // returns {reloaded:true} if Proceed was clicked (page is navigating away)
  async function driveGroup(r, g) {
    g.drives = (g.drives || 0) + 1; saveRun(r);
    dbg("drive", g.regNo, "· round", g.drives, "· pending", pendingWorkers(g).length);
    try {
      if (stopping()) { dbg("stop before drive", g.regNo); return { reloaded: false }; }
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
        dbg("village", g.village, "selected");
      }

      // After a village change the registration dropdown repopulates a beat later — wait for it.
      await waitFor(function () { return findRegOption(g.regNo) !== null; }, 8000);

      // -- registration (skip if already selected) --
      var ropt = findRegOption(g.regNo);
      if (!ropt) { markGroupWorkers(g, "error", "registration " + g.regNo + " not found in the list"); log(r, "warn", g.regNo + ": registration not found"); saveRun(r); return { reloaded: false }; }
      if (currentReg() !== ropt) {
        var rr = await selectDDL(IDS.reg, UNAME.reg, ropt);
        if (rr.timeout || rr.error) throw new Error("registration select " + (rr.timeout ? "timed out" : rr.error));
        await sleep(PACE);
      }
      // The grid may render a beat after the registration postback — wait for its rows.
      await waitFor(function () { return gridRows().length > 0; }, 8000);
      dbg("registration", g.regNo, "selected · grid rows", gridRows().length);

      // -- clear Date of Application on EVERY row first --
      // The portal persists previously-entered dates. Clearing dt_app on all rows makes the sheet
      // authoritative: rows not in the sheet get their demand removed when we Proceed; the sheet's
      // own workers are re-filled below. (Re-query each row — the grid DOM is replaced per postback.)
      var clr = gridRows();
      for (var k = 0; k < clr.length; k++) {
        var rp = clr[k].pfx;
        var appEl = $(rp + "_dt_app");
        if (appEl && String(appEl.value).trim() !== "") {
          var rbase = UPFX + rp.substring(PFX.length).replace(/_/g, "$");
          await fillField(rp + "_dt_app", rbase + "$dt_app", "");
          await sleep(PACE);
        }
      }

      dbg("cleared Date of Application on all rows");

      // -- fill each pending worker --
      var submitted = [];
      var pend = pendingWorkers(g);
      for (var i = 0; i < pend.length; i++) {
        if (stopping()) { dbg("stop during fill", g.regNo); log(r, "warn", g.regNo + ": stopped before submitting."); saveRun(r); return { reloaded: false }; }
        var w = pend[i];
        var row = findWorkerRow(w.applicant);
        if (!row) { w.status = "error"; w.message = "name not found in this registration's grid"; w.at = nowMs(); saveRun(r); continue; }
        if (!hasAadhaar(row.pfx)) {
          w.status = "skipped"; w.message = "No Aadhaar data available"; w.at = nowMs();
          dbg("skip (no Aadhaar data)", w.applicant); saveRun(r); continue;
        }
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
        w.status = "filled"; w.at = nowMs(); saveRun(r);
        dbg("filled", w.applicant, { app: w.appDate, from: w.from, days: w.days });
      }

      if (!submitted.length) { log(r, "warn", g.regNo + ": no matching worker filled"); saveRun(r); return { reloaded: false }; }

      // Last chance to abort before we actually submit. If Stop was clicked while filling, do NOT
      // Proceed — the filled rows stay pending and are re-submitted on Resume.
      if (stopping()) { dbg("stop before Proceed", g.regNo); log(r, "warn", g.regNo + ": stop requested — not submitting this registration."); saveRun(r); return { reloaded: false }; }

      // -- Proceed --
      r.pendingProceed = { groupIdx: g.idx, workerKeys: submitted, at: nowMs() };
      clearLastAlert(); clearInlineResult(); saveRun(r);   // blank any prior alert/on-screen line first
      log(r, "info", g.regNo + ": submitting " + submitted.length + " worker(s)…"); saveRun(r);

      dbg("proceed", g.regNo, submitted.length, "worker(s)");
      var out = await clickProceed();
      dbg("proceed result", g.regNo, out);
      if (out.reloaded) return { reloaded: true }; // full reload → resolveProceed handles it next load
      if (out.stopped) {                            // Stop clicked during the confirmation wait
        r.pendingProceed = null;
        dbg("stop during Proceed wait", g.regNo);
        log(r, "warn", g.regNo + ": stopped while awaiting confirmation — left pending for Resume.");
        saveRun(r);
        return { reloaded: false };                 // workers stay "filled"/pending; loop halts on stop
      }

      // Async submit (portal keeps the page).
      r.pendingProceed = null;
      var msg = out.msg || "";
      clearLastAlert();
      if (out.responded) {
        // Definitive portal answer (success alert OR on-screen line) → classify and DO NOT retry.
        // OK_RE catches success/"already there"; ERR_RE guards against "not entered" etc. matching OK_RE.
        var ok = OK_RE.test(msg) && !ERR_RE.test(msg);
        finalizeProceed(r, g, submitted, ok, msg);
      } else {
        // No answer at all within the wait → transient hang → retry per applicant.
        retryProceed(r, g, submitted, out.reason || "no confirmation");
      }
      saveRun(r);
      return { reloaded: false };
    } catch (e) {
      // Stop requested mid-step (a wait was aborted): bail cleanly — leave workers pending, no error/retry.
      // The main loop's stop check then logs "Stopped by user." and halts.
      if (e && e.__stop) { dbg("stopped mid-step", g.regNo); saveRun(r); return { reloaded: false }; }
      // A thrown error (timeout, DOM/postback failure) isn't applicant-specific — count it against
      // every applicant still pending in this registration; those out of retries are marked error.
      var reason = (e && e.message ? e.message : String(e));
      log(r, "err", g.regNo + ": " + reason + " (round " + g.drives + ")");
      pendingWorkers(g).forEach(function (w) { bumpFail(r, g, w, null, reason); });
      saveRun(r);
      return { reloaded: false };
    }
  }

  /* ---------------------- main loop ---------------------- */
  async function runLoop() {
    var r = loadRun();
    if (!r || !r.active) { restoreDialogs(); return; }
    overrideDialogs();

    try { await waitFor(function () { return document.readyState !== "loading" && prmReady() && ($(IDS.village) || loggedOut()); }, 30000); }
    catch (e) { /* stop requested during startup — fall through to the stop check below */ }

    r = loadRun(); if (!r || !r.active) { restoreDialogs(); return; }

    if (r.pendingProceed) { resolveProceed(r); await sleep(200); r = loadRun(); }

    while (true) {
      r = loadRun();
      if (!r) { restoreDialogs(); return; }
      // Check stop first — a UI Stop sets BOTH stopRequested and active=false; log it before bailing.
      if (r.stopRequested) { r.active = false; log(r, "warn", "Stopped by user."); saveRun(r); restoreDialogs(); return; }
      if (!r.active) { restoreDialogs(); return; }
      // No consecutive-failure circuit breaker: each failing applicant is retried (APPLICANT_RETRIES)
      // then skipped, and the run moves forward through the rest of the sheet.

      var g = nextGroup(r);
      if (!g) { finish(r); return; }

      var res = await driveGroup(r, g);
      if (res.reloaded || res.halted) return; // navigating away, or halted
      await sleep(PACE);
    }
  }

  // Single-flight guard so only one runLoop runs at a time (message + poll + boot all funnel here).
  var __loopActive = false;
  function kick() {
    if (__loopActive) return;
    var r = loadRun(); if (!r || !r.active) return;
    __loopActive = true;
    Promise.resolve().then(runLoop).then(function () { __loopActive = false; }, function () { __loopActive = false; });
  }

  /* ---------------------- boot ---------------------- */
  // Install overrides ASAP so the post-submit alert on this load is captured.
  (function boot() {
    var r = loadRun();
    dbg("engine loaded (MAIN world) on", location.pathname, "· debug ON — set localStorage dxwd_debug=0 to silence",
      r && r.active ? "· run ACTIVE, resuming" : "· idle");
    if (r && r.active) overrideDialogs();
    // Fast path: the UI posts "start"/"stop". Don't require ev.source===window — an
    // isolated-world content script's postMessage may not set it as expected.
    window.addEventListener("message", function (ev) {
      if (!ev.data || ev.data.source !== "DXWD_UI") return;
      if (ev.data.type === "start") { overrideDialogs(); kick(); }
      else if (ev.data.type === "stop") {
        var rr = loadRun(); if (rr) { rr.stopRequested = true; rr.active = false; saveRun(rr); }
        restoreDialogs();
      }
    });
    // Robust fallback: poll for an active run so a Start (or a post-reload resume)
    // always drives even if the cross-world message is missed.
    setInterval(function () { var rr = loadRun(); if (rr && rr.active && !rr.stopRequested) { kick(); } }, 1000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", kick);
    else kick();
  })();
})();
