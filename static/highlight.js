/* =========================================================================
 * highlight.js  —  Resaltado de sintaxis estilo Arduino IDE.
 *
 * Paleta basada en el Arduino IDE clasico, ajustada para fondo oscuro:
 *   - estructuras de control (if/for/while):  oliva   (#5E6D03 ->)
 *   - tipos de dato (void/int/float):         teal    (#00979C ->)
 *   - funciones conocidas (digitalWrite):     naranja (#D35400 ->)
 *   - constantes (HIGH/LOW/OUTPUT):           teal claro
 *   - strings y chars:                        cyan    (#005C5F ->)
 *   - comentarios:                            gris    (#95A5A6 ->)
 *   - preprocesador (#include/#define):       oliva claro (#728E00 ->)
 *
 * Render: Highlight.render(codigo) -> HTML con <span class="tk-*">.
 * Se pinta en un <pre> debajo del textarea transparente (overlay).
 * ========================================================================= */
(function (global) {
  "use strict";

  function set(words) {
    var o = {};
    words.split(" ").forEach(function (w) { o[w] = true; });
    return o;
  }

  var CTRL = set("if else for while do switch case break continue return default goto");
  var TYPES = set("void int long short float double bool boolean byte char word unsigned signed " +
    "const static volatile String size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t " +
    "int32_t int64_t enum struct class typedef auto");
  var FNS = set("pinMode digitalWrite digitalRead analogWrite analogRead analogReadResolution " +
    "analogWriteResolution pulseIn pulseInLong tone noTone shiftOut shiftIn millis micros delay " +
    "delayMicroseconds yield map constrain min max abs sq sqrt pow sin cos tan floor ceil round " +
    "log exp random randomSeed bit bitRead bitWrite bitSet bitClear lowByte highByte " +
    "attachInterrupt detachInterrupt noInterrupts interrupts digitalPinToInterrupt sizeof F " +
    "begin end print println write read available peek flush stop connected readString " +
    "readStringUntil indexOf substring charAt startsWith endsWith trim replace concat remove " +
    "toInt toFloat toUpperCase toLowerCase equals equalsIgnoreCase length setCharAt " +
    "beginAP localIP status RSSI SSID disconnect macAddress config");
  var OBJS = set("Serial WiFi WiFiServer WiFiClient IPAddress Servo");
  var CONSTS = set("HIGH LOW INPUT OUTPUT INPUT_PULLUP LED_BUILTIN true false NULL nullptr " +
    "A0 A1 A2 A3 A4 A5 A6 A7 PI HALF_PI TWO_PI DEG_TO_RAD RAD_TO_DEG EULER " +
    "DEC HEX OCT BIN WL_AP_LISTENING WL_CONNECTED WL_IDLE_STATUS WL_NO_SHIELD CHANGE RISING FALLING");

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function span(cls, s) { return '<span class="tk-' + cls + '">' + esc(s) + "</span>"; }

  var RE = new RegExp(
    "(\\/\\*[\\s\\S]*?(?:\\*\\/|$))" +            // 1 comentario de bloque
    "|(\\/\\/[^\\n]*)" +                            // 2 comentario de linea
    "|(\"(?:[^\"\\\\\\n]|\\\\.)*(?:\"|$))" +      // 3 string
    "|('(?:[^'\\\\\\n]|\\\\.)*(?:'|$))" +          // 4 char
    "|(^[ \\t]*#[^\\n]*)" +                         // 5 preprocesador
    "|(\\b\\d[\\w.]*\\b)" +                         // 6 numero
    "|\\b([A-Za-z_]\\w*)\\b",                       // 7 identificador
    "gm");

  function render(src) {
    src = String(src == null ? "" : src);
    var out = "", last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      out += esc(src.slice(last, m.index));
      var t = m[0];
      if (m[1] != null || m[2] != null) out += span("com", t);
      else if (m[3] != null || m[4] != null) out += span("str", t);
      else if (m[5] != null) out += span("pre", t);
      else if (m[6] != null) out += span("num", t);
      else {
        var w = m[7];
        if (CTRL[w]) out += span("ctrl", t);
        else if (TYPES[w]) out += span("type", t);
        else if (OBJS[w]) out += span("obj", t);
        else if (CONSTS[w]) out += span("const", t);
        else if (FNS[w]) out += span("fn", t);
        else out += esc(t);
      }
      last = m.index + t.length;
    }
    out += esc(src.slice(last));
    return out;
  }

  global.Highlight = { render: render };
})(typeof window !== "undefined" ? window : this);
