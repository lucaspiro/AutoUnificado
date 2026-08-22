/* =========================================================================
 * run_tests.js  —  Tests de regresion del transpiler Arduino -> JavaScript.
 *
 * Cubre los findings del issue #2 (transpiler) y sus contrapartes de runtime:
 *   1  struct con tipos compuestos
 *   2  init agregado de structs (array y escalar)
 *   3  sizeof() -> .length
 *   4  parametros por referencia (wrappers + copy-back)
 *   5  "const T *" no vuelve const el binding JS
 *   6  NULL / nullptr -> null
 *   7  variantes de spacing en firmas con puntero
 *   8  metodos de String de Arduino (equals, toInt, reserve, ...)
 *   9  F() con literales adyacentes (una y varias lineas)
 *  10  async/await en llamadas anidadas (outer(inner(...)))
 *  11  todas las funciones del usuario son async y sus llamadas tienen await
 *  12  insercion de await en expresiones completas (return, +, ternario, [])
 *  13  WiFiClient.print/println construyen la respuesta HTTP real
 *  14  polaridad de motores configurable por lado
 *  Ademas: sketch de integracion completo (test/sketch_autotito.ino) con
 *  invariante de mapa de lineas y corrida runtime del server HTTP.
 *
 *  Correr:  node test/run_tests.js
 * ========================================================================= */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var ROOT = path.join(__dirname, "..");
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "static/transpiler.js"), "utf8"), { filename: "transpiler.js" });
vm.runInThisContext(fs.readFileSync(path.join(ROOT, "static/arduino-shim.js"), "utf8"), { filename: "arduino-shim.js" });

var T = global.Transpiler;
var A = global.Arduino;

var passed = 0, failed = 0;
var current = "";

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// Los tests runtime comparten el estado global del shim (console, program,
// requests): se serializan con un queue para que no se pisen entre si.
var queue = Promise.resolve();
function serial(fn) {
  var p = queue.then(fn);
  queue = p.catch(function () {});
  return p;
}

function section(name) { current = name; console.log("\n== " + name); }

function ok(cond, label, extra) {
  if (cond) { passed++; console.log("  PASS  " + label); }
  else {
    failed++;
    console.log("  FAIL  " + label + (extra !== undefined ? "  | " + extra : ""));
  }
}

function transpile(src) {
  var res = T.transpile(String(src).replace(/\r\n/g, "\n"));
  return { code: res.code, lines: res.code.split("\n"), srcLines: String(src).split("\n") };
}

function compileValid(src) {
  try { new Function(src); return true; } catch (e) { return false; }
}

// Compila un sketch y corre setup + N vueltas de loop en el shim.
// Se ejecuta dentro del queue: el estado del shim es global y compartido.
// onCompiled() corre despues del compile (el compile reinicia el estado,
// incluido el pedido HTTP pendiente): sirve para setear la request.
function runSketch(src, loops, onCompiled) {
  return serial(function () { return runSketchInner(src, loops, onCompiled); });
}
async function runSketchInner(src, loops, onCompiled) {
  var r = A.compile(String(src));
  if (!r.ok) return { compileError: r.error };
  if (onCompiled) onCompiled();
  var s = await A.runSetup();
  if (!s.ok) return { setupError: s.error };
  for (var i = 0; i < (loops || 10); i++) {
    var l = A.runLoop();
    if (!l.ok) return { loopError: l.error };
    await sleep(10);
  }
  await sleep(20);
  return { console: A.getConsole() };
}

function outContains(code, substr) { return code.indexOf(substr) >= 0; }

/* -------------------------------------------------------------------------
 * 1. struct con tipos compuestos
 * ------------------------------------------------------------------------- */
section("#1 struct con tipos compuestos");
(function () {
  var t = transpile("struct Step { int left; int right; unsigned int duration; };\nvoid setup() {}\nvoid loop() {}\n");
  ok(outContains(t.code, "function __make_Step(){ return { left: 0, right: 0, duration: 0 }; }"),
    "factory con campos bien separados (duration no arrastra el tipo)",
    JSON.stringify(t.lines[0]));
  ok(!/duration\s*:/ .test(t.code.replace(/duration: 0/g, "")), "no queda casting raro");
  ok(compileValid(t.code), "JS valido");
})();

/* -------------------------------------------------------------------------
 * 2. init agregado de structs (array y escalar) con campos nombrados
 * ------------------------------------------------------------------------- */
