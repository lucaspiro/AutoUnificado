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
    function parentActive() {
      if (stack.length < 2) return true;
      return stack[stack.length - 2].active;
    }
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

  // struct -> factory __make_Nombre()
  function structFactory(name, body) {
    var fields = [];
    splitTop(body, ";").forEach(function (f) {
      f = f.trim(); if (!f) return;
      // "int a, b" / "float x" / "String s"
      var tm = f.match(/^[\w\s\*&]+?\s+([\s\S]+)$/);
      if (!tm) return;
      var isStr = /\b(String|char)\b/.test(f.split(/\s+/)[0] || f);
      splitTop(tm[1], ",").forEach(function (nm) {
        nm = nm.replace(/[\*&\[\]0-9]/g, "").trim();
        if (nm) fields.push(nm + ": " + (isStr ? '""' : "0"));
      });
    });
    return "function __make_" + name + "(){ return { " + fields.join(", ") + " }; }";
  }

  // -----------------------------------------------------------------------
  // Transpile principal.
  // -----------------------------------------------------------------------
  function transpile(src) {
    var knownTypes = {};   // enum/struct/class/typedef names -> "let" o "make"
    var structNames = {};  // name -> true
    var userFuncs = { delay: 1, delayMicroseconds: 1, yield: 1 };

    var text = String(src).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    text = stripComments(text);
    text = preprocess(text);

    // F("...") -> "..."  ;  PROGMEM / PSTR fuera
    text = text.replace(/\bF\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*\)/g, "$1");
    text = text.replace(/\bPSTR\s*\(\s*("(?:[^"\\]|\\.)*")\s*\)/g, "$1");
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
      function (m, body, name) { knownTypes[name] = "make"; structNames[name] = true; return structFactory(name, body) + padNL(m); });
    text = text.replace(/\bstruct\s+(\w+)\s*\{([^}]*)\}\s*;/g,
      function (m, name, body) { knownTypes[name] = "make"; structNames[name] = true; return structFactory(name, body) + padNL(m); });

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
      "^(\\s*)((?:" + MOD + "\\s+)*(?:" + baseList + ")\\b(?:\\s+(?:unsigned|signed|long|short|int|double))*\\s*[*&]*)\\s+" +
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
    for (var k = 0; k < tmpLines.length; k++) {
      var fm = tmpLines[k].match(funcRe);
      if (fm && !CONTROL[fm[3]]) {
        userFuncs[fm[3]] = 1;
      }
    }

    // Procesar linea por linea (preservando cantidad de lineas)
    var lines = text.split("\n");
    var out = new Array(lines.length);
    var staticHoists = [];
    var staticMaps = {};
    var i = 0;
    var currentFunc = null, funcDepth = 0;
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
          if (res.name && d > 0) { currentFunc = res.name; funcDepth = d; }
          // si el cuerpo seguia en la misma ultima linea, va incluido en res.first
          i = j + 1;
          continue;
        }
      }
      // ---- Declaracion de variable ----
      var dm = line.match(typeRe);
      if (dm && !CONTROL[(line.trim().split(/\s+/)[0])]) {
        var conv = transformDecl(dm, structNames, currentFunc, staticHoists, staticMaps);
        if (conv !== null) {
          out[i] = currentFunc && staticMaps[currentFunc] ? replaceIdentifiers(conv, staticMaps[currentFunc]) : conv;
          i++;
          continue;
        }
      }
      out[i] = line;
      if (currentFunc && staticMaps[currentFunc]) {
        out[i] = replaceIdentifiers(out[i], staticMaps[currentFunc]);
      }
      if (currentFunc) {
        funcDepth += braceDelta(line);
        if (funcDepth <= 0) { currentFunc = null; funcDepth = 0; }
      }
      i++;
    }

    var code = (staticHoists.length ? staticHoists.join(" ") + " " : "") + out.join("\n");
    // String.length()  ->  .length
    code = code.replace(/\.length\s*\(\s*\)/g, ".length");
    code = code.replace(/\b([A-Za-z_]\w*)\.toLowerCase\s*\(\s*\)\s*;/g, "$1 = String($1).toLowerCase();");
    code = code.replace(/\b([A-Za-z_]\w*)\.toUpperCase\s*\(\s*\)\s*;/g, "$1 = String($1).toUpperCase();");
    code = code.replace(/\b([A-Za-z_]\w*)\.trim\s*\(\s*\)\s*;/g, "$1 = String($1).trim();");

    code = insertAwaitsInFunctions(code, Object.keys(userFuncs));

    return { code: code, knownTypes: knownTypes };
  }

  function replaceIdentifiers(line, map) {
    var names = Object.keys(map || {});
    if (!names.length) return line;
    var re = new RegExp("\\b(" + names.join("|") + ")\\b", "g");
    return replaceOutsideStrings(line, re, function (m, name) { return map[name] || m; });
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

  function insertAwaitsInFunctions(code, names) {
    if (!names.length) return code;
    var callRe = new RegExp("(^|[^a-zA-Z0-9_$.])\\b(" + names.join("|") + ")\\s*\\(", "g");
    var lines = code.split("\n");
    var depth = 0;
    for (var i = 0; i < lines.length; i++) {
      var startsFunc = /\basync\s+function\b/.test(lines[i]);
      if (depth > 0 || startsFunc) {
        lines[i] = replaceOutsideStrings(lines[i], callRe, function (m, pre, name, offset, full) {
          var nameStart = offset + pre.length;
          var before = full.slice(0, nameStart);
          if (/\bfunction\s*$/.test(before)) return m;
          if (/\bnew\s*$/.test(before)) return m;
          if (/\bawait\s*$/.test(before)) return m;
          return pre + "await " + name + "(";
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

  function transformDecl(dm, structNames, currentFunc, staticHoists, staticMaps) {
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
    var isStatic = /\bstatic\b/.test(mods);
    var kw = isConst ? "const" : "let";
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
          rhs = rhs.replace(/\{/g, "[").replace(/\}/g, "]"); // init de array -> JS
          return nm + " = " + rhs;
        }
        // sin init: new Array(N).fill(0) (1D); multi-dim -> anidado simple
        var sizes = [];
        dims.replace(/\[([^\]]*)\]/g, function (mm, s) { sizes.push(s.trim()); return ""; });
        return nm + " = " + buildArray(sizes, 0, structNames[base]);
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
        return d + " = new " + base + "()";
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
      staticNames.forEach(function (s) {
        var unique = "__static_" + currentFunc + "_" + s.name;
        staticHoists.push(kw + " " + unique + " = " + s.init + ";");
        staticMaps[currentFunc] = staticMaps[currentFunc] || {};
        staticMaps[currentFunc][s.name] = unique;
      });
      return indent + "";
    }

    return indent + kw + " " + parts.join(", ") + ";" + tail;
  }

  function buildArray(sizes, idx, isStruct) {
    if (idx >= sizes.length) return isStruct ? "{}" : "0";
    var n = sizes[idx];
    if (!n) return "[]";
    var inner = buildArray(sizes, idx + 1, isStruct);
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
