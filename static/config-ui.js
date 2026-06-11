/* =========================================================================
 * config-ui.js  —  Pestana de configuracion.
 *
 * Edita nombres de variables, pines y velocidades/umbrales. Guarda en el
 * backend (config/config.json, transportable). Exporta / importa JSON.
 * Al aplicar, reconfigura el simulador (pines -> ruedas/sensores).
 * ========================================================================= */
window.ConfigUI = (function () {
  "use strict";

  var cfg = null;
  var api = {};
  api.onApply = null;

  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "text") e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { e.appendChild(c); });
    return e;
  }
  function field(label, value, onCh, type) {
    var inp = el("input", { class: "cfg-inp", value: value == null ? "" : value, type: type || "text" });
    inp.addEventListener("change", function () {
      onCh(type === "number" ? parseFloat(inp.value) : inp.value);
    });
    return el("label", { class: "cfg-field" }, [el("span", { text: label }), inp]);
  }

  function num(label, value, onCh) { return field(label, value, onCh, "number"); }

  // -----------------------------------------------------------------------
  api.load = function () {
    return fetch("/__sim/config").then(function (r) { return r.json(); }).then(function (c) {
      cfg = c; return c;
    });
  };
  api.getConfig = function () { return cfg; };

  api.render = function (container) {
    if (!cfg) { container.textContent = "Cargando config..."; return; }
    container.innerHTML = "";

    // ---- Comando ----
    var secC = section("Comando recibido");
    secC.appendChild(field("Variable del request", cfg.comando.varName, function (v) { cfg.comando.varName = v; }));
    secC.appendChild(hint("Es solo informativo: en tu sketch vos leés el request con tu propia variable."));

    // ---- Motores ----
    var secM = section("Motores (pines L298N)");
    var p = cfg.motores.pins;
    secM.appendChild(grid([
      num("IN1 (izq adelante)", p.IN1, function (v) { p.IN1 = v; }),
      num("IN2 (izq atras)", p.IN2, function (v) { p.IN2 = v; }),
      num("IN3 (der adelante)", p.IN3, function (v) { p.IN3 = v; }),
      num("IN4 (der atras)", p.IN4, function (v) { p.IN4 = v; })
    ]));
    secM.appendChild(grid([
      field("Variable velocidad", cfg.motores.velocidadVar, function (v) { cfg.motores.velocidadVar = v; }),
      num("Velocidad default", cfg.motores.velocidadDefault, function (v) { cfg.motores.velocidadDefault = v; })
    ]));
    secM.appendChild(hint("Los PINES tienen que coincidir con los #define de tu sketch. Los nombres son orientativos."));

    // ---- Ultrasonido ----
    var secU = section("Ultrasonido");
    cfg.ultrasonido.sensores.forEach(function (s, i) {
      secU.appendChild(sensorRowUS(s, i, secU));
    });
    var addU = el("button", { class: "small-btn", text: "+ sensor ultrasonico" });
    addU.addEventListener("click", function () {
      cfg.ultrasonido.sensores.push({ rol: "frontal", varName: "sensor_x", trigPin: 0, echoPin: 0 });
      api.render(container);
    });
    secU.appendChild(addU);

    // ---- Infrarrojo ----
    var secI = section("Infrarrojo (siguelinea)");
    secI.appendChild(field("Variable umbral", cfg.infrarrojo.umbralVar, function (v) { cfg.infrarrojo.umbralVar = v; }));
    secI.appendChild(num("Umbral default", cfg.infrarrojo.umbralDefault, function (v) { cfg.infrarrojo.umbralDefault = v; }));
    cfg.infrarrojo.sensores.forEach(function (s, i) {
      secI.appendChild(sensorRowIR(s, i, container));
    });
    var addI = el("button", { class: "small-btn", text: "+ sensor IR" });
    addI.addEventListener("click", function () {
      cfg.infrarrojo.sensores.push({ rol: "x", varName: "lectura_x", pin: "A2" });
      cfg.infrarrojo.cantidad = cfg.infrarrojo.sensores.length;
      api.render(container);
    });
    secI.appendChild(addI);

    // ---- Parametros ----
    var secP = section("Parametros");
    secP.appendChild(grid([
      num("velAvanzar", cfg.parametros.velAvanzar, function (v) { cfg.parametros.velAvanzar = v; }),
      num("velGiro", cfg.parametros.velGiro, function (v) { cfg.parametros.velGiro = v; })
    ]));

    // ---- Acciones ----
    var save = el("button", { class: "primary-btn", text: "Guardar y aplicar" });
    save.addEventListener("click", function () { api.save().then(function () { flash(save, "Guardado ✓"); }); });
    var exp = el("button", { class: "small-btn", text: "Exportar JSON" });
    exp.addEventListener("click", function () { window.location.href = "/__sim/config/export"; });
    var imp = el("button", { class: "small-btn", text: "Importar JSON" });
    var file = el("input", { type: "file", accept: ".json" }); file.style.display = "none";
    imp.addEventListener("click", function () { file.click(); });
    file.addEventListener("change", function () {
      if (!file.files[0]) return;
      var fd = new FormData(); fd.append("file", file.files[0]);
      fetch("/__sim/config/import", { method: "POST", body: fd })
        .then(function (r) { return r.json(); })
        .then(function (res) { cfg = res.config; apply(); api.render(container); });
    });
    var actions = el("div", { class: "cfg-actions" }, [save, exp, imp, file]);

    [secC, secM, secU, secI, secP, actions].forEach(function (s) { container.appendChild(s); });
  };

  function sensorRowUS(s, i, parent) {
    var row = el("div", { class: "sensor-row" });
    row.appendChild(field("rol", s.rol, function (v) { s.rol = v; }));
    row.appendChild(field("variable", s.varName, function (v) { s.varName = v; }));
    row.appendChild(num("trig", s.trigPin, function (v) { s.trigPin = v; }));
    row.appendChild(num("echo", s.echoPin, function (v) { s.echoPin = v; }));
    var del = el("button", { class: "del-btn", text: "✕" });
    del.addEventListener("click", function () { cfg.ultrasonido.sensores.splice(i, 1); row.remove(); });
    row.appendChild(del);
    return row;
  }
  function sensorRowIR(s, i, container) {
    var row = el("div", { class: "sensor-row" });
    row.appendChild(field("rol", s.rol, function (v) { s.rol = v; }));
    row.appendChild(field("variable", s.varName, function (v) { s.varName = v; }));
    row.appendChild(field("pin", s.pin, function (v) { s.pin = v; }));
    var del = el("button", { class: "del-btn", text: "✕" });
    del.addEventListener("click", function () {
      cfg.infrarrojo.sensores.splice(i, 1);
      cfg.infrarrojo.cantidad = cfg.infrarrojo.sensores.length;
      api.render(container);
    });
    row.appendChild(del);
    return row;
  }

  function section(title) {
    return el("div", { class: "cfg-section" }, [el("h3", { text: title })]);
  }
  function grid(items) { return el("div", { class: "cfg-grid" }, items); }
  function hint(t) { return el("p", { class: "cfg-hint", text: t }); }
  function flash(btn, txt) { var o = btn.textContent; btn.textContent = txt; setTimeout(function () { btn.textContent = o; }, 1200); }

  function apply() {
    cfg.infrarrojo.cantidad = cfg.infrarrojo.sensores.length;
    if (window.Sim) window.Sim.setConfig(cfg);
    if (api.onApply) api.onApply(cfg);
  }

  api.save = function () {
    apply();
    return fetch("/__sim/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg)
    }).then(function (r) { return r.json(); });
  };

  return api;
})();