section("#2 init agregado de structs");
(function () {
  var t = transpile(
    "struct Step { int left; int right; unsigned int duration; };\n" +
    "const Step seq[] = { {100, 100, 200}, {-100, -100, 200} };\n" +
    "Step solo = {1, 2, 3};\n" +
    "void setup() {}\nvoid loop() {}\n");
  ok(outContains(t.code, "{ left: 100, right: 100, duration: 200 }"),
    "array: cada elemento es objeto con campos", t.lines[1]);
  ok(outContains(t.code, "{ left: -100, right: -100, duration: 200 }"), "array: segundo elemento");
  ok(outContains(t.code, "solo = { left: 1, right: 2, duration: 3 }"), "escalar: objeto con campos", t.lines[2]);
  ok(compileValid(t.code), "JS valido");
})();

/* -------------------------------------------------------------------------
 * 3. sizeof()
 * ------------------------------------------------------------------------- */
section("#3 sizeof()");
(function () {
  var t = transpile(
    "struct Step { int left; int right; unsigned int duration; };\n" +
    "const Step seq[] = { {100, 100, 200}, {-100, -100, 200} };\n" +
    "#define CANT (sizeof(seq) / sizeof(Step))\n" +
    "void setup() {\n  int n = sizeof(seq) / sizeof(seq[0]);\n}\nvoid loop() {}\n");
  ok(!/\bsizeof\s*\(/.test(t.code), "no queda ningun sizeof()");
  ok(outContains(t.code, "const CANT = (seq.length);"), "sizeof(arr)/sizeof(Tipo) -> arr.length", t.lines[2]);
  ok(outContains(t.code, "let n = seq.length;"), "sizeof(arr)/sizeof(arr[0]) -> arr.length");
})();

/* -------------------------------------------------------------------------
 * 4. parametros por referencia: semantica runtime
 * ------------------------------------------------------------------------- */
section("#4 parametros por referencia");
(function () {
  // callee: escribe el wrapper; caller: ve el valor escrito de vuelta
  var t = transpile(
    "bool flag = false;\n" +
    "int readValue(bool &valid) { valid = true; return 42; }\n" +
    "void setup() {\n  int r = readValue(flag);\n  Serial.print(r); Serial.print(\":\"); Serial.println(flag);\n}\nvoid loop() {}\n");
  ok(outContains(t.code, "async function readValue(valid) { valid.v = true; return 42; }"),
    "callee escribe valid.v", t.lines[1]);
  ok(outContains(t.code, "__ref("), "caller envuelve con __ref");
  ok(outContains(t.code, "flag = __ref1.v;"), "caller copia de vuelta");
  ok(outContains(t.code, "await readValue(__ref1)"), "con await en la llamada");
  ok(compileValid(t.code), "JS valido");
  return runSketch(
    "bool flag = false;\n" +
    "int readValue(bool &valid) { valid = true; return 42; }\n" +
    "void setup() {\n  int r = readValue(flag);\n  Serial.print(r); Serial.print(\":\"); Serial.println(flag);\n}\nvoid loop() {}\n"
  ).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console.length && res.console[0] === "42:true", "runtime: flag queda en true tras la llamada", res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 5. "const T *" no congela el binding
 * ------------------------------------------------------------------------- */
section("#5 const T* (binding mutable)");
(function () {
  var t = transpile(
    "const char *nombre = nullptr;\n" +
    "void setName(const char *value) { nombre = value; }\n" +
    "void setup() {\n  setName(\"hola\");\n  Serial.println(nombre);\n}\nvoid loop() {}\n");
  ok(outContains(t.code, "let nombre = null;"), "binding mutable (let) + nullptr -> null", t.lines[0]);
  ok(compileValid(t.code), "JS valido");
  return runSketch(
    "const char *nombre = nullptr;\n" +
    "void setName(const char *value) { nombre = value; }\n" +
    "void setup() {\n  setName(\"hola\");\n  Serial.println(nombre);\n}\nvoid loop() {}\n"
  ).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console && res.console[0] === "hola", "runtime: reasignacion permitida", res.console && res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 6. NULL / nullptr -> null
 * ------------------------------------------------------------------------- */
section("#6 NULL / nullptr");
(function () {
  var t = transpile(
    "char *ptr = NULL;\n" +
    "void setup() {}\nvoid loop() {}\n");
  ok(outContains(t.code, "let ptr = null;"), "char *ptr = NULL; -> let ptr = null;", t.lines[0]);
  ok(!/\b(NULL|nullptr)\b/.test(t.code), "no sobrevive NULL ni nullptr");
})();

/* -------------------------------------------------------------------------
 * 7. firmas con puntero y spacing variado
 * ------------------------------------------------------------------------- */
section("#7 firmas con puntero (spacing)");
(function () {
  var src =
    "const char* getNameA() { return \"A\"; }\n" +
    "const char *getNameB() { return \"B\"; }\n" +
    "const char * getNameC() { return \"C\"; }\n" +
    "void setup() {\n  Serial.print(getNameA()); Serial.print(getNameB()); Serial.println(getNameC());\n}\nvoid loop() {}\n";
  var t = transpile(src);
  ok(outContains(t.code, "async function getNameA()"), "const char* getNameA()");
  ok(outContains(t.code, "async function getNameB()"), "const char *getNameB()");
  ok(outContains(t.code, "async function getNameC()"), "const char * getNameC()");
  ok(outContains(t.code, "await getNameA()") && outContains(t.code, "await getNameB()") && outContains(t.code, "await getNameC()"),
    "llamadas con await");
  ok(compileValid(t.code), "JS valido");
  return runSketch(src).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console && res.console[0] === "ABC", "runtime: las tres variantes funcionan", res.console && res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 8. metodos de String de Arduino en el runtime
 * ------------------------------------------------------------------------- */
section("#8 String de Arduino");
(function () {
  ok(typeof String.prototype.equals === "function", "prototype.equals existe");
  ok(typeof String.prototype.toInt === "function", "prototype.toInt existe");
  ok(typeof String.prototype.reserve === "function", "prototype.reserve existe (no-op)");
  ok(typeof String.prototype.toCharArray === "function", "prototype.toCharArray existe");
  ok(typeof String.prototype.getBytes === "function", "prototype.getBytes existe");
  ok(typeof String.prototype.compareTo === "function", "prototype.compareTo existe");
  return runSketch(
    "String a = \"hola\";\n" +
    "void setup() {\n" +
    "  a.reserve(128);\n" +
    "  Serial.print(a.equals(\"hola\") ? \"EQ\" : \"NE\");\n" +
    "  Serial.print(\":\");\n" +
    "  Serial.println(String(\"123\").toInt() + 1);\n" +
    "}\nvoid loop() {}\n"
  ).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console && res.console[0] === "EQ:124", "runtime: equals + toInt + reserve", res.console && res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 9. F() con literales adyacentes (una y varias lineas)
 * ------------------------------------------------------------------------- */
section("#9 F() con literales concatenados");
(function () {
  var t = transpile(
    "void setup() {\n" +
    "  Serial.print(F(\"Hola \" \"mundo\"));\n" +
    "  Serial.println(F(\n    \"<html>\"\n    \"<body>\"\n    \"Hola\"\n    \"</body>\"\n    \"</html>\"\n  ));\n" +
    "}\nvoid loop() {}\n");
  ok(outContains(t.code, "\"Hola mundo\""), "una linea: literales concatenados");
  ok(outContains(t.code, "\"<html><body>Hola</body></html>\""), "multilinea: concatenado");
  ok(!/\bF\s*\(/.test(t.code), "no queda ningun F(");
  ok(compileValid(t.code), "JS valido");
  ok(t.code.split("\n").length === t.srcLines.length, "mapa de lineas preservado");
  return runSketch(
    "void setup() {\n" +
    "  Serial.print(F(\"Hola \" \"mundo\"));\n" +
    "  Serial.println(F(\n    \"<html>\"\n    \"<body>\"\n    \"Hola\"\n    \"</body>\"\n    \"</html>\"\n  ));\n" +
    "}\nvoid loop() {}\n"
  ).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console && res.console[0] === "Hola mundo<html><body>Hola</body></html>",
      "runtime: F() concatenado", res.console && res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 10. async/await en llamadas anidadas
 * ------------------------------------------------------------------------- */
section("#10 llamadas anidadas async");
(function () {
  var src =
    "int inner2(int x) { return x * 2; }\n" +
    "int outer2(int x) { return x + 1; }\n" +
    "void setup() {\n  int result = outer2(inner2(10));\n  Serial.println(result);\n}\nvoid loop() {}\n";
  var t = transpile(src);
  ok(outContains(t.code, "await outer2(await inner2(10))"), "await outer(await inner(...))", t.lines[4].trim());
  ok(compileValid(t.code), "JS valido");
  return runSketch(src).then(function (res) {
    if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
    ok(res.console && res.console[0] === "21", "runtime: inner resuelto antes de outer", res.console && res.console[0]);
  });
})();

/* -------------------------------------------------------------------------
 * 11. funciones async + await en todos sus callers
 * ------------------------------------------------------------------------- */
section("#11 funciones async y await en callers");
(function () {
  var t = transpile(
    "int clampValue(int value) { return value; }\n" +
    "void setup() {\n  int x = clampValue(5);\n  int y = clampValue(clampValue(7));\n  Serial.println(x + y);\n}\nvoid loop() {}\n");
  ok(outContains(t.code, "async function clampValue(value) { return value; }"), "funcion convertida a async", t.lines[0]);
  ok(outContains(t.code, "let x = await clampValue(5);"), "caller directo con await");
  ok(outContains(t.code, "await clampValue(await clampValue(7))") ||
     outContains(t.code, "let y = await clampValue(await clampValue(7))"), "caller anidado con ambos await");
})();

/* -------------------------------------------------------------------------
 * 12. await en expresiones completas
 * ------------------------------------------------------------------------- */
section("#12 await en expresiones completas");
(function () {
  var t = transpile(
    "int a12() { return 5; }\n" +
    "int b12() { return 7; }\n" +
    "int ret() { return a12(); }\n" +
    "void setup() {\n" +
    "  int s = a12() + b12();\n" +
    "  int arr[3];\n" +
    "  arr[a12()] = 1;\n" +
    "  int c = a12() > 2 ? b12() : 0;\n" +
    "}\nvoid loop() {}\n");
  ok(outContains(t.code, "return await a12();"), "return foo(); -> return await foo();");
  ok(outContains(t.code, "let s = await a12() + await b12();"), "x = foo() + bar(); con ambos await");
  ok(outContains(t.code, "arr[await a12()]"), "arr[foo()]; con await");
  ok(outContains(t.code, "await a12() > 2 ? await b12() : 0"), "ternario con await");
  ok(compileValid(t.code), "JS valido");
})();

/* -------------------------------------------------------------------------
 * 13. WiFiClient.print/println construyen la respuesta HTTP real
 * ------------------------------------------------------------------------- */
section("#13 WiFiClient -> respuesta HTTP real");
(function () {
  var src =
    "WiFiServer server(80);\n" +
    "void setup() { server.begin(); }\n" +
    "void loop() {\n" +
    "  WiFiClient client = server.available();\n" +
    "  if (client) {\n" +
    "    while (client.available()) { char c = client.read(); if (c == '\\n') break; }\n" +
    "    client.println(\"HTTP/1.1 200 OK\");\n" +
    "    client.println(\"Content-Type: application/json\");\n" +
    "    client.println();\n" +
    "    client.println(\"{\\\"ok\\\":true}\");\n" +
    "    client.stop();\n" +
    "  }\n" +
    "}\n";
  var t = transpile(src);
  ok(compileValid(t.code), "JS valido del sketch HTTP");
  var delivered = null;
  var probe = { src: src, delivered: null };
  return serial(function () {
    probe.delivered = null;
    return runSketchInner(src, 80, function () {
      A.onResponse = function (resp) { probe.delivered = resp; };
      A.setRequest("GET /estado HTTP/1.1", 99);
    }).then(function (res) {
      if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
      delivered = probe.delivered;
      ok(!!delivered, "stop() entrega la respuesta (onResponse)");
      ok(delivered && delivered.id === 99, "apareada con el id del pedido");
      ok(delivered && delivered.body.indexOf("HTTP/1.1 200 OK\r\n") === 0, "usa los bytes exactos escritos: status line");
      ok(delivered && delivered.body.indexOf("Content-Type: application/json\r\n") > 0, "cabeceras exactas");
      ok(delivered && /\{"ok":true}\r\n$/.test(delivered.body), "body exacto al final");
      ok(!res.loopError, "loop sin errores", res.loopError && res.loopError.message);
    });
  });
})();

/* -------------------------------------------------------------------------
 * 14. polaridad de motores por lado (config)
 * ------------------------------------------------------------------------- */
section("#14 polaridad de motores");
(function () {
  return serial(function () {
    A.configure({
      motores: {
        pins: { IN1: 5, IN2: 6, IN3: 10, IN4: 11 },
        invertido: { izq: false, der: true }
      }
    });
    return runSketchInner(
      "void setup() { analogWrite(10, 200); }\nvoid loop() {}\n"
    ).then(function (res) {
      if (res.compileError || res.setupError) { ok(false, "runtime sin errores", res.compileError || res.setupError); return; }
      var w = A.getWheels();
      ok(w.right === -200, "motor derecho invertido gira al reves", "right=" + w.right);
      ok(w.left === 0, "motor izquierdo no invertido");
      A.configure({ motores: { pins: { IN1: 5, IN2: 6, IN3: 10, IN4: 11 } } });
    });
  });
})();

/* -------------------------------------------------------------------------
 * Integral: sketch completo (test/sketch_autotito.ino)
 * ------------------------------------------------------------------------- */
section("Integral: sketch completo");
(function () {
  var src = fs.readFileSync(path.join(__dirname, "sketch_autotito.ino"), "utf8");
  var t = transpile(src);
  console.log("  (sketch: " + t.srcLines.length + " lineas)");

  ok(t.code.split("\n").length === t.srcLines.length, "mapa de lineas preservado");
  ok(compileValid(t.code), "JS generado valido (sintaxis)");

  ok(outContains(t.code, "function __make_PasoEmote(){ return { izq: 0, der: 0, duracion: 0 }; }"), "#1 factory PasoEmote");
  ok(outContains(t.code, "function __make_Emote(){ return { nombre: \"\", pasos: 0, cantidad: 0 }; }"),
     "#1 factory Emote (nombre char -> \"\"; punteros -> 0)");
  ok(outContains(t.code, "{ izq: 140, der: 140, duracion: 120 }"), "#2 EMOTE_SI en objetos");
  ok(!/\bsizeof\s*\(/.test(t.code), "#3 sin sizeof()");
  ok(outContains(t.code, "CANTIDAD_EMOTES = (EMOTES.length)"), "#3 count de emotes via .length");
  ok(outContains(t.code, "EMOTES.length"), "#3 sizeof(EMOTES)/sizeof(Emote) -> EMOTES.length");
  ok(outContains(t.code, "valido.v = false;") && outContains(t.code, "valido.v = true;"), "#4 medirDistancia escribe el wrapper");
  ok(outContains(t.code, "let nombreEmote = null;") && outContains(t.code, "let pasosEmote = null;"), "#5/#6 punteros const -> let + null");
  ok(!/\b(NULL|nullptr)\b/.test(t.code), "#6 sin NULL/nullptr");
  ok(outContains(t.code, "async function medirDistancia(trig, echo, valido)"), "#7 firma con & + spacing");
  ok(/String\.prototype\.reserve/.test(fs.readFileSync(path.join(ROOT, "static/arduino-shim.js"), "utf8")), "#8 reserve en shim");
  ok(!/\bF\s*\(/.test(t.code), "#9 panel: F() concatenado");
  ok(compileValid(t.code), "JS valido tras todas las transformaciones");
  ok(t.code.split("\n").length === t.srcLines.length, "invariante de lineas tras todo");

  // Corrida runtime del server HTTP del sketch (setup tiene un delay de 8 s).
  var responses = [];
  return serial(function () {
    responses = [];
    return runSketchInner(src, 200, function () {
      A.onResponse = function (resp) { responses.push(resp); };
      A.setRequest("GET /estado HTTP/1.1", 1);
    }).then(function (res) {
      if (res.compileError) { ok(false, "compila", res.compileError.message); return; }
      if (res.setupError) { ok(false, "setup corre", res.setupError.message); return; }
      if (res.loopError) { ok(false, "loop sin errores", res.loopError.message + " (linea " + res.loopError.line + ")"); return; }
      ok(responses.length > 0, "el sketch responde /estado con bytes reales");
      ok(responses[0] && responses[0].body.indexOf("HTTP/1.1 200 OK\r\n") === 0, "respuesta HTTP real (status line)");
      ok(responses[0] && responses[0].body.indexOf("\"modo\"") > 0 && responses[0].body.indexOf("\"ok\":true") > 0,
        "respuesta JSON valida del /estado");
    });
  });
})();

/* -------------------------------------------------------------------------
 * Resumen
 * ------------------------------------------------------------------------- */
queue.then(function () {
  console.log("\n=====================");
  console.log("  PASS: " + passed + "   FAIL: " + failed);
  console.log("=====================");
  process.exit(failed ? 1 : 0);
}, function (e) {
  console.log("\nERROR DE TEST:", e && e.stack || e);
  process.exit(1);
});