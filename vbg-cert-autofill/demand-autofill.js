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

  var LS_RUN = "dxwd_run", LS_ALERT = "dxwd_lastAlert";
  var STATE_MAP = { WB: "32" };            // LGD state code (West Bengal). Extend if needed.
  var sel = {};

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
  function villageFromReg(regNo) {
    var jc = String(regNo || "").split("/")[0].trim();
    var m = jc.match(/^([A-Za-z]{2})[-\s]?(.+)$/);
    if (!m) return "";
    var code = STATE_MAP[m[1].toUpperCase()]; if (!code) return "";
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
    var t = 0, done = 0, err = 0, pend = 0;
    (r.groups || []).forEach(function (g) {
      (g.workers || []).forEach(function (w) { t++; if (w.status === "done") done++; else if (w.status === "error") err++; else pend++; });
    });
    return { total: t, done: done, err: err, pend: pend, groups: (r.groups || []).length };
  }

  /* ---------------------- panel ---------------------- */
  function status(msg, kind) { if (!sel.st) return; sel.st.textContent = msg || ""; sel.st.className = "st" + (kind ? " " + kind : ""); }

  function render() {
    var r = loadRun();
    if (!r || !r.groups) {
      sel.summary.textContent = "No sheet loaded.";
      sel.tbody.innerHTML = ""; sel.logbox.innerHTML = "";
      sel.start.disabled = true; sel.stop.disabled = true; sel.over.disabled = true; sel.exp.disabled = true;
      return;
    }
    var c = counts(r);
    sel.summary.textContent = c.groups + " registration(s), " + c.total + " worker(s) — " +
      c.done + " done" + (c.err ? ", " + c.err + " error" : "") + ", " + c.pend + " pending" + (r.active ? "  ·  running…" : "");

    // rows
    var html = "", n = 0;
    r.groups.forEach(function (g) {
      g.workers.forEach(function (w) {
        n++;
        var cls = w.status === "done" ? "ok" : w.status === "error" ? "err" : w.status === "filled" ? "warn" : "";
        var sy = w.status === "done" ? "✓" : w.status === "error" ? "✕" : w.status === "filled" ? "…" : "•";
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

    sel.start.disabled = r.active || c.pend === 0;
    sel.start.textContent = (c.done || c.err) ? ("▶ Resume (" + c.done + "/" + c.total + " done)") : ("▶ Start (" + c.total + " worker" + (c.total === 1 ? "" : "s") + ")");
    sel.stop.disabled = !r.active;
    sel.over.disabled = r.active;
    sel.exp.disabled = c.total === 0;
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
        var prev = loadRun();
        if (prev && prev.sig === run.sig && prev.groups) {   // same sheet → keep progress (resume)
          run = prev; run.active = false; run.stopRequested = false;
          status("Same sheet recognised — resuming where it left off.", "ok");
        } else {
          status("Loaded " + counts(run).total + " worker(s). Review, then Start.", "ok");
        }
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
    saveRun(r); render();
    post("start");
  }
  function doStop() {
    var r = loadRun(); if (!r) return;
    r.stopRequested = true; r.active = false; saveRun(r);
    post("stop"); render();
    status("Stopping… the current worker finishes and is saved.", "warn");
  }
  function doStartOver() {
    var r = loadRun(); if (!r) return;
    r.groups.forEach(function (g) { g.attempts = 0; g.workers.forEach(function (w) { w.status = "pending"; w.message = ""; w.at = 0; }); });
    r.active = false; r.stopRequested = false; r.consecFail = 0; r.pendingProceed = null; r.log = [];
    try { localStorage.removeItem(LS_ALERT); } catch (e) {}
    saveRun(r); render(); status("Reset — all rows pending.", "ok");
  }
  function doExport() {
    var r = loadRun(); if (!r || !window.XLSX) return;
    var aoa = [["Reg No", "Applicant", "Work From", "No of Days", "Date of Application", "Status", "Message", "When"]];
    r.groups.forEach(function (g) {
      g.workers.forEach(function (w) {
        aoa.push([g.regNo, w.applicant, w.from, w.days, w.appDate, w.status, w.message || "", w.at ? new Date(w.at).toLocaleString() : ""]);
      });
    });
    var ws = XLSX.utils.aoa_to_sheet(aoa), wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Work Demand");
    var d = new Date(), name = "WorkDemand-results-" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + ".xlsx";
    XLSX.writeFile(wb, name);
  }

  /* ---------------------- build panel ---------------------- */
  function buildPanel() {
    var host = document.createElement("div");
    host.id = "dxwd-host";
    host.style.cssText = "position:fixed;top:70px;right:16px;z-index:2147483647;";
    (document.body || document.documentElement).appendChild(host);
    var root = host.attachShadow({ mode: "open" });

    var css = document.createElement("style"); css.textContent = STYLE; root.appendChild(css);
    var box = document.createElement("div"); box.className = "panel"; box.innerHTML = HTML; root.appendChild(box);

    ["hd", "min", "bd", "pick", "file", "summary", "tbl", "tbody", "start", "stop", "over", "exp", "st", "logbox"]
      .forEach(function (id) { sel[id] = root.getElementById("dx_" + id); });

    sel.pick.addEventListener("click", function () { sel.file.click(); });
    sel.file.addEventListener("change", function (e) { if (e.target.files && e.target.files[0]) onFile(e.target.files[0]); e.target.value = ""; });
    sel.start.addEventListener("click", doStart);
    sel.stop.addEventListener("click", doStop);
    sel.over.addEventListener("click", doStartOver);
    sel.exp.addEventListener("click", doExport);
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
    "<div class='hd' id='dx_hd'><b>GramG Ninja · Work Demand autofill</b><button class='mn' id='dx_min'>–</button></div>" +
    "<div class='bd' id='dx_bd'>" +
    "<button class='btn pick' id='dx_pick'>① Choose Excel (.xlsx)…</button>" +
    "<input type='file' id='dx_file' accept='.xlsx,.xls' style='display:none'>" +
    "<div class='summary' id='dx_summary'>No sheet loaded.</div>" +
    "<div class='scroll'><table id='dx_tbl'><thead><tr><th>#</th><th>Reg</th><th>Applicant</th><th>From</th><th>Days</th><th>St</th></tr></thead><tbody id='dx_tbody'></tbody></table></div>" +
    "<div class='btnrow'><button class='btn fill' id='dx_start'>▶ Start</button><button class='btn stop' id='dx_stop'>■ Stop</button></div>" +
    "<div class='btnrow'><button class='btn ghost' id='dx_over'>↺ Start over</button><button class='btn ghost' id='dx_exp'>⭳ Export results</button></div>" +
    "<div class='st' id='dx_st'></div>" +
    "<div class='sec'>Activity</div><div class='logbox' id='dx_logbox'></div>" +
    "<div class='foot'><b>VisionTech</b> — Vision Technologies &amp; Robotics · VB-G RAM G utilities</div>" +
    "</div>";

  var STYLE =
    ".panel{width:360px;font-family:Segoe UI,Arial,sans-serif;font-size:13px;color:#1a1a1a;background:#fff;border:1px solid #224aaa;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.28);overflow:hidden}" +
    ".hd{background:#224aaa;color:#fff;padding:8px 10px;display:flex;align-items:center;justify-content:space-between}" +
    ".hd b{font-size:12.5px;font-weight:600}" +
    ".mn{cursor:pointer;background:rgba(255,255,255,.2);border:none;color:#fff;width:22px;height:22px;border-radius:5px;font-size:15px;line-height:1}" +
    ".bd{padding:10px;max-height:80vh;overflow:auto}" +
    ".btn{padding:8px 9px;border:none;border-radius:7px;font-size:12.5px;font-weight:600;cursor:pointer}" +
    ".btn.pick{width:100%;background:#eef2fb;color:#224aaa;border:1px solid #224aaa;margin-bottom:8px}" +
    ".btnrow{display:flex;gap:6px;margin-top:6px}.btnrow .btn{flex:1}" +
    ".btn.fill{background:#0A66C2;color:#fff}.btn.fill:hover{background:#0952a0}.btn.fill:disabled{background:#9bbce0;cursor:not-allowed}" +
    ".btn.stop{background:#c5221f;color:#fff}.btn.stop:disabled{background:#e6a6a4;cursor:not-allowed}" +
    ".btn.ghost{background:#f2f4f8;color:#334;border:1px solid #d7dce6}.btn.ghost:disabled{color:#aab;cursor:not-allowed}" +
    ".summary{font-size:11.5px;color:#224aaa;background:#eef3fb;border-radius:7px;padding:6px 8px;margin:8px 0;line-height:1.35}" +
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
    ".foot{margin-top:9px;text-align:center;font-size:10px;color:#8a92a0;line-height:1.35}";

  /* ---------------------- sync with engine ---------------------- */
  window.addEventListener("message", function (ev) {
    if (ev.source !== window || !ev.data || ev.data.source !== "DXWD_DRV") return;
    if (ev.data.type === "sync") render();
  });
  setInterval(render, 1500);   // fallback poll (same-document writes don't fire storage events)

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", buildPanel);
  else buildPanel();
})();
