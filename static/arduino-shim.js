/* =========================================================================
 * arduino-shim.js  —  Runtime Arduino/WiFiS3 en el navegador.
 *
 * Da vida al codigo ya transpilado (transpiler.js):
 *  - Stubs de WiFiS3: WiFiServer/WiFiClient/WiFi alimentados por el request
 *    que el simulador pooleo del backend  =>  atenderCliente() corre sin tocar.
 *  - Primitivos Arduino: analogWrite/digitalWrite -> ruedas, pulseIn -> ultrasonido,
 *    analogRead -> IR, millis/map/constrain/Serial, etc.
 *  - Compila a un scope persistente {setup, loop} (estado del FSM persiste).
 *  - Panel de errores: sintaxis y runtime con numero de linea ORIGINAL + hint.
 *
 * El simulador (sim.js) maneja este modulo via la API global `Arduino`.
 * ========================================================================= */
(function (global) {
  "use strict";

  var A = {};            // API publica -> global.Arduino
  var env = null;        // objeto inyectado al codigo del usuario (con `with`)
  var program = null;    // { setup, loop } compilado
  var currentSource = "";
  var t0 = 0;            // origen de millis()

  // ---- Async execution state --------------------------
  var setupRunning = false;
  var setupError = null;
  var loopRunning = false;
  var loopError = null;
  var replaying = false; // Kept for api compat

  // ---- Estado del hardware simulado --------------------------------------
  var pinState = {};      // pin -> valor PWM (0..255). digital HIGH=255 LOW=0
  var ultrasonic = {};    // echoPin -> distancia cm (o grande si libre)
  var irValues = {};      // pin (ej "A0") -> 0..1023
  var pendingRequest = null; // ultima linea HTTP no consumida
  var consoleLines = [];  // salida Serial
  var consoleCur = "";

  // ---- Mapa de pines (de la config) --------------------------------------
  var motorPins = { leftFwd: 5, leftBack: 6, rightFwd: 10, rightBack: 11 };

  // ---- Constantes Arduino -------------------------------------------------
  var CONST = {
    HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2,
    LED_BUILTIN: 13, true: true, false: false, null: null,
    DEC: 10, HEX: 16, OCT: 8, BIN: 2,
    A0: "A0", A1: "A1", A2: "A2", A3: "A3", A4: "A4", A5: "A5",
    A6: "A6", A7: "A7",
    WL_AP_LISTENING: 7, WL_CONNECTED: 3, WL_IDLE_STATUS: 0, WL_NO_SHIELD: 255,
    PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180,
    RAD_TO_DEG: 180 / Math.PI, EULER: Math.E
  };

  // -----------------------------------------------------------------------
  // Helpers de motores / sensores
  // -----------------------------------------------------------------------
  function setPin(pin, val) { pinState[pin] = val; }

  function getWheels() {
    var lf = pinState[motorPins.leftFwd] || 0;
    var lb = pinState[motorPins.leftBack] || 0;
    var rf = pinState[motorPins.rightFwd] || 0;
    var rb = pinState[motorPins.rightBack] || 0;
    return {
      left: clampPWM(lf - lb),
      right: clampPWM(rf - rb)
    };
  }
  function clampPWM(v) { return Math.max(-255, Math.min(255, v)); }

  // -----------------------------------------------------------------------
  // Stubs de WiFiS3
  // -----------------------------------------------------------------------
  function WiFiClient(line) {
    this._buf = (line != null) ? (line + "\r\n\r\n") : "";
    this._open = true;
  }
  WiFiClient.prototype.connected = function () { return this._open && this._buf.length > 0; };
  WiFiClient.prototype.available = function () { return this._buf.length; };
  WiFiClient.prototype.read = function () {
    if (!this._buf.length) { this._open = false; return ""; }
    var ch = this._buf[0];
    this._buf = this._buf.slice(1);
    if (!this._buf.length) this._open = false;
    return ch; // 1-char string: compara bien contra '\n', '\r'
  };
  WiFiClient.prototype.readStringUntil = function (term) {
    var idx = this._buf.indexOf(term);
    if (idx < 0) { var s = this._buf; this._buf = ""; this._open = false; return s; }
    var s2 = this._buf.slice(0, idx);
    this._buf = this._buf.slice(idx + 1);
    if (!this._buf.length) this._open = false;
    return s2;
  };
  WiFiClient.prototype.readString = function () { var s = this._buf; this._buf = ""; this._open = false; return s; };
  WiFiClient.prototype.peek = function () { return this._buf.length ? this._buf[0] : ""; };
  WiFiClient.prototype.print = function () {};
  WiFiClient.prototype.println = function () {};
  WiFiClient.prototype.write = function () {};
  WiFiClient.prototype.flush = function () {};
  WiFiClient.prototype.stop = function () { this._open = false; };

  function WiFiServer(port) { this.port = port; }
  WiFiServer.prototype.begin = function () {};
  WiFiServer.prototype.available = function () {
    if (pendingRequest != null) {
      var line = pendingRequest;
      pendingRequest = null;
      return new WiFiClient(line);
    }
    return null; // falsy => if(client) salta
  };

  // IP que muestra WiFi.localIP(): en el sim, el "Arduino" es esta PC.
  // app.js la setea con la IP real (de /__sim/info) apenas carga.
  var localIP = "127.0.0.1";

  var WiFiObj = {
    beginAP: function () { return CONST.WL_AP_LISTENING; },
    begin: function () { return CONST.WL_CONNECTED; },
    localIP: function () { return localIP; },
    status: function () { return CONST.WL_AP_LISTENING; },
    config: function () {}, RSSI: function () { return -50; },
    SSID: function () { return "Sim_AP"; }, disconnect: function () {},
    macAddress: function () { return "00:00:00:00:00:00"; }
  };

  // -----------------------------------------------------------------------
  // Serial
  // -----------------------------------------------------------------------
  function fmt(x, base) {
    if (typeof x === "number" && base && base !== 10) {
      var v = Math.trunc(x);
      if (v < 0 && base !== 10) v = v >>> 0;
      return v.toString(base).toUpperCase();
    }
    if (typeof x === "number") {
      // Arduino imprime floats con 2 decimales por defecto
      return (Number.isInteger(x) ? String(x) : x.toFixed(2));
    }
    return String(x);
  }
  function serialWrite(s) {
    s = String(s);
    var parts = s.split("\n");
    consoleCur += parts[0];
    for (var i = 1; i < parts.length; i++) {
      consoleLines.push(consoleCur);
      consoleCur = parts[i];
      if (consoleLines.length > 400) consoleLines.shift();
    }
  }
  var SerialObj = {
    begin: function () {}, end: function () {}, flush: function () {},
    available: function () { return 0; }, read: function () { return -1; },
    peek: function () { return -1; },
    print: function (x, base) { serialWrite(x == null ? "" : fmt(x, base)); },
    println: function (x, base) { serialWrite((x == null ? "" : fmt(x, base)) + "\n"); },
    write: function (x) { serialWrite(typeof x === "number" ? String.fromCharCode(x) : x); },
    print_P: function (x) { serialWrite(String(x)); }
  };

  // -----------------------------------------------------------------------
  // Math / IO Arduino
  // -----------------------------------------------------------------------
  function aMap(x, inMin, inMax, outMin, outMax) {
    if (inMax === inMin) return outMin;
    return Math.trunc((x - inMin) * (outMax - outMin) / (inMax - inMin) + outMin);
  }
  function aConstrain(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
  function aRandom(a, b) {
    if (b === undefined) { b = a; a = 0; }
    return Math.floor(Math.random() * (b - a)) + a;
  }
  function pulseIn(pin, state, timeout) {
    var d = ultrasonic[pin];
    if (d == null || d > 300) return 0;        // sin eco -> 0 (el codigo usa su "libre")
    return Math.round(d * 58.0);               // dist = dur*0.034/2  ~  dur/58
  }

  // -----------------------------------------------------------------------
  // Construccion del entorno inyectado
  // -----------------------------------------------------------------------
  function buildEnv() {
    var e = {
      // IO
      pinMode: function () {},
      digitalWrite: function (pin, val) { setPin(pin, val ? 255 : 0); },
      digitalRead: function (pin) { return (pinState[pin] || 0) > 127 ? 1 : 0; },
      analogWrite: function (pin, val) { setPin(pin, Math.max(0, Math.min(255, val | 0))); },
      analogRead: function (pin) { var v = irValues[pin]; return v == null ? 0 : v | 0; },
      analogReadResolution: function () {}, analogWriteResolution: function () {},
      pulseIn: pulseIn, pulseInLong: pulseIn,
      tone: function () {}, noTone: function () {},
      shiftOut: function () {}, shiftIn: function () { return 0; },
      attachInterrupt: function () {}, detachInterrupt: function () {},
      noInterrupts: function () {}, interrupts: function () {},
      digitalPinToInterrupt: function (p) { return p; },
      // Tiempo
      millis: function () { return Date.now() - t0; },
      micros: function () { return (Date.now() - t0) * 1000; },
      delay: async function (ms) {
        ms = Math.max(0, ms | 0);
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      },
      delayMicroseconds: async function (us) {
        var ms = Math.max(1, Math.round((us || 0) / 1000));
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      },
      __yield: async function () {
        return new Promise(function(resolve) { setTimeout(resolve, 0); });
      },
      yield: async function () {
        return new Promise(function(resolve) { setTimeout(resolve, 0); });
      },
      // Math
      map: aMap, constrain: aConstrain,
      min: function (a, b) { return Math.min(a, b); },
      max: function (a, b) { return Math.max(a, b); },
      abs: function (a) { return Math.abs(a); },
      sq: function (a) { return a * a; },
      sqrt: function (a) { return Math.sqrt(a); },
      pow: function (a, b) { return Math.pow(a, b); },
      sin: Math.sin, cos: Math.cos, tan: Math.tan,
      floor: Math.floor, ceil: Math.ceil, round: Math.round,
      log: Math.log, exp: Math.exp,
      random: aRandom, randomSeed: function () {},
      // Bits
      bit: function (n) { return 1 << n; },
      bitRead: function (v, n) { return (v >> n) & 1; },
      bitWrite: function (v, n, b) { return b ? (v | (1 << n)) : (v & ~(1 << n)); },
      bitSet: function (v, n) { return v | (1 << n); },
      bitClear: function (v, n) { return v & ~(1 << n); },
      lowByte: function (v) { return v & 0xFF; },
      highByte: function (v) { return (v >> 8) & 0xFF; },
      // Texto / util
      String: global.String,
      sizeof: function (x) { return (x && x.length) || 1; },
      constrainf: aConstrain,
      // Serial / WiFiS3
      Serial: SerialObj,
      WiFiServer: WiFiServer, WiFiClient: WiFiClient, WiFi: WiFiObj,
      IPAddress: function () { return "0.0.0.0"; },
      Servo: function () { return { attach: function () {}, write: function () {}, read: function () { return 0; }, detach: function () {} }; }
    };
    // Constantes
    for (var k in CONST) if (CONST.hasOwnProperty(k)) e[k] = CONST[k];
    return e;
  }

  // -----------------------------------------------------------------------
  // String prototype extras (Arduino)
  // -----------------------------------------------------------------------
  if (!String.prototype.toInt) {
    String.prototype.toInt = function () { var n = parseInt(this, 10); return isNaN(n) ? 0 : n; };
    String.prototype.toFloat = function () { var n = parseFloat(this); return isNaN(n) ? 0 : n; };
    String.prototype.toDouble = String.prototype.toFloat;
    String.prototype.equals = function (o) { return String(this) === String(o); };
    String.prototype.equalsIgnoreCase = function (o) { return String(this).toLowerCase() === String(o).toLowerCase(); };
    String.prototype.toLowerCaseAr = function () { return this.toLowerCase(); };
  }

  // -----------------------------------------------------------------------
  // Deteccion de errores de sintaxis (sobre el .ino ORIGINAL, line map identidad)
  // -----------------------------------------------------------------------
  function findSyntaxIssue(srcText) {
    var lines = srcText.replace(/\r\n/g, "\n").split("\n");
    var stack = [], pairs = { ")": "(", "]": "[", "}": "{" };
    var q = null, block = false;
    for (var ln = 0; ln < lines.length; ln++) {
      var s = lines[ln];
      for (var i = 0; i < s.length; i++) {
        var c = s[i], d = s[i + 1];
        if (block) { if (c === "*" && d === "/") { block = false; i++; } continue; }
        if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
        if (c === "/" && d === "/") break;          // comentario de linea
        if (c === "/" && d === "*") { block = true; i++; continue; }
        if (c === '"' || c === "'" || c === "`") { q = c; continue; }
        if (c === "(" || c === "[" || c === "{") stack.push({ c: c, ln: ln });
        else if (c === ")" || c === "]" || c === "}") {
          var open = stack.pop();
          if (!open || open.c !== pairs[c]) {
            return { line: ln + 1, hint: 'Cierre "' + c + '" sin su apertura.', text: s };
          }
        }
      }
    }
    if (stack.length) {
      var o = stack[stack.length - 1];
      return { line: o.ln + 1, hint: 'Falta cerrar "' + o.c + '" (se abrio aca y no se cierra).', text: lines[o.ln] };
    }
    return null;
  }

  function parseErrLine(err, preambleLines) {
    var m = (err && err.stack || "").match(/<anonymous>:(\d+):(\d+)/);
    if (m) {
      var l = parseInt(m[1], 10) - preambleLines;
      if (l > 0) return l;
    }
    if (err && typeof err.lineNumber === "number") return err.lineNumber - preambleLines;
    return null;
  }

  function sourceLine(src, line) {
    if (!line || line < 1) return "";
    return String(src || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")[line - 1] || "";
  }

  function hintForError(err, phase, srcLine) {
    var msg = (err && err.message) || "";
    if (/Unexpected identifier|Unexpected token/.test(msg) && /\b(if|for|while)\s*\([^)]*\)\s*(?:int|long|float|double|bool|boolean|byte|String|char)\b/.test(srcLine || "")) {
      return "Hay una declaracion C/C++ justo despues de un if/for/while sin llaves. En el simulador usa llaves: if (...) { int x = ...; }.";
    }
    if (/Unexpected identifier|Unexpected token/.test(msg)) {
      return "El transpilador dejo sintaxis C/C++ sin convertir en esta linea. Revisa declaradores, llaves y punto y coma.";
    }
    if (/is not defined/.test(msg)) {
      return "Hay un nombre que no existe en el sketch simulado. Revisa #define, pines, variables globales o una libreria no soportada.";
    }
    if (/Cannot read properties of undefined/.test(msg)) {
      return "Se esta usando un objeto o variable antes de inicializarlo. Revisa declaraciones como Tipo nombre; y constructores.";
    }
    if (/Assignment to constant variable/.test(msg)) {
      return "El codigo intenta cambiar una constante o un #define. En Arduino un #define no se puede reasignar.";
    }
    if (phase === "compile") {
      return "Revisa que no falte un ';', un parentesis o una llave. Si la linea es C++ valido, falta soporte del transpilador para ese patron.";
    }
    var where = (phase === "setup" || phase === "loop") ? (phase + "()") : phase;
    return "Error de ejecucion en " + where + ". Revisa la linea indicada y el estado de variables/sensores.";
  }

  function makeRuntimeError(err, phase) {
    var line = parseErrLine(err, PREAMBLE_LINES) || 0;
    var text = sourceLine(currentSource, line);
    return {
      line: line,
      message: err && err.message || String(err),
      hint: hintForError(err, phase, text),
      text: text
    };
  }

  function findLikelySourceLine(src) {
    var lines = String(src || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    for (var i = 0; i < lines.length; i++) {
      if (/\b(if|for|while)\s*\([^)]*\)\s*(?:int|long|float|double|bool|boolean|byte|String|char)\b/.test(lines[i])) {
        return i + 1;
      }
    }
    for (var j = 0; j < lines.length; j++) {
      if (/^\s*(?:int|long|float|double|bool|boolean|byte|String|char)\b/.test(lines[j]) && lines[j].indexOf(";") < 0 && lines[j].indexOf("{") < 0) {
        return j + 1;
      }
    }
    return 0;
  }

  // -----------------------------------------------------------------------
  // Compilacion
  // -----------------------------------------------------------------------
  var PREAMBLE_LINES = 1; // "with(__env){" ocupa 1 linea antes del codigo

  A.compile = function (userSrc) {
    program = null;
    currentSource = String(userSrc || "");
    var T = global.Transpiler;
    if (!T) return { ok: false, error: { line: 0, message: "Transpiler no cargado", hint: "" } };

    var res = T.transpile(userSrc);
    var code = res.code;

    // Chequeo de balance (errores lindos con linea original)
    var issue = findSyntaxIssue(userSrc);

    var body = "with(__env){\n" + code +
      "\n; return { setup: (typeof setup==='function')?setup:function(){}, " +
      "loop: (typeof loop==='function')?loop:function(){} }; }";
    var factory;
    try {
      factory = new Function("__env", body);
    } catch (e) {
      var line = issue ? issue.line : (parseErrLine(e, PREAMBLE_LINES) || findLikelySourceLine(userSrc));
      var errorText = issue ? issue.text : (line ? sourceLine(userSrc, line) : "");
      return {
        ok: false,
        error: {
          line: line || 0,
          message: e.message,
          hint: issue ? issue.hint : hintForError(e, "compile", errorText),
          text: errorText
        }
      };
    }

    // Reset de estado e instanciacion del programa
    resetState();
    env = buildEnv();
    try {
      program = factory(env);
    } catch (e2) {
      return {
        ok: false,
        error: makeRuntimeError(e2, "inicializacion")
      };
    }
    return { ok: true };
  };

  function resetState() {
    pinState = {}; ultrasonic = {}; irValues = {};
    pendingRequest = null; consoleLines = []; consoleCur = "";
    t0 = Date.now();
    setupRunning = false; setupError = null;
    loopRunning = false; loopError = null;
  }

  A.runSetup = async function () {
    if (!program) return { ok: false };
    setupRunning = true;
    setupError = null;
    try {
      await program.setup();
      setupRunning = false;
      return { ok: true };
    } catch (e) {
      setupRunning = false;
      return { ok: false, error: makeRuntimeError(e, "setup") };
    }
  };

  A.runLoop = function () {
    if (!program) return { ok: false };
    if (setupError) {
       var se = setupError;
       setupError = null;
       return { ok: false, error: se };
    }
    if (setupRunning) return { ok: true, delaying: true };
    if (loopError) {
       var e = loopError;
       loopError = null;
       return { ok: false, error: e };
    }
    if (loopRunning) return { ok: true, delaying: true };

    loopRunning = true;
    try {
      var p = program.loop();
      if (p && p.then) {
        p.then(function() {
          loopRunning = false;
        }, function(err) {
          loopError = makeRuntimeError(err, "loop");
          loopRunning = false;
        });
      } else {
        loopRunning = false;
      }
    } catch (err) {
      loopRunning = false;
      return { ok: false, error: makeRuntimeError(err, "loop") };
    }
    return { ok: true };
  };

  // -----------------------------------------------------------------------
  // API que usa el simulador (sim.js)
  // -----------------------------------------------------------------------
  A.configure = function (cfg) {
    try {
      var p = cfg.motores.pins;
      motorPins = { leftFwd: p.IN1, leftBack: p.IN2, rightFwd: p.IN3, rightBack: p.IN4 };
    } catch (e) { /* config incompleta: deja default */ }
  };

  A.setRequest = function (line) { pendingRequest = line; };
  A.setLocalIP = function (ip) { if (ip) localIP = ip; };
  A.setUltrasonic = function (echoPin, distCm) { ultrasonic[echoPin] = distCm; };
  A.setIR = function (pin, val) { irValues[pin] = val; };
  A.getWheels = getWheels;
  A.getConsole = function () { return consoleLines.concat(consoleCur ? [consoleCur] : []); };
  A.clearConsole = function () { consoleLines = []; consoleCur = ""; };
  A.reset = resetState;
  A.isReady = function () { return !!program; };

  global.Arduino = A;
})(typeof window !== "undefined" ? window : this);
