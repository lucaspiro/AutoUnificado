# -*- coding: utf-8 -*-
"""
Auto Unificado - Backend Flask.

Espeja el WiFiServer del Arduino UNO R4 WiFi: recibe CUALQUIER request HTTP
(de donde sea, sin seguridad), guarda la ultima linea, y el simulador web la
poolea. Tambien sirve el frontend y maneja la config JSON (persistente,
exportable / importable).

Correr:
    pip install flask
    python app.py
    abrir http://localhost:5000
"""

import json
import os
import socket
import sys
import time

from flask import (
    Flask,
    Response,
    jsonify,
    request,
    send_from_directory,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
CONFIG_DIR = os.path.join(BASE_DIR, "config")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")

app = Flask(__name__, static_folder=None)

# --------------------------------------------------------------------------
# Estado en memoria (espeja el server del Arduino)
# --------------------------------------------------------------------------
estado = {
    "request": "",   # ultima linea HTTP recibida, ej "GET /adelante HTTP/1.1"
    "ts": 0.0,       # timestamp de cuando llego
}

# Config por defecto: solo hardware (que sensor/motor esta en que pin).
# Velocidades, umbrales y variables viven en el codigo, como en el Arduino.
CONFIG_DEFAULT = {
    "motores": {
        "pins": {"IN1": 5, "IN2": 6, "IN3": 10, "IN4": 11},
    },
    "ultrasonido": {
        "sensores": [
            {"rol": "frontal",   "trigPin": 9,  "echoPin": 8},
            {"rol": "izquierdo", "trigPin": 12, "echoPin": 13},
            {"rol": "derecho",   "trigPin": 7,  "echoPin": 4},
        ]
    },
    "infrarrojo": {
        "sensores": [
            {"rol": "izq", "pin": "A0"},
            {"rol": "der", "pin": "A1"},
        ],
        "lecturaBlanco": 100,
        "lecturaNegro": 900,
    },
}


# Puerto del server. Default 80 (igual que el Arduino real: la app usa la IP
# pelada, sin puerto). Si el 80 esta ocupado cae solo a 5000.
# Se puede forzar otro:  python app.py 8080   (o variable de entorno PORT)
PORT = 80
PORT_FALLBACK = 5000
if os.environ.get("PORT"):
    try:
        PORT = int(os.environ["PORT"])
    except ValueError:
        pass
if len(sys.argv) > 1:
    try:
        PORT = int(sys.argv[1])
    except ValueError:
        pass


def _puerto_disponible(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(("0.0.0.0", port))
        s.close()
        return True
    except OSError:
        return False


def _ip_local():
    """IP de esta PC en la red local (la que va en la app del celular)."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # no manda nada, solo elige interfaz
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def _cors(resp):
    """Agrega cabeceras CORS abiertas (sin seguridad, como el Arduino real)."""
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "*"
    return resp


def _leer_config():
    if not os.path.exists(CONFIG_PATH):
        return dict(CONFIG_DEFAULT)
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return dict(CONFIG_DEFAULT)


def _guardar_config(data):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


@app.after_request
def after(resp):
    return _cors(resp)


# --------------------------------------------------------------------------
# Endpoints internos del simulador (prefijo /__sim/, NO se graban como comando)
# --------------------------------------------------------------------------
@app.route("/__sim/estado", methods=["GET"])
def sim_estado():
    return jsonify(estado)


@app.route("/__sim/info", methods=["GET"])
def sim_info():
    ip = _ip_local()
    return jsonify({
        "ip": ip,
        "port": PORT,
        "url": _url(ip, PORT),
    })


@app.route("/__sim/reset", methods=["POST", "GET"])
def sim_reset():
    estado["request"] = ""
    estado["ts"] = time.time()
    return jsonify(estado)


@app.route("/__sim/config", methods=["GET"])
def sim_config_get():
    return jsonify(_leer_config())


@app.route("/__sim/config", methods=["POST"])
def sim_config_post():
    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"error": "JSON invalido"}), 400
    _guardar_config(data)
    return jsonify({"ok": True})


@app.route("/__sim/config/export", methods=["GET"])
def sim_config_export():
    data = _leer_config()
    body = json.dumps(data, ensure_ascii=False, indent=2)
    resp = Response(body, mimetype="application/json")
    resp.headers["Content-Disposition"] = "attachment; filename=config.json"
    return resp


@app.route("/__sim/config/import", methods=["POST"])
def sim_config_import():
    # Acepta archivo (multipart) o JSON crudo en el body.
    if "file" in request.files:
        try:
            data = json.load(request.files["file"])
        except ValueError:
            return jsonify({"error": "Archivo JSON invalido"}), 400
    else:
        data = request.get_json(force=True, silent=True)
        if data is None:
            return jsonify({"error": "JSON invalido"}), 400
    _guardar_config(data)
    return jsonify({"ok": True, "config": data})


# --------------------------------------------------------------------------
# Frontend estatico
# --------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def index():
    # Si "/" viene con query string (ej joystick "/?X=..&Y=.."), es un comando,
    # no el home. Lo grabamos igual que cualquier ruta.
    qs = request.query_string.decode("utf-8", "ignore")
    if qs:
        estado["request"] = "GET /?" + qs + " HTTP/1.1"
        estado["ts"] = time.time()
        return Response("OK\n", mimetype="text/plain")
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>", methods=["GET"])
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


# --------------------------------------------------------------------------
# Catch-all: CUALQUIER otra ruta = comando del auto.
# Graba la linea HTTP igual que la leeria el Arduino y responde 200 OK.
# --------------------------------------------------------------------------
@app.route("/<path:ruta>", methods=["GET", "POST", "OPTIONS"])
def comando(ruta):
    if request.method == "OPTIONS":
        return ("", 204)

    qs = request.query_string.decode("utf-8", "ignore")
    full = "/" + ruta
    if qs:
        full += "?" + qs
    estado["request"] = "GET " + full + " HTTP/1.1"
    estado["ts"] = time.time()
    return Response("OK\n", mimetype="text/plain")


# Caso especial: "/?X=..&Y=.." (joystick) cae en "/" con query string.
@app.route("/", methods=["POST", "OPTIONS"])
def root_post():
    return comando("")


def _url(ip, port):
    # En puerto 80 el navegador no muestra el puerto, igual que el Arduino.
    if port == 80:
        return "http://" + ip
    return "http://" + ip + ":" + str(port)


if __name__ == "__main__":
    os.makedirs(CONFIG_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        _guardar_config(CONFIG_DEFAULT)

    if os.environ.get("WERKZEUG_RUN_MAIN") == "true":
        # Proceso hijo del reloader: hereda el socket ya bindeado del padre.
        # NO re-chequear el puerto (lo veria "ocupado" por su propio padre);
        # adoptar el que decidio el padre.
        PORT = int(os.environ.get("AUTOSIM_PORT", PORT))
    else:
        if not _puerto_disponible(PORT):
            print("AVISO: puerto %d ocupado, usando %d" % (PORT, PORT_FALLBACK))
            PORT = PORT_FALLBACK
        os.environ["AUTOSIM_PORT"] = str(PORT)

        ip = _ip_local()
        print("=" * 52)
        print("  Simulador Auto Unificado")
        print("  En esta PC:     " + _url("localhost", PORT))
        print("  Desde la app:   " + _url(ip, PORT))
        print("  (la IP que va en la aplicacion del celular)")
        print("=" * 52, flush=True)

    # Desactivamos el reloader de Flask para que no queden procesos zombis en Windows
    # al cerrar la terminal con la X.
    app.run(host="0.0.0.0", port=PORT, debug=True, use_reloader=False)
