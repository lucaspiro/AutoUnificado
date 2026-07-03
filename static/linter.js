/* =========================================================================
 * linter.js  —  Verificador de sintaxis estilo compilador Arduino.
 *
 * Corre ANTES de ejecutar (al apretar Ejecutar): revisa el .ino original y
 * devuelve TODOS los errores encontrados, con linea y hint pedagogico en
 * espanol. Si devuelve errores, el sketch NO se ejecuta.
 *
 * No es un parser C++ completo: son chequeos conservadores pensados para
 * los errores tipicos de alumno (falta ';', llaves desbalanceadas, string
 * sin cerrar, mayusculas, typos de funciones, '=' en un if). Ante la duda
 * NO marca error (los casos raros los atrapa el compilador JS despues).
 * ========================================================================= */
(function (global) {
  "use strict";

  // ---- Palabras clave / funciones conocidas -------------------------------
  var TYPES = "void int long short float double bool boolean byte char word unsigned signed const static volatile String size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t enum struct class typedef".split(" ");
  var CONTROL = "if else for while do switch case default break continue return goto".split(" ");
  var KEYWORDS = TYPES.concat(CONTROL);

  var KNOWN_FUNCS = ("pinMode digitalWrite digitalRead analogWrite analogRead analogReadResolution " +
    "analogWriteResolution pulseIn pulseInLong tone noTone shiftOut shiftIn millis micros delay " +
    "delayMicroseconds yield map constrain min max abs sq sqrt pow sin cos tan floor ceil round " +
    "log exp random randomSeed bit bitRead bitWrite bitSet bitClear lowByte highByte " +
    "attachInterrupt detachInterrupt noInterrupts interrupts digitalPinToInterrupt sizeof String " +
    "WiFiServer WiFiClient IPAddress Servo isDigit isAlpha isSpace").split(" ");

  var KNOWN_OBJS = { Serial: true, WiFi: true };

  var SERIAL_METHODS = "begin end print println write read available peek flush".split(" ");
  var WIFI_METHODS = "begin beginAP localIP status config RSSI SSID disconnect macAddress".split(" ");

  // -------------------------------------------------------------------------
  // Utilidades
  // -------------------------------------------------------------------------
  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m || !n) return m || n;
    var row = [];
    for (var j = 0; j <= n; j++) row[j] = j;
    for (var i = 1; i <= m; i++) {
      var prev = row[0]; row[0] = i;
      for (var k = 1; k <= n; k++) {
        var tmp = row[k];
        row[k] = Math.min(row[k] + 1, row[k - 1] + 1, prev + (a[i - 1] === b[k - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return row[n];
  }

  // Enmascara comentarios y strings (mismo largo, preserva lineas).
  // Los strings quedan como "SSS" para no confundir a los chequeos.
  // Devuelve { text, unclosedString: [lineas] }
  function mask(src) {
    var out = "", i = 0, n = src.length, line = 1;
    var unclosed = [];
    while (i < n) {
      var c = src[i];
      if (c === "\n") { out += c; line++; i++; continue; }
      if (c === "/" && src[i + 1] === "/") {          // comentario de linea
        while (i < n && src[i] !== "\n") { out += " "; i++; }
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {          // comentario de bloque
        out += "  "; i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") { out += "\n"; line++; } else out += " ";
          i++;
        }
        if (i < n) { out += "  "; i += 2; }
        continue;
      }
      if (c === '"' || c === "'") {                    // string / char
        var q = c, startLine = line;
        out += q; i++;
        var closed = false;
        while (i < n) {
          if (src[i] === "\\") { out += "SS"; i += 2; continue; }
          if (src[i] === q) { out += q; i++; closed = true; break; }
          if (src[i] === "\n") break;                  // C++: string no cruza lineas
          out += "S"; i++;
        }
        if (!closed) unclosed.push({ line: startLine, quote: q });
        continue;
      }
      out += c; i++; line++; line--;                   // caracter comun
    }
    return { text: out, unclosedStrings: unclosed };
  }

  // -------------------------------------------------------------------------
  // Chequeos
  // -------------------------------------------------------------------------

  // Balance de {} () [] con ubicacion. Clasifica bloques { } para saber si
  // una linea esta dentro de un enum o de un inicializador (alli no se
  // exige ';' por linea).
  function checkBalance(text, errors) {
    var stack = [];               // {ch, line, kind}  kind: code|enum|init|paren|bracket
    var lines = text.split("\n");
    var lineKinds = [];           // por linea: dentro de enum/init?
    var pairs = { ")": "(", "]": "[", "}": "{" };

    for (var li = 0; li < lines.length; li++) {
      var l = lines[li];
      // kind vigente al ARRANCAR la linea
      var inSoft = stack.some(function (s) { return s.kind === "enum" || s.kind === "init"; });
      lineKinds[li] = inSoft;
      for (var ci = 0; ci < l.length; ci++) {
        var ch = l[ci];
        if (ch === "(" || ch === "[") { stack.push({ ch: ch, line: li + 1, kind: ch === "(" ? "paren" : "bracket" }); continue; }
        if (ch === "{") {
          var before = l.slice(0, ci);
          // que habia antes de la llave (misma linea)
          var kind = "code";
          if (/(=|,|\(|\{|\breturn)\s*$/.test(before)) kind = "init";
          else if (/\benum\b[^{]*$/.test(before)) kind = "enum";
          else {
            // llave al inicio de linea: mirar si venimos apilando init/enum
            var top = stack[stack.length - 1];
            if (top && (top.kind === "init" || top.kind === "enum")) kind = "init";
          }
          stack.push({ ch: ch, line: li + 1, kind: kind });
          continue;
        }
        if (ch === ")" || ch === "]" || ch === "}") {
          var top2 = stack[stack.length - 1];
          if (!top2 || top2.ch !== pairs[ch]) {
            errors.push({
              line: li + 1,
              message: "Hay un '" + ch + "' de mas (no coincide con nada abierto).",
              hint: top2
                ? "Lo ultimo abierto fue '" + top2.ch + "' en la linea " + top2.line + ". Revisa el orden de cierre."
                : "No hay nada abierto para cerrar aca. Sobra este caracter."
            });
            return lineKinds; // cortar: el resto seria cascada de falsos errores
          }
          stack.pop();
        }
      }
    }
    for (var s = stack.length - 1; s >= 0; s--) {
      var o = stack[s];
      var nombre = o.ch === "{" ? "llave '{'" : (o.ch === "(" ? "parentesis '('" : "corchete '['");
      errors.push({
        line: o.line,
        message: "Este " + nombre + " nunca se cierra.",
        hint: "Todo lo que se abre se cierra. Conta " + (o.ch === "{" ? "las llaves" : "los parentesis") + " desde esta linea hacia abajo."
      });
    }
    return lineKinds;
  }

  function checkSetupLoop(text, errors) {
    if (!/\bvoid\s+setup\s*\(/.test(text)) {
      errors.push({ line: 1, message: "Falta la funcion setup().", hint: "Todo sketch necesita  void setup() { ... }  aunque quede vacia." });
    }
    if (!/\bvoid\s+loop\s*\(/.test(text)) {
      errors.push({ line: 1, message: "Falta la funcion loop().", hint: "Todo sketch necesita  void loop() { ... }  aunque quede vacia." });
    }
  }

  // Mayusculas en keywords y objetos: Void, If, serial., wifi.
  function checkCase(lines, errors) {
    var kwBad = /\b(Void|Int|Long|Float|Double|Bool|Boolean|Byte|Char|If|Else|For|While|Do|Switch|Case|Break|Continue|Return|VOID|INT|IF|ELSE|FOR|WHILE|RETURN)\b/;
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(kwBad);
      if (m) {
        errors.push({
          line: i + 1,
          message: "'" + m[1] + "' no existe: en C++ las mayusculas importan.",
          hint: "Escribilo en minusculas: '" + m[1].toLowerCase() + "'."
        });
        continue;
      }
      var mo = lines[i].match(/\b(serial|wifi|SERIAL|WIFI)\s*\./);
      if (mo) {
        var ok = mo[1].toLowerCase() === "wifi" ? "WiFi" : "Serial";
        errors.push({
          line: i + 1,
          message: "'" + mo[1] + "' no existe (mayusculas/minusculas).",
          hint: "El objeto se llama '" + ok + "' (asi, con esas mayusculas)."
        });
      }
    }
  }

  // Metodos de Serial/WiFi mal escritos: Serial.Println, Serial.pintln...
  function checkMethods(lines, errors) {
    for (var i = 0; i < lines.length; i++) {
      var re = /\b(Serial|WiFi)\s*\.\s*([A-Za-z_]\w*)/g, m;
      while ((m = re.exec(lines[i]))) {
        var list = m[1] === "Serial" ? SERIAL_METHODS : WIFI_METHODS;
        var meth = m[2];
        if (list.indexOf(meth) >= 0) continue;
        // exacto ignorando mayusculas -> error de mayusculas
        var sug = null;
        for (var k = 0; k < list.length; k++) {
          if (list[k].toLowerCase() === meth.toLowerCase()) { sug = list[k]; break; }
        }
        if (!sug) {
          var best = null, bd = 3;
          for (var j = 0; j < list.length; j++) {
            var d = lev(meth.toLowerCase(), list[j].toLowerCase());
            if (d < bd) { bd = d; best = list[j]; }
          }
          if (bd <= 2) sug = best;
        }
        if (sug) {
          errors.push({
            line: i + 1,
            message: m[1] + "." + meth + "() no existe.",
            hint: "Quisiste decir " + m[1] + "." + sug + "()?"
          });
        }
      }
    }
  }

  // Typos de funciones globales conocidas: digitalWrit(, delai(, DigitalWrite(
  function checkTypos(text, lines, errors) {
    // nombres definidos por el alumno (funciones propias)
    var userNames = {};
    var sigRe = /^[ \t]*(?:[A-Za-z_]\w*[ \t]+)+([A-Za-z_]\w*)[ \t]*\(/gm, sm;
    while ((sm = sigRe.exec(text))) userNames[sm[1]] = true;

    var known = {};
    for (var k = 0; k < KNOWN_FUNCS.length; k++) known[KNOWN_FUNCS[k]] = true;

    for (var i = 0; i < lines.length; i++) {
      var re = /(^|[^\w.])([A-Za-z_]\w*)\s*\(/g, m;
      while ((m = re.exec(lines[i]))) {
        var name = m[2];
        if (known[name] || userNames[name] || KNOWN_OBJS[name]) continue;
        if (KEYWORDS.indexOf(name) >= 0) continue;
        if (/^(F|PSTR|__\w+)$/.test(name)) continue;
        // exacto ignorando mayusculas
        var sug = null;
        for (var kf = 0; kf < KNOWN_FUNCS.length; kf++) {
          if (KNOWN_FUNCS[kf].toLowerCase() === name.toLowerCase()) { sug = KNOWN_FUNCS[kf]; break; }
        }
        if (!sug && name.length >= 4) {
          var best = null, bd = 2;             // typo: distancia 1 (o 2 en nombres largos)
          for (var j = 0; j < KNOWN_FUNCS.length; j++) {
            var cand = KNOWN_FUNCS[j];
            if (Math.abs(cand.length - name.length) > 2) continue;
            var d = lev(name.toLowerCase(), cand.toLowerCase());
            var lim = name.length >= 8 ? 2 : 1;
            if (d <= lim && d < bd + 1 && (best === null || d < bd)) { bd = d; best = cand; }
          }
          sug = best;
        }
        if (sug && sug !== name) {
          errors.push({
            line: i + 1,
            message: "La funcion '" + name + "' no existe.",
            hint: "Quisiste decir '" + sug + "'?"
          });
        }
      }
    }
  }

  // '=' (asignacion) dentro de una condicion if/while
  function checkAssignInCond(lines, errors) {
    for (var i = 0; i < lines.length; i++) {
      var m = lines[i].match(/\b(if|while)\s*\((.*)\)/);
      if (!m) continue;
      var cond = m[2];
      // sacar comparadores y operadores compuestos para no confundir
      var limpio = cond.replace(/==|!=|<=|>=|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|<<=|>>=/g, "@@");
      if (/=/.test(limpio)) {
        errors.push({
          line: i + 1,
          message: "Hay un '=' (asignacion) dentro de la condicion del " + m[1] + ".",
          hint: "Para COMPARAR se usa '==' (doble igual). Con un solo '=' le estas asignando el valor."
        });
      }
    }
  }

  // Falta ';' — heuristica conservadora linea por linea.
  function checkSemicolons(lines, lineKinds, errors) {
    var typeStart = new RegExp("^\\s*(?:" + TYPES.join("|") + ")\\b");
    function nextNonEmpty(idx) {
      for (var j = idx + 1; j < lines.length; j++) {
        if (lines[j].trim() !== "") return lines[j].trim();
      }
      return "";
    }
    for (var i = 0; i < lines.length; i++) {
      if (lineKinds[i]) continue;                        // dentro de enum / inicializador
      var t = lines[i].trim();
      if (t === "") continue;
      if (t[0] === "#") continue;                        // preprocesador
      if (/^(case\b.*|default\s*)\:$/.test(t)) continue; // etiquetas
      if (/^(public|private|protected)\s*:$/.test(t)) continue;
      if (/^(else|do|try)\b\s*\{?\s*$/.test(t)) continue;
      if (/[;{}:,]$/.test(t)) continue;                  // termina bien
      if (/(&&|\|\||[+\-*\/%<>=!&|^?.,(\[])$/.test(t)) continue; // continua en la otra linea
      var nxt = nextNonEmpty(i);
      if (/^[{).?:]/.test(nxt) || /^(&&|\|\||[+\-*\/%<>=,])/.test(nxt)) continue; // continuacion
      // termina en ')' -> puede ser cabecera de if/for/... o firma de funcion
      if (/\)$/.test(t)) {
        if (/^(if|for|while|switch)\b/.test(t)) continue;        // cabecera de control
        if (/^\}?\s*else\b/.test(t)) continue;
        if (typeStart.test(t) && /\w+\s*\([^;]*\)$/.test(t)) continue; // firma de funcion
        if (/^\}\s*while\b/.test(t)) {                            // do-while
          errors.push({ line: i + 1, message: "Falta un ';' despues del while del do-while.", hint: "El do { ... } while (cond); termina con punto y coma." });
          continue;
        }
        errors.push({
          line: i + 1,
          message: "Parece que falta un ';' al final de esta linea.",
          hint: "Toda instruccion termina con punto y coma:  " + t.slice(0, 40) + ";"
        });
        continue;
      }
      // termina en identificador / numero / string / ']' / '++' / '--'
      if (/(\w|\+\+|--|\]|["'])$/.test(t)) {
        // solo si la linea PARECE una instruccion (no una palabra suelta rara)
        var esDecl = typeStart.test(t);
        var esAsig = /^[A-Za-z_][\w.\[\]]*\s*([+\-*\/%&|^]?=|\+\+|--)/.test(t);
        var esReturn = /^return\b/.test(t);
        if (esDecl || esAsig || esReturn) {
          errors.push({
            line: i + 1,
            message: "Parece que falta un ';' al final de esta linea.",
            hint: "Toda instruccion termina con punto y coma:  " + t.slice(0, 40) + ";"
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // API
  // -------------------------------------------------------------------------
  function lint(src) {
    var errors = [];
    src = String(src || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");

    var masked = mask(src);
    var text = masked.text;
    var lines = text.split("\n");

    // strings sin cerrar (corta ahi: lo demas seria cascada)
    for (var u = 0; u < masked.unclosedStrings.length; u++) {
      var us = masked.unclosedStrings[u];
      errors.push({
        line: us.line,
        message: "Hay " + (us.quote === '"' ? "una comilla doble \"" : "una comilla simple '") + " sin cerrar.",
        hint: "Los textos van entre comillas de apertura y de cierre en la MISMA linea."
      });
    }
    if (errors.length) return errors;

    var lineKinds = checkBalance(text, errors);
    var balanceOK = errors.length === 0;

    checkSetupLoop(text, errors);
    checkCase(lines, errors);
    checkMethods(lines, errors);
    checkTypos(text, lines, errors);
    checkAssignInCond(lines, errors);
    if (balanceOK) checkSemicolons(lines, lineKinds, errors); // sin balance, el ';' daria cascada

    // ordenar por linea, max 10 (como un compilador que corta)
    errors.sort(function (a, b) { return a.line - b.line; });
    var vistos = {};
    var unicos = [];
    for (var e = 0; e < errors.length; e++) {
      var key = errors[e].line + "|" + errors[e].message;
      if (vistos[key]) continue;
      vistos[key] = true;
      unicos.push(errors[e]);
      if (unicos.length >= 10) break;
    }
    return unicos;
  }

  global.Linter = { lint: lint };
})(typeof window !== "undefined" ? window : this);
