/* =========================================================================
 * sim.js  —  Simulador p5.js del auto.
 *
 * Escena editable (pista dibujable + obstaculos) compartida por los 3 modos.
 * Cada frame: poolea el request del backend, mide sensores (ultrasonico + IR),
 * corre loop() del sketch (via Arduino shim) y mueve el robot con las ruedas.
 * ========================================================================= */
window.Sim = (function () {
  "use strict";

  var CM = 4;            // pixeles por centimetro
  var MAXR = 220;        // alcance ultrasonico (cm)
  var MAXSPEED = 2.6;    // px/frame a PWM 255

  var p5i = null, p = null;
  var track = null;      // p5.Graphics: la pista (linea negra) para IR
  var obstacles = [];    // {type:'rect',x,y,w,h} | {type:'circle',x,y,r}
  var robot = { x: 150, y: 300, angle: 0, w: 58, h: 56 };
  var running = false;
  var cfg = null;
  var lastTs = -1, pollAccum = 0;
  var tool = "line", brush = 22;
  var dragObs = null;    // obstaculo en creacion (rect/circle, con preview)
  var polyPts = null;    // trazo a mano alzada en curso (obstaculo poligono)
  var lastPaint = null;  // ultimo punto pintado (trazo continuo de pista)
  var slineStart = null, slineEnd = null; // linea recta en curso
  var draggingRobot = false;
  var W = 900, H = 600;
  var startPose = { x: 150, y: 300, angle: 0 };
  var lastSensors = { us: [], ir: [] };

  var api = {};
  api.onError = null;
  api.onConsole = null;
  api.onRequest = null;

  // -----------------------------------------------------------------------
  function rolAngle(rol) {
    // Igual que el simulador de Ultrasonido original: laterales a ±90°.
    rol = (rol || "").toLowerCase();
    if (rol.indexOf("front") >= 0 || rol.indexOf("frontal") >= 0) return 0;
    if (rol.indexOf("izq") >= 0 || rol.indexOf("left") >= 0) return -Math.PI / 2;
    if (rol.indexOf("der") >= 0 || rol.indexOf("right") >= 0) return Math.PI / 2;
    return 0;
  }

  function pointInPoly(x, y, pts) {
    var inside = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if ((pts[i].y > y) !== (pts[j].y > y) &&
          x < (pts[j].x - pts[i].x) * (y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) {
        inside = !inside;
      }
    }
    return inside;
  }

  function hitObstacle(x, y) {
    // indice del obstaculo bajo (x,y), o -1
    for (var i = obstacles.length - 1; i >= 0; i--) {
      var o = obstacles[i];
      if (o.type === "rect") {
        if (x >= o.x && x <= o.x + o.w && y >= o.y && y <= o.y + o.h) return i;
      } else if (o.type === "circle") {
        var dx = x - o.x, dy = y - o.y;
        if (dx * dx + dy * dy <= o.r * o.r) return i;
      } else if (o.type === "poly") {
        if (pointInPoly(x, y, o.pts)) return i;
      }
    }
    return -1;
  }

  function pointInObstacle(x, y) {
    if (x < 0 || y < 0 || x > W || y > H) return true; // paredes = obstaculo
    return hitObstacle(x, y) >= 0;
  }

  // Raycast de un solo rayo: distancia px hasta obstaculo/pared.
  function raySingle(ox, oy, ang) {
    var step = 3, maxPx = MAXR * CM;
    for (var d = 6; d <= maxPx; d += step) {
      var x = ox + Math.cos(ang) * d;
      var y = oy + Math.sin(ang) * d;
      if (pointInObstacle(x, y)) return d;
    }
    return -1;
  }

  // Cono ultrasonico (como medirDistanciaCono del original): 5 rayos en ~15°,
  // devuelve la distancia MINIMA en cm. El sensor real tiene apertura de haz.
  function raycast(ox, oy, ang) {
    var apertura = Math.PI / 24; // ±7.5°
    var n = 5, min = -1;
    for (var r = 0; r < n; r++) {
      var a = ang - apertura + (2 * apertura / (n - 1)) * r;
      var d = raySingle(ox, oy, a);
      if (d >= 0 && (min < 0 || d < min)) min = d;
    }
    if (min < 0) return MAXR + 200; // libre -> el shim devuelve 0 en pulseIn
    return min / CM;
  }

  function measureSensors() {
    lastSensors = { us: [], ir: [] };
    var L = robot.h, A = robot.w;
    var cosA = Math.cos(robot.angle), sinA = Math.sin(robot.angle);

    // Posicion local de cada sensor segun su rol (coincide con drawRobot)
    function sensorWorldPos(localX, localY) {
      return {
        x: robot.x + cosA * localX - sinA * localY,
        y: robot.y + sinA * localX + cosA * localY
      };
    }
    function sensorLocalByRol(rol) {
      rol = (rol || "").toLowerCase();
      if (rol.indexOf("izq") >= 0 || rol.indexOf("left") >= 0)
        return { x: L * 0.15, y: -A / 2 + 2 };    // lateral izq
      if (rol.indexOf("der") >= 0 || rol.indexOf("right") >= 0)
        return { x: L * 0.15, y: A / 2 - 2 };      // lateral der
      return { x: L * 0.42, y: 0 };                  // frontal
    }

    // Ultrasonico: cada sensor emite desde SU posicion real
    var us = (cfg && cfg.ultrasonido && cfg.ultrasonido.sensores) || [];
    for (var i = 0; i < us.length; i++) {
      var s = us[i];
      var local = sensorLocalByRol(s.rol);
      var pos = sensorWorldPos(local.x, local.y);
      var ang = robot.angle + rolAngle(s.rol);
      var dist = raycast(pos.x, pos.y, ang);
      window.Arduino.setUltrasonic(s.echoPin, dist);
      lastSensors.us.push({ x: pos.x, y: pos.y, ang: ang, dist: dist });
    }

    // IR (lee pixel de la pista). Sensores repartidos al frente.
    // Calibracion como en la vida real: que valor da el sensor sobre blanco
    // y sobre negro (se mide y se carga en Config). El umbral va en el codigo.
    var irCfg = (cfg && cfg.infrarrojo) || {};
    var ir = irCfg.sensores || [];
    var vBlanco = (irCfg.lecturaBlanco != null) ? irCfg.lecturaBlanco : 100;
    var vNegro = (irCfg.lecturaNegro != null) ? irCfg.lecturaNegro : 900;
    var umbralViz = (vBlanco + vNegro) / 2;
    // Los IR estan DEBAJO del chasis, cerca del frente (como el auto real)
    var irFwd = robot.h * 0.36;
    var irSpread = robot.w * 0.52;
    for (var j = 0; j < ir.length; j++) {
      var off = ir.length === 1 ? 0 : (j / (ir.length - 1) - 0.5) * irSpread;
      var px = robot.x + Math.cos(robot.angle) * irFwd - Math.sin(robot.angle) * off;
      var py = robot.y + Math.sin(robot.angle) * irFwd + Math.cos(robot.angle) * off;
      var bright = 255;
      if (px >= 0 && py >= 0 && px < W && py < H) {
        var c = track.get(px | 0, py | 0);
        bright = c[0];
      }
      var val = Math.round(map255(bright, 255, 0, vBlanco, vNegro) + (Math.random() * 30 - 15));
      val = Math.max(0, Math.min(1023, val));
      window.Arduino.setIR(ir[j].pin, val);
      lastSensors.ir.push({ x: px, y: py, val: val, negro: val > umbralViz });
    }
  }
  function map255(v, a, b, c, d) { return (v - a) * (d - c) / (b - a) + c; }

  function applyKinematics() {
    var w = window.Arduino.getWheels();
    var vL = (w.left / 255) * MAXSPEED;
    var vR = (w.right / 255) * MAXSPEED;
    var v = (vL + vR) / 2;
    // En pantalla (Y hacia abajo) el angulo positivo es horario: rueda izq mas
    // rapida => gira a la DERECHA => omega = (vL - vR). Igual que el original.
    var omega = (vL - vR) / (robot.w / CM) * 0.5;
    var nx = robot.x + Math.cos(robot.angle) * v * CM;
    var ny = robot.y + Math.sin(robot.angle) * v * CM;
    // chequeo de colision en la trompa
    var hx = nx + Math.cos(robot.angle) * (robot.h / 2);
    var hy = ny + Math.sin(robot.angle) * (robot.h / 2);
    if (!pointInObstacle(hx, hy)) { robot.x = nx; robot.y = ny; }
    robot.angle += omega;
  }

  function pollIfDue(dt) {
    pollAccum += dt;
    if (pollAccum < 100) return;
    pollAccum = 0;
    fetch("/__sim/estado").then(function (r) { return r.json(); }).then(function (d) {
      if (d.ts !== lastTs) {
        lastTs = d.ts;
        if (d.request) {
          window.Arduino.setRequest(d.request);
          if (api.onRequest) api.onRequest(d.request);
        }
      }
    }).catch(function () {});
  }

  // -----------------------------------------------------------------------
  // Dibujo
  // -----------------------------------------------------------------------
  function drawObstacles() {
    p.noStroke(); p.fill(90, 100, 120);
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (o.type === "rect") p.rect(o.x, o.y, o.w, o.h, 4);
      else if (o.type === "circle") p.ellipse(o.x, o.y, o.r * 2, o.r * 2);
      else if (o.type === "poly") {
        p.beginShape();
        for (var j = 0; j < o.pts.length; j++) p.vertex(o.pts[j].x, o.pts[j].y);
        p.endShape(p.CLOSE);
      }
    }
  }

  // Preview en vivo de lo que se esta creando (rect/circulo/trazo libre)
  function drawDraft() {
    if (dragObs) {
      p.fill(31, 111, 235, 60); p.stroke(88, 166, 255); p.strokeWeight(2);
      if (dragObs.type === "rect") p.rect(dragObs.x, dragObs.y, dragObs.w, dragObs.h, 4);
      else p.ellipse(dragObs.x, dragObs.y, dragObs.r * 2, dragObs.r * 2);
    }
    if (polyPts && polyPts.length > 1) {
      p.fill(31, 111, 235, 60); p.stroke(88, 166, 255); p.strokeWeight(2);
      p.beginShape();
      for (var i = 0; i < polyPts.length; i++) p.vertex(polyPts[i].x, polyPts[i].y);
      p.endShape(); // abierto mientras se dibuja; se cierra al soltar
    }
    if (slineStart && slineEnd) {
      p.stroke(20, 160); p.strokeWeight(brush); p.strokeCap(p.ROUND);
      p.line(slineStart.x, slineStart.y, slineEnd.x, slineEnd.y);
    }
  }
  // HC-SR04: placa azul con los dos "ojos" plateados (mas chico, proporcional al auto)
  function drawHC(x, y, rot) {
    p.push();
    p.translate(x, y);
    p.rotate(rot);
    p.noStroke(); p.fill(30, 58, 138);          // placa azul
    p.rect(0, 0, 6, 16, 1);
    p.stroke(110); p.strokeWeight(0.8); p.fill(205); // cilindros plateados
    p.ellipse(0, -4.5, 6, 6);
    p.ellipse(0, 4.5, 6, 6);
    p.noStroke(); p.fill(70);                   // malla interior
    p.ellipse(0, -4.5, 3.5, 3.5);
    p.ellipse(0, 4.5, 3.5, 3.5);
    p.pop();
  }

  // Dibujado calcado del auto real (fotos): chasis negro impreso 3D con
  // frente achaflanado, ruedas amarillas, 3 HC-SR04, L298N rojo, UNO R4,
  // protoboard amarilla, IR azules y LED. Sin cables.
  function drawRobot() {
    var L = robot.h;  // largo (eje de avance)
    var A = robot.w;  // ancho
    p.push();
    p.translate(robot.x, robot.y);
    p.rotate(robot.angle);
    p.rectMode(p.CENTER);

    // Ruedas traseras: cubierta negra + llanta amarilla, bien atrás
    p.noStroke(); p.fill(22);
    p.rect(-L * 0.30, -A / 2 - 5, 24, 11, 3);   // rueda izq
    p.rect(-L * 0.30, A / 2 + 5, 24, 11, 3);    // rueda der
    p.fill("#f1c40f");
    p.rect(-L * 0.30, -A / 2 - 5, 12, 6, 2);    // llanta izq
    p.rect(-L * 0.30, A / 2 + 5, 12, 6, 2);     // llanta der
    // Rueda loca delantera (chiquita, debajo del chasis)
    p.fill(60); p.ellipse(L * 0.38, 0, 6, 6);

    // Chasis negro rectangular con chaflanes al frente
    p.stroke(0); p.strokeWeight(1.5); p.fill(30, 32, 36);
    p.beginShape();
    p.vertex(L * 0.46, -A * 0.28);
    p.vertex(L * 0.46, A * 0.28);
    p.vertex(L * 0.34, A / 2);
    p.vertex(-L * 0.42, A / 2);
    p.vertex(-L / 2, A * 0.36);
    p.vertex(-L / 2, -A * 0.36);
    p.vertex(-L * 0.42, -A / 2);
    p.vertex(L * 0.34, -A / 2);
    p.endShape(p.CLOSE);

    // === COMPONENTES (de atras hacia adelante, como el auto real) ===

    // Arduino UNO R4 (celeste) — atras, ocupa buena parte
    p.noStroke(); p.fill(0, 130, 150);
    p.rect(-L * 0.20, 0, L * 0.34, A * 0.50, 2);
    // Puerto USB plateado
    p.fill(185); p.rect(-L * 0.37, 0, 5, 7, 1);
    // Chip negro del micro
    p.fill(20); p.rect(-L * 0.14, 0, L * 0.07, A * 0.12, 1);
    // Pines dorados
    p.fill(180, 160, 50);
    p.rect(-L * 0.20, -A * 0.22, L * 0.28, 2, 0);
    p.rect(-L * 0.20, A * 0.22, L * 0.28, 2, 0);

    // Protoboard amarilla — mas chica que el L298N, centrada
    p.fill(240, 210, 80);
    p.rect(L * 0.10, 0, L * 0.14, A * 0.34, 2);
    // Canal central
    p.fill(200, 180, 60); p.rect(L * 0.10, 0, L * 0.14, 1.5);
    // Agujeros de la proto
    p.fill(170, 150, 40);
    for (var row = -2; row <= 2; row++) {
      for (var col = -1; col <= 1; col++) {
        p.ellipse(L * 0.10 + col * 3.5, row * 3, 1.2, 1.2);
      }
    }

    // L298N rojo con disipador — adelante de la proto, mas grande que la proto
    p.fill(192, 57, 43);
    p.rect(L * 0.28, 0, L * 0.18, A * 0.40, 2);
    // Disipador negro
    p.fill(25); p.rect(L * 0.28, 0, L * 0.05, A * 0.28, 1);
    // Borneras azules
    p.fill(40, 80, 200);
    p.rect(L * 0.35, -A * 0.12, 3, 5, 1);
    p.rect(L * 0.35, A * 0.12, 3, 5, 1);

    // 3 Sensores Infrarrojos dentro del chasis (naranja)
    p.fill(230, 126, 34);
    p.rect(L * 0.40, -A * 0.20, 5, 5, 1);
    p.rect(L * 0.40, 0, 5, 5, 1);
    p.rect(L * 0.40, A * 0.20, 5, 5, 1);
    // Lentes IR (punto negro)
    p.fill(0);
    p.ellipse(L * 0.40, -A * 0.20, 2.5, 2.5);
    p.ellipse(L * 0.40, 0, 2.5, 2.5);
    p.ellipse(L * 0.40, A * 0.20, 2.5, 2.5);

    // 3 sensores HC-SR04: frontal al borde, laterales adelante de la rueda (como el real)
    drawHC(L * 0.42, 0, 0);                           // frontal
    drawHC(L * 0.15, -A / 2 + 2, -Math.PI / 2);       // lateral izq
    drawHC(L * 0.15, A / 2 - 2, Math.PI / 2);          // lateral der

    p.rectMode(p.CORNER);
    p.pop();
  }
  function drawSensorViz() {
    var i;
    // Haz ultrasonico: cono PIE como drawSensorCono() del original
    // (rojo = cerca, amarillo = medio, azul = libre)
    var apertura = Math.PI / 24;
    var VIS_MAX = 80; // cm: tope visual del haz para que no inunde la escena
    for (i = 0; i < lastSensors.us.length; i++) {
      var s = lastSensors.us[i];
      var d = Math.min(s.dist, VIS_MAX) * CM;
      if (s.dist < 20)            { p.fill(255, 0, 0, 80);   p.stroke(255, 0, 0, 120);   }
      else if (s.dist < VIS_MAX)  { p.fill(255, 255, 0, 60); p.stroke(255, 255, 0, 100); }
      else                        { p.fill(0, 100, 255, 40); p.stroke(0, 100, 255, 60);  }
      p.strokeWeight(1);
      p.arc(s.x, s.y, d * 2, d * 2, s.ang - apertura, s.ang + apertura, p.PIE);
    }
    // Sensores IR del siguelinea: puntitos (igual que antes)
    for (i = 0; i < lastSensors.ir.length; i++) {
      var r = lastSensors.ir[i];
      p.noStroke(); p.fill(r.negro ? "#111" : "#e67e22");
      p.ellipse(r.x, r.y, 8, 8);
    }
  }

  // -----------------------------------------------------------------------
  // p5 sketch
  // -----------------------------------------------------------------------
  function sketch(pp) {
    p = pp;
    pp.setup = function () {
      var cont = document.getElementById("canvas-container");
      if (cont) {
        W = Math.max(600, Math.min(1280, (cont.clientWidth || 960) - 60));
        H = Math.max(400, Math.min(920, (cont.clientHeight || 700) - 110));
      }
      var c = pp.createCanvas(W, H);
      c.parent("canvas-holder");
      track = pp.createGraphics(W, H);
      track.background(255);
      pp.frameRate(60);
      robot.x = W * 0.18; robot.y = H * 0.5;
      startPose = { x: robot.x, y: robot.y, angle: 0 };
      loadScene();
    };
    pp.draw = function () {
      window.__simFrames = (window.__simFrames || 0) + 1;
      pp.background(245);
      pp.image(track, 0, 0);
      drawObstacles();
      if (running && window.Arduino && window.Arduino.isReady()) {
        pollIfDue(pp.deltaTime || 16);
        // Always apply kinematics: the car keeps moving with whatever
        // pin state was set before a delay() paused execution.
        applyKinematics();
        measureSensors();
        var r = window.Arduino.runLoop();
        if (!r.ok) { running = false; if (api.onError) api.onError(r.error); }
        if (api.onConsole) api.onConsole(window.Arduino.getConsole());
      }
      drawRobot();
      drawSensorViz();
      drawDraft();
    };

    pp.mousePressed = function () {
      if (!inCanvas()) return;
      var mx = pp.mouseX, my = pp.mouseY;
      if (tool === "robot") {
        if (Math.hypot(mx - robot.x, my - robot.y) < robot.w) draggingRobot = true;
        return;
      }
      if (tool === "rect") { dragObs = { type: "rect", x: mx, y: my, w: 1, h: 1 }; return; }
      if (tool === "circle") { dragObs = { type: "circle", x: mx, y: my, r: 1 }; return; }
      if (tool === "poly") { polyPts = [{ x: mx, y: my }]; return; }
      if (tool === "sline") { slineStart = { x: mx, y: my }; slineEnd = { x: mx, y: my }; return; }
      if (tool === "erase") { lastPaint = null; eraseAt(mx, my); return; }
      lastPaint = null;
      paintStroke(mx, my, 20);
    };
    pp.mouseDragged = function () {
      if (!inCanvas()) return;
      var mx = pp.mouseX, my = pp.mouseY;
      if (draggingRobot) { robot.x = mx; robot.y = my; return; }
      if (dragObs) {
        if (dragObs.type === "rect") { dragObs.w = mx - dragObs.x; dragObs.h = my - dragObs.y; }
        else { dragObs.r = Math.hypot(mx - dragObs.x, my - dragObs.y); }
        return;
      }
      if (polyPts) {
        var last = polyPts[polyPts.length - 1];
        if (Math.hypot(mx - last.x, my - last.y) > 5) polyPts.push({ x: mx, y: my });
        return;
      }
      if (slineStart) { slineEnd = { x: mx, y: my }; return; }
      if (tool === "erase") { eraseAt(mx, my); return; }
      if (tool === "line") paintStroke(mx, my, 20);
    };
    pp.mouseReleased = function () {
      draggingRobot = false;
      if (dragObs) {
        if (dragObs.type === "rect") {
          if (dragObs.w < 0) { dragObs.x += dragObs.w; dragObs.w = -dragObs.w; }
          if (dragObs.h < 0) { dragObs.y += dragObs.h; dragObs.h = -dragObs.h; }
          if (dragObs.w > 5 && dragObs.h > 5) obstacles.push(dragObs);
        } else if (dragObs.r > 5) obstacles.push(dragObs);
        dragObs = null;
      }
      if (polyPts) {
        // Cerrar el trazo: queda un obstaculo uniforme relleno
        if (polyPts.length >= 3) obstacles.push({ type: "poly", pts: polyPts });
        polyPts = null;
      }
      if (slineStart && slineEnd) {
        // Confirmar la linea recta sobre la pista
        track.stroke(20); track.strokeWeight(brush); track.strokeCap(p.ROUND);
        track.line(slineStart.x, slineStart.y, slineEnd.x, slineEnd.y);
        slineStart = slineEnd = null;
      }
      lastPaint = null;
    };
    pp.mouseWheel = function (ev) {
      if (!inCanvas() || tool !== "robot") return;
      robot.angle += (ev.delta > 0 ? 0.12 : -0.12);
      return false;
    };
  }

  function inCanvas() {
    return p && p.mouseX >= 0 && p.mouseY >= 0 && p.mouseX <= W && p.mouseY <= H;
  }
  // Trazo CONTINUO: une el punto anterior con el actual con una linea de
  // punta redonda (sin huecos aunque el mouse vaya rapido).
  function paintStroke(x, y, col) {
    if (!track) return;
    if (lastPaint) {
      track.stroke(col); track.strokeWeight(brush); track.strokeCap(p.ROUND);
      track.line(lastPaint.x, lastPaint.y, x, y);
    }
    track.noStroke(); track.fill(col);
    track.ellipse(x, y, brush, brush);
    lastPaint = { x: x, y: y };
  }

  // Goma: si toca un obstaculo lo borra ENTERO; si no, borra pista (continuo).
  function eraseAt(x, y) {
    var idx = hitObstacle(x, y);
    if (idx >= 0) { obstacles.splice(idx, 1); lastPaint = null; return; }
    paintStroke(x, y, 255);
  }

  // -----------------------------------------------------------------------
  // Escena: guardar / cargar (localStorage)
  // -----------------------------------------------------------------------
  function saveScene() {
    try {
      startPose = { x: robot.x, y: robot.y, angle: robot.angle };
      var data = {
        obstacles: obstacles,
        robot: startPose,
        track: track.canvas.toDataURL()
      };
      localStorage.setItem("autosim_scene", JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  }
  function loadScene() {
    try {
      var raw = localStorage.getItem("autosim_scene");
      if (!raw) return;
      var data = JSON.parse(raw);
      obstacles = data.obstacles || [];
      if (data.robot) {
        robot.x = data.robot.x; robot.y = data.robot.y; robot.angle = data.robot.angle;
        startPose = { x: robot.x, y: robot.y, angle: robot.angle };
      }
      if (data.track) {
        var img = new Image();
        img.onload = function () { track.background(255); track.drawingContext.drawImage(img, 0, 0); };
        img.src = data.track;
      }
    } catch (e) {}
  }
  function clearScene() {
    obstacles = [];
    if (track) track.background(255);
  }

  // -----------------------------------------------------------------------
  // API publica
  // -----------------------------------------------------------------------
  api.init = function () { if (!p5i) p5i = new p5(sketch); };
  api.setConfig = function (c) { cfg = c; if (window.Arduino) window.Arduino.configure(c); };
  api.start = function () { running = true; lastTs = -1; };
  api.pause = function () { running = false; };
  api.isRunning = function () { return running; };
  api.reset = function () {
    running = false;
    if (window.Arduino) window.Arduino.reset();
    // Vuelve el auto a la pose inicial (la guardada con la escena, si hay)
    robot.x = startPose.x; robot.y = startPose.y; robot.angle = startPose.angle;
    lastSensors = { us: [], ir: [] };
  };
  api.setTool = function (t) { tool = t; };
  api.setBrush = function (b) { brush = b; };
  api.saveScene = saveScene;
  api.clearScene = clearScene;
  api.getRobot = function () { return robot; };
  api.placeRobot = function (x, y) { robot.x = x; robot.y = y; };
  api.getObstacles = function () { return obstacles; };
  api.redraw = function () { if (p) p.redraw(); };

  return api;
})();
