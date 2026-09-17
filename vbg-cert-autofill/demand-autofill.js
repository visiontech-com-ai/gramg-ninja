/* =====================================================================
   demand-autofill.js  —  VB-G RAM G Work Demand bulk autofill (UI)

   Isolated-world content script on demand_new.aspx. Renders the in-page
   panel, parses the picked .xlsx (SheetJS), builds the grouped job list,
   and stores it in the portal-origin localStorage under "dxwd_run". The
   MAIN-world engine (demand-driver.js) reads that state, drives the page,
   and writes progress back; this UI mirrors it and offers Start / Stop /
   Start over / Export results.
   ===================================================================== */
(function () {
  "use strict";
  if (window.__DXWD_UI) return; window.__DXWD_UI = true;

  var LS_RUN = "dxwd_run", LS_ALERT = "dxwd_lastAlert", LS_RESULTS = "dxwd_lastResults";
  var CS_LOG = "dxwd_log_runs";             // durable activity log, in chrome.storage.local
  var CS_LOG_MAX_RUNS = 15;                 // keep the most recent N runs of log history
  var STATE_MAP = { WB: "32" };            // fallback LGD state code (used only if the portal dropdown can't be read)
  var sel = {};
  var wasActive = false;                    // to detect the run-finished transition
  var lastLogSig = "";                      // throttle: only re-persist the log when it changes

  /* ---------------- durable activity log (chrome.storage.local) ---------------- */
  function cstore() { try { return (chrome && chrome.storage && chrome.storage.local) || null; } catch (e) { return null; } }
  // Mirror the current run's activity log into chrome.storage.local, keyed by run id (replace, no
  // dedup needed). Throttled so it only writes when the log actually grew. cb() fires when stored.
  function persistLog(r, cb) {
    var cs = cstore();
    if (!cs || !r || !r.log) { if (cb) cb(); return; }
    var id = r.runId || ("wd-" + (r.sig || "nosig"));
    var sig = id + ":" + r.log.length;
    if (sig === lastLogSig && !cb) return;   // nothing new (skip unless a caller is waiting)
    lastLogSig = sig;
    try {
      cs.get(CS_LOG, function (o) {
        var runs = (o && o[CS_LOG]) || [];
        var idx = -1;
        for (var i = 0; i < runs.length; i++) { if (runs[i].runId === id) { idx = i; break; } }
        var rec = {
          runId: id, sig: r.sig || "",
          startedAt: (idx >= 0 ? runs[idx].startedAt : Date.now()),
          updatedAt: Date.now(),
          entries: r.log
        };
        if (idx >= 0) runs[idx] = rec; else runs.push(rec);
        if (runs.length > CS_LOG_MAX_RUNS) runs = runs.slice(-CS_LOG_MAX_RUNS);
        var set = {}; set[CS_LOG] = runs;
        try { cs.set(set, function () { if (cb) cb(); }); } catch (e) { if (cb) cb(); }
      });
    } catch (e) { if (cb) cb(); }
  }
  function clearLogStore(cb) {
    var cs = cstore(); lastLogSig = "";
    if (!cs) { if (cb) cb(); return; }
    try { cs.remove(CS_LOG, function () { if (cb) cb(); }); } catch (e) { if (cb) cb(); }
  }

  // Debug logging — on by default; disable with localStorage.setItem('dxwd_debug','0').
  var DEBUG = (function () { try { return localStorage.getItem("dxwd_debug") !== "0"; } catch (e) { return true; } })();
  function dbg() { if (!DEBUG) return; try { console.log.apply(console, ["%c[GramG-WD/ui]", "color:#0A66C2;font-weight:bold"].concat([].slice.call(arguments))); } catch (e) {} }

  /* ---------------- smart rate & share prompt ----------------
     Fires at a HAPPY moment (after a successful batch here, or a cert upload / wage
     breakup elsewhere — recordWin() is called by each area) once the user has had a
     couple of wins, then snoozes ~7 days. Shared across surfaces on the same origin. */
  var STORE_URL = "https://chromewebstore.google.com/detail/gramg-ninja/aafcpdejpfbkcnglhihleoiaalnfhlko";
  var RATE_KEY = "gramg_rate_next", RATE_WINS = "gramg_rate_wins";
  var RATE_PERIOD = 7 * 24 * 60 * 60 * 1000, RATE_MIN_WINS = 2;
  function rateNext() { try { return parseInt(localStorage.getItem(RATE_KEY) || "0", 10) || 0; } catch (e) { return 0; } }
  function rateWins() { try { return parseInt(localStorage.getItem(RATE_WINS) || "0", 10) || 0; } catch (e) { return 0; } }
  function rateDue() { return rateWins() >= RATE_MIN_WINS && Date.now() >= rateNext(); }
  function recordWin() { try { localStorage.setItem(RATE_WINS, String(rateWins() + 1)); } catch (e) {} maybeShowRate(); }
  function snoozeRate() { try { localStorage.setItem(RATE_KEY, String(Date.now() + RATE_PERIOD)); localStorage.setItem(RATE_WINS, "0"); } catch (e) {} if (sel.rate) sel.rate.hidden = true; }
  function maybeShowRate() { if (sel.rate) sel.rate.hidden = !rateDue(); }

  /* ---------------------- state store (shared localStorage) ---------------------- */
  function loadRun() { try { return JSON.parse(localStorage.getItem(LS_RUN) || "null"); } catch (e) { return null; } }
  function saveRun(r) { try { r.updatedAt = Date.now(); localStorage.setItem(LS_RUN, JSON.stringify(r)); } catch (e) {} }
  function post(type) { try { window.postMessage({ source: "DXWD_UI", type: type }, "*"); } catch (e) {} }

  /* ---------------------- parsing helpers ---------------------- */
  function pad2(n) { n = String(n); return n.length < 2 ? "0" + n : n; }
  function todayDMY() { var d = new Date(); return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear(); }
  function toDMY(v) {
    if (v == null || v === "") return "";
    if (v instanceof Date && !isNaN(v)) return pad2(v.getUTCDate()) + "/" + pad2(v.getUTCMonth() + 1) + "/" + v.getUTCFullYear();
    // Excel serial date (raw cell value) -> unambiguous Y/M/D via SheetJS SSF
    if (typeof v === "number" && isFinite(v)) {
      try { var dc = window.XLSX && XLSX.SSF && XLSX.SSF.parse_date_code(v); if (dc && dc.y) return pad2(dc.d) + "/" + pad2(dc.m) + "/" + dc.y; } catch (e) {}
    }
    var s = String(v).trim(); if (!s) return "";
    var iso = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/);
    if (iso) return pad2(+iso[3]) + "/" + pad2(+iso[2]) + "/" + iso[1];
    var m = s.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/);      // Indian DD-MM-YYYY / DD/MM/YYYY
    if (m) { var y = +m[3]; if (y < 100) y += 2000; return pad2(+m[1]) + "/" + pad2(+m[2]) + "/" + y; }
    return s;
  }
  // The village-dropdown option values on the portal already begin with the correct 2-digit LGD state
  // code (e.g. "3206003006001" → "32"). Read it from the page so the state code is not hardcoded.
  function portalStateCode() {
    try {
      var el = document.getElementById("ctl00_ContentPlaceHolder1_DDL_Village");
      if (el && el.options) {
        for (var i = 0; i < el.options.length; i++) {
          var v = String(el.options[i].value || "").replace(/[^0-9]/g, "");
          if (v.length >= 12) return v.slice(0, 2);   // full village code is 13 digits: state(2)+11
        }
      }
    } catch (e) {}
    return "";
  }
  function villageFromReg(regNo) {
    var jc = String(regNo || "").split("/")[0].trim();
    var m = jc.match(/^([A-Za-z]{2})[-\s]?(.+)$/);
    if (!m) return "";
    // Prefer the state code read live from the portal; fall back to the static map when unavailable.
    var code = portalStateCode() || STATE_MAP[m[1].toUpperCase()]; if (!code) return "";
    var digits = m[2].replace(/[^0-9]/g, "");
    return digits ? code + digits : "";
  }
  function pick(obj, re) { for (var k in obj) if (obj.hasOwnProperty(k) && re.test(k)) return obj[k]; return ""; }
  function hashStr(s) { var h = 5381, i = s.length; while (i) h = (h * 33) ^ s.charCodeAt(--i); return (h >>> 0).toString(16); }

  // Parse workbook -> grouped run object (statuses all "pending").
  function parseWorkbook(ab) {
    if (!window.XLSX) throw new Error("spreadsheet library not loaded");
    var wb = XLSX.read(ab, { cellDates: false });
    var ws = wb.Sheets[wb.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(ws, { defval: "", raw: true });
    var norm = [], sigParts = [];
    rows.forEach(function (o) {
      var regNo = String(pick(o, /reg/i) || "").trim();
      var applicant = String(pick(o, /applic|worker|name/i) || "").trim();
      var from = toDMY(pick(o, /from|work.*from|demand.*from/i));
      var daysRaw = String(pick(o, /day/i) || "").replace(/[^0-9]/g, "");
      if (!regNo && !applicant) return;                 // skip blank lines
      norm.push({ regNo: regNo, applicant: applicant, from: from, days: daysRaw, village: villageFromReg(regNo) });
      sigParts.push(regNo + "|" + applicant.toLowerCase() + "|" + from + "|" + daysRaw);
    });
    if (!norm.length) throw new Error("no data rows found (need columns: Reg No, Applicant, Work From, No of Days)");

    // group by registration, preserve order
    var groups = [], byReg = {}, appDate = todayDMY();
    norm.forEach(function (n) {
      var key = n.village + "::" + n.regNo;
      if (!byReg[key]) { byReg[key] = { village: n.village, regNo: n.regNo, attempts: 0, workers: [] }; groups.push(byReg[key]); }
      byReg[key].workers.push({ applicant: n.applicant, from: n.from, days: n.days, appDate: appDate, status: "pending", message: "", at: 0 });
    });
    return {
      v: 1, sig: hashStr(sigParts.join("~")), createdAt: Date.now(), updatedAt: Date.now(),
      active: false, stopRequested: false, consecFail: 0, pendingProceed: null, groups: groups, log: []
    };
  }

  /* ---------------------- run summary ---------------------- */
  function counts(r) {
    var t = 0, done = 0, err = 0, skip = 0, pend = 0;
    (r.groups || []).forEach(function (g) {
      (g.workers || []).forEach(function (w) {
        t++;
        if (w.status === "done") done++;
        else if (w.status === "error") err++;
        else if (w.status === "skipped") skip++;
        else pend++;
      });
    });
    return { total: t, done: done, err: err, skip: skip, pend: pend, groups: (r.groups || []).length };
  }
  function formatTs(ms) {
    if (!ms) return "";
    var d = new Date(ms); if (isNaN(d.getTime())) return "";
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear() + " " +
      pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
  }

  /* ---------------------- panel ---------------------- */
  function status(msg, kind) { if (!sel.st) return; sel.st.textContent = msg || ""; sel.st.className = "st" + (kind ? " " + kind : ""); }

  function render() {
    maybeShowRate();
    var r = loadRun();
    var active = !!(r && r.active);
    if (wasActive && !active) onRunEnded(r);   // run just ended — may auto-export + clear the grid
    wasActive = active;
    r = loadRun();                             // re-read: onRunEnded may have cleared the run
    if (!r || !r.groups) {
      sel.summary.textContent = "No sheet loaded.";
      sel.tbody.innerHTML = ""; sel.logbox.innerHTML = "";
      if (sel.prog) sel.prog.hidden = true;
      sel.start.disabled = true; sel.stop.disabled = true; sel.over.disabled = true; sel.exp.disabled = true;
      if (sel.clear) sel.clear.disabled = true;
      if (sel.dl) sel.dl.disabled = false;   // persisted log may still be downloadable
      return;
    }
    var c = counts(r);
    sel.summary.textContent = c.groups + " registration(s), " + c.total + " worker(s) — " +
      c.done + " done" + (c.err ? ", " + c.err + " error" : "") + (c.skip ? ", " + c.skip + " skipped" : "") + ", " + c.pend + " pending" + (r.active ? "  ·  running…" : "");

    // progress bar (visible only while a run is active)
    if (sel.prog) {
      var processed = c.done + c.err + c.skip;
      var pct = c.total ? Math.round(processed / c.total * 100) : 0;
      if (sel.progfill) sel.progfill.style.width = pct + "%";
      if (sel.progtxt) sel.progtxt.textContent = processed + "/" + c.total + " (" + pct + "%)";
      sel.prog.hidden = !r.active;
    }

    // rows
    var html = "", n = 0;
    r.groups.forEach(function (g) {
      g.workers.forEach(function (w) {
        n++;
        var cls = w.status === "done" ? "ok" : w.status === "error" ? "err" : (w.status === "skipped" || w.status === "filled") ? "warn" : "";
        var sy = w.status === "done" ? "✓" : w.status === "error" ? "✕" : w.status === "skipped" ? "⊘" : w.status === "filled" ? "…" : "•";
        html += "<tr>" +
          "<td class='c'>" + n + "</td>" +
          "<td title='" + esc(g.regNo) + "'>" + esc(shortReg(g.regNo)) + "</td>" +
          "<td>" + esc(w.applicant) + "</td>" +
          "<td class='c'>" + esc(w.from) + "</td>" +
          "<td class='c'>" + esc(w.days) + "</td>" +
          "<td class='c st-" + cls + "' title='" + esc(w.message || "") + "'>" + sy + "</td>" +
          "</tr>";
      });
    });
    sel.tbody.innerHTML = html;

    // log (latest 40)
    var lg = (r.log || []).slice(-40).reverse().map(function (e) {
      var cl = e.level === "err" ? "l-err" : e.level === "warn" ? "l-warn" : e.level === "ok" ? "l-ok" : "l-info";
      return "<div class='" + cl + "'>" + esc(e.text) + "</div>";
    }).join("");
    sel.logbox.innerHTML = lg;

    persistLog(r);   // durably mirror the activity log to chrome.storage.local

    sel.start.disabled = r.active || c.pend === 0;
    sel.start.textContent = (c.done || c.err) ? ("▶ Resume (" + c.done + "/" + c.total + " done)") : ("▶ Start (" + c.total + " worker" + (c.total === 1 ? "" : "s") + ")");
    sel.stop.disabled = !r.active;
    sel.over.disabled = r.active;
    sel.exp.disabled = c.total === 0;
    if (sel.clear) sel.clear.disabled = r.active;
    if (sel.dl) sel.dl.disabled = false;
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (m) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]; }); }
  function shortReg(r) { var p = String(r || "").split("/"); return p.length > 1 ? "…/" + p[p.length - 1] : r; }

  /* ---------------------- actions ---------------------- */
  function onFile(file) {
    var r = loadRun();
    if (r && r.active) { status("A run is in progress — Stop it before loading a new sheet.", "warn"); return; }
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var run = parseWorkbook(fr.result);
        dbg("parsed sheet", { registrations: run.groups.length, workers: counts(run).total, sig: run.sig });
        var prev = loadRun();
        if (prev && prev.sig === run.sig && prev.groups) {   // same sheet → keep progress (resume)
          run = prev; run.active = false; run.stopRequested = false;
          status("Same sheet recognised — resuming where it left off.", "ok");
        } else {
          status("Loaded " + counts(run).total + " worker(s). Review, then Start.", "ok");
        }
        if (!run.runId) run.runId = "wd-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
        saveRun(run); render();
      } catch (e) { status("Could not read that file: " + (e && e.message ? e.message : e), "warn"); }
    };
    fr.onerror = function () { status("Could not read that file.", "warn"); };
    fr.readAsArrayBuffer(file);
  }

  function doStart() {
    var r = loadRun(); if (!r) return;
    r.active = true; r.stopRequested = false; r.consecFail = 0;
    (r.log = r.log || []).push({ t: Date.now(), level: "info", text: "Run started." });
    saveRun(r); wasActive = true; render();
    dbg("start clicked", counts(r));
    post("start");
  }
  function doStop() {
    var r = loadRun(); if (!r) return;
    r.stopRequested = true; r.active = false; saveRun(r);
    post("stop"); render();
    status("Stopping… the current registration will not be submitted; Resume continues from here.", "warn");
  }
  function doStartOver() {
    var r = loadRun(); if (!r) return;
    r.groups.forEach(function (g) { g.attempts = 0; g.workers.forEach(function (w) { w.status = "pending"; w.message = ""; w.at = 0; }); });
    r.active = false; r.stopRequested = false; r.consecFail = 0; r.pendingProceed = null; r.log = [];
    try { localStorage.removeItem(LS_ALERT); } catch (e) {}
    saveRun(r); render(); status("Reset — all rows pending.", "ok");
  }
  // Wipe the loaded sheet and all queued rows (back to "No sheet loaded"). No confirm.
  function clearQueue() {
    try { localStorage.removeItem(LS_RUN); } catch (e) {}
    try { localStorage.removeItem(LS_ALERT); } catch (e) {}
    wasActive = false;
    render();
  }
  // Clear the loaded sheet and all queued rows entirely (button — asks first).
  function doClear() {
    var r = loadRun();
    if (r && r.active) { status("Stop the run before clearing the queue.", "warn"); return; }
    if (!r || !r.groups || !r.groups.length) { status("Nothing to clear.", "ok"); return; }
    var c = counts(r);
    var msg = "Clear the loaded sheet and all " + c.total + " queued row(s)?" +
      ((c.done || c.err) ? "\n\n" + c.done + " done / " + c.err + " error will be discarded — export first if you need a record." : "");
    if (!confirm(msg)) return;
    dbg("queue cleared by user", c);
    clearQueue();
    status("Queue cleared. Choose an Excel file to load a new one.", "ok");
  }
  function doExport(runArg) {
    var r = runArg || loadRun(); if (!r || !window.XLSX) return false;
    var aoa = [["Reg No", "Applicant", "Work From", "No of Days", "Date of Application", "Status", "Entry Result", "Timestamp"]];
    r.groups.forEach(function (g) {
      g.workers.forEach(function (w) {
        aoa.push([g.regNo, w.applicant, w.from, w.days, w.appDate,
          (w.status === "done" ? "Success" : w.status === "error" ? "Error" : w.status === "skipped" ? "Skipped" : w.status),
          w.message || "", formatTs(w.at)]);
      });
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Work Demand");
    var d = new Date(), name = "WorkDemand-results-" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + ".xlsx";
    dbg("export results", name, (aoa.length - 1) + " rows");
    XLSX.writeFile(wb, name);
    return true;
  }
  // Export results button: write the .xlsx, then clear the queue (unless a run is still active).
  function onClickExport() {
    var r = loadRun();
    if (!r || !r.groups || !r.groups.length) { status("Nothing to export yet.", "warn"); return; }
    if (!doExport(r)) { status("Export needs the spreadsheet library — reload the page.", "warn"); return; }
    if (r.active) { status("Results exported. (Queue kept — run still active.)", "ok"); return; }
    clearQueue();
    status("Results exported and queue cleared.", "ok");
  }
  // Download the durable activity log (chrome.storage.local, all recent runs) as an .xlsx.
  function doDownloadLog(cb) {
    if (!window.XLSX) { status("Log download needs the spreadsheet library — reload the page.", "warn"); if (cb) cb(false); return; }
    var r = loadRun();
    persistLog(r, function () {              // make sure the latest lines are stored first
      var cs = cstore();
      var write = function (runs) {
        var aoa = [["Run", "Timestamp", "Level", "Message"]];
        (runs || []).forEach(function (run) {
          (run.entries || []).forEach(function (e) {
            aoa.push([run.runId || "", formatTs(e.t), (e.level || "info"), e.text || ""]);
          });
        });
        if (aoa.length <= 1) { status("No activity log to download yet.", "warn"); if (cb) cb(false); return; }
        var ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, "Activity Log");
        var d = new Date(), name = "WorkDemand-activity-log-" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + "-" + pad2(d.getHours()) + pad2(d.getMinutes()) + ".xlsx";
        dbg("download log", name, (aoa.length - 1) + " lines");
        XLSX.writeFile(wb, name);
        if (cb) cb(true, aoa.length - 1);
      };
      if (!cs) { write(r && r.log ? [{ runId: r.runId || "current", entries: r.log }] : []); return; }
      try { cs.get(CS_LOG, function (o) { write((o && o[CS_LOG]) || []); }); } catch (e) { write([]); }
    });
  }
  // Download log button: save the .xlsx, then clear the stored log (and the live panel log when idle).
  function onClickDownloadLog() {
    doDownloadLog(function (ok) {
      if (!ok) return;
      clearLogStore(function () {
        var r = loadRun();
        if (r && !r.active) { r.log = []; saveRun(r); }   // empty the live Activity panel too (only when idle)
        render();
        status("Activity log downloaded and cleared.", "ok");
      });
    });
  }

  // When the whole batch has finished, capture the per-record results to an export
  // (Status + Entry Result + error message), then clear the extension's data grid.
  function onRunEnded(r) {
    if (!r) return;
    var c = counts(r);
    var naturalFinish = c.pend === 0 && (c.done + c.err + c.skip) > 0 && !r.stopRequested;
    dbg("run ended", { done: c.done, error: c.err, skipped: c.skip, pending: c.pend, stopped: !!r.stopRequested, naturalFinish: naturalFinish });
    if (!naturalFinish) return;
    try { localStorage.setItem(LS_RESULTS, JSON.stringify(r)); } catch (e) {}   // safety copy
    var exported = false;
    try { exported = doExport(r); } catch (e) { dbg("export failed", e && e.message); }
    try { localStorage.removeItem(LS_RUN); localStorage.removeItem(LS_ALERT); } catch (e) {}
    wasActive = false;
    status("All " + (c.done + c.err + c.skip) + " record(s) processed — " + c.done + " ok" + (c.err ? ", " + c.err + " error" : "") + (c.skip ? ", " + c.skip + " skipped" : "") +
      (exported ? " · results exported and the grid was cleared." : " · grid cleared (export failed — check pop-up/download settings)."), c.err ? "warn" : "ok");
    dbg("grid cleared after processing");
    if (c.done > 0) recordWin();   // a good moment — count it toward the rate prompt
  }

  /* ---------------------- build panel ---------------------- */
  function buildPanel() {
    // Idempotent: sweep away any panel left by a previous/orphaned content-script context
    // (e.g. after an extension reload, or a bfcache/redirect restore) so only ONE panel exists.
    try {
      var stale = document.querySelectorAll("#dxwd-host");
      for (var s = 0; s < stale.length; s++) stale[s].parentNode && stale[s].parentNode.removeChild(stale[s]);
      if (stale.length) dbg("removed", stale.length, "stale panel(s) before build");
    } catch (e) {}

    var host = document.createElement("div");
    host.id = "dxwd-host";
    host.style.cssText = "position:fixed;top:70px;right:16px;z-index:2147483647;";
    (document.body || document.documentElement).appendChild(host);
    var root = host.attachShadow({ mode: "open" });

    var css = document.createElement("style"); css.textContent = STYLE; root.appendChild(css);
    var box = document.createElement("div"); box.className = "panel"; box.innerHTML = HTML; root.appendChild(box);

    ["hd", "min", "bd", "pick", "file", "summary", "prog", "progfill", "progtxt", "tbl", "tbody", "start", "stop", "over", "exp", "dl", "clear", "st", "logbox", "logo", "ver", "rate", "rate_go", "rate_share", "rate_x"]
      .forEach(function (id) { sel[id] = root.getElementById("dx_" + id); });

    try {
      if (sel.logo && chrome && chrome.runtime && chrome.runtime.getURL) sel.logo.src = chrome.runtime.getURL("icons/icon48.png");
      if (sel.ver && chrome && chrome.runtime && chrome.runtime.getManifest) sel.ver.textContent = chrome.runtime.getManifest().version;
    } catch (e) {}

    if (sel.rate_go) sel.rate_go.addEventListener("click", function () { try { window.open(STORE_URL + "/reviews", "_blank", "noopener"); } catch (e) {} snoozeRate(); });
    if (sel.rate_share) sel.rate_share.addEventListener("click", function () {
      try { if (navigator.clipboard) { navigator.clipboard.writeText(STORE_URL); status("Store link copied — share it!", "ok"); } else { window.open(STORE_URL, "_blank", "noopener"); } } catch (e) { try { window.open(STORE_URL, "_blank", "noopener"); } catch (e2) {} }
      snoozeRate();
    });
    if (sel.rate_x) sel.rate_x.addEventListener("click", snoozeRate);
    maybeShowRate();

    sel.pick.addEventListener("click", function () { sel.file.click(); });
    sel.file.addEventListener("change", function (e) { if (e.target.files && e.target.files[0]) onFile(e.target.files[0]); e.target.value = ""; });
    sel.start.addEventListener("click", doStart);
    sel.stop.addEventListener("click", doStop);
    sel.over.addEventListener("click", doStartOver);
    sel.exp.addEventListener("click", onClickExport);
    sel.dl.addEventListener("click", onClickDownloadLog);
    sel.clear.addEventListener("click", doClear);
    sel.min.addEventListener("click", function () {
      sel.bd.style.display = sel.bd.style.display === "none" ? "block" : "none";
      sel.min.textContent = sel.bd.style.display === "none" ? "+" : "–";
    });
    makeDraggable(box, sel.hd);
    render();
  }

  function makeDraggable(box, handle) {
    var sx, sy, ox, oy, drag = false; handle.style.cursor = "move";
    handle.addEventListener("mousedown", function (e) {
      if (e.target === sel.min) return; drag = true; sx = e.clientX; sy = e.clientY;
      var host = document.getElementById("dxwd-host"); var rr = host.getBoundingClientRect(); ox = rr.left; oy = rr.top;
      host.style.right = "auto"; e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return; var host = document.getElementById("dxwd-host");
      host.style.left = (ox + e.clientX - sx) + "px"; host.style.top = (oy + e.clientY - sy) + "px";
    });
    document.addEventListener("mouseup", function () { drag = false; });
  }

  var HTML =
    "<div class='hd' id='dx_hd'><span class='hdl'><img class='logo' id='dx_logo' alt=''><b>GramG Ninja · Work Demand Automation</b></span><button class='mn' id='dx_min'>–</button></div>" +
    "<div class='bd' id='dx_bd'>" +
    "<div class='rate' id='dx_rate' hidden><span class='rate-msg'>⭐ Finding GramG Ninja useful? Please rate &amp; share.</span><span class='rate-btns'><button class='rlink' id='dx_rate_go'>Rate</button><button class='rlink' id='dx_rate_share'>Share</button><button class='rx' id='dx_rate_x' title='Later'>×</button></span></div>" +
    "<button class='btn pick' id='dx_pick'>① Choose Excel (.xlsx)…</button>" +
    "<input type='file' id='dx_file' accept='.xlsx,.xls' style='display:none'>" +
    "<div class='summary' id='dx_summary'>No sheet loaded.</div>" +
    "<div class='prog' id='dx_prog' hidden><div class='progbar'><div class='progfill' id='dx_progfill'></div></div><div class='progtxt' id='dx_progtxt'></div></div>" +
    "<div class='scroll'><table id='dx_tbl'><thead><tr><th>#</th><th>Reg</th><th>Applicant</th><th>From</th><th>Days</th><th>St</th></tr></thead><tbody id='dx_tbody'></tbody></table></div>" +
    "<div class='btnrow'><button class='btn fill' id='dx_start'>▶ Start</button><button class='btn stop' id='dx_stop'>■ Stop</button></div>" +
    "<div class='btnrow'><button class='btn ghost' id='dx_over'>↺ Start over</button><button class='btn ghost' id='dx_exp'>⭳ Export results</button></div>" +
    "<div class='btnrow'><button class='btn ghost' id='dx_dl'>📄 Download log</button><button class='btn ghost danger' id='dx_clear'>🗑 Clear queue</button></div>" +
    "<div class='st' id='dx_st'></div>" +
    "<div class='sec'>Activity</div><div class='logbox' id='dx_logbox'></div>" +
    "<div class='disclaimer'>⚠ Automated entry can make mistakes. This tool assists — it does not replace you. Review every row, keep a person in the loop, and verify demands on the portal before relying on them. Use at your own responsibility.</div>" +
    "<div class='foot'><a class='vt' href='https://visiontech.com.in' target='_blank' rel='noopener'><b>VisionTech</b></a> — Vision Technologies &amp; Robotics · VB-G RAM G utilities · v<span id='dx_ver'></span></div>" +
    "</div>";

  var STYLE =
    ".panel{width:360px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1a1a1a;background:#fff;border:1px solid #224aaa;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);overflow:hidden}" +
    ".hd{background:#224aaa;color:#fff;padding:8px 10px;display:flex;align-items:center;justify-content:space-between}" +
    ".hd b{font-size:12.5px;font-weight:600}" +
    ".hdl{display:flex;align-items:center;gap:7px;min-width:0}" +
    ".logo{width:20px;height:20px;border-radius:4px;flex:0 0 auto;background:#fff}" +
    ".mn{cursor:pointer;background:rgba(255,255,255,.2);border:none;color:#fff;width:22px;height:22px;border-radius:5px;font-size:15px;line-height:1;flex:0 0 auto}" +
    ".bd{padding:10px;max-height:80vh;overflow:auto}" +
    ".btn{padding:8px 9px;border:none;border-radius:7px;font-size:12.5px;font-weight:600;cursor:pointer}" +
    ".btn.pick{width:100%;background:#eef2fb;color:#224aaa;border:1px solid #224aaa;margin-bottom:8px}" +
    ".btnrow{display:flex;gap:6px;margin-top:6px}.btnrow .btn{flex:1}" +
    ".btn.fill{background:#0A66C2;color:#fff}.btn.fill:hover{background:#0952a0}.btn.fill:disabled{background:#9bbce0;cursor:not-allowed}" +
    ".btn.stop{background:#c5221f;color:#fff}.btn.stop:disabled{background:#e6a6a4;cursor:not-allowed}" +
    ".btn.ghost{background:#f2f4f8;color:#334;border:1px solid #d7dce6}.btn.ghost:disabled{color:#aab;cursor:not-allowed}" +
    ".btn.ghost.danger{background:#fdecea;color:#c5221f;border-color:#f3b4b0}.btn.ghost.danger:hover{background:#fbdbd8}.btn.ghost.danger:disabled{background:#f2f4f8;color:#c9a9a8;border-color:#e6d3d2}" +
    ".summary{font-size:11.5px;color:#224aaa;background:#eef3fb;border-radius:7px;padding:6px 8px;margin:8px 0;line-height:1.35}" +
    ".prog{margin:8px 0}" +
    ".progbar{height:8px;background:#e6e9f0;border-radius:5px;overflow:hidden}" +
    ".progfill{height:100%;width:0;background:#0A66C2;transition:width .3s}" +
    ".progtxt{margin-top:4px;font-size:11px;text-align:center;color:#224aaa;font-weight:600}" +
    ".scroll{max-height:210px;overflow:auto;border:1px solid #e6e9f0;border-radius:7px}" +
    "table{border-collapse:collapse;width:100%;font-size:11px}" +
    "th,td{border-bottom:1px solid #eef0f4;padding:3px 6px;text-align:left}" +
    "th{position:sticky;top:0;background:#f4f6fb;color:#224aaa;font-weight:600}" +
    "td.c,th:nth-child(1),th:nth-child(4),th:nth-child(5),th:nth-child(6){text-align:center}" +
    ".st-ok{color:#137333;font-weight:700}.st-err{color:#c5221f;font-weight:700}.st-warn{color:#9a6700;font-weight:700}" +
    ".st{margin-top:8px;font-size:11.5px;padding:6px 8px;border-radius:6px;background:#f2f4f8;min-height:15px;line-height:1.35}" +
    ".st.ok{background:#e7f4ec;color:#137333}.st.warn{background:#fef7e0;color:#9a6700}" +
    ".sec{font-weight:700;color:#224aaa;margin:10px 0 6px;border-top:1px solid #e6e9f0;padding-top:8px;font-size:12px}" +
    ".logbox{max-height:130px;overflow:auto;font-size:10.5px;line-height:1.4;background:#fbfcfe;border:1px solid #eef0f4;border-radius:6px;padding:5px 7px}" +
    ".logbox div{padding:1px 0;border-bottom:1px dotted #eef0f4}" +
    ".l-err{color:#c5221f}.l-warn{color:#9a6700}.l-ok{color:#137333}.l-info{color:#5b6472}" +
    ".disclaimer{margin-top:9px;font-size:9.5px;color:#8a92a0;line-height:1.35;background:#fbfbfd;border:1px solid #eef0f4;border-radius:6px;padding:5px 7px}" +
    ".foot{margin-top:8px;text-align:center;font-size:10px;color:#8a92a0;line-height:1.35}" +
    ".foot a.vt{color:#224aaa;text-decoration:none}.foot a.vt:hover{text-decoration:underline}" +
    ".rate{display:flex;align-items:center;justify-content:space-between;gap:6px;background:#fff8e6;border:1px solid #f2d98a;border-radius:7px;padding:6px 8px;margin-bottom:8px;font-size:11px;color:#7a5a00}" +
    ".rate-msg{line-height:1.3}.rate-btns{display:flex;gap:4px;flex:0 0 auto}" +
    ".rlink{background:#224aaa;color:#fff;border:none;border-radius:5px;padding:3px 8px;font-size:11px;font-weight:600;cursor:pointer}.rlink:hover{background:#1a3a86}" +
    ".rx{background:transparent;border:none;color:#9a6700;font-size:15px;line-height:1;cursor:pointer;padding:0 2px}";

  /* ---------------------- sync with engine ---------------------- */
  window.addEventListener("message", function (ev) {
    if (!ev.data || ev.data.source !== "DXWD_DRV") return;   // don't require ev.source===window (cross-world)
    if (ev.data.type === "sync") render();
  });
  setInterval(render, 1500);   // fallback poll (same-document writes don't fire storage events)

  dbg("panel loaded (isolated world) on", location.pathname, "· debug ON — set localStorage dxwd_debug=0 to silence");
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildPanel);
  else buildPanel();
})();
