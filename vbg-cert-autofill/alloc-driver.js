/* =====================================================================
   alloc-driver.js  —  VB-G RAM G Work Allocation autofill (ENGINE)

   Runs in the PAGE (MAIN) world at document_start on workalloc.aspx. Mirrors
   demand-driver.js: shared state in portal-origin localStorage under "dxwa_run",
   driven by the UI content script (alloc-autofill.js).

   The page has ONE grid of all demanded workers. Per WORK CODE the driver
   selects the category (postback) + the work code, ticks the sheet's reg+applicant
   rows, fills Allocation From + days, then clicks Save (one Save per work code).
   ===================================================================== */
(function () {
  "use strict";
  if (window.__DXWA_DRV) return;
  window.__DXWA_DRV = true;

  var LS_RUN = "dxwa_run";
  var LS_ALERT = "dxwa_lastAlert";
  var PFX = "ctl00_ContentPlaceHolder1_";
  var UPFX = "ctl00$ContentPlaceHolder1$";
  var IDS = {
    cat: PFX + "ddlworkcategory",
    search: PFX + "txtwrksearchkey",
    work: PFX + "ddlWork_code",
    grid: PFX + "GridView1",
    save: PFX + "cmdSave"
  };
  var UNAME = { cat: UPFX + "ddlworkcategory" };

  var STEP_TIMEOUT = 90000;   // wait up to 90s per async postback
  var SAVE_WAIT = 90000;      // wait this long for the portal's confirmation after Save
  var POST_GRACE = 550;       // if no postback begins this soon after an action, assume none (a real UpdatePanel postback begins within tens of ms)
  var PACE = 150;
  var APPLICANT_RETRIES = 2;
  var NAME_THRESHOLD = 0.82;

  /* ---------------------- dialog overrides ---------------------- */
  var origAlert = window.alert, origConfirm = window.confirm, overridden = false;
  function overrideDialogs() {
    if (overridden) return; overridden = true;
    window.alert = function (m) { try { localStorage.setItem(LS_ALERT, JSON.stringify({ t: nowMs(), msg: String(m == null ? "" : m) })); } catch (e) {} };
    window.confirm = function () { return true; };
  }
  function restoreDialogs() { if (!overridden) return; overridden = false; window.alert = origAlert; window.confirm = origConfirm; }
  // After a run ends the portal can still fire a trailing "Allocation has been done"
  // alert on window.onload of the last Save's postback. Keep swallowing dialogs a few
  // seconds so that alert never blocks the page — but skip the restore if a new run has
  // started meanwhile (don't clobber its override).
  function restoreDialogsSoon() { setTimeout(function () { var rr = loadRun(); if (!rr || !rr.active) restoreDialogs(); }, 9000); }
  function readLastAlert() { try { return JSON.parse(localStorage.getItem(LS_ALERT) || "null"); } catch (e) { return null; } }
  function clearLastAlert() { try { localStorage.removeItem(LS_ALERT); } catch (e) {} }

  // Allocation results: success is usually an alert; errors/notices may be an on-screen line only.
  var INLINE_RE = /allocat|saved|success|updated|record|already|not\s+allowed|invalid|exceed|greater|less than|before|overlap/i;
  var OK_RE = /success|saved|allocat(ed|ion done|ion save)|updated|record (saved|inserted)|complete|done|already/i;
  var ERR_RE = /invalid|\berror\b|fail|wrong|cannot|not\s+(allowed|valid|found|saved|allocated)|exceed|greater|less than|before|overlap|please\s/i;
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
  function clearInlineResult() {
    try {
      var els = document.querySelectorAll("font, b, span, td, label, div, p");
      for (var i = 0; i < els.length; i++) { var el = els[i]; if (el.children && el.children.length) continue; if (INLINE_RE.test(el.textContent || "")) el.textContent = ""; }
    } catch (e) {}
  }

  /* ---------------------- run state ---------------------- */
  function loadRun() { try { return JSON.parse(localStorage.getItem(LS_RUN) || "null"); } catch (e) { return null; } }
  function saveRun(r) { try { r.updatedAt = nowMs(); localStorage.setItem(LS_RUN, JSON.stringify(r)); } catch (e) {} notifyUI(); }
  function notifyUI() { try { window.postMessage({ source: "DXWA_DRV", type: "sync" }, "*"); } catch (e) {} }
  function log(r, level, text) { (r.log = r.log || []).push({ t: nowMs(), level: level, text: text }); if (r.log.length > 2000) r.log = r.log.slice(-2000); }

  /* ---------------------- helpers ---------------------- */
  function $(id) { return document.getElementById(id); }
  function nowMs() { try { return Math.round((performance.timeOrigin || 0) + performance.now()); } catch (e) { return 0; } }
  var DEBUG = (function () { try { return localStorage.getItem("dxwa_debug") !== "0"; } catch (e) { return true; } })();
  function dbg() { if (!DEBUG) return; try { console.log.apply(console, ["%c[GramG-WA/drv]", "color:#8a2be2;font-weight:bold"].concat([].slice.call(arguments))); } catch (e) {} }
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  function prmReady() { return !!(window.Sys && Sys.WebForms && Sys.WebForms.PageRequestManager && Sys.WebForms.PageRequestManager.getInstance); }
  function prm() { return Sys.WebForms.PageRequestManager.getInstance(); }
  function stopSignal() { var e = new Error("stopped by user"); e.__stop = true; return e; }
  function stopping() { var rr = loadRun(); return !rr || rr.stopRequested || !rr.active; }

  function waitFor(cond, timeout, interval) {
    interval = interval || 150;
    return new Promise(function (res, reject) {
      var t0 = nowMs();
      (function tick() {
        if (stopping()) return reject(stopSignal());
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
      var proto = el.tagName === "SELECT" ? HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, val);
    } catch (e) { try { el.value = val; } catch (e2) { return false; } }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // Run actionFn; if it starts an async postback, await it (up to STEP_TIMEOUT); if none begins within
  // POST_GRACE, assume there's no postback and continue. Rejects a __stop error if Stop is requested.
  function doAction(actionFn) {
    return new Promise(function (resolve, reject) {
      var done = false, began = false, to = null, sp = null, p = prmReady() ? prm() : null;
      function detach() { try { if (p) { p.remove_beginRequest(onBegin); p.remove_endRequest(onEnd); } } catch (e) {} clearTimeout(to); clearInterval(sp); }
      function fin(res) { if (done) return; done = true; detach(); resolve(res); }
      function onBegin() { began = true; clearTimeout(to); to = setTimeout(function () { fin({ timeout: true }); }, STEP_TIMEOUT); }
      function onEnd(s, a) { var err = null; try { err = a && a.get_error && a.get_error(); } catch (e) {} if (err) { try { a.set_errorHandled(true); } catch (e) {} } fin(err ? { error: err.message || String(err) } : { ok: true }); }
      try { if (p) { p.add_beginRequest(onBegin); p.add_endRequest(onEnd); } } catch (e) {}
      sp = setInterval(function () { if (stopping()) { done = true; detach(); reject(stopSignal()); } }, 250);
      try { actionFn(); } catch (e) { return fin({ error: String(e) }); }
      to = setTimeout(function () { if (!began) fin({ ok: true, noPost: true }); }, POST_GRACE);
    });
  }

  /* ---------------------- name / date / reg ---------------------- */
  function normName(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim(); }
  function tokenSort(s) { return s.split(" ").filter(Boolean).sort().join(" "); }
  function lev(a, b) { a = a || ""; b = b || ""; var m = a.length, n = b.length; if (!m) return n; if (!n) return m; var prev = [], cur = [], i, j; for (j = 0; j <= n; j++) prev[j] = j; for (i = 1; i <= m; i++) { cur[0] = i; for (j = 1; j <= n; j++) { var c = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1; cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c); } var t = prev; prev = cur; cur = t; } return prev[n]; }
  function sim(a, b) { if (!a && !b) return 1; var mx = Math.max(a.length, b.length); return mx ? 1 - lev(a, b) / mx : 1; }
  function nameScore(a, b) { var na = normName(a), nb = normName(b); if (na === nb) return 1; var sa = tokenSort(na), sb = tokenSort(nb); if (sa === sb) return 0.99; return Math.max(sim(na, nb), sim(sa, sb)); }
  function normReg(s) { return String(s == null ? "" : s).replace(/\s+/g, "").toUpperCase(); }
  function dmyToNum(s) { var m = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(String(s || "").trim()); return m ? (+m[3]) * 10000 + (+m[2]) * 100 + (+m[1]) : 0; }

  /* ---------------------- page inspection ---------------------- */
  function loggedOut() { return !$(IDS.cat) && !$(IDS.work) && !$(IDS.grid); }
  function currentCat() { var el = $(IDS.cat); return el ? String(el.value) : ""; }
  function currentWork() { var el = $(IDS.work); return el ? String(el.value) : ""; }
  function findCatOption(code) { var el = $(IDS.cat); if (!el) return null; for (var i = 0; i < el.options.length; i++) if (String(el.options[i].value) === code) return el.options[i].value; return null; }
  function findWorkOption(code) { var el = $(IDS.work); if (!el) return null; for (var i = 0; i < el.options.length; i++) { var v = String(el.options[i].value); if (v.split("~")[0] === code || v === code) return v; } return null; }
  // Grid data rows -> [{pfx, reg, name, demandFrom}]. pfx is the full element-id prefix (…GridView1_ctlNN).
  // The chkAllocate lives inside a NESTED table, so iterate the OUTER GridView data rows
  // (direct tbody > tr). Those have cells: [0]=S.No, [1]=Registration No, [3]=Job seeker name.
  function gridRows() {
    var grid = $(IDS.grid); if (!grid) return [];
    var tbody = grid.tBodies && grid.tBodies[0]; var trs = tbody ? tbody.children : [];
    var out = [];
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var chk = tr.querySelector ? tr.querySelector('input[type="checkbox"][id$="_chkAllocate"]') : null;
      if (!chk) continue;
      var pfx = chk.id.replace(/_chkAllocate$/, "");
      var cells = tr.children;
      var reg = cells[1] ? (cells[1].textContent || "").replace(/\s+/g, " ").trim() : "";
      var name = cells[3] ? (cells[3].textContent || "").replace(/\s+/g, " ").trim() : "";
      var dfEl = $(pfx + "_txtDemandFrom"); var demandFrom = dfEl ? String(dfEl.value).trim() : "";
      out.push({ pfx: pfx, reg: reg, name: name, demandFrom: demandFrom });
    }
    return out;
  }
  function findAllocRow(reg, applicant, rows) {
    var nreg = normReg(reg), best = null, bestScore = 0;
    for (var i = 0; i < rows.length; i++) {
      if (normReg(rows[i].reg) !== nreg) continue;
      var s = nameScore(applicant, rows[i].name);
      if (s > bestScore) { bestScore = s; best = rows[i]; }
    }
    return (best && bestScore >= NAME_THRESHOLD) ? best : null;
  }
  function baseName(pfx) { return UPFX + pfx.substring(PFX.length).replace(/_/g, "$"); }

  /* ---------------------- click Save ---------------------- */
  function clickSave() {
    return new Promise(function (resolve) {
      var done = false, timer = null;
      function finish(res) { if (done) return; done = true; try { window.removeEventListener("beforeunload", onUnload); window.removeEventListener("unload", onUnload); } catch (e) {} if (timer) clearTimeout(timer); resolve(res); }
      function onUnload() { finish({ submitted: true, reloaded: true, responded: true }); }
      window.addEventListener("beforeunload", onUnload, { once: true });
      window.addEventListener("unload", onUnload, { once: true });
      try { var b = $(IDS.save); if (!b) return finish({ blocked: true, responded: false, reason: "Save button missing" }); b.click(); } catch (e) { return finish({ blocked: true, responded: false, reason: String(e) }); }
      var t0 = nowMs();
      (function tick() {
        if (done) return;
        var a = readLastAlert(); if (a && a.msg) return finish({ submitted: true, responded: true, msg: a.msg, via: "alert" });
        var im = readInlineResult(); if (im) return finish({ submitted: true, responded: true, msg: im, via: "onscreen" });
        if (stopping()) return finish({ stopped: true });
        if (nowMs() - t0 > SAVE_WAIT) return finish({ blocked: true, responded: false, reason: "no confirmation after " + Math.round(SAVE_WAIT / 1000) + "s" });
        timer = setTimeout(tick, 300);
      })();
    });
  }

  /* ---------------------- run bookkeeping ---------------------- */
  function wkey(w) { return normReg(w.reg) + "|" + normName(w.applicant); }
  function pendingWorkers(g) { return (g.workers || []).filter(function (w) { return w.status !== "done" && w.status !== "error" && w.status !== "skipped"; }); }
  function driveCap(g) { return ((g.workers || []).length + 1) * (APPLICANT_RETRIES + 1) + 3; }
  function nextGroup(r) {
    for (var i = 0; i < r.groups.length; i++) {
      var g = r.groups[i];
      if (!pendingWorkers(g).length) continue;
      if ((g.drives || 0) >= driveCap(g)) {
        pendingWorkers(g).forEach(function (w) { w.status = "error"; w.message = w.message || "gave up (max attempts reached)"; w.at = nowMs(); });
        log(r, "err", g.workCode + ": stopped after " + g.drives + " rounds — remaining applicant(s) marked error");
        continue;
      }
      g.idx = i; return g;
    }
    return null;
  }
  function markGroupWorkers(g, status, message) { (g.workers || []).forEach(function (w) { if (w.status !== "done") { w.status = status; w.message = message; w.at = nowMs(); } }); }
  function bumpFail(r, g, w, msg, fallbackReason) {
    w.attempts = (w.attempts || 0) + 1;
    var text = msg || fallbackReason || "portal reported an error";
    if (w.attempts > APPLICANT_RETRIES) { w.status = "error"; w.message = text; w.at = nowMs(); log(r, "err", g.workCode + " · " + w.applicant + ": " + text + " — giving up after " + w.attempts + " attempt(s)"); }
    else { w.message = text; w.at = nowMs(); log(r, "warn", g.workCode + " · " + w.applicant + ": " + text + " — will retry (" + w.attempts + " of " + (APPLICANT_RETRIES + 1) + ")"); }
  }
  function finalizeSave(r, g, filledKeys, ok, msg) {
    var fw = (g.workers || []).filter(function (w) { return filledKeys.indexOf(wkey(w)) >= 0; });
    fw.forEach(function (w) { w.status = ok ? "done" : "error"; w.message = msg || (ok ? "allocated" : "portal reported an error"); w.at = nowMs(); });
    log(r, ok ? "ok" : "err", g.workCode + ": " + (msg || (ok ? "allocated" : "error")) + " (" + fw.length + " applicant" + (fw.length !== 1 ? "s" : "") + ")");
  }
  function retrySave(r, g, filledKeys, reason) {
    var fw = (g.workers || []).filter(function (w) { return filledKeys.indexOf(wkey(w)) >= 0; });
    fw.forEach(function (w) { bumpFail(r, g, w, null, reason); });
  }
  function finish(r) {
    var ok = 0, err = 0;
    r.groups.forEach(function (g) { (g.workers || []).forEach(function (w) { if (w.status === "done") ok++; else err++; }); });
    r.active = false; r.stopRequested = false; r.pendingSave = null;
    dbg("FINISHED", { allocated: ok, notDone: err });
    log(r, err ? "warn" : "ok", "Finished — " + ok + " allocated" + (err ? ", " + err + " not done" : "") + ".");
    saveRun(r); restoreDialogsSoon();
  }
  function halt(r, reason) { r.active = false; r.pendingSave = null; log(r, "err", reason); saveRun(r); restoreDialogsSoon(); }

  function resolveSave(r) {
    var pp = r.pendingSave; if (!pp) return;
    var g = r.groups[pp.groupIdx]; r.pendingSave = null;
    if (!g) { saveRun(r); return; }
    var a = readLastAlert(); clearLastAlert();
    var msg = (a && a.msg) || readInlineResult() || "";
    var done = OK_RE.test(msg) || !ERR_RE.test(msg);
    finalizeSave(r, g, pp.keys || [], done, msg || (done ? "allocated" : "portal reported an error"));
    saveRun(r);
  }

  /* ---------------------- drive one work code ---------------------- */
  async function driveGroup(r, g) {
    g.drives = (g.drives || 0) + 1; saveRun(r);
    dbg("drive", g.workCode, "· round", g.drives, "· pending", pendingWorkers(g).length);
    try {
      if (stopping()) return { reloaded: false };
      if (loggedOut()) { halt(r, "Portal session/page changed — log in, reopen the Work Allocation page, then click Resume."); return { reloaded: false, halted: true }; }

      // -- category (postback; skip if already selected) --
      if (g.category) {
        if (!findCatOption(g.category)) { markGroupWorkers(g, "error", "work category " + g.category + " not in list"); log(r, "warn", g.workCode + ": category not found (" + g.category + ")"); saveRun(r); return { reloaded: false }; }
        if (currentCat() !== g.category) {
          var cr = await doAction(function () { setNative($(IDS.cat), g.category); if (typeof window.__doPostBack === "function") window.__doPostBack(UNAME.cat, ""); });
          if (cr.error || cr.timeout) throw new Error("category select " + (cr.timeout ? "timed out" : cr.error));
          await sleep(PACE);
        }
      }

      // -- search the work code so the work-code dropdown populates (type full code + change=Tab) --
      var searchEl = $(IDS.search);
      if (!searchEl) { markGroupWorkers(g, "error", "work search box missing"); log(r, "warn", g.workCode + ": search box missing"); saveRun(r); return { reloaded: false }; }
      var se = await doAction(function () { setNative(searchEl, g.workCode); });
      if (se && se.error) throw new Error("work search " + se.error);
      // the onchange schedules the postback; wait for the dropdown to fill with this code
      await waitFor(function () { return findWorkOption(g.workCode) !== null; }, 15000);
      var wopt = findWorkOption(g.workCode);
      if (!wopt) { markGroupWorkers(g, "error", "work code not found after search"); log(r, "warn", g.workCode + ": not found after search"); saveRun(r); return { reloaded: false }; }
      if (currentWork() !== wopt) { var ws = await doAction(function () { setNative($(IDS.work), wopt); }); if (ws && ws.error) throw new Error("work select " + ws.error); await sleep(PACE); }

      await waitFor(function () { return gridRows().length > 0; }, 8000);
      var rows = gridRows();
      dbg("work code", g.workCode, "selected · grid rows", rows.length);

      // -- tick + fill each pending applicant for this work --
      var filled = [];
      var pend = pendingWorkers(g);
      for (var i = 0; i < pend.length; i++) {
        if (stopping()) { log(r, "warn", g.workCode + ": stopped before saving."); saveRun(r); return { reloaded: false }; }
        var w = pend[i];
        var row = findAllocRow(w.reg, w.applicant, rows);
        if (!row) { w.status = "skipped"; w.message = "not found in portal grid"; w.at = nowMs(); log(r, "warn", g.workCode + " · " + w.applicant + " (" + w.reg + "): not found in portal — skipped"); saveRun(r); continue; }
        var dNum = dmyToNum(row.demandFrom), aNum = dmyToNum(w.from);
        if (dNum && aNum && aNum < dNum) { w.status = "skipped"; w.message = "alloc date " + w.from + " before demand date " + row.demandFrom; w.at = nowMs(); log(r, "warn", g.workCode + " · " + w.applicant + ": " + w.message + " — skipped"); saveRun(r); continue; }

        var base = baseName(row.pfx);
        var chk = $(row.pfx + "_chkAllocate");
        if (chk && !chk.checked) { var t = await doAction(function () { chk.click(); }); if (t.error || t.timeout) throw new Error("allocate check " + (t.timeout ? "timed out" : t.error)); await sleep(PACE); }

        // These are plain grid data-entry inputs — they don't postback, so set them directly (no doAction grace wait).
        var afEl = $(row.pfx + "_txtAllocFrom"); if (afEl) setNative(afEl, w.from);
        var adEl = $(row.pfx + "_txtWorkBalDays"); if (adEl) setNative(adEl, String(w.days));
        // Alloc To: only set if the portal didn't auto-fill it.
        var toEl = $(row.pfx + "_txtAllocTo");
        if (toEl && !String(toEl.value).trim() && aNum) { var toStr = addDays(w.from, (+w.days || 1) - 1); if (toStr) setNative(toEl, toStr); }
        await sleep(PACE);

        filled.push(wkey(w)); w.status = "filled"; w.at = nowMs(); saveRun(r);
        dbg("ticked+filled", w.applicant, { from: w.from, days: w.days });
      }

      if (!filled.length) { log(r, "warn", g.workCode + ": no matching applicant to allocate"); saveRun(r); return { reloaded: false }; }
      if (stopping()) { log(r, "warn", g.workCode + ": stop requested — not saving."); saveRun(r); return { reloaded: false }; }

      // -- Save --
      r.pendingSave = { groupIdx: g.idx, keys: filled, at: nowMs() };
      clearLastAlert(); clearInlineResult(); saveRun(r);
      log(r, "info", g.workCode + ": saving " + filled.length + " allocation(s)…"); saveRun(r);
      var out = await clickSave();
      dbg("save result", g.workCode, out);
      if (out.reloaded) return { reloaded: true };
      if (out.stopped) { r.pendingSave = null; log(r, "warn", g.workCode + ": stopped while awaiting confirmation — left pending for Resume."); saveRun(r); return { reloaded: false }; }
      r.pendingSave = null;
      var msg = out.msg || "";
      clearLastAlert();
      if (out.responded) { var ok = OK_RE.test(msg) && !ERR_RE.test(msg); finalizeSave(r, g, filled, ok, msg); }
      else { retrySave(r, g, filled, out.reason || "no confirmation"); }
      saveRun(r);
      return { reloaded: false };
    } catch (e) {
      if (e && e.__stop) { dbg("stopped mid-step", g.workCode); saveRun(r); return { reloaded: false }; }
      var reason = (e && e.message ? e.message : String(e));
      log(r, "err", g.workCode + ": " + reason + " (round " + g.drives + ")");
      pendingWorkers(g).forEach(function (w) { bumpFail(r, g, w, null, reason); });
      saveRun(r);
      return { reloaded: false };
    }
  }
  function addDays(dmy, add) {
    var m = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/.exec(String(dmy || "").trim()); if (!m) return "";
    var day = +m[1], mon = +m[2], yr = +m[3];
    var mdays = [31, (yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day += (+add || 0);
    while (day > mdays[mon - 1]) { day -= mdays[mon - 1]; mon++; if (mon > 12) { mon = 1; yr++; mdays[1] = (yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)) ? 29 : 28; } }
    return ("0" + day).slice(-2) + "/" + ("0" + mon).slice(-2) + "/" + yr;
  }

  /* ---------------------- main loop ---------------------- */
  async function runLoop() {
    var r = loadRun();
    if (!r || !r.active) { restoreDialogs(); return; }
    overrideDialogs();
    try { await waitFor(function () { return document.readyState !== "loading" && prmReady() && ($(IDS.cat) || loggedOut()); }, 30000); }
    catch (e) {}
    r = loadRun(); if (!r || !r.active) { restoreDialogs(); return; }
    if (r.pendingSave) { resolveSave(r); await sleep(200); r = loadRun(); }
    while (true) {
      r = loadRun();
      if (!r) { restoreDialogs(); return; }
      if (r.stopRequested) { r.active = false; log(r, "warn", "Stopped by user."); saveRun(r); restoreDialogs(); return; }
      if (!r.active) { restoreDialogs(); return; }
      var g = nextGroup(r);
      if (!g) { finish(r); return; }
      var res = await driveGroup(r, g);
      if (res.reloaded || res.halted) return;
      await sleep(PACE);
    }
  }
  var __loopActive = false;
  function kick() {
    if (__loopActive) return;
    var r = loadRun(); if (!r || !r.active) return;
    __loopActive = true;
    Promise.resolve().then(runLoop).then(function () { __loopActive = false; }, function () { __loopActive = false; });
  }

  /* ---------------------- boot ---------------------- */
  (function boot() {
    var r = loadRun();
    dbg("engine loaded (MAIN world) on", location.pathname, "· debug ON — set localStorage dxwa_debug=0 to silence", r && r.active ? "· run ACTIVE, resuming" : "· idle");
    if (r && r.active) overrideDialogs();
    window.addEventListener("message", function (ev) {
      if (!ev.data || ev.data.source !== "DXWA_UI") return;
      if (ev.data.type === "start") { overrideDialogs(); kick(); }
      else if (ev.data.type === "stop") { var rr = loadRun(); if (rr) { rr.stopRequested = true; rr.active = false; saveRun(rr); } restoreDialogs(); }
    });
    setInterval(function () { var rr = loadRun(); if (rr && rr.active && !rr.stopRequested) { kick(); } }, 1000);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", kick);
    else kick();
  })();
})();
