(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  var rnd = function (x) { return Math.round(x + 1e-9); };
  var inr = function (n) { return Number(n).toLocaleString("en-IN"); };
  var num = function (v, d) { var n = parseFloat(String(v == null ? "" : v).replace(/[,₹\s]/g, "")); return isNaN(n) ? (d == null ? 0 : d) : n; };
  var blank = function (v) { return v === undefined || v === null || String(v).trim() === ""; };
  var yes = function (v, d) { return blank(v) ? d : /^(y|yes|true|1|active)$/i.test(String(v).trim()); };

  var DEFAULT_RATES = { mpf: 12, pmpf: 12, eps: 8.33, er: 12, epsCeil: 15000, edliCeil: 15000, edli: 0.5 };

  /* ================= state ================= */
  var S = { rates: Object.assign({}, DEFAULT_RATES), employees: [], months: {}, cur: null, view: "contribution", editUan: null, ratesDirty: false, cid: null, viaAdmin: false };

  function monthLabel(k) {
    var p = String(k).split("-"); if (p.length !== 2) return k;
    return new Date(+p[0], +p[1] - 1, 1).toLocaleString("en-IN", { month: "long", year: "numeric" });
  }
  function nextMonth(k) { var p = k.split("-"); var y = +p[0], m = +p[1] + 1; if (m > 12) { m = 1; y++; } return y + "-" + (m < 10 ? "0" : "") + m; }
  function prevMonthOfToday() { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2); }
  function fyOf(k) { var p = k.split("-"), y = +p[0], m = +p[1]; var s = m >= 4 ? y : y - 1; return s + "-" + String((s + 1) % 100).padStart(2, "0"); }

  /* ================= toast ================= */
  var toastT;
  function toast(msg) {
    var t = $("#toast"); t.textContent = msg; t.classList.add("on");
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove("on"); }, 4200);
  }

  /* ================= server calls ================= */
  var chains = {};
  function queue(path, fn) {
    var p = (chains[path] || Promise.resolve()).then(fn, fn);
    chains[path] = p.catch(function () {});
    return p;
  }
  var onExpired = null;
  function api(method, url, body) {
    var opt = { method: method, headers: { "X-Requested-With": "pfs" }, credentials: "same-origin" };
    if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    return fetch(url, opt).then(function (r) {
      return r.text().then(function (t) {
        var j = null; try { j = t ? JSON.parse(t) : null; } catch (e) { /* not JSON */ }
        if (!r.ok) {
          var err = new Error((j && j.error) || ("Request failed (" + r.status + ")"));
          err.status = r.status;
          if (r.status === 401 && onExpired && url.indexOf("/login") < 0 && url !== "/api/me") onExpired();
          throw err;
        }
        return j;
      });
    }, function () { throw new Error("The server could not be reached. Check your connection."); });
  }

  /* the app addresses data by path; each path maps to one API route */
  var store = {
    load: function () { return api("GET", "/api/data"); },
    set: function (path, data) {
      var p = path.split("/");
      return queue(path, function () {
        if (p[0] === "config") return api("PUT", "/api/rates", data);
        if (p[0] === "employees") return api("PUT", "/api/employees/" + encodeURIComponent(p[1]), data);
        if (p[0] === "months") return api("PUT", "/api/months/" + encodeURIComponent(p[1]), data);
        return Promise.reject(new Error("Unknown path"));
      });
    },
    del: function (path) {
      var p = path.split("/");
      return queue(path, function () {
        if (p[0] === "employees") return api("DELETE", "/api/employees/" + encodeURIComponent(p[1]));
        if (p[0] === "months") return api("DELETE", "/api/months/" + encodeURIComponent(p[1]));
        return Promise.reject(new Error("Unknown path"));
      });
    }
  };

  function errText(e) { return e && e.message ? e.message : "Unknown error"; }

  /* ================= calculation ================= */
  function calc(row, c) {
    var pf = rnd(row.pf || 0), pen = !!row.pension;
    var epsW = pen ? (c.epsCeil > 0 ? Math.min(pf, c.epsCeil) : pf) : 0;
    var edliW = c.edliCeil > 0 ? Math.min(pf, c.edliCeil) : pf;
    var mpfRate = pen ? (row.mpf != null ? +row.mpf : c.pmpf) : c.mpf;
    var mpf = rnd(pf * mpfRate / 100);
    var vpf = rnd(row.vpf || 0);
    var eps = pen ? rnd(epsW * c.eps / 100) : 0;
    var er = rnd(pf * c.er / 100);
    var cpf = Math.max(0, er - eps);
    var edli = rnd(edliW * c.edli / 100);
    return { pf: pf, epsW: epsW, edliW: edliW, mpf: mpf, vpf: vpf, ee: mpf + vpf, eps: eps, cpf: cpf, edli: edli, total: mpf + vpf + eps + cpf };
  }
  function flags(row) {
    var f = [];
    if (!/^\d{12}$/.test(String(row.uan || ""))) f.push("UAN not 12 digits");
    if (!row.name || !String(row.name).trim()) f.push("Name missing");
    if (!(row.pf > 0) && !(row.ncp > 0)) f.push("Wages not entered");
    if (row.pf > 0 && !(row.gross >= row.pf)) f.push("PF wages above gross");
    if (!(Number.isInteger(row.ncp) && row.ncp >= 0 && row.ncp <= 31)) f.push("NCP days");
    return f;
  }
  function sumRows(rows, c) {
    var s = { n: rows.length, gross: 0, pf: 0, epsW: 0, edliW: 0, mpf: 0, vpf: 0, ee: 0, eps: 0, cpf: 0, edli: 0, total: 0, ncp: 0 };
    rows.forEach(function (r) {
      var k = calc(r, c);
      s.gross += rnd(r.gross || 0); s.pf += k.pf; s.epsW += k.epsW; s.edliW += k.edliW; s.mpf += k.mpf; s.vpf += k.vpf;
      s.ee += k.ee; s.eps += k.eps; s.cpf += k.cpf; s.edli += k.edli; s.total += k.total; s.ncp += r.ncp || 0;
    });
    return s;
  }
  function ecrName(n) { return String(n || "").toUpperCase().replace(/[^A-Z .]/g, "").replace(/\s+/g, " ").trim(); }
  function ecrLine(row, c) {
    var k = calc(row, c);
    return [row.uan, ecrName(row.name), rnd(row.gross || 0), k.pf, k.epsW, k.edliW, k.ee, k.eps, k.cpf, row.ncp || 0, rnd(row.refund || 0)].join("#~#");
  }
  function ratesFor(sheet) { return sheet && sheet.status === "final" && sheet.rates ? sheet.rates : S.rates; }
  function ecrFile(k) { var m = String(k || "").split("-"); return m.length === 2 ? "ECR_" + m[1] + m[0] + ".txt" : "ECR.txt"; }
  function ecrText(sheet) { var c = ratesFor(sheet); return sheet.rows.map(function (r) { return ecrLine(r, c); }).join("\r\n"); }

  /* ================= month documents ================= */
  function packMonth(k, sh) {
    return {
      month: k, status: sh.status, rates: sh.rates || null, updatedAt: new Date().toISOString(),
      rows: sh.rows.map(function (r) { return [r.uan, r.name, r.pension ? 1 : 0, r.mpf, r.gross, r.pf, r.ncp, r.refund, r.vpf]; })
    };
  }
  function unpackMonth(d) {
    return {
      month: d.month, status: d.status === "final" ? "final" : "draft", rates: d.rates || null,
      rows: (d.rows || []).map(function (a) { return { uan: String(a[0]), name: a[1], pension: !!a[2], mpf: a[3] == null ? null : a[3], gross: a[4] || 0, pf: a[5] || 0, ncp: a[6] || 0, refund: a[7] || 0, vpf: a[8] || 0 }; })
    };
  }
  var saveT, saving = 0;
  function setSaveState(t) { $("#savestate").textContent = t; }
  function scheduleSave() {
    var k = S.cur; if (!k || !S.months[k]) return;
    setSaveState("Unsaved changes");
    clearTimeout(saveT); saveT = setTimeout(function () { saveMonthNow(k); }, 700);
  }
  function saveMonthNow(k) {
    clearTimeout(saveT);
    var sh = S.months[k]; if (!sh) return Promise.resolve();
    setSaveState("Saving…"); saving++;
    return store.set("months/" + k, packMonth(k, sh)).then(function () {
      saving--; if (S.cur === k && !saving) setSaveState("All changes saved");
    }, function (e) { saving--; setSaveState("Not saved"); toast("The month could not be saved: " + errText(e)); });
  }

  /* ================= routing ================= */
  function route() {
    if (!S.cid) return;
    var h = (location.hash || "#contribution").slice(1);
    if (["contribution", "reports", "employees", "rates"].indexOf(h) < 0) h = "contribution";
    S.view = h;
    ["contribution", "reports", "employees", "rates"].forEach(function (v) { $("#v-" + v).hidden = v !== h; });
    document.querySelectorAll("#nav a").forEach(function (a) {
      if (a.dataset.view === h) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    if (h === "contribution") renderContribution();
    if (h === "reports") renderReports();
    if (h === "employees") renderEmployees();
    if (h === "rates") renderRates();
  }
  window.addEventListener("hashchange", route);

  /* ================= file helpers ================= */
  var ALIAS = {
    uan: ["uan", "uannumber", "uanno"],
    name: ["name", "membername", "employeename", "employee"],
    gross: ["grosswages", "gross", "grosssalary"],
    pf: ["pfwages", "epfwages", "pfwage", "wages"],
    ncp: ["ncpdays", "ncp", "lop", "lopdays"],
    refund: ["refundofadvances", "refund", "refundadvances"],
    pension: ["pensionmember", "pension", "epsmember", "ispensionmember"],
    vpf: ["vpfamount", "vpf", "standingvpf", "vpfamt"],
    mpf: ["mpfrate", "pensionrate", "mpf"],
    active: ["active", "status"]
  };
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }
  function pick(o, f) {
    var ks = Object.keys(o);
    for (var i = 0; i < ks.length; i++) if (ALIAS[f].indexOf(norm(ks[i])) > -1) return o[ks[i]];
    return undefined;
  }
  function readSheet(file) {
    if (typeof XLSX === "undefined") return Promise.reject(new Error("The spreadsheet reader did not load. Check the connection and reopen the page."));
    return file.arrayBuffer().then(function (buf) {
      var wb = XLSX.read(buf, { type: "array" });
      return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: true });
    });
  }
  var MIME = { txt: "text/plain", csv: "text/csv", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  function saveFile(filename, data) {
    try {
      var ext = filename.split(".").pop().toLowerCase();
      var blob = new Blob([data], { type: (MIME[ext] || "application/octet-stream") + ";charset=utf-8" });
      var url = URL.createObjectURL(blob), a = document.createElement("a");
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
      toast("Saved " + filename + ".");
    } catch (e) { toast("The file could not be saved: " + errText(e)); }
    return Promise.resolve();
  }
  function wireDrop(el, cb) {
    ["dragenter", "dragover"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { el.addEventListener(ev, function (e) { e.preventDefault(); el.classList.remove("over"); }); });
    el.addEventListener("drop", function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) cb(f); });
  }
  function armed(btn, label, armedLabel, action) {
    if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = label; action(); return; }
    btn.dataset.armed = "1"; btn.textContent = armedLabel;
    setTimeout(function () { if (btn.dataset.armed === "1") { btn.dataset.armed = ""; btn.textContent = label; } }, 3500);
  }

  /* ================= RATES page ================= */
  var RATE_FIELDS = { mpf: "r-mpf", pmpf: "r-pmpf", eps: "r-eps", er: "r-er", epsCeil: "r-epsceil", edliCeil: "r-edliceil", edli: "r-edli" };
  function fillRates() {
    Object.keys(RATE_FIELDS).forEach(function (k) { $("#" + RATE_FIELDS[k]).value = S.rates[k]; });
    cpfDerived(); $("#r-state").textContent = "";
  }
  function formRates() {
    var o = {};
    Object.keys(RATE_FIELDS).forEach(function (k) { o[k] = num($("#" + RATE_FIELDS[k]).value, DEFAULT_RATES[k]); });
    return o;
  }
  function cpfDerived() { var r = formRates(); $("#r-cpf").textContent = (Math.round((r.er - r.eps) * 100) / 100) + "%"; }
  function renderRates() { fillRates(); }
  Object.keys(RATE_FIELDS).forEach(function (k) {
    $("#" + RATE_FIELDS[k]).addEventListener("input", function () { cpfDerived(); $("#r-state").textContent = "Unsaved changes"; });
  });
  $("#r-save").addEventListener("click", function () {
    var r = formRates();
    S.rates = r; $("#r-state").textContent = "Saving…";
    store.set("config/rates", Object.assign({}, r, { updatedAt: new Date().toISOString() })).then(function () {
      $("#r-state").textContent = "Saved"; toast("Rates saved. Draft months now use them.");
    }, function (e) { $("#r-state").textContent = "Not saved"; toast("Rates could not be saved: " + errText(e)); });
  });
  $("#r-reset").addEventListener("click", function () {
    Object.keys(RATE_FIELDS).forEach(function (k) { $("#" + RATE_FIELDS[k]).value = DEFAULT_RATES[k]; });
    cpfDerived(); $("#r-state").textContent = "Defaults filled in. Save to apply.";
  });

  /* ================= EMPLOYEES page ================= */
  function findEmp(uan) { for (var i = 0; i < S.employees.length; i++) if (S.employees[i].uan === uan) return S.employees[i]; return null; }
  function empDoc(e) { return { uan: e.uan, name: e.name, pension: !!e.pension, mpf: e.mpf == null ? null : e.mpf, vpf: e.vpf || 0, active: e.active !== false, sample: !!e.sample }; }
  function upsertEmp(e) {
    var i = S.employees.map(function (x) { return x.uan; }).indexOf(e.uan);
    if (i > -1) S.employees[i] = e; else S.employees.push(e);
    return store.set("employees/" + e.uan, empDoc(e));
  }
  function renderEmployees() {
    var q = ($("#e-search").value || "").trim().toLowerCase();
    var list = S.employees.slice().sort(function (a, b) { return (b.sample ? 1 : 0) - (a.sample ? 1 : 0) || a.name.localeCompare(b.name); });
    var active = S.employees.filter(function (e) { return e.active !== false; }).length;
    $("#e-count").textContent = S.employees.length ? "· " + S.employees.length + " total, " + active + " active" : "";
    $("#e-sample").hidden = !S.employees.some(function (e) { return e.sample; });
    var shown = list.filter(function (e) { return !q || e.name.toLowerCase().indexOf(q) > -1 || e.uan.indexOf(q) > -1; });
    $("#e-rows").innerHTML = shown.map(function (e) {
      return "<tr>" +
        '<td class="mono">' + esc(e.uan) + "</td>" +
        '<td class="name">' + esc(e.name) + (e.sample ? ' <span class="tag">example</span>' : "") + "</td>" +
        '<td><span class="tag ' + (e.pension ? "yes" : "") + '">' + (e.pension ? "Yes" : "No") + "</span></td>" +
        '<td class="n">' + (e.mpf == null ? "—" : esc(e.mpf)) + "</td>" +
        '<td class="n">' + inr(e.vpf || 0) + "</td>" +
        "<td>" + (e.active !== false ? '<span class="tag yes">Active</span>' : '<span class="tag">Inactive</span>') + "</td>" +
        '<td><button class="btn link" data-act="edit" data-uan="' + esc(e.uan) + '">Edit</button><button class="btn link danger" data-act="del" data-uan="' + esc(e.uan) + '">Remove</button></td>' +
        "</tr>";
    }).join("");
    $("#e-empty").hidden = S.employees.length > 0;
    mpfToggle();
  }
  function mpfToggle() { var p = $("#epen-yes").checked; $("#e-mpf-wrap").style.opacity = p ? 1 : .45; $("#e-mpf").disabled = !p; }
  function resetEForm() {
    $("#eform").reset(); $("#epen-yes").checked = true; $("#e-active").checked = true; $("#e-vpf").value = 0;
    S.editUan = null; $("#e-uan").disabled = false; $("#e-submit").textContent = "Add employee"; $("#e-cancel").hidden = true;
    $("#emp-form-title").textContent = "Add employee"; mpfToggle();
  }
  $("#eform").addEventListener("change", mpfToggle);
  $("#eform").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var uan = $("#e-uan").value.trim(), name = $("#e-name").value.trim();
    if (!/^\d{12}$/.test(uan)) { toast("UAN must be 12 digits."); $("#e-uan").focus(); return; }
    if (!name) { toast("Enter the member name."); $("#e-name").focus(); return; }
    var mp = $("#e-mpf").value.trim();
    var e = { uan: uan, name: name, pension: $("#epen-yes").checked, mpf: $("#epen-yes").checked && mp !== "" ? num(mp) : null, vpf: num($("#e-vpf").value, 0), active: $("#e-active").checked, sample: false };
    if (!S.editUan && findEmp(uan)) { toast("That UAN is already in the master. Use Edit on its row."); return; }
    upsertEmp(e).then(function () { toast((S.editUan ? "Updated " : "Added ") + name + "."); resetEForm(); renderEmployees(); },
      function (er) { toast("Could not save: " + errText(er)); });
  });
  $("#e-cancel").addEventListener("click", resetEForm);
  $("#e-search").addEventListener("input", renderEmployees);
  $("#e-rows").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-act]"); if (!b) return;
    var uan = b.dataset.uan, e = findEmp(uan); if (!e) return;
    if (b.dataset.act === "edit") {
      S.editUan = uan; $("#e-uan").value = e.uan; $("#e-uan").disabled = true; $("#e-name").value = e.name;
      $(e.pension ? "#epen-yes" : "#epen-no").checked = true; $("#e-mpf").value = e.mpf == null ? "" : e.mpf;
      $("#e-vpf").value = e.vpf || 0; $("#e-active").checked = e.active !== false;
      $("#e-submit").textContent = "Update employee"; $("#e-cancel").hidden = false; $("#emp-form-title").textContent = "Edit employee";
      mpfToggle(); $("#e-name").scrollIntoView({ block: "center" }); $("#e-name").focus();
    } else {
      armed(b, "Remove", "Confirm", function () {
        S.employees = S.employees.filter(function (x) { return x.uan !== uan; });
        store.del("employees/" + uan).then(function () { toast("Removed " + e.name + ". Saved months keep their rows."); renderEmployees(); }, function (er) { toast("Could not remove: " + errText(er)); });
        renderEmployees();
      });
    }
  });
  $("#e-clear-sample").addEventListener("click", function () {
    var ex = S.employees.filter(function (e) { return e.sample; });
    S.employees = S.employees.filter(function (e) { return !e.sample; }); renderEmployees();
    ex.reduce(function (p, e) { return p.then(function () { return store.del("employees/" + e.uan); }); }, Promise.resolve())
      .then(function () { toast("Examples removed."); }, function (er) { toast("Could not remove all examples: " + errText(er)); });
  });

  function importEmployees(list) {
    var jobs = [], skipped = [];
    list.forEach(function (o, i) {
      var uan = String(pick(o, "uan") == null ? "" : pick(o, "uan")).replace(/\D/g, "");
      var name = String(pick(o, "name") == null ? "" : pick(o, "name")).trim();
      if (!uan && !name) return;
      if (!/^\d{12}$/.test(uan)) { skipped.push("row " + (i + 2) + ": UAN is not 12 digits"); return; }
      if (!name) { skipped.push("row " + (i + 2) + ": name missing"); return; }
      var pen = yes(pick(o, "pension"), true), mp = pick(o, "mpf");
      jobs.push({ uan: uan, name: name, pension: pen, mpf: pen && !blank(mp) ? num(mp) : null, vpf: num(pick(o, "vpf"), 0), active: yes(pick(o, "active"), true), sample: false });
    });
    var added = 0, updated = 0, failed = 0;
    var chain = jobs.reduce(function (p, e, idx) {
      return p.then(function () {
        if (findEmp(e.uan)) updated++; else added++;
        return upsertEmp(e).catch(function () { failed++; });
      }).then(function () { if (jobs.length > 40 && idx % 20 === 19) toast("Saving employees… " + (idx + 1) + " of " + jobs.length); });
    }, Promise.resolve());
    chain.then(function () {
      renderEmployees();
      var msg = "Added " + added + ", updated " + updated + ".";
      if (failed) msg += " " + failed + " could not be saved.";
      if (skipped.length) msg += " Skipped " + skipped.length + ": " + skipped.slice(0, 2).join("; ") + (skipped.length > 2 ? "…" : "");
      toast(msg);
    });
  }
  function empFile(f) { readSheet(f).then(function (l) { if (!l.length) toast("No rows found in the first sheet."); else importEmployees(l); }, function (e) { toast(errText(e)); }); }
  $("#e-pick").addEventListener("click", function () { $("#e-file").click(); });
  $("#e-file").addEventListener("change", function () { if (this.files[0]) empFile(this.files[0]); this.value = ""; });
  wireDrop($("#edrop"), empFile);
  $("#e-tpl").addEventListener("click", function () {
    saveFile("pf_employee_master_template.csv", "UAN,Name,Pension Member,VPF Amount,MPF Rate,Active\r\n100000000001,SAMPLE MEMBER ONE,Yes,0,,Yes\r\n100000000002,SAMPLE MEMBER TWO,No,500,,Yes\r\n");
  });

  /* ================= CONTRIBUTION page ================= */
  function curSheet() { return S.months[S.cur] || null; }

  function renderContribution() {
    $("#wm").value = S.cur;
    var sh = curSheet();
    var st = $("#status");
    $("#c-empty").hidden = !!sh; $("#c-summary").hidden = !sh; $("#c-sheet").hidden = !sh;
    if (!sh) {
      st.hidden = true; setSaveState("");
      var has = S.employees.some(function (e) { return e.active !== false; });
      $("#c-empty-text").textContent = has
        ? "No contribution sheet for " + monthLabel(S.cur) + " yet. Starting it lists every active employee with wages, NCP days and refunds at zero."
        : "No active employees in the master yet. Add employees first, then start the month.";
      $("#start").hidden = !has; $("#goto-emp").hidden = has;
      return;
    }
    st.hidden = false; st.className = "chip " + sh.status; st.textContent = sh.status === "final" ? "Finalised" : "Draft";
    renderSheetStructure();
    renderTotals(); renderEcr();
    if (!saving) setSaveState(sh.status === "final" ? "Locked" : "All changes saved");
  }

  function renderSheetStructure() {
    var sh = curSheet(), final = sh.status === "final", c = ratesFor(sh);
    $("#draft-actions").hidden = final; $("#up-hint").hidden = final;
    $("#finalise").hidden = final; $("#reopen").hidden = !final; $("#next-month").hidden = !final;
    $("#final-help").textContent = final
      ? "This month is locked with the rates it was closed with. Reopen it to change wages."
      : "Finalising locks the wages and keeps today's rates with the month. You can reopen it later.";
    $("#thead").innerHTML = "<tr><th>UAN</th><th>Member</th><th>Pension</th>" +
      '<th class="n">Gross ₹</th><th class="n">PF wages ₹</th><th class="n">NCP days</th><th class="n">Refund ₹</th><th class="n">VPF ₹</th>' +
      '<th class="n calc">EPS wages</th><th class="n calc">EDLI wages</th><th class="n calc">MPF</th><th class="n calc">CPF</th><th class="n calc">EPS</th><th class="n calc">EDLI amount</th><th class="n calc">Total</th><th>Check</th>' +
      (final ? "" : "<th></th>") + "</tr>";
    $("#rows").innerHTML = sh.rows.map(function (r, i) {
      var k = calc(r, c);
      function inp(f, cls) {
        return final ? '<td class="n">' + inr(r[f] || 0) + "</td>"
          : '<td class="n"><input class="cell num ' + (cls || "") + '" type="number" min="0" step="1" inputmode="numeric" data-f="' + f + '" value="' + (r[f] || 0) + '" aria-label="' + esc(r.name) + " " + f + '"></td>';
      }
      return '<tr data-i="' + i + '">' +
        '<td class="mono">' + esc(r.uan) + "</td>" +
        '<td class="name">' + esc(r.name) + "</td>" +
        '<td><span class="tag ' + (r.pension ? "yes" : "") + '">' + (r.pension ? "Yes" : "No") + "</span></td>" +
        inp("gross") + inp("pf") + inp("ncp", "sm") + inp("refund") + inp("vpf") +
        '<td class="n calc" data-c="epsW">' + inr(k.epsW) + '</td><td class="n calc" data-c="edliW">' + inr(k.edliW) + "</td>" +
        '<td class="n calc" data-c="mpf">' + inr(k.mpf) + '</td><td class="n calc" data-c="cpf">' + inr(k.cpf) + '</td><td class="n calc" data-c="eps">' + inr(k.eps) + "</td>" +
        '<td class="n calc" data-c="edli">' + inr(k.edli) + '</td><td class="n calc" data-c="total"><b>' + inr(k.total) + "</b></td>" +
        '<td data-c="flags">' + flagHtml(r) + "</td>" +
        (final ? "" : '<td><button class="btn link danger" data-act="rm" aria-label="Remove ' + esc(r.name) + ' from this month">Remove</button></td>') +
        "</tr>";
    }).join("");
    refreshAddList();
  }
  function flagHtml(r) { return flags(r).map(function (x) { return '<span class="flag">' + esc(x) + "</span>"; }).join(""); }

  function renderTotals() {
    var sh = curSheet(); if (!sh) return;
    var c = ratesFor(sh), s = sumRows(sh.rows, c);
    function t(k, v, sub, cls) { return '<div class="' + (cls || "") + '"><div class="k">' + k + '</div><div class="v">' + v + "</div>" + (sub ? '<div class="s">' + sub + "</div>" : "") + "</div>"; }
    $("#totals").innerHTML =
      t("Employees", s.n, "") +
      t("PF wages ₹", inr(s.pf), "EPS wages " + inr(s.epsW)) +
      t("Employee share ₹", inr(s.ee), "MPF " + inr(s.mpf) + " + VPF " + inr(s.vpf)) +
      t("EPS ₹", inr(s.eps), "") +
      t("CPF ₹", inr(s.cpf), "employer, EPF − EPS") +
      t("EDLI ₹", inr(s.edli), "on EDLI wages " + inr(s.edliW)) +
      t("NCP days", inr(s.ncp), "non-contributory days") +
      t("Total remittance ₹", inr(s.total), "MPF + VPF + EPS + CPF", "grand");
    var final = sh.status === "final";
    $("#foot").innerHTML = sh.rows.length ? "<tr><td></td><td>Total</td><td></td>" +
      '<td class="n">' + inr(s.gross) + '</td><td class="n">' + inr(s.pf) + '</td><td class="n">' + inr(s.ncp) + '</td><td class="n">' + inr(sh.rows.reduce(function (a, r) { return a + rnd(r.refund || 0); }, 0)) + '</td><td class="n">' + inr(s.vpf) + "</td>" +
      '<td class="n">' + inr(s.epsW) + '</td><td class="n">' + inr(s.edliW) + '</td><td class="n">' + inr(s.mpf) + '</td><td class="n">' + inr(s.cpf) + '</td><td class="n">' + inr(s.eps) + '</td><td class="n">' + inr(s.edli) + '</td><td class="n">' + inr(s.total) + "</td><td></td>" + (final ? "" : "<td></td>") + "</tr>" : "";
    var bad = sh.rows.filter(function (r) { return flags(r).length; }).length;
    var wn = $("#warn-note");
    if (bad && !final) { wn.hidden = false; wn.textContent = bad + (bad === 1 ? " row needs" : " rows need") + " attention before the month can be finalised. Fill in wages or NCP days, or remove the employee from this month."; }
    else wn.hidden = true;
    $("#finalise").disabled = !sh.rows.length || bad > 0;
  }
  function renderEcr() {
    var sh = curSheet(); if (!sh) return;
    var c = ratesFor(sh);
    $("#slip").innerHTML = sh.rows.length
      ? sh.rows.map(function (r) { return esc(ecrLine(r, c)).replace(/#~#/g, '<span class="sep">#~#</span>'); }).join("\n")
      : '<span class="muted">The file lines appear here once the month has employees.</span>';
    $("#ecr-name").textContent = ecrFile(S.cur);
    ["#save-ecr", "#copy-ecr", "#save-xlsx"].forEach(function (s) { $(s).disabled = !sh.rows.length; });
  }
  function refreshAddList() {
    var sh = curSheet(); if (!sh) return;
    var inSheet = {}; sh.rows.forEach(function (r) { inSheet[r.uan] = 1; });
    var avail = S.employees.filter(function (e) { return e.active !== false && !inSheet[e.uan]; });
    $("#add-emp").innerHTML = avail.length
      ? avail.map(function (e) { return '<option value="' + esc(e.uan) + '">' + esc(e.name) + " · " + esc(e.uan) + "</option>"; }).join("")
      : '<option value="">All active employees are in this month</option>';
    $("#add-emp").disabled = !avail.length; $("#add-emp-btn").disabled = !avail.length;
  }

  function newRowFromEmp(e) { return { uan: e.uan, name: e.name, pension: !!e.pension, mpf: e.mpf == null ? null : e.mpf, gross: 0, pf: 0, ncp: 0, refund: 0, vpf: e.vpf || 0 }; }

  $("#wm").addEventListener("change", function () {
    if (!this.value) return;
    if (curSheet() && saving === 0) { /* already saved by debounce or pending */ }
    S.cur = this.value; try { localStorage.setItem("pfstatutory.month." + S.cid, S.cur); } catch (e) { /* ignore */ }
    renderContribution();
  });
  $("#start").addEventListener("click", function () {
    var k = S.cur;
    if (S.months[k]) return;
    var rows = S.employees.filter(function (e) { return e.active !== false; }).map(newRowFromEmp);
    S.months[k] = { month: k, status: "draft", rates: null, rows: rows };
    renderContribution(); saveMonthNow(k); toast(monthLabel(k) + " started. All wages are zero.");
  });

  $("#rows").addEventListener("input", function (ev) {
    var inp = ev.target.closest("input[data-f]"); if (!inp) return;
    var tr = inp.closest("tr"), sh = curSheet(); if (!sh || sh.status === "final") return;
    var r = sh.rows[+tr.dataset.i], f = inp.dataset.f;
    var v = num(inp.value, 0);
    r[f] = f === "ncp" ? Math.round(v) : v;
    var k = calc(r, ratesFor(sh));
    var map = { epsW: k.epsW, edliW: k.edliW, mpf: k.mpf, cpf: k.cpf, eps: k.eps, edli: k.edli };
    Object.keys(map).forEach(function (m) { tr.querySelector('[data-c="' + m + '"]').textContent = inr(map[m]); });
    tr.querySelector('[data-c="total"]').innerHTML = "<b>" + inr(k.total) + "</b>";
    tr.querySelector('[data-c="flags"]').innerHTML = flagHtml(r);
    renderTotals(); renderEcr(); scheduleSave();
  });
  $("#rows").addEventListener("click", function (ev) {
    var b = ev.target.closest('button[data-act="rm"]'); if (!b) return;
    var sh = curSheet(), i = +b.closest("tr").dataset.i;
    armed(b, "Remove", "Confirm", function () { sh.rows.splice(i, 1); renderSheetStructure(); renderTotals(); renderEcr(); saveMonthNow(S.cur); });
  });
  $("#add-emp-btn").addEventListener("click", function () {
    var sh = curSheet(), uan = $("#add-emp").value, e = findEmp(uan); if (!sh || !e) return;
    sh.rows.push(newRowFromEmp(e)); renderSheetStructure(); renderTotals(); renderEcr(); saveMonthNow(S.cur); toast("Added " + e.name + " to " + monthLabel(S.cur) + ".");
  });

  /* wage upload */
  function importWages(list) {
    var sh = curSheet(); if (!sh) return;
    var byUan = {}; sh.rows.forEach(function (r) { byUan[r.uan] = r; });
    var touched = 0, added = 0, skipped = [];
    list.forEach(function (o, i) {
      var uan = String(pick(o, "uan") == null ? "" : pick(o, "uan")).replace(/\D/g, "");
      if (!uan) return;
      var r = byUan[uan];
      if (!r) {
        var e = findEmp(uan);
        if (!e) { skipped.push("row " + (i + 2) + ": UAN " + uan + " is not in the employee master"); return; }
        r = newRowFromEmp(e); sh.rows.push(r); byUan[uan] = r; added++;
      }
      var g = pick(o, "gross"), p = pick(o, "pf"), n = pick(o, "ncp"), rf = pick(o, "refund"), v = pick(o, "vpf");
      if (!blank(g)) r.gross = num(g); if (!blank(p)) r.pf = num(p);
      if (!blank(n)) r.ncp = Math.round(num(n)); if (!blank(rf)) r.refund = num(rf); if (!blank(v)) r.vpf = num(v);
      if (!blank(p) && blank(g) && !(r.gross > 0)) r.gross = r.pf;
      touched++;
    });
    renderSheetStructure(); renderTotals(); renderEcr(); saveMonthNow(S.cur);
    var msg = "Updated " + touched + (touched === 1 ? " row" : " rows") + (added ? ", added " + added + " from the master" : "") + ".";
    if (skipped.length) msg += " Skipped " + skipped.length + ": " + skipped.slice(0, 2).join("; ") + (skipped.length > 2 ? "…" : "");
    toast(msg);
  }
  function wageFile(f) { readSheet(f).then(function (l) { if (!l.length) toast("No rows found in the first sheet."); else importWages(l); }, function (e) { toast(errText(e)); }); }
  $("#pick").addEventListener("click", function () { $("#file").click(); });
  $("#file").addEventListener("change", function () { if (this.files[0]) wageFile(this.files[0]); this.value = ""; });
  $("#tpl").addEventListener("click", function () {
    var sh = curSheet(); if (!sh) return;
    var csv = "UAN,Name,Gross Wages,PF Wages,NCP Days,Refund,VPF Amount\r\n" + sh.rows.map(function (r) {
      return [r.uan, '"' + String(r.name).replace(/"/g, '""') + '"', r.gross, r.pf, r.ncp, r.refund, r.vpf].join(",");
    }).join("\r\n") + "\r\n";
    saveFile("pf_wages_" + S.cur + ".csv", csv);
  });

  /* month actions */
  $("#finalise").addEventListener("click", function () {
    var sh = curSheet(); if (!sh) return;
    armed(this, "Finalise month", "Confirm finalise", function () {
      sh.status = "final"; sh.rates = Object.assign({}, S.rates);
      renderContribution(); saveMonthNow(S.cur).then(function () { toast(monthLabel(S.cur) + " finalised."); });
    });
  });
  $("#reopen").addEventListener("click", function () {
    var sh = curSheet(); if (!sh) return;
    sh.status = "draft"; sh.rates = null; renderContribution(); saveMonthNow(S.cur); toast("Reopened. The month now uses the current rates.");
  });
  $("#next-month").addEventListener("click", function () {
    S.cur = nextMonth(S.cur); try { localStorage.setItem("pfstatutory.month." + S.cid, S.cur); } catch (e) { /* ignore */ }
    renderContribution(); window.scrollTo(0, 0);
  });
  $("#del-month").addEventListener("click", function () {
    var k = S.cur; if (!S.months[k]) return;
    armed(this, "Delete month", "Confirm delete", function () {
      delete S.months[k];
      store.del("months/" + k).then(function () { toast(monthLabel(k) + " deleted."); }, function (e) { toast("Could not delete: " + errText(e)); });
      renderContribution();
    });
  });
  $("#save-ecr").addEventListener("click", function () { var sh = curSheet(); if (sh && sh.rows.length) saveFile(ecrFile(S.cur), ecrText(sh)); });
  $("#copy-ecr").addEventListener("click", function () {
    var sh = curSheet(); if (!sh || !sh.rows.length) return;
    var t = ecrText(sh);
    var fallback = function () {
      var r = document.createRange(); r.selectNodeContents($("#slip")); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      toast("Select and copy the highlighted text.");
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast("ECR text copied."); }, fallback); else fallback();
  });
  $("#save-xlsx").addEventListener("click", function () {
    var sh = curSheet(); if (!sh || !sh.rows.length) return;
    if (typeof XLSX === "undefined") { toast("The spreadsheet writer did not load."); return; }
    var c = ratesFor(sh);
    var aoa = [["UAN", "Member name", "Pension member", "Gross wages", "PF wages", "EPS wages", "EDLI wages", "MPF", "VPF", "CPF", "EPS", "Total", "EDLI amount", "NCP days", "Refund of advances"]];
    sh.rows.forEach(function (r) {
      var k = calc(r, c);
      aoa.push([r.uan, r.name, r.pension ? "Yes" : "No", rnd(r.gross || 0), k.pf, k.epsW, k.edliW, k.mpf, k.vpf, k.cpf, k.eps, k.total, k.edli, r.ncp || 0, rnd(r.refund || 0)]);
    });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), monthLabel(S.cur).slice(0, 31));
    saveFile("PF_" + S.cur + ".xlsx", XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  });
  wireDrop($("#c-sheet"), function (f) { var sh = curSheet(); if (sh && sh.status !== "final") wageFile(f); });

  /* ================= REPORTS page ================= */
  function reportMonths() {
    var fy = $("#fy").value;
    return Object.keys(S.months).sort().reverse().filter(function (k) { return !fy || fy === "all" || fyOf(k) === fy; });
  }
  function renderReports() {
    var keys = Object.keys(S.months), fys = {};
    keys.forEach(function (k) { fys[fyOf(k)] = 1; });
    var sel = $("#fy"), prev = sel.value;
    var opts = ["all"].concat(Object.keys(fys).sort().reverse());
    sel.innerHTML = opts.map(function (o) { return '<option value="' + o + '">' + (o === "all" ? "All months" : "FY " + o) + "</option>"; }).join("");
    sel.value = opts.indexOf(prev) > -1 ? prev : "all";
    var list = reportMonths(), tot = { n: 0, pf: 0, ee: 0, eps: 0, cpf: 0, edli: 0, ncp: 0, total: 0 };
    $("#rep-rows").innerHTML = list.map(function (k) {
      var sh = S.months[k], s = sumRows(sh.rows, ratesFor(sh));
      tot.pf += s.pf; tot.ee += s.ee; tot.eps += s.eps; tot.cpf += s.cpf; tot.edli += s.edli; tot.ncp += s.ncp; tot.total += s.total;
      return "<tr><td><b>" + esc(monthLabel(k)) + '</b></td><td><span class="chip ' + sh.status + '">' + (sh.status === "final" ? "Finalised" : "Draft") + "</span></td>" +
        '<td class="n">' + s.n + '</td><td class="n">' + inr(s.pf) + '</td><td class="n">' + inr(s.ee) + '</td><td class="n">' + inr(s.eps) + '</td><td class="n">' + inr(s.cpf) + '</td><td class="n">' + inr(s.edli) + '</td><td class="n">' + inr(s.ncp) + '</td><td class="n"><b>' + inr(s.total) + "</b></td>" +
        '<td><button class="btn link" data-act="open" data-m="' + k + '">Open</button><button class="btn link" data-act="ecr" data-m="' + k + '">ECR .txt</button></td></tr>';
    }).join("");
    $("#rep-empty").hidden = list.length > 0;
    $("#rep-foot").innerHTML = list.length > 1 ? "<tr><td>Total</td><td></td><td></td>" +
      '<td class="n">' + inr(tot.pf) + '</td><td class="n">' + inr(tot.ee) + '</td><td class="n">' + inr(tot.eps) + '</td><td class="n">' + inr(tot.cpf) + '</td><td class="n">' + inr(tot.edli) + '</td><td class="n">' + inr(tot.ncp) + '</td><td class="n">' + inr(tot.total) + "</td><td></td></tr>" : "";
    $("#rep-xlsx").disabled = !list.length;
  }
  $("#fy").addEventListener("change", renderReports);
  $("#rep-rows").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-act]"); if (!b) return;
    var k = b.dataset.m, sh = S.months[k]; if (!sh) return;
    if (b.dataset.act === "open") { S.cur = k; location.hash = "contribution"; }
    else saveFile(ecrFile(k), ecrText(sh));
  });
  $("#rep-xlsx").addEventListener("click", function () {
    if (typeof XLSX === "undefined") { toast("The spreadsheet writer did not load."); return; }
    var aoa = [["Month", "Status", "Employees", "PF wages", "EPS wages", "EDLI wages", "MPF", "VPF", "Employee share", "EPS", "CPF", "EDLI amount", "NCP days", "Total remittance"]];
    reportMonths().slice().reverse().forEach(function (k) {
      var sh = S.months[k], s = sumRows(sh.rows, ratesFor(sh));
      aoa.push([k, sh.status === "final" ? "Finalised" : "Draft", s.n, s.pf, s.epsW, s.edliW, s.mpf, s.vpf, s.ee, s.eps, s.cpf, s.edli, s.ncp, s.total]);
    });
    var wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), "Monthly contributions");
    saveFile("PF_monthly_report.xlsx", XLSX.write(wb, { bookType: "xlsx", type: "array" }));
  });

  /* ================= gate: welcome, sign in, admin ================= */
  var G = { companies: [], resetId: null };
  var ID_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;

  function showGate(name) {
    $("#gate").hidden = false; $("#app").hidden = true;
    ["welcome", "login", "admin"].forEach(function (n) { $("#g-" + n).hidden = n !== name; });
    window.scrollTo(0, 0);
  }
  function genPw() {
    var al = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789", out = "", r = crypto.getRandomValues(new Uint8Array(12));
    for (var i = 0; i < r.length; i++) out += al[r[i] % al.length];
    return out;
  }

  /* workspace entry and exit */
  function resetState() {
    clearTimeout(saveT); saving = 0;
    S.rates = Object.assign({}, DEFAULT_RATES); S.employees = []; S.months = {}; S.cur = null; S.editUan = null;
    resetEForm();
  }
  function flush() {
    if (S.cid && S.cur && S.months[S.cur] && $("#savestate").textContent === "Unsaved changes") return saveMonthNow(S.cur);
    return Promise.resolve();
  }
  function setSync() { var el = $("#sync"); el.textContent = "Saved on the server"; el.className = "sync ok"; }
  function enterWorkspace(cid, name, viaAdmin) {
    resetState(); S.cid = cid; S.viaAdmin = !!viaAdmin;
    return store.load().then(function (d) {
      if (d.rates) S.rates = Object.assign({}, DEFAULT_RATES, d.rates);
      S.employees = d.employees.map(function (e) { return { uan: String(e.uan), name: e.name, pension: !!e.pension, mpf: e.mpf == null ? null : e.mpf, vpf: e.vpf || 0, active: e.active !== false, sample: !!e.sample }; });
      Object.keys(d.months).forEach(function (k) { S.months[k] = unpackMonth(d.months[k]); });
      try { S.cur = localStorage.getItem("pfstatutory.month." + cid); } catch (e) { /* ignore */ }
      if (!S.cur || !/^\d{4}-\d{2}$/.test(S.cur)) S.cur = prevMonthOfToday();
      $("#co-badge").textContent = name || cid;
      $("#back-admin").hidden = !viaAdmin; $("#signout").hidden = !!viaAdmin;
      $("#gate").hidden = true; $("#app").hidden = false;
      setSync();
      if (location.hash !== "#contribution") location.hash = "contribution";
      route();
    });
  }
  function leaveWorkspace() { S.cid = null; resetState(); }
  onExpired = function () {
    if (!S.cid && $("#g-admin").hidden) return;
    var wasAdmin = !$("#g-admin").hidden;
    S.cid = null; resetState(); showGate(wasAdmin ? "login" : "login");
    $("#login-err").textContent = "Your session ended. Sign in again.";
  };

  /* welcome and sign in */
  $("#go-login").addEventListener("click", function () { showGate("login"); $("#l-id").focus(); });
  $("#back-welcome").addEventListener("click", function () { showGate("welcome"); });
  $("#login-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("#login-err"); err.textContent = "";
    var id = $("#l-id").value.trim().toLowerCase(), pw = $("#l-pw").value;
    if (!id || !pw) { err.textContent = "Enter the company ID and the password."; return; }
    var btn = $("#l-btn"); btn.disabled = true;
    api("POST", "/api/login", { code: id, password: pw }).then(function (r) {
      $("#l-pw").value = "";
      return enterWorkspace(r.company.code, r.company.name, false);
    }).catch(function (e) { err.textContent = e.message; }).then(function () { btn.disabled = false; });
  });
  $("#signout").addEventListener("click", function () {
    flush().then(function () { return api("POST", "/api/logout"); }).catch(function () {}).then(function () {
      leaveWorkspace(); $("#l-id").value = ""; $("#login-err").textContent = ""; showGate("login");
    });
  });
  $("#back-admin").addEventListener("click", function () {
    flush().then(function () { return api("POST", "/api/admin/leave"); }).then(function () { leaveWorkspace(); openAdmin(); },
      function (e) { toast(errText(e)); });
  });

  /* administrator */
  $("#admin-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var err = $("#admin-err"); err.textContent = "";
    var user = $("#a-user").value.trim(), pw = $("#a-pw").value;
    if (!user || !pw) { err.textContent = "Enter the administrator username and password."; return; }
    var btn = $("#a-btn"); btn.disabled = true;
    api("POST", "/api/admin/login", { username: user, password: pw }).then(function () {
      $("#a-pw").value = ""; return openAdmin();
    }).catch(function (e) { err.textContent = e.message; }).then(function () { btn.disabled = false; });
  });
  $("#admin-out").addEventListener("click", function () {
    api("POST", "/api/logout").catch(function () {}).then(function () { showGate("login"); });
  });
  $("#acct-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var user = $("#ac-user").value.trim(), cur = $("#ac-cur").value, nw = $("#ac-new").value;
    if (!user) { toast("Enter a username."); $("#ac-user").focus(); return; }
    if (!cur) { toast("Enter the current password."); $("#ac-cur").focus(); return; }
    if (nw && nw.length < 8) { toast("The new password needs at least 8 characters."); $("#ac-new").focus(); return; }
    var btn = $("#ac-submit"); btn.disabled = true;
    api("PUT", "/api/admin/account", { username: user, currentPassword: cur, newPassword: nw }).then(function () {
      $("#ac-cur").value = ""; $("#ac-new").value = ""; toast("Administrator account saved.");
    }).catch(function (e) { toast(e.message); }).then(function () { btn.disabled = false; });
  });

  function openAdmin() {
    showGate("admin"); $("#cred").hidden = true; $("#pw-panel").hidden = true;
    api("GET", "/api/admin/account").then(function (a) { $("#ac-user").value = a.username || ""; }, function () {});
    return loadCompanies().then(renderCompanies, function (e) { toast("Companies could not be loaded: " + errText(e)); });
  }
  function loadCompanies() {
    return api("GET", "/api/admin/companies").then(function (r) {
      G.companies = r.companies.map(function (c) { c.id = c.code; return c; });
    });
  }
  function renderCompanies() {
    $("#co-count").textContent = G.companies.length ? "· " + G.companies.length : "";
    $("#co-empty").hidden = G.companies.length > 0;
    $("#co-rows").innerHTML = G.companies.map(function (c) {
      var on = c.active !== false, d = c.createdAt ? new Date(c.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
      return "<tr><td class=\"name\">" + esc(c.name) + "</td><td class=\"mono\">" + esc(c.id) + "</td>" +
        "<td>" + (on ? '<span class="tag yes">Active</span>' : '<span class="tag">Switched off</span>') + "</td><td>" + esc(d) + "</td>" +
        "<td><button class=\"btn link\" data-act=\"open\" data-id=\"" + esc(c.id) + "\">Open workspace</button>" +
        "<button class=\"btn link\" data-act=\"reset\" data-id=\"" + esc(c.id) + "\">Reset password</button>" +
        "<button class=\"btn link\" data-act=\"toggle\" data-id=\"" + esc(c.id) + "\">" + (on ? "Switch off" : "Switch on") + "</button>" +
        "<button class=\"btn link danger\" data-act=\"del\" data-id=\"" + esc(c.id) + "\">Delete</button></td></tr>";
    }).join("");
  }
  function showCred(title, c, pw) {
    $("#cred-title").textContent = title;
    $("#cred-body").textContent = "Company: " + c.name + "\nCompany ID: " + c.id + "\nPassword: " + pw;
    $("#cred-body").style.whiteSpace = "pre-wrap"; $("#cred").hidden = false;
  }
  var idTouched = false;
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30); }
  $("#co-name").addEventListener("input", function () { if (!idTouched) $("#co-id").value = slug(this.value); });
  $("#co-id").addEventListener("input", function () { idTouched = true; });
  $("#co-gen").addEventListener("click", function () { $("#co-pw").value = genPw(); });
  $("#co-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("#co-name").value.trim(), id = $("#co-id").value.trim().toLowerCase(), pw = $("#co-pw").value;
    if (!name) { toast("Enter the company name."); $("#co-name").focus(); return; }
    if (!ID_RE.test(id)) { toast("Company ID must be 3 to 30 characters: lower-case letters, digits, - or _."); $("#co-id").focus(); return; }
    if (pw.length < 8) { toast("The password needs at least 8 characters."); $("#co-pw").focus(); return; }
    var btn = $("#co-submit"); btn.disabled = true;
    api("POST", "/api/admin/companies", { name: name, code: id, password: pw }).then(function () {
      showCred("Company created", { name: name, id: id }, pw);
      $("#co-form").reset(); idTouched = false;
      return loadCompanies().then(renderCompanies);
    }).catch(function (e) { toast("Could not create the company: " + errText(e)); }).then(function () { btn.disabled = false; });
  });
  $("#cred-close").addEventListener("click", function () { $("#cred").hidden = true; $("#cred-body").textContent = ""; });
  $("#cred-copy").addEventListener("click", function () {
    var t = $("#cred-body").textContent;
    var fb = function () { var r = document.createRange(); r.selectNodeContents($("#cred-body")); var s = window.getSelection(); s.removeAllRanges(); s.addRange(r); toast("Select and copy the highlighted text."); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(function () { toast("Sign-in details copied."); }, fb); else fb();
  });

  $("#co-rows").addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-act]"); if (!b) return;
    var id = b.dataset.id, c = G.companies.filter(function (x) { return x.id === id; })[0]; if (!c) return;
    var act = b.dataset.act;
    if (act === "open") {
      api("POST", "/api/admin/open", { code: id }).then(function () { return enterWorkspace(id, c.name, true); })
        .catch(function (e) { toast("Could not open the workspace: " + errText(e)); });
    } else if (act === "reset") {
      G.resetId = id; $("#pw-title").textContent = "Reset password for " + c.name; $("#pw-new").value = genPw();
      $("#pw-panel").hidden = false; $("#pw-new").focus(); $("#pw-panel").scrollIntoView({ block: "center" });
    } else if (act === "toggle") {
      var on = c.active !== false;
      api("PATCH", "/api/admin/companies/" + encodeURIComponent(id), { active: !on }).then(function () {
        c.active = !on; renderCompanies(); toast(c.name + (on ? " is switched off. Its users are signed out." : " is switched on."));
      }, function (e) { toast("Could not change the status: " + errText(e)); });
    } else if (act === "del") {
      armed(b, "Delete", "Delete " + c.name + " and all its data?", function () {
        api("DELETE", "/api/admin/companies/" + encodeURIComponent(id)).then(function () {
          G.companies = G.companies.filter(function (x) { return x.id !== id; }); renderCompanies(); toast(c.name + " and its data were deleted.");
        }, function (e) { toast("Could not delete: " + errText(e)); });
      });
    }
  });
  $("#pw-gen").addEventListener("click", function () { $("#pw-new").value = genPw(); });
  $("#pw-cancel").addEventListener("click", function () { $("#pw-panel").hidden = true; });
  $("#pw-save").addEventListener("click", function () {
    var pw = $("#pw-new").value, id = G.resetId, c = G.companies.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    if (pw.length < 8) { toast("The password needs at least 8 characters."); return; }
    api("PATCH", "/api/admin/companies/" + encodeURIComponent(id), { password: pw }).then(function () {
      $("#pw-panel").hidden = true; showCred("Password changed", c, pw);
    }, function (e) { toast("Could not change the password: " + errText(e)); });
  });

  /* ================= boot ================= */
  showGate("welcome");
  api("GET", "/api/me").then(function (me) {
    if (me.role === "company" && me.company) return enterWorkspace(me.company.code, me.company.name, false);
    if (me.role === "admin") {
      if (me.company) return enterWorkspace(me.company.code, me.company.name, true);
      return openAdmin();
    }
  }).catch(function (e) {
    $("#unavail").hidden = false; $("#go-login").disabled = true; toast(errText(e));
  });
})();
