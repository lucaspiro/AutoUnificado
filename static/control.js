/* =========================================================================
 * control.js  —  Panel manual: FLECHAS + JOYSTICK.
 *
 * Manda HTTP al backend (que lo graba como request, igual que el Arduino real).
 * Las RUTAS son editables (viven en el codigo del alumno) y se guardan en
 * localStorage. Lo unico que cambia entre flechas y joystick es lo que se manda.
 * ========================================================================= */
window.Control = (function () {
  "use strict";

  var DEFAULT_ROUTES = {
    adelante: "/adelante",
    atras: "/atras",
    izquierda: "/izquierda",
    derecha: "/derecha",
    stop: "/stop",
    modoManual: "/manual",
    modoUltra: "/automatico",
    modoLinea: "/siguelinea",
    joystick: "/?X={x}&Y={y}"
  };
  var routes = load();
  var vel = 150;
  var autoStop = true;
  var joyTimer = null, joyActive = false;

  function load() {
    try {
      var r = JSON.parse(localStorage.getItem("autosim_routes"));
      return Object.assign({}, DEFAULT_ROUTES, r || {});
    } catch (e) { return Object.assign({}, DEFAULT_ROUTES); }
  }
  function save() { localStorage.setItem("autosim_routes", JSON.stringify(routes)); }

  function send(route) {
    if (!route) return;
    // agrega vel= si corresponde y la ruta no es joystick
    var url = route;
    if (route.indexOf("{x}") < 0 && route.indexOf("vel=") < 0) {
      url += (route.indexOf("?") >= 0 ? "&" : "?") + "vel=" + vel;
    }
    fetch(url, { method: "GET" }).catch(function () {});
  }
  function sendJoystick(x, y) {
    var url = routes.joystick.replace("{x}", Math.round(x)).replace("{y}", Math.round(y));
    fetch(url, { method: "GET" }).catch(function () {});
  }

  // -----------------------------------------------------------------------
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

  function routeRow(key, label) {
    var inp = el("input", { class: "route-inp", value: routes[key] });
    inp.addEventListener("change", function () { routes[key] = inp.value.trim(); save(); });
    return el("div", { class: "route-row" }, [el("span", { text: label, class: "route-lbl" }), inp]);
  }

  function holdButton(label, key, cls) {
    var b = el("button", { class: "pad-btn " + (cls || ""), text: label });
    var down = function (ev) { ev.preventDefault(); send(routes[key]); b.classList.add("active"); };
    var up = function () { b.classList.remove("active"); if (autoStop) send(routes.stop); };
    b.addEventListener("mousedown", down);
    b.addEventListener("touchstart", down, { passive: false });
    b.addEventListener("mouseup", up);
    b.addEventListener("mouseleave", function () { if (b.classList.contains("active")) up(); });
    b.addEventListener("touchend", up);
    return b;
  }

  // -----------------------------------------------------------------------
  function buildArrows() {
    var wrap = el("div", { class: "arrows-grid" });
    var blank = function () { return el("div"); };
    wrap.appendChild(blank());
    wrap.appendChild(holdButton("▲", "adelante"));
    wrap.appendChild(blank());
    wrap.appendChild(holdButton("◀", "izquierda"));
    wrap.appendChild(holdButton("■", "stop", "stop"));
    wrap.appendChild(holdButton("▶", "derecha"));
    wrap.appendChild(blank());
    wrap.appendChild(holdButton("▼", "atras"));
    wrap.appendChild(blank());
    return wrap;
  }

  function buildJoystick() {
    var base = el("div", { class: "joy-base" });
    var knob = el("div", { class: "joy-knob" });
    base.appendChild(knob);
    var R = 70;
    function setKnob(dx, dy) { knob.style.left = (70 + dx) + "px"; knob.style.top = (70 + dy) + "px"; }
    setKnob(0, 0);
    function move(cx, cy) {
      var r = base.getBoundingClientRect();
      var dx = cx - (r.left + 70), dy = cy - (r.top + 70);
      var mag = Math.hypot(dx, dy);
      if (mag > R) { dx = dx / mag * R; dy = dy / mag * R; }
      setKnob(dx, dy);
      var x = (dx / R) * 127, y = (-dy / R) * 127; // y hacia arriba = +
      sendJoystick(x, y);
    }
    function start(ev) {
      joyActive = true; ev.preventDefault();
      var pt = ev.touches ? ev.touches[0] : ev;
      move(pt.clientX, pt.clientY);
      if (joyTimer) clearInterval(joyTimer);
    }
    function drag(ev) {
      if (!joyActive) return;
      var pt = ev.touches ? ev.touches[0] : ev;
      move(pt.clientX, pt.clientY);
    }
    function end() { joyActive = false; setKnob(0, 0); sendJoystick(0, 0); }
    base.addEventListener("mousedown", start);
    window.addEventListener("mousemove", drag);
    window.addEventListener("mouseup", function () { if (joyActive) end(); });
    base.addEventListener("touchstart", start, { passive: false });
    base.addEventListener("touchmove", drag, { passive: false });
    base.addEventListener("touchend", end);
    return base;
  }

  // -----------------------------------------------------------------------
  api_init();
  function api_init() {}

  var api = {};
  api.render = function (container) {
    container.innerHTML = "";

    // Selector flechas / joystick
    var modeArrows = el("button", { class: "seg active", text: "Flechas" });
    var modeJoy = el("button", { class: "seg", text: "Joystick" });
    var seg = el("div", { class: "segmented" }, [modeArrows, modeJoy]);

    var arrows = buildArrows();
    var joy = el("div", { class: "joy-wrap" }, [buildJoystick()]);
    joy.style.display = "none";

    modeArrows.addEventListener("click", function () {
      modeArrows.classList.add("active"); modeJoy.classList.remove("active");
      arrows.style.display = ""; joy.style.display = "none";
    });
    modeJoy.addEventListener("click", function () {
      modeJoy.classList.add("active"); modeArrows.classList.remove("active");
      joy.style.display = ""; arrows.style.display = "none";
    });

    // Velocidad
    var velLbl = el("span", { text: "Velocidad: " + vel, class: "vel-lbl" });
    var velSld = el("input", { type: "range", min: "0", max: "255", value: String(vel), class: "vel-sld" });
    velSld.addEventListener("input", function () { vel = parseInt(velSld.value, 10); velLbl.textContent = "Velocidad: " + vel; });

    // Botones de modo
    var bM = el("button", { class: "mode-btn", text: "Modo Manual" });
    var bU = el("button", { class: "mode-btn", text: "Modo Ultrasonido" });
    var bL = el("button", { class: "mode-btn", text: "Modo Siguelinea" });
    bM.addEventListener("click", function () { send(routes.modoManual); });
    bU.addEventListener("click", function () { send(routes.modoUltra); });
    bL.addEventListener("click", function () { send(routes.modoLinea); });
    var modeRow = el("div", { class: "mode-row" }, [bM, bU, bL]);

    // Auto-stop
    var asWrap = el("label", { class: "chk" });
    var asInp = el("input", { type: "checkbox" }); asInp.checked = autoStop;
    asInp.addEventListener("change", function () { autoStop = asInp.checked; });
    asWrap.appendChild(asInp); asWrap.appendChild(document.createTextNode(" Frenar al soltar (manda /stop)"));

    // Editor de rutas
    var routesBox = el("details", { class: "routes-box" });
    routesBox.appendChild(el("summary", { text: "Rutas HTTP (editar para que coincidan con tu sketch)" }));
    [["adelante", "Adelante"], ["atras", "Atras"], ["izquierda", "Izquierda"],
     ["derecha", "Derecha"], ["stop", "Stop"], ["modoManual", "Modo manual"],
     ["modoUltra", "Modo ultrasonido"], ["modoLinea", "Modo siguelinea"],
     ["joystick", "Joystick ({x}/{y})"]].forEach(function (r) {
      routesBox.appendChild(routeRow(r[0], r[1]));
    });

    container.appendChild(seg);
    container.appendChild(arrows);
    container.appendChild(joy);
    container.appendChild(el("div", { class: "vel-row" }, [velLbl, velSld]));
    container.appendChild(asWrap);
    container.appendChild(el("hr"));
    container.appendChild(modeRow);
    container.appendChild(routesBox);
  };

  return api;
})();
