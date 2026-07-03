/* =========================================================================
 * app.js  —  Pegamento de la UI: tabs del panel, editor, compilacion, run.
 * ========================================================================= */
(function () {
  "use strict";

  var editor, gutter, serialEl, lastReqEl;

  document.addEventListener("DOMContentLoaded", function () {
    editor = document.getElementById("editor");
    gutter = document.getElementById("gutter");
    serialEl = document.getElementById("serial");
    lastReqEl = document.getElementById("lastReq");

    setupTabs();
    setupEditor();
    setupSimControls();
    setupSceneTools();
    wireSimCallbacks();
    loadNetworkInfo();

    // Render de paneles
    window.Control.render(document.getElementById("manual-panel"));
    window.ConfigUI.load().then(function (cfg) {
      window.Sim.setConfig(cfg);
      window.Sim.init();
      window.ConfigUI.render(document.getElementById("config-panel"));
      window.ConfigUI.onApply = function (c) { window.Sim.setConfig(c); };
      // Compilacion inicial silenciosa para que Ejecutar ande de una
      compileAndLoad(true, false);
    });
  });

  // ---- IP de esta PC (lo que va en la app del celular) ----
  function loadNetworkInfo() {
    fetch("/__sim/info").then(function (r) { return r.json(); }).then(function (d) {
      // WiFi.localIP() del sketch devuelve esta IP (el "Arduino" es esta PC)
      window.Arduino.setLocalIP(d.ip);
      var urlEl = document.getElementById("ipUrl");
      urlEl.textContent = d.url;
      var badge = document.getElementById("ipBadge");
      badge.addEventListener("click", function () {
        navigator.clipboard.writeText(d.url).then(function () {
          var cp = badge.querySelector(".ip-copy");
          cp.textContent = "✓ copiado";
          setTimeout(function () { cp.textContent = "⧉"; }, 1200);
        }).catch(function () {});
      });
    }).catch(function () {
      document.getElementById("ipUrl").textContent = "http://localhost:5000";
    });
  }

  // ---- Tabs del panel lateral ----
  function setupTabs() {
    var tabs = document.querySelectorAll(".ptab");
    tabs.forEach(function (t) {
      t.addEventListener("click", function () {
        tabs.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        document.querySelectorAll(".ptab-pane").forEach(function (p) { p.classList.remove("active"); });
        document.getElementById("tab-" + t.dataset.tab).classList.add("active");
      });
    });
  }

  // ---- Editor + gutter ----
  function setupEditor() {
    editor.value = window.STARTER_SKETCH || "";
    updateGutter();
    editor.addEventListener("input", updateGutter);
    editor.addEventListener("scroll", function () {
      gutter.scrollTop = editor.scrollTop;
      var hl = document.getElementById("hl");
      if (hl) { hl.scrollTop = editor.scrollTop; hl.scrollLeft = editor.scrollLeft; }
    });
    editor.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        e.preventDefault();
        var s = editor.selectionStart, en = editor.selectionEnd;
        editor.value = editor.value.slice(0, s) + "  " + editor.value.slice(en);
        editor.selectionStart = editor.selectionEnd = s + 2;
        updateGutter();
      }
    });
  }
  var errLines = [];   // lineas marcadas en rojo en el gutter

  function updateGutter() {
    var n = editor.value.split("\n").length;
    var html = "";
    for (var i = 1; i <= n; i++) {
      html += errLines.indexOf(i) >= 0
        ? '<span class="err-ln">' + i + "</span>\n"
        : i + "\n";
    }
    gutter.innerHTML = html;
    renderHighlight();
  }

  // Capa de colores estilo Arduino IDE debajo del textarea transparente
  function renderHighlight() {
    var hl = document.getElementById("hl");
    if (!hl || !window.Highlight) return;
    // "\n" final extra para que el scroll del pre llegue igual que el textarea
    hl.innerHTML = window.Highlight.render(editor.value) + "\n";
    hl.scrollTop = editor.scrollTop;
    hl.scrollLeft = editor.scrollLeft;
  }
  function markErrLines(lines) {
    errLines = lines || [];
    updateGutter();
  }

  // ---- Compilacion ----
  async function compileAndLoad(silent, runSetup) {
    if (runSetup == null) runSetup = true;
    clearError();
    // 1) Verificacion estilo compilador: si hay errores NO se ejecuta nada
    if (window.Linter) {
      var lintErrs = window.Linter.lint(editor.value);
      if (lintErrs.length) {
        if (!silent) showLintErrors(lintErrs);
        return false;
      }
    }
    // 2) Compilacion real (transpilador + new Function)
    var res = window.Arduino.compile(editor.value);
    if (!res.ok) { if (!silent) showError(res.error); return false; }
    if (!runSetup) return true;
    var su = await window.Arduino.runSetup();
    if (!su.ok) { if (!silent) showError(su.error); return false; }
    return true;
  }

  // ---- Controles principales (estilo originales: Ejecutar / Pausa / Restart) ----
  function setupSimControls() {
    document.getElementById("btnPlay").addEventListener("click", async function () {
      // Ejecutar = compilar el sketch actual + correr (como runCode() original)
      var success = await compileAndLoad(false, true);
      if (!success) { goTab("code"); return; }
      serialEl.textContent = "";
      window.Sim.start();
    });
    document.getElementById("btnPause").addEventListener("click", function () {
      window.Sim.pause();
    });
    document.getElementById("btnReset").addEventListener("click", async function () {
      window.Sim.pause();
      clearError();
      await compileAndLoad(true, true);
      window.Sim.reset();
      serialEl.textContent = "";
      lastReqEl.textContent = "—";
      fetch("/__sim/reset", { method: "POST" }).catch(function () {});
    });
  }

  // ---- Herramientas de escena (overlay) ----
  function setupSceneTools() {
    var tools = document.querySelectorAll(".tool");
    tools.forEach(function (t) {
      t.addEventListener("click", function () {
        tools.forEach(function (x) { x.classList.remove("active"); });
        t.classList.add("active");
        window.Sim.setTool(t.dataset.tool);
      });
    });
    var brushVal = document.getElementById("brush-val");
    document.getElementById("brush").addEventListener("input", function (e) {
      var v = parseInt(e.target.value, 10);
      window.Sim.setBrush(v);
      brushVal.textContent = v;
    });
    document.getElementById("saveScene").addEventListener("click", function (e) {
      window.Sim.saveScene(); flash(e.target, "✓");
    });
    document.getElementById("clearScene").addEventListener("click", function () {
      window.Sim.clearScene();
    });
  }

  // ---- Callbacks del sim ----
  function wireSimCallbacks() {
    window.Sim.onError = function (err) { showError(err); goTab("code"); };
    window.Sim.onConsole = function (lines) {
      var txt = lines.slice(-200).join("\n");
      if (serialEl.textContent !== txt) {
        serialEl.textContent = txt;
        serialEl.scrollTop = serialEl.scrollHeight;
      }
    };
    window.Sim.onRequest = function (req) { lastReqEl.textContent = req; };
  }

  // ---- Panel de error (lindo) ----
  function showError(err) {
    var pnl = document.getElementById("errPanel");
    var line = err.line ? ("línea " + err.line) : "ubicación desconocida";
    var html = '<div class="err-head' + (err.line ? " clickable" : "") + '">❌ Error · ' + line + '</div>';
    if (err.hint) html += '<div class="err-hint">💡 ' + esc(err.hint) + '</div>';
    if (err.text) html += '<pre class="err-code">' + esc(err.text) + '</pre>';
    html += '<div class="err-msg">' + esc(err.message || "") + '</div>';
    pnl.innerHTML = html;
    pnl.style.display = "";
    if (err.line) {
      pnl.querySelector(".err-head").addEventListener("click", function () { gotoLine(err.line); });
    }
    goTab("code");
  }
  // Lista de errores del verificador (estilo salida de compilador)
  function showLintErrors(errs) {
    var pnl = document.getElementById("errPanel");
    var html = '<div class="err-head">❌ ' +
      (errs.length === 1 ? "1 error de compilación" : errs.length + " errores de compilación") +
      ' — corregí y volvé a Ejecutar</div>';
    for (var i = 0; i < errs.length; i++) {
      var e = errs[i];
      html += '<div class="err-item clickable" data-line="' + e.line + '">' +
        '<span class="err-item-line">línea ' + e.line + '</span> ' + esc(e.message) +
        (e.hint ? '<div class="err-hint">💡 ' + esc(e.hint) + "</div>" : "") +
        "</div>";
    }
    pnl.innerHTML = html;
    pnl.style.display = "";
    var items = pnl.querySelectorAll(".err-item");
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener("click", function () {
        gotoLine(parseInt(this.getAttribute("data-line"), 10));
      });
    }
    markErrLines(errs.map(function (e) { return e.line; }));
    goTab("code");
  }

  function clearError() {
    var pnl = document.getElementById("errPanel");
    pnl.style.display = "none";
    pnl.innerHTML = "";
    markErrLines([]);
  }
  function gotoLine(n) {
    var lines = editor.value.split("\n");
    var pos = 0;
    for (var i = 0; i < n - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    editor.focus();
    editor.selectionStart = pos;
    editor.selectionEnd = pos + (lines[n - 1] ? lines[n - 1].length : 0);
    var lh = 19.4; // ~12.5px * 1.55
    editor.scrollTop = Math.max(0, (n - 6) * lh);
    gutter.scrollTop = editor.scrollTop;
  }

  // ---- Util ----
  function goTab(name) {
    document.querySelector('.ptab[data-tab="' + name + '"]').click();
  }
  function flash(btn, txt) {
    if (!btn) return;
    var o = btn.textContent; btn.textContent = txt;
    setTimeout(function () { btn.textContent = o; }, 1000);
  }
  function esc(s) {
    return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
  }
})();
