/* =========================================================================
 * transpiler.js  —  C++ / Arduino  ->  JavaScript
 *
 * Objetivo: que un sketch .ino se pegue TAL CUAL y corra.
 * Cubre el subset MUY amplio que escribe un alumno: #define/#include/#ifdef,
 * tipos (int/long/float/bool/byte/uintN_t/String...), arrays, punteros/refs,
 * enum, struct, typedef, class, firmas de funcion, F(), sufijos UL/L/F, etc.
 *
 * Regla de oro: TODAS las transformaciones preservan la cantidad de lineas
 * (line map identidad) => los errores apuntan a la linea original del .ino.
 *
 * NO es un compilador C++ real: templates, sobrecarga, aritmetica de punteros
 * y herencia compleja quedan fuera. El panel de errores avisa cuando algo no entra.
 * ========================================================================= */
(function (global) {
  "use strict";

  // Tipos base de C/Arduino reconocidos como inicio de declaracion.
  var BUILTIN = [
    "void", "int", "long", "short", "char", "float", "double",
    "bool", "boolean", "byte", "word", "size_t",
    "uint8_t", "uint16_t", "uint32_t", "uint64_t",
    "int8_t", "int16_t", "int32_t", "int64_t", "String"
  ];

  // Clases de librerias comunes: "Tipo nombre(args);" -> "let nombre = new Tipo(args);"
  var LIB_TYPES = [
    "WiFiServer", "WiFiClient", "IPAddress", "Servo", "SoftwareSerial",
    "LiquidCrystal", "NewPing", "Stepper", "Adafruit_NeoPixel"
  ];

  function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function countNL(s) { var m = s.match(/\n/g); return m ? m.length : 0; }
  function padNL(s) { return new Array(countNL(s) + 1).join("\n"); }

  function braceDelta(s) {
    var d = 0, q = null;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "{") d++;
      else if (c === "}") d--;
    }
    return d;
  }

  // -----------------------------------------------------------------------
  // 1. Stripper de comentarios consciente de strings (preserva newlines).
  // -----------------------------------------------------------------------
  function stripComments(src) {
    var out = "";
    var i = 0, n = src.length;
    var q = null; // comilla activa
    while (i < n) {
      var c = src[i], d = src[i + 1];
      if (q) {
        out += c;
        if (c === "\\") { out += (d || ""); i += 2; continue; }
        if (c === q) q = null;
        i++; continue;
      }
      if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
      if (c === "/" && d === "/") { // comentario de linea
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && d === "*") { // comentario de bloque (conserva \n)
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") out += "\n";
          i++;
        }
        i += 2; continue;
      }
      out += c; i++;
    }
    return out;
  }

  function evalPreprocessorExpr(expr, defines) {
    var safeExprRe = /^[0-9a-fA-FxXbB+\-*/%()!<>=&|.^~\s]+$/;
    expr = String(expr || "0");
    expr = expr.replace(/\bdefined\s*\(\s*(\w+)\s*\)/g, function (m, nm) {
      return Object.prototype.hasOwnProperty.call(defines, nm) ? "1" : "0";
    });
    expr = expr.replace(/\bdefined\s+(\w+)/g, function (m, nm) {
      return Object.prototype.hasOwnProperty.call(defines, nm) ? "1" : "0";
    });
    expr = expr.replace(/\b[A-Za-z_]\w*\b/g, function (nm) {
      if (!Object.prototype.hasOwnProperty.call(defines, nm)) return "0";
      var v = String(defines[nm] || "1").trim();
      return safeExprRe.test(v) ? v : "1";
    });
    if (!safeExprRe.test(expr)) return false;
    try { return !!Function("return (" + expr + ");")(); }
    catch (e) { return false; }
  }

  function preprocess(text) {
    var defines = {};
    var stack = [];
    function active() { return stack.length ? stack[stack.length - 1].active : true; }
    var lines = text.split("\n");
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if ((m = line.match(/^[ \t]*#\s*define\s+(\w+)(?:\(([^)]*)\))?(?:[ \t]+(.*))?$/))) {
        if (active()) defines[m[1]] = (m[3] || "1").trim() || "1";
        else lines[i] = "";
        continue;
      }
      if ((m = line.match(/^[ \t]*#\s*undef\s+(\w+)/))) {
        if (active()) delete defines[m[1]];
        lines[i] = "";
        continue;
      }
      if ((m = line.match(/^[ \t]*#\s*ifdef\s+(\w+)/))) {
        var pa = active();
        var cond = Object.prototype.hasOwnProperty.call(defines, m[1]);
        stack.push({ parent: pa, active: pa && cond, anyTrue: pa && cond });
        lines[i] = "";
        continue;
      }
      if ((m = line.match(/^[ \t]*#\s*ifndef\s+(\w+)/))) {
        var pa2 = active();
        var cond2 = !Object.prototype.hasOwnProperty.call(defines, m[1]);
        stack.push({ parent: pa2, active: pa2 && cond2, anyTrue: pa2 && cond2 });
        lines[i] = "";
        continue;
      }
      if ((m = line.match(/^[ \t]*#\s*if\s+(.+)$/))) {
        var pa3 = active();
        var cond3 = evalPreprocessorExpr(m[1], defines);
        stack.push({ parent: pa3, active: pa3 && cond3, anyTrue: pa3 && cond3 });
        lines[i] = "";
        continue;
      }
      if ((m = line.match(/^[ \t]*#\s*elif\s+(.+)$/))) {
        if (stack.length) {
          var top = stack[stack.length - 1];
          var c = !top.anyTrue && evalPreprocessorExpr(m[1], defines);
          top.active = top.parent && c;
          top.anyTrue = top.anyTrue || top.active;
        }
        lines[i] = "";
        continue;
      }
      if (/^[ \t]*#\s*else\b/.test(line)) {
        if (stack.length) {
          var top2 = stack[stack.length - 1];
          top2.active = top2.parent && !top2.anyTrue;
          top2.anyTrue = true;
        }
        lines[i] = "";
        continue;
      }
      if (/^[ \t]*#\s*endif\b/.test(line)) {
        if (stack.length) stack.pop();
        lines[i] = "";
        continue;
      }
      if (!active()) lines[i] = "";
    }
    return lines.join("\n");
  }

  // Split por separador respetando () [] {} y strings.
  function splitTop(str, sep) {
    var res = [], depth = 0, cur = "", q = null;
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (q) { cur += c; if (c === "\\") { cur += (str[++i] || ""); } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; cur += c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      if (c === sep && depth === 0) { res.push(cur); cur = ""; continue; }
      cur += c;
    }
    res.push(cur);
    return res;
  }

  function balance(str) {
    var depth = 0, q = null;
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (q) { if (c === "\\") { i++; } else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") depth++; else if (c === ")") depth--;
    }
    return depth;
  }

  // -----------------------------------------------------------------------
  // 2. enum -> consts (auto-incremento).
  // -----------------------------------------------------------------------
  function enumBody(body) {
    var val = 0, parts = [];
    splitTop(body, ",").forEach(function (e) {
      e = e.trim(); if (!e) return;
      var mm = e.match(/^(\w+)\s*=\s*([\s\S]+)$/);
      if (mm) {
        parts.push(mm[1] + " = " + mm[2].trim());
        var num = parseInt(mm[2], 10);
        val = isNaN(num) ? val : num + 1;
      } else {
        parts.push(e + " = " + val);
        val++;
      }
    });
    return "const " + parts.join(", ") + ";";
  }

  // Nombres de campo de un cuerpo de struct, en orden de declaracion.
  // Soporta tipos compuestos ("unsigned int duration", "const char *nombre")
  // y multiples declaradores ("int a, b"): el nombre es el ULTIMO token.
  function structFieldNames(body) {
    var fields = [];
    splitTop(body, ";").forEach(function (f) {
      f = f.trim(); if (!f) return;
      var isStr = /\b(String|char)\b/.test(f);
      var isBool = /\b(bool|boolean)\b/.test(f);
      var defaultValue = isStr ? '""' : (isBool ? "false" : "0");
      f = f.split("=")[0]; // sin valores por defecto
      splitTop(f, ",").forEach(function (d) {
        d = d.trim(); if (!d) return;
        var toks = d.split(/\s+/);
        var nm = (toks[toks.length - 1] || "").split("[")[0].replace(/[*&]/g, "").trim();
        if (/^[A-Za-z_]\w*$/.test(nm)) fields.push({ name: nm, defaultValue: defaultValue });
      });
    });
    return fields;
  }

  // struct -> factory __make_Nombre()
  function structFactory(name, body) {
    var inits = [];
    splitTop(body, ";").forEach(function (f) {
      f = f.trim(); if (!f) return;
      var isStr = /\b(String|char)\b/.test(f);
      var isBool = /\b(bool|boolean)\b/.test(f);
      f = f.split("=")[0];
      splitTop(f, ",").forEach(function (d) {
        d = d.trim(); if (!d) return;
        var toks = d.split(/\s+/);
        var nm = (toks[toks.length - 1] || "").split("[")[0].replace(/[*&]/g, "").trim();
        if (!/^[A-Za-z_]\w*$/.test(nm)) return;
        inits.push(nm + ": " + (isStr ? '""' : (isBool ? "false" : "0")));
      });
    });
    return "function __make_" + name + "(){ return { " + inits.join(", ") + " }; }";
  }

  // Inicializacion agregada C++ -> literal JS con campos nombrados.
  // "{100, 100, 200}"            -> "{ left: 100, right: 100, duration: 200 }"
  // "{{1,1,2},{-1,-1,2}}"        -> "[ { left: 1, ... }, { left: -1, ... } ]"
  function structInitToJS(rhs, fields) {
    var t = String(rhs).trim();
    if (!fields || !fields.length || t.charAt(0) !== "{") return rhs;
    var inner = t.slice(1, t.length - 1);
    var vals = [];
    splitTop(inner, ",").forEach(function (p) {
      p = p.trim(); if (p) vals.push(p);
    });
    function obj(partsArr) {
      var o = [];
      for (var k = 0; k < fields.length; k++) {
        var field = fields[k];
        var fieldName = typeof field === "string" ? field : field.name;
        var fieldDefault = typeof field === "string" ? "0" : field.defaultValue;
        o.push(fieldName + ": " + (k < partsArr.length ? partsArr[k] : fieldDefault));
      }
      return "{ " + o.join(", ") + " }";
    }
    if (!vals.length) return obj([]);
    var nested = false;
    for (var j = 0; j < vals.length; j++) {
      if (vals[j].charAt(0) === "{") { nested = true; break; }
    }
    if (!nested) return obj(vals);
    var outs = [];
    for (var q = 0; q < vals.length; q++) {
      var v = vals[q];
      if (v.charAt(0) !== "{") { outs.push(v); continue; }
      var parts = [];
      splitTop(v.slice(1, v.length - 1), ",").forEach(function (s) {
        s = s.trim(); if (s) parts.push(s);
      });
      outs.push(obj(parts));
    }
    return "[ " + outs.join(", ") + " ]";
  }

  // Indice del ')' que cierra el '(' en openIdx (-1 si no cierra en esta linea).
  function matchParen(s, openIdx) {
    var depth = 0, q = null;
    for (var p = openIdx; p >= 0 && p < s.length; p++) {
      var c = s[p];
      if (q) { if (c === "\\") p++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) return p; }
    }
    return -1;
  }

  // -----------------------------------------------------------------------
  // Transpile principal.
  // -----------------------------------------------------------------------
  function transpile(src) {
    var knownTypes = {};   // enum/struct/class/typedef names -> "let" o "make"
    var structNames = {};  // name -> true
    var structFields = {}; // name -> [campos en orden] (para init agregado)
    var userFuncs = { delay: 1, delayMicroseconds: 1, yield: 1 };

    var text = String(src).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = stripComments(text);
    text = preprocess(text);

    // F("...") / PSTR("...") -> "..."  ;  PROGMEM / PSTR fuera.
    // C++ concatena literales adyacentes (tambien multilinea):
    //   F("<html>"  "<body>"  "Hello")  ->  "<html><body>Hello"
    var STRLIT = "(?:\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*')";
    var flashRe = new RegExp(
      "\\b(F|PSTR)\\s*\\(\\s*(" + STRLIT + "(?:\\s+" + STRLIT + ")*)\\s*\\)", "g");
    text = text.replace(flashRe, function (m, fn, inner) {
      var parts = [], soloChars = false;
      var rest = inner.replace(new RegExp(STRLIT, "g"), function (s) {
        if (s.charAt(0) === "'") soloChars = true;
        parts.push(s);
        return "";
      });
      // Si queda algo que no sea espacio entre literales, no es concatenacion.
      if (/\S/.test(rest) || soloChars) return m;
      var repl = "\"" + parts.map(function (p) { return p.slice(1, -1); }).join("") + "\"";
      // Preservar lineas (mapa de lineas identidad): lo que sobra en blanco.
      var falta = countNL(m) - countNL(repl);
      if (falta > 0) repl += new Array(falta + 1).join("\n");
      return repl;
    });
    text = text.replace(/\bPROGMEM\b/g, "");

    // Sufijos numericos enteros/float: 8000UL -> 8000, 2.5f -> 2.5
    text = text.replace(/\b(0[xX][0-9a-fA-F]+)\b/g, "$1") // hex intacto
               .replace(/\bB([01]+)\b/g, function (m, bits) { return "0b" + bits; })
               .replace(/\b(\d+\.\d+)[fFlL]\b/g, "$1")
               .replace(/\b(\d+)[uUlL]+\b/g, "$1");

    // Casts estilo C:  (long)x, (int)(a+b), (float)v  ->  x, (a+b), v
    var castRe = new RegExp(
      "\\((?:\\s*(?:unsigned|signed|const)\\s+)*(?:" + BUILTIN.join("|") + ")\\b\\s*\\**\\s*\\)", "g");
    text = text.replace(castRe, "");

    // Preprocesador
    text = text.replace(/^[ \t]*#\s*include\b.*$/gm, "");
    text = text.replace(/^[ \t]*#\s*(if|ifdef|ifndef|else|elif|endif|pragma|error|undef|line)\b.*$/gm, "");
    // #define MACRO(a,b) cuerpo  -> const MACRO = (a,b) => (cuerpo);
    text = text.replace(/^[ \t]*#\s*define\s+(\w+)\(([^)]*)\)[ \t]+(.*)$/gm,
      function (m, nm, args, body) { return "const " + nm + " = (" + args + ") => (" + body.trim() + ");"; });
    // #define NOMBRE valor  -> const NOMBRE = valor;
    text = text.replace(/^[ \t]*#\s*define\s+(\w+)(?:[ \t]+(.*))?$/gm,
      function (m, nm, val) {
        val = (val || "").trim();
        return "const " + nm + " = " + (val === "" ? "true" : val) + ";";
      });

    // typedef enum / enum
    text = text.replace(/\btypedef\s+enum\b[^{]*\{([^}]*)\}\s*(\w+)\s*;/g,
      function (m, body, name) { knownTypes[name] = "let"; return enumBody(body) + padNL(m); });
    text = text.replace(/\benum\s+(?:class\s+)?(\w+)?[^{]*\{([^}]*)\}\s*(\w*)\s*;/g,
      function (m, name, body) { if (name) knownTypes[name] = "let"; return enumBody(body) + padNL(m); });

    // typedef struct / struct
    text = text.replace(/\btypedef\s+struct\b[^{]*\{([^}]*)\}\s*(\w+)\s*;/g,
      function (m, body, name) {
        knownTypes[name] = "make"; structNames[name] = true;
        structFields[name] = structFieldNames(body);
        return structFactory(name, body) + padNL(m);
      });
    text = text.replace(/\bstruct\s+(\w+)\s*\{([^}]*)\}\s*;/g,
      function (m, name, body) {
        knownTypes[name] = "make"; structNames[name] = true;
        structFields[name] = structFieldNames(body);
        return structFactory(name, body) + padNL(m);
      });

    // class Nombre { ... };  (brace-matched, best-effort)
    text = transformClasses(text, knownTypes);

    // Construir matcher de tipos (incluye knownTypes y LIB_TYPES)
    var baseList = BUILTIN.concat(LIB_TYPES, Object.keys(knownTypes)).map(esc).join("|");
    var MOD = "(?:unsigned|signed|const|static|volatile|struct|register)";
    var typeRe = new RegExp(
      "^(\\s*)((?:" + MOD + "\\s+)*)(" + baseList + ")\\b" +
      "((?:\\s+(?:unsigned|signed|long|short|int|double))*)\\s*([*&]*)\\s*([A-Za-z_][\\s\\S]*)$"
    );
    var funcRe = new RegExp(
      "^(\\s*)((?:" + MOD + "\\s+)*(?:" + baseList + ")\\b(?:\\s+(?:unsigned|signed|long|short|int|double))*\\s*[*&]*)\\s*" +
      "([A-Za-z_]\\w*)\\s*\\("
    );
    var CONTROL = { "if": 1, "for": 1, "while": 1, "switch": 1, "return": 1, "else": 1, "do": 1, "sizeof": 1 };

    // Test: ¿una lista de parametros parece tipos (prototipo) o valores (constructor)?
    var typeHeadRe = new RegExp("^(?:(?:" + MOD + ")\\s+)*(?:" + baseList + ")\\b");
    function isParamList(p) {
      p = String(p).replace(/\n/g, " ").trim();
      if (p === "" || p === "void") return true;
      return splitTop(p, ",").every(function (x) { return typeHeadRe.test(x.trim()); });
    }
    var ctx = { isParamList: isParamList, structNames: structNames };

    // for (int i=0; ...) -> for (let i=0; ...)
    var forRe = new RegExp(
      "(\\bfor\\s*\\(\\s*)(?:(?:" + MOD + ")\\s+)*(?:" + baseList + ")\\b[\\s*&]*([A-Za-z_]\\w*)(\\s*=)", "g");
    text = text.replace(forRe, function (m, pre, name, eq) { return pre + "let " + name + eq; });

    // Declaraciones inline tras '{' o ';' (cuerpos de funcion en una sola linea)
    var inlineRe = new RegExp(
      "([{;][ \\t]*)(?:(" + MOD + ")[ \\t]+)*(?:" + baseList + ")\\b(?:[ \\t]+(?:unsigned|signed|long|short|int|double))*[ \\t]*[*&]*[ \\t]*([A-Za-z_]\\w*)([ \\t]*[=;,])", "g");
    text = text.replace(inlineRe, function (m, b, mod, name, after) {
      var kw = (mod && /const/.test(mod)) ? "const" : "let";
      return b + kw + " " + name + after;
    });

    var tmpLines = text.split("\n");
    // Pre-scan: nombres de funciones del usuario + funciones con parametros
    // por referencia (C++ "T &nombre"), que necesitan reescritura (#4).
    var refFuncs = {}; // nombre -> { indices: [pos], nombres: [param] }
    for (var k = 0; k < tmpLines.length; k++) {
      var fm = tmpLines[k].match(funcRe);
      if (!fm || CONTROL[fm[3]]) continue;
      userFuncs[fm[3]] = 1;
      var sigScan = tmpLines[k], jScan = k;
      while (balance(sigScan) > 0 && jScan + 1 < tmpLines.length) {
        jScan++; sigScan += "\n" + tmpLines[jScan];
      }
      var opScan = sigScan.indexOf("(");
      var clScan = matchParen(sigScan, opScan);
      if (clScan < 0) continue;
      var idxs = [], nms = [];
      splitTop(sigScan.slice(opScan + 1, clScan), ",").forEach(function (par, ix) {
        var mr = par.replace(/\n/g, " ").match(/&\s*([A-Za-z_]\w*)/);
        if (mr) { idxs.push(ix); nms.push(mr[1]); }
      });
      if (idxs.length) refFuncs[fm[3]] = { indices: idxs, nombres: nms };
    }

    // Procesar linea por linea (preservando cantidad de lineas)
    var lines = text.split("\n");
    var out = new Array(lines.length);
    var staticMaps = {};
    var lineRefNames = new Array(lines.length); // refs del cuerpo al que pertenece la linea
    var i = 0;
    var currentFunc = null, funcDepth = 0;
    var curRefNames = null; // params por referencia de la funcion actual
    while (i < lines.length) {
      var line = lines[i];
      // ---- Definicion de funcion (posible firma multilinea) ----
      var fm = line.match(funcRe);
      if (fm && !CONTROL[fm[3]]) {
        var sig = line, j = i;
        while (balance(sig) > 0 && j + 1 < lines.length) { j++; sig += "\n" + lines[j]; }
        var res = transformFunc(sig, ctx);
        if (res) {
          out[i] = res.first;
          for (var k = i + 1; k <= j; k++) out[k] = "";
          var d = braceDelta(res.first);
          if (res.name && d > 0) {
            currentFunc = res.name; funcDepth = d;
            curRefNames = refFuncs[res.name] ? refFuncs[res.name].nombres : null;
          }
          if (res.name && refFuncs[res.name]) {
            // El cuerpo puede venir pegado a la firma en la misma linea:
            // se aplica ".v" solo despues del cierre de los parametros.
            out[i] = applyRefInBody(out[i], refFuncs[res.name].nombres);
            if (d <= 0) curRefNames = null;
          }
          lineRefNames[i] = null; // la linea de firma no lleva ".v" en el post-paso
          // si el cuerpo seguia en la misma ultima linea, va incluido en res.first
          i = j + 1;
          continue;
        }
      }
      // ---- Declaracion de variable ----
      var dm = line.match(typeRe);
      if (dm && !CONTROL[(line.trim().split(/\s+/)[0])]) {
        var conv = transformDecl(dm, structNames, structFields, currentFunc, staticMaps);
        if (conv === null) {
          // Declaracion multilinea: el ';' (o el cierre de llaves/parentesis)
          // esta mas abajo.
          // Ej:  const PasoEmote EMOTE_SI[] = { \n { 140, 140, 120 }, ...
          //      int velocidad = constrain( \n  parametroEntero(...) \n );
          var declText = line, jm = i;
          while ((braceDelta(declText) > 0 || balance(declText) > 0) && jm + 1 < lines.length) {
            jm++; declText += " " + lines[jm]; // en un solo renglon: las lineas
          }                                     // consumidas quedan en blanco
          var semi2 = indexOfTop(declText, ";");
          if (semi2 > 0) {
            var dmM = dm.slice();
            dmM[6] = dm[6] + declText.slice(line.length);
            conv = transformDecl(dmM, structNames, structFields, currentFunc, staticMaps);
            if (conv !== null) {
              out[i] = conv;
              lineRefNames[i] = curRefNames;
              for (var k2 = i + 1; k2 <= jm; k2++) out[k2] = "";
              if (currentFunc && staticMaps[currentFunc]) out[i] = replaceIdentifiers(out[i], staticMaps[currentFunc]);
              i = jm + 1;
              continue;
            }
          }
        }
        if (conv !== null) {
          out[i] = conv;
          lineRefNames[i] = curRefNames;
          if (currentFunc && staticMaps[currentFunc]) out[i] = replaceIdentifiers(out[i], staticMaps[currentFunc]);
          i++;
          continue;
        }
      }
      out[i] = line;
      lineRefNames[i] = curRefNames;
      if (currentFunc && staticMaps[currentFunc]) {
        out[i] = replaceIdentifiers(out[i], staticMaps[currentFunc]);
      }
      if (currentFunc) {
        funcDepth += braceDelta(line);
        if (funcDepth <= 0) { currentFunc = null; funcDepth = 0; curRefNames = null; }
      }
      i++;
    }

    // Parametros por referencia (#4). Orden por linea:
    //  1. dentro del cuerpo del callee, los usos directos pasan por ".v":
    //       pedido.indexOf(...) -> pedido.v.indexOf(...)
    //  2. llamadas a funciones con refs: se envuelve el argumento y se copia
    //     de vuelta el resultado:
    //       x = f(a, ref) ->  var __refN = __ref(ref.v); x = f(a, __refN); ...
    //     Un arg ya convertido a "x.v" se trata como un lvalue mas: el callee
    //     recibe un wrapper fresco y el write-back devuelve el valor al
    //     wrapper del ambito (mismo objeto que la variable original).
    var rewriteRefCalls = makeRefCallRewriter(refFuncs);
    for (var rc = 0; rc < out.length; rc++) {
      if (lineRefNames[rc]) {
        out[rc] = rewriteRefUses(out[rc], lineRefNames[rc]);
      }
      out[rc] = rewriteRefCalls(out[rc], lineRefNames[rc]);
    }

    var code = out.join("\n");

    // sizeof(A) / sizeof(A[0])  ->  A.length   (#3)
    code = code.replace(
      /\bsizeof\s*\(\s*([A-Za-z_]\w*)\s*\)\s*\/\s*sizeof\s*\(\s*\1\s*\[\s*0\s*\]\s*\)/g,
      "$1.length");
    // sizeof(A) / sizeof(Tipo)  ->  A.length   (patron clasico de conteo)
    var typeAlts = BUILTIN.concat(LIB_TYPES, Object.keys(knownTypes)).map(esc).join("|");
    code = code.replace(new RegExp(
      "\\bsizeof\\s*\\(\\s*([A-Za-z_]\\w*)\\s*\\)\\s*/\\s*sizeof\\s*\\(\\s*(?:(?:struct|class)\\s+)?(?:" + typeAlts + ")\\s*\\)", "g"),
      "$1.length");
    // Otros sizeof quedan para el runtime (arrays -> length).

    // NULL / nullptr -> null  (#6), fuera de strings.
    code = replaceOutsideStrings(code, /\b(NULL|nullptr)\b/g, function () { return "null"; });

    // Constructores de librerias usados como expresion: clienteActual = WiFiClient();
    // En C++ llama al constructor; en JS hace falta "new".
    // (WiFiClient() sin argumentos = cliente desconectado = falsy: se deja
    // en null para que "if (!client)" del patron clasico siga funcionando.)
    code = replaceOutsideStrings(code,
      /(^|[^A-Za-z0-9_$.])(new\s+)?\bWiFiClient\s*\(\s*\)/g,
      function (m, pre, nw) { return nw ? m : pre + "null"; });
    var libNames2 = LIB_TYPES.filter(function (t) { return t !== "WiFiClient"; }).join("|");
    var libCtorRe = new RegExp(
      "(^|[^A-Za-z0-9_$.])(new\\s+)?\\b(" + libNames2 + ")\\s*\\(", "g");
    code = replaceOutsideStrings(code, libCtorRe, function (m, pre, nw, ty) {
      if (nw) return m;
      return pre + "new " + ty + "(";
    });

    // String.length()  ->  .length
    code = code.replace(/\.length\s*\(\s*\)/g, ".length");
    code = code.replace(/\b([A-Za-z_]\w*)\.toLowerCase\s*\(\s*\)\s*;/g, "$1 = String($1).toLowerCase();");
    code = code.replace(/\b([A-Za-z_]\w*)\.toUpperCase\s*\(\s*\)\s*;/g, "$1 = String($1).toUpperCase();");
    code = code.replace(/\b([A-Za-z_]\w*)\.trim\s*\(\s*\)\s*;/g, "$1 = String($1).trim();");
    // Mutadores de String de Arduino (statement suelto): en C++ mutan in-place.
    // replace() ademas reemplaza TODAS las ocurrencias (JS solo la primera).
    // Solo mismo renglon ([^\n]) para no romper el mapa de lineas.
    code = code.replace(/(^|[;{}])([ \t]*)([A-Za-z_]\w*)\.replace\s*\(([^\n]*?)\)\s*;/gm,
                        "$1$2$3 = __replaceAll($3, $4);");
    code = code.replace(/(^|[;{}])([ \t]*)([A-Za-z_]\w*)\.concat\s*\(([^\n]*?)\)\s*;/gm,
                        "$1$2$3 = String($3) + ($4);");
    code = code.replace(/(^|[;{}])([ \t]*)([A-Za-z_]\w*)\.remove\s*\(([^\n]*?)\)\s*;/gm,
                        "$1$2$3 = __strRemove($3, $4);");

    code = insertAwaitsInFunctions(code, Object.keys(userFuncs));

    return { code: code, knownTypes: knownTypes };
  }

  function replaceIdentifiers(line, map) {
    var names = Object.keys(map || {});
    if (!names.length) return line;
    var re = new RegExp("(?<![A-Za-z0-9_$.])(" + names.map(esc).join("|") + ")\\b(?!\\s*:)", "g");
    return replaceOutsideStrings(line, re, function (m, name) {
      return map[name] || name;
    });
  }

  function replaceOutsideStrings(text, re, replacer) {
    var out = "", chunk = "", q = null;
    function flush() {
      if (chunk) {
        out += chunk.replace(re, replacer);
        chunk = "";
      }
    }
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        out += c;
        if (c === "\\") {
          if (i + 1 < text.length) out += text[++i];
        } else if (c === q) {
          q = null;
        }
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        flush();
        q = c;
        out += c;
        continue;
      }
      chunk += c;
    }
    flush();
    return out;
  }

  // Usos de un parametro por referencia DENTRO del cuerpo de su funcion:
  // el parametro llega como wrapper { v: valor }, asi que toda lectura o
  // asignacion pasa por ".v" (#4).  "valido = false;" -> "valido.v = false;"
  function rewriteRefUses(line, names) {
    var re = new RegExp(
      "(?<![A-Za-z0-9_$.])(" + names.map(esc).join("|") + ")\\b(?!\\s*\\.v)", "g");
    return replaceOutsideStrings(line, re, function (m, nm) {
      return nm + ".v";
    });
  }

  // ".v" sobre el cuerpo de una firma que viene en la misma linea:
  // solo la parte posterior al cierre de los parametros.
  function applyRefInBody(first, names) {
    var openIdx = first.indexOf("(");
    var closeIdx = matchParen(first, openIdx);
    if (closeIdx < 0) return first;
    return first.slice(0, closeIdx + 1) +
      rewriteRefUses(first.slice(closeIdx + 1), names);
  }

  // Reescritura de una EXPRESION anidada. El copy-back de lvalues lo resuelve
  // makeRefCallRewriter con una IIFE async; aca se cubren argumentos anidados.
  // Los argumentos que ya son wrappers (params por referencia del ambito)
  // se pasan tal cual: comparten el objeto y las mutaciones se propagan solas.
  function makeExprRefRewriter(refFuncs) {
    var names = Object.keys(refFuncs);
    if (!names.length) return null;
    var argRe = new RegExp(
      "(?<![A-Za-z0-9_$.])(" + names.map(esc).join("|") + ")\\s*\\(", "g");
    function rewrite(expr, refNamesAtLine) {
      argRe.lastIndex = 0;
      var mm, outParts = [], last = 0;
      while ((mm = argRe.exec(expr))) {
        var nameStart = mm.index; // con lookbehind no hay grupo antes del nombre
        var before = expr.slice(0, mm.index);
        if (/\bfunction\s*$/.test(before)) continue;
        var openIdx = expr.indexOf("(", nameStart);
        var closeIdx = matchParen(expr, openIdx);
        if (closeIdx < 0) break;                    // multilinea: no se toca
        outParts.push(expr.slice(last, mm.index));
        var info = refFuncs[mm[1]];
        var args = splitTop(expr.slice(openIdx + 1, closeIdx), ",");
        for (var w = 0; w < info.indices.length; w++) {
          var ai = info.indices[w];
          if (ai >= args.length) continue;
          var a = args[ai].trim();
          if (!a) continue;
          if (refNamesAtLine && refNamesAtLine.indexOf(a) >= 0) continue;
          if (/^__ref\(.*\)$/.test(a)) continue;    // ya envuelto
          args[ai] = "__ref(" + rewrite(a, refNamesAtLine) + ")";
        }
        outParts.push(mm[1] + "(" + args.join(",") + ")");
        last = closeIdx + 1;
        argRe.lastIndex = last;
      }
      if (!outParts.length) return expr;
      outParts.push(expr.slice(last));
      return outParts.join("");
    }
    return rewrite;
  }

  // Lado llamador de los parametros por referencia (#4). Por linea:
  //  - llamadas en SENTENCIA (asignacion o llamada suelta terminada en ';'):
  //    se envuelve con una variable temporal y se copia de vuelta:
  //      var __refN = __ref(arg); x = f(a, __refN); arg = __refN.v;
  //  - llamadas en EXPRESION (dentro de una condicion, de otro argumento...):
  //    una IIFE async conserva el resultado y copia los lvalues de vuelta.
  // Los argumentos que ya son wrappers (refs del ambito exterior) no se
  // envuelven: al ser el mismo objeto, las mutaciones del callee se propagan.
  function makeRefCallRewriter(refFuncs) {
    var exprRewrite = makeExprRefRewriter(refFuncs);
    var names = Object.keys(refFuncs);
    if (!names.length) return function (line) { return line; };
    var counter = 0;
    var callRe = new RegExp(
      "(?<![A-Za-z0-9_$.])(" + names.map(esc).join("|") + ")\\s*\\(", "g");
    return function (line, refNamesAtLine) {
      callRe.lastIndex = 0;
      var mm;
      while ((mm = callRe.exec(line))) {
        var nameStart = mm.index;
        var before = line.slice(0, nameStart);
        if (/\bfunction\s*$/.test(before)) continue; // definicion, no llamada
        if (/\bnew\s*$/.test(before)) continue;
        var openIdx = line.indexOf("(", nameStart);
        var closeIdx = matchParen(line, openIdx);
        if (closeIdx < 0) break;                     // llamada multilinea
        var info = refFuncs[mm[1]];
        var args = splitTop(line.slice(openIdx + 1, closeIdx), ",");
        var stmtCtx = /^\s*;/.test(line.slice(closeIdx + 1));
        var wraps = [], unwraps = [], changed = false;
        for (var w = 0; w < info.indices.length; w++) {
          var ai = info.indices[w];
          if (ai >= args.length) continue;
          var a = args[ai].trim();
          if (!a) continue;
          if (/^__ref\(.*\)$/.test(a)) continue;     // ya envuelto
          if (stmtCtx && /^[A-Za-z_]\w*(\.[A-Za-z_]\w*|\[[^\[\]]+\])?$/.test(a)) {
            var vname = "__ref" + (++counter);
            args[ai] = vname;
            wraps.push("var " + vname + " = __ref(" + a + ");");
            unwraps.push(a + " = " + vname + ".v;");
            changed = true;
          } else {
            args[ai] = "__ref(" + (exprRewrite ? exprRewrite(a, refNamesAtLine) : a) + ")";
            changed = true;
          }
        }
        if (!changed) continue;
        var continueScan = false;
        if (stmtCtx) {
          var st = nameStart - 1;
          while (st >= 0 && ";{}".indexOf(line.charAt(st)) < 0) st--;
          var stmtStart = st + 1;
          line = line.slice(0, stmtStart) + wraps.join(" ") +
            line.slice(stmtStart, nameStart) + mm[1] + "(" + args.join(",") + ")" +
            line.slice(closeIdx + 1) + unwraps.join(" ");
        } else {
          var exprWraps = [], exprUnwraps = [];
          for (var ew = 0; ew < info.indices.length; ew++) {
            var eai = info.indices[ew];
            if (eai >= args.length) continue;
            var original = splitTop(line.slice(openIdx + 1, closeIdx), ",")[eai].trim();
            if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*|\[[^\[\]]+\])?$/.test(original)) continue;
            var evname = "__ref" + (++counter);
            args[eai] = evname;
            exprWraps.push("var " + evname + " = __ref(" + original + ");");
            exprUnwraps.push(original + " = " + evname + ".v;");
          }
          if (exprWraps.length) {
            var retname = "__refResult" + counter;
            var wrapped = "(await (async function(){" + exprWraps.join(" ") +
              " var " + retname + " = await " + mm[1] + "(" + args.join(",") + "); " +
              exprUnwraps.join(" ") + " return " + retname + ";})())";
            line = line.slice(0, nameStart) + wrapped + line.slice(closeIdx + 1);
            callRe.lastIndex = nameStart + wrapped.length;
            continueScan = true;
          } else {
            line = line.slice(0, nameStart) + mm[1] + "(" + args.join(",") + ")" +
              line.slice(closeIdx + 1);
          }
        }
        if (continueScan) continue;
        break;
      }
      return line;
    };
  }

  function insertAwaitsInFunctions(code, names) {
    if (!names.length) return code;
    // Lookbehind (no consume): "(" antes de una llamada no impide matchear la
    // siguiente, p.ej. outer(inner(...)) -> ambos reciben await (#10/#12).
    var callRe = new RegExp("(?<![A-Za-z0-9_$.])(" + names.join("|") + ")\\s*\\(", "g");
    var lines = code.split("\n");
    var depth = 0;
    for (var i = 0; i < lines.length; i++) {
      var startsFunc = /\basync\s+function\b/.test(lines[i]);
      if (depth > 0 || startsFunc) {
        lines[i] = replaceOutsideStrings(lines[i], callRe, function (m, name, offset, full) {
          var before = full.slice(0, offset);
          if (/\bfunction\s*$/.test(before)) return m;
          if (/\bnew\s*$/.test(before)) return m;
          if (/\bawait\s*$/.test(before)) return m;
          return "await " + name + "(";
        });
      }
      if (depth > 0 || startsFunc) depth += braceDelta(lines[i]);
      if (depth < 0) depth = 0;
    }
    return lines.join("\n");
  }

  // class Nombre [: base] { cuerpo };  -> class JS best-effort
  function transformClasses(text, knownTypes) {
    var re = /\bclass\s+(\w+)\s*(?::[^{]*)?\{/g, m;
    while ((m = re.exec(text))) {
      var name = m[1];
      var open = text.indexOf("{", m.index);
      var depth = 0, p = open, q = null;
      for (; p < text.length; p++) {
        var c = text[p];
        if (q) { if (c === "\\") p++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === "`") { q = c; continue; }
        if (c === "{") depth++;
        else if (c === "}") { depth--; if (depth === 0) break; }
      }
      // p = '}' de cierre; buscar ';' opcional
      var end = p + 1;
      while (end < text.length && /\s/.test(text[end])) end++;
      if (text[end] === ";") end++;
      var whole = text.slice(m.index, end);
      var bodyInner = text.slice(open + 1, p);
      var body = transformClassBody(bodyInner);
      // clase en una sola linea (el procesador de lineas la deja intacta)
      var repl = "class " + name + " {" + body + "}";
      var falta = countNL(whole) - countNL(repl);
      if (falta > 0) repl += new Array(falta + 1).join("\n");
      knownTypes[name] = "let";
      text = text.slice(0, m.index) + repl + text.slice(end);
      re.lastIndex = m.index + repl.length;
    }
    return text;
  }

  function transformClassBody(body) {
    var members = [], i = 0, n = body.length;
    while (i < n) {
      var rest = body.slice(i);
      if (/^\s*$/.test(rest)) break;
      var am = rest.match(/^\s*(public|private|protected)\s*:/);
      if (am) { i += am[0].length; continue; }
      var ws = rest.match(/^\s*/)[0].length; i += ws;
      // localizar siguiente '{' (metodo) o ';' (campo) a profundidad 0
      var j = i, depth = 0, q = null, brace = -1, semi = -1;
      for (; j < n; j++) {
        var c = body[j];
        if (q) { if (c === "\\") j++; else if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === "`") { q = c; continue; }
        if (c === "(" || c === "[") depth++;
        else if (c === ")" || c === "]") depth--;
        else if (c === "{" && depth === 0) { brace = j; break; }
        else if (c === ";" && depth === 0) { semi = j; break; }
      }
      if (brace >= 0) {
        var d = 0, k = brace, qq = null;
        for (; k < n; k++) {
          var cc = body[k];
          if (qq) { if (cc === "\\") k++; else if (cc === qq) qq = null; continue; }
          if (cc === '"' || cc === "'" || cc === "`") { qq = cc; continue; }
          if (cc === "{") d++; else if (cc === "}") { d--; if (d === 0) break; }
        }
        var decl = body.slice(i, brace);
        var bodyPart = body.slice(brace, k + 1).replace(/\n/g, " ");
        members.push(convMethod(decl) + " " + bodyPart);
        i = k + 1;
      } else if (semi >= 0) {
        members.push(convField(body.slice(i, semi)));
        i = semi + 1;
      } else { members.push(body.slice(i).replace(/\n/g, " ")); break; }
    }
    return " " + members.filter(Boolean).join(" ") + " ";
  }

  function convMethod(decl) {
    decl = decl.replace(/\n/g, " ");
    var open = decl.indexOf("("), close = decl.lastIndexOf(")");
    if (open < 0) return decl.trim();
    var head = decl.slice(0, open), params = decl.slice(open + 1, close);
    var nm = head.match(/([A-Za-z_]\w*)\s*$/);
    var name = nm ? nm[1] : head.trim();
    if (name === head.trim()) name = name; // constructor: nombre == clase
    return name + "(" + convParams(params) + ")";
  }

  function convField(f) {
    f = f.replace(/\n/g, " ").trim();
    if (!f) return "";
    var eq = f.indexOf("=");
    if (eq >= 0) {
      var nm = f.slice(0, eq).match(/([A-Za-z_]\w*)\s*$/);
      return (nm ? nm[1] : f.slice(0, eq).trim()) + " = " + f.slice(eq + 1).trim() + ";";
    }
    var nm2 = f.match(/([A-Za-z_]\w*)\s*$/);
    return (nm2 ? nm2[1] : f) + ";";
  }

  // Convierte una firma completa de funcion. Devuelve {first} o null.
  function transformFunc(sig, ctx) {
    var openIdx = sig.indexOf("(");
    if (openIdx < 0) return null;
    // matching paren
    var depth = 0, p = openIdx, q = null;
    for (; p < sig.length; p++) {
      var c = sig[p];
      if (q) { if (c === "\\") p++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) return null;
    var head = sig.slice(0, openIdx);          // "  void  nombre"
    var params = sig.slice(openIdx + 1, p);     // "int a, int b" o "80"
    var suffix = sig.slice(p + 1);              // " {" o ";" o " { ...}"
    var hm = head.match(/^(\s*)([\s\S]*?)([A-Za-z_]\w*)\s*$/);
    if (!hm) return null;
    var indent = hm[1], typePart = hm[2], name = hm[3];
    var sTrim = suffix.replace(/^\s*/, "");

    if (sTrim[0] === ";") {
      // Termina en ';' => prototipo de funcion O declaracion-constructor.
      if (ctx && !ctx.isParamList(params)) {
        // args son valores => es "Tipo nombre(args);" (constructor)
        var baseType = (typePart.trim().split(/\s+/).pop() || "").replace(/[*&]/g, "");
        var rhs;
        if (LIB_TYPES.indexOf(baseType) >= 0) rhs = "new " + baseType + "(" + params + ")";
        else if (ctx.structNames[baseType]) rhs = "__make_" + baseType + "()";
        else rhs = "new " + baseType + "(" + params + ")";
        return { first: indent + "let " + name + " = " + rhs + ";", name: null };
      }
      return { first: indent, name: null }; // prototipo -> se elimina
    }
    var jsParams = convParams(params);
    // suffix puede ser multilinea: colapsamos a una sola linea (se preservan \n via blanks).
    var suffixOneLine = suffix.replace(/\n/g, " ");
    return { first: indent + "async function " + name + "(" + jsParams + ")" + suffixOneLine, name: name };
  }

  function convParams(p) {
    p = p.replace(/\n/g, " ").trim();
    if (p === "" || p === "void") return "";
    return splitTop(p, ",").map(function (par) {
      par = par.trim();
      var def = "";
      var dm = par.match(/=\s*([\s\S]+)$/);
      if (dm) { def = dm[1].trim(); par = par.slice(0, par.length - dm[0].length).trim(); }
      var nm = par.match(/([A-Za-z_]\w*)\s*(\[\s*\])?\s*$/);
      var name = nm ? nm[1] : par;
      return def ? (name + " = " + def) : name;
    }).join(", ");
  }

  // Convierte una linea de declaracion. dm = match de typeRe.
  function defaultValueFor(base, isStruct) {
    if (isStruct) return "__make_" + base + "()";
    if (base === "String" || base === "char") return '""';
    if (base === "bool" || base === "boolean") return "false";
    return "0";
  }

  function transformDecl(dm, structNames, structFields, currentFunc, staticMaps) {
    var indent = dm[1];
    var mods = dm[2] || "";
    var base = dm[3];
    var decls = dm[6];

    // separar parte de declaradores y la cola tras ';'
    var semi = indexOfTop(decls, ";");
    if (semi < 0) return null; // declaracion multilinea / no soportada -> dejar igual
    var declPart = decls.slice(0, semi);
    var tail = decls.slice(semi + 1); // normalmente ""

    var isConst = /\bconst\b/.test(mods);
    // "const char *p" es puntero-a-constante: el binding sigue siendo mutable
    // en JS. Solo un const real (sin '*') se vuelve const de JS (#5).
    var isPointer = /\*/.test(dm[5] || "") || /\*/.test(declPart);
    var isStatic = /\bstatic\b/.test(mods);
    var kw = (isConst && !isPointer) ? "const" : "let";
    var staticNames = [];

    var parts = splitTop(declPart, ",").map(function (d) {
      d = d.trim();
      if (!d) return "";
      // array con init: name[..] = {..}  /  name[] = "..."
      var am = d.match(/^([A-Za-z_]\w*)\s*((?:\[[^\]]*\])+)\s*(=\s*[\s\S]+)?$/);
      if (am) {
        var nm = am[1], dims = am[2], init = am[3];
        if (init) {
          var rhs = init.replace(/^=\s*/, "");
          if (structNames[base]) {
            // init agregado de structs: {..} / {{..},{..}} -> objetos con campos (#2)
            rhs = structInitToJS(rhs, structFields[base]);
          } else {
            rhs = rhs.replace(/\{/g, "[").replace(/\}/g, "]"); // init de array -> JS
          }
          return nm + " = " + rhs;
        }
        // sin init: new Array(N).fill(0) (1D); multi-dim -> anidado simple
        var sizes = [];
        dims.replace(/\[([^\]]*)\]/g, function (mm, s) { sizes.push(s.trim()); return ""; });
        return nm + " = " + buildArray(sizes, 0, structNames[base] ? base : null);
      }
      // struct con init agregado:  Tipo x = {a, b, c};  (#2)
      var sm2 = d.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/);
      if (sm2 && structNames[base] && /^\s*\{/.test(sm2[2])) {
        return sm2[1] + " = " + structInitToJS(sm2[2], structFields[base]);
      }
      // forma constructor: name(args)  -> new Tipo(args) si es clase/lib
      var cm = d.match(/^([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/);
      if (cm) {
        if (LIB_TYPES.indexOf(base) >= 0) return cm[1] + " = new " + base + "(" + cm[2] + ")";
        if (structNames[base]) return cm[1] + " = __make_" + base + "()";
        return cm[1] + " = " + (cm[2].trim() === "" ? "undefined" : cm[2]);
      }
      // struct sin init:  Tipo x;  -> x = __make_Tipo()
      if (structNames[base] && /^[A-Za-z_]\w*$/.test(d)) {
        return d + " = __make_" + base + "()";
      }
      // clase/lib sin constructor explicito: Servo s; / Foo f;
      if (LIB_TYPES.indexOf(base) >= 0 && /^[A-Za-z_]\w*$/.test(d)) {
        // WiFiClient v/s: el patron Arduino clasico es "if (!client) { client =
        // server.available(); }". Un objecto nuevo es SIEMPRE truthy en JS y
        // el pedido nunca se tomaba. Se inicializa en null (falsy) igual que
        // un WiFiClient recien construido en C++.
        return d + " = " + (base === "WiFiClient" ? "null" : "new " + base + "()");
      }
      if (isStatic) {
        var sm = d.match(/^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/);
        if (sm) staticNames.push({ name: sm[1], init: sm[2] || defaultValueFor(base, structNames[base]) });
      }
      if (!currentFunc && /^[A-Za-z_]\w*$/.test(d) && base !== "void") {
        return d + " = " + defaultValueFor(base, false);
      }
      return d; // "name = expr"
    }).filter(function (x) { return x !== ""; });

    if (isStatic && currentFunc && staticNames.length) {
      var initLines = [];
      staticNames.forEach(function (s) {
        var unique = currentFunc + ".__static_" + s.name;
        staticMaps[currentFunc] = staticMaps[currentFunc] || {};
        staticMaps[currentFunc][s.name] = unique;
        initLines.push("if (typeof " + unique + ' === "undefined") ' + unique + " = " + s.init + ";");
      });
      return indent + initLines.join(" ");
    }

    return indent + kw + " " + parts.join(", ") + ";" + tail;
  }

  function buildArray(sizes, idx, structBase) {
    if (idx >= sizes.length) return structBase ? "__make_" + structBase + "()" : "0";
    var n = sizes[idx];
    if (!n) return "[]";
    var inner = buildArray(sizes, idx + 1, structBase);
    return "Array.from({ length: " + n + " }, function(){ return " + inner + "; })";
  }

  function indexOfTop(str, ch) {
    var depth = 0, q = null;
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (q) { if (c === "\\") i++; else if (c === q) q = null; continue; }
      if (c === '"' || c === "'" || c === "`") { q = c; continue; }
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === ch && depth === 0) return i;
    }
    return -1;
  }

  global.Transpiler = { transpile: transpile, stripComments: stripComments };
})(typeof window !== "undefined" ? window : this);
