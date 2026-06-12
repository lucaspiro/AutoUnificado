# Auto Unificado — Simulador (manual + ultrasónico + siguelínea)

Herramienta web para programar un auto robot **igual que en el Arduino IDE** y probarlo en un
simulador, controlándolo por HTTP. El mismo sketch que escribís acá se pega en el IDE y anda en
el **Arduino UNO R4 WiFi** (librería `WiFiS3.h`).

## Cómo correr en tu computadora (Local)

Tenés dos opciones para levantarlo de forma local según lo que prefieras:

### Opción A: Inicio rápido (Recomendado)
1. **Windows:** Hacé doble clic en el archivo [iniciar.bat](file:///d:/Piromaniac04/Descargas/Union_U_S_M/AutoUnificado/iniciar.bat).
2. **Mac / Linux:** Abrí una terminal y ejecutá `./iniciar.sh`.
*(El script se encarga de validar que tengas Python, instalar las librerías necesarias y levantar el servidor solo).*

### Opción B: Manual por Consola
Si preferís hacerlo a mano en la terminal:
```bash
# 1. Instalar dependencias
pip install -r requirements.txt

# 2. Levantar el servidor Flask
python app.py
```

---

### ¿Cómo acceder?
Una vez que el servidor esté corriendo (por cualquiera de los dos métodos), abrí en tu navegador:
* **En tu PC:** [http://localhost](http://localhost) (o [http://localhost:5000](http://localhost:5000) si el puerto 80 estaba ocupado).
* **Desde el celular:** Usá la dirección IP que te imprime la consola al arrancar (ej. `http://192.168.1.15`).

## Qué hace

- **Backend Python (Flask):** recibe CUALQUIER request HTTP (de donde sea, sin seguridad) y lo
  guarda como "último request" — igual que el `WiFiServer` del Arduino. El simulador lo poolea.
- **Editor estilo Arduino IDE:** escribís `setup()` + `loop()` + funciones. Un transpilador
  C++→JS hace que el `.ino` corra tal cual (con `#include`, `#define`, `enum`, `String`, etc.).
- **Simulador p5.js:** escena editable (dibujás la pista de línea y ponés obstáculos). El robot
  se mueve según tu código. Sensores ultrasónicos (raycast) e infrarrojos (leen la pista).
- **3 modos** (manual / ultrasónico / siguelínea): emergen de TU código según el request.
- **Control manual:** flechas o joystick. Las rutas son editables para que coincidan con tu sketch.
- **Configuración:** nombres de variables, pines y velocidades/umbrales. Se guarda en
  `config/config.json` (transportable). Exportá / importá.

## Contrato del sketch (cómo lo lee el simulador)

| En tu código | El simulador… |
|---|---|
| `WiFiServer server(80);` + `server.available()` | te devuelve un cliente con el **request** que llegó al backend |
| `client.readStringUntil('\n')` / `client.read()` | entrega la línea HTTP (`GET /adelante HTTP/1.1`) |
| `analogWrite(IN1..IN4, pwm)` / `digitalWrite(...)` | mueve las **ruedas** (config: pines IN1..IN4) |
| `pulseIn(echo, HIGH, t)` (vía tu `leerDistancia`) | devuelve la **distancia** ultrasónica simulada |
| `analogRead(A0..)` | devuelve la lectura **infrarroja** (0–1023) según la pista |
| `Serial.print/println` | sale en el **Monitor Serial** |
| `millis()` | tiempo real (sirve para FSM con timers) |

> **Importante:** los **pines** de la Configuración tienen que coincidir con los `#define`/`const`
> de tu sketch. Los nombres de variables son orientativos.

## Pines por defecto (config.json)

- Motores L298N: `IN1=5, IN2=6` (izq), `IN3=10, IN4=11` (der).
- Ultrasónico: frontal `trig 9/echo 8`, izquierdo `12/13`, derecho `7/4`.
- Infrarrojo: `A0` (izq), `A1` (der). Umbral 500.

## Ejemplos incluidos

En `static/ejemplos/` hay dos sketches REALES de alumnos que andan pegados tal cual:

- `ejemplo_flechas.ino` — control por rutas (`/adelante`, `/atras`...) + modo automático.
- `ejemplo_joystick.ino` — control por joystick (`/?X=..&Y=..`) + modo obstáculo.

También accesibles desde el navegador: `http://localhost/static/ejemplos/ejemplo_flechas.ino`.

## Probar el modo manual desde afuera

```bash
curl http://localhost/adelante
curl "http://localhost/?X=120&Y=0"
```

El simulador reacciona aunque el comando venga de otra máquina o del celular.

## Límites del transpilador

Cubre un subset MUY amplio de Arduino/C++ (tipos, arrays, punteros, `enum`, `struct`, `class`,
`#define`/`#ifdef`, casts, sufijos `UL/L/F`, `F()`...). **No** es un compilador C++ completo:
templates, sobrecarga compleja, aritmética de punteros y herencia avanzada quedan fuera. Cuando
algo no entra, el panel de errores avisa con número de línea y un hint.

## Archivos

```
app.py                  backend Flask
config/config.json      configuración (editable / exportable)
static/
  index.html            UI (tabs)
  transpiler.js         C++ -> JS
  arduino-shim.js       runtime Arduino/WiFiS3 + compilación + errores
  sim.js                simulador p5.js
  control.js            panel manual (flechas + joystick)
  config-ui.js          pestaña de configuración
  starter.js            sketch de ejemplo
  app.js                pegamento de la UI
  style.css
```
