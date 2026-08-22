#include <WiFiS3.h>

#define IN1 5
#define IN2 6
#define IN3 10
#define IN4 11

#define SENSOR_IZQ A0
#define SENSOR_DER A1

// Sensor ultrasónico frontal
#define TRIG 9
#define ECHO 8

// Sensores ultrasónicos laterales
#define TRIG_IZQ 7
#define ECHO_IZQ 4
#define TRIG_DER 12
#define ECHO_DER 13

// LEDs indicadores. Poner en 0 si el auto no los tiene conectados.
#define USAR_LEDS 1

#define LED_TRASERO A3
#define LED_GIRO_IZQ A4
#define LED_GIRO_DER A5

#define TIEMPO_BLINK 250

#define NEGRO_ALTO 0

#define UMBRAL 300
#define HISTERESIS 25

// Velocidad de avance normal
#define VEL_MIN 90
#define VEL_MAX 145

// Rampas de aceleración y frenado
#define RAMPA_SUBIDA 1
#define RAMPA_BAJADA 8

// Diferencia entre motores durante correcciones
#define DIFERENCIAL_CORRECCION 55

// Velocidad mínima permitida solo durante correcciones
#define VEL_MIN_CORRECCION 25

// Giro en arco
#define VEL_ARCO_INTERIOR 45
#define VEL_ARCO_EXTERIOR 145

// Giro pivotando
#define VEL_PIVOTE 115
#define VEL_PIVOTE_FINAL 90

// Tiempos de detección y giro
#define TIEMPO_CONFIRMAR_GIRO 95
#define TIEMPO_ARCO_INICIAL 85
#define TIEMPO_MIN_GIRO 35
#define TIEMPO_SENSOR_OBJETIVO 2
#define TIEMPO_SOBREGIRO 15
#define TIEMPO_MAX_GIRO 1300

// Salida del giro
#define VEL_SALIDA 95
#define TIEMPO_SALIDA 12

// Rango del joystick que manda la app
#define JOY_MAX 127
#define JOY_ZONA_MUERTA 4

// Velocidades del modo manual
#define VEL_MANUAL_MIN 80
#define VEL_MANUAL_MAX 200

// Velocidad que usan los comandos que no la especifican
#define VEL_MANUAL_DEFECTO 180

// Si no llega ningún comando en este tiempo, el auto frena solo
#define TIEMPO_SIN_COMANDO 700

// Duración máxima aceptada por /pulso
#define PULSO_MAX 3000

// Conversión del eco a centímetros
#define SONAR_DIVISOR 58.0
#define SONAR_TIMEOUT 8000

// Valor usado cuando todavía no hay una medición válida.
// Un timeout del sonar NO se interpreta como camino libre: queda marcado
// explícitamente como lectura inválida.
#define DISTANCIA_INVALIDA -1.0

// Distancia a la que hay que frenar y retroceder
#define DISTANCIA_OBSTACULO 18

// Distancia a la que empieza a corregir
#define DISTANCIA_PRECAUCION 30

// Velocidades del modo obstáculos
#define VEL_OBSTACULO_AVANCE 200
#define VEL_OBSTACULO_GIRO 150
#define VEL_OBSTACULO_RETROCESO 145

// Tiempos del modo obstáculos
#define TIEMPO_LECTURA_SONAR 80
#define TIEMPO_RETROCESO 250
#define TIEMPO_GIRO_ESTRATEGICO 380

// Plazo para juntar la primera línea de un pedido HTTP.
// Ya no es tiempo bloqueado: el pedido se arma de a pedazos entre vueltas del
// loop, así que se puede ser generoso sin sacarle reflejos al sigue líneas.
#define TIEMPO_CLIENTE 500

// Tope de la línea de pedido, para que un pedido roto no coma memoria.
#define LARGO_MAX_PEDIDO 160

// El AP tarda en levantar después de beginAP().
#define ESPERA_AP 8000

char ssid[] = "LaIsla";
char pass[] = "deGhiGhi";

WiFiServer server(80);

// Cliente que se está leyendo ahora. Se mantiene entre vueltas del loop para
// no bloquear esperando a que llegue el pedido completo.
WiFiClient clienteActual;

String lineaPedido = "";

unsigned long inicioCliente = 0;

enum ModoRobot {
  MANUAL,
  LINEA,
  OBSTACULOS,
  EMOTE
};

enum EstadoRobot {
  SIGUIENDO,
  GIRANDO_IZQUIERDA,
  GIRANDO_DERECHA,
  SOBREGIRANDO,
  SALIENDO_GIRO
};

enum FaseGiro {
  ARCO_INICIAL,
  PIVOTE_FINAL
};

enum FaseObstaculo {
  AVANZANDO,
  CORRIGIENDO_IZQUIERDA,
  CORRIGIENDO_DERECHA,
  ESQUIVANDO_IZQUIERDA,
  ESQUIVANDO_DERECHA,
  RETROCEDIENDO
};

// Un paso de emote: velocidad de cada rueda y cuánto dura.
struct PasoEmote {
  int izq;
  int der;
  unsigned int duracion;
};

struct Emote {
  const char *nombre;
  const PasoEmote *pasos;
  byte cantidad;
};

// Asiente: adelante y atrás en pulsos cortos.
const PasoEmote EMOTE_SI[] = {
  { 140, 140, 120 },
  { -140, -140, 120 },
  { 140, 140, 120 },
  { -140, -140, 120 },
  { 0, 0, 80 }
};

// Niega: pivotes cortos a un lado y al otro.
const PasoEmote EMOTE_NO[] = {
  { -160, 160, 130 },
  { 160, -160, 130 },
  { -160, 160, 130 },
  { 160, -160, 130 },
  { 0, 0, 80 }
};

// Festeja: vuelta completa y dos saltitos.
const PasoEmote EMOTE_FESTEJO[] = {
  { 190, -190, 1100 },
  { 0, 0, 150 },
  { 140, 140, 150 },
  { -140, -140, 150 },
  { 140, 140, 150 },
  { -140, -140, 150 },
  { 0, 0, 80 }
};

// Se asusta: retroceso brusco y se queda temblando.
const PasoEmote EMOTE_SUSTO[] = {
  { -200, -200, 320 },
  { 0, 0, 180 },
  { -130, 130, 90 },
  { 130, -130, 90 },
  { -130, 130, 90 },
  { 130, -130, 90 },
  { 0, 0, 100 }
};

// Se marea: giros lentos que se van cortando.
const PasoEmote EMOTE_MAREO[] = {
  { 120, -120, 400 },
  { -120, 120, 400 },
  { 120, -120, 300 },
  { -120, 120, 300 },
  { 120, -120, 200 },
  { 0, 0, 150 }
};

// Saluda: se inclina en arco hacia cada lado.
const PasoEmote EMOTE_SALUDO[] = {
  { 60, 170, 260 },
  { 170, 60, 260 },
  { 60, 170, 260 },
  { 170, 60, 260 },
  { 0, 0, 100 }
};

// Baila: mezcla de pivotes y saltitos.
const PasoEmote EMOTE_BAILE[] = {
  { 160, -160, 180 },
  { -160, 160, 180 },
  { 150, 150, 150 },
  { -150, -150, 150 },
  { 160, -160, 180 },
  { -160, 160, 180 },
  { 150, 150, 150 },
  { -150, -150, 150 },
  { 0, 0, 100 }
};

// Vuelta completa sobre su eje.
const PasoEmote EMOTE_VUELTA[] = {
  { 190, -190, 1200 },
  { 0, 0, 100 }
};

const Emote EMOTES[] = {
  { "si", EMOTE_SI, sizeof(EMOTE_SI) / sizeof(PasoEmote) },
  { "no", EMOTE_NO, sizeof(EMOTE_NO) / sizeof(PasoEmote) },
  { "festejo", EMOTE_FESTEJO, sizeof(EMOTE_FESTEJO) / sizeof(PasoEmote) },
  { "susto", EMOTE_SUSTO, sizeof(EMOTE_SUSTO) / sizeof(PasoEmote) },
  { "mareo", EMOTE_MAREO, sizeof(EMOTE_MAREO) / sizeof(PasoEmote) },
  { "saludo", EMOTE_SALUDO, sizeof(EMOTE_SALUDO) / sizeof(PasoEmote) },
  { "baile", EMOTE_BAILE, sizeof(EMOTE_BAILE) / sizeof(PasoEmote) },
  { "vuelta", EMOTE_VUELTA, sizeof(EMOTE_VUELTA) / sizeof(PasoEmote) }
};

#define CANTIDAD_EMOTES (sizeof(EMOTES) / sizeof(Emote))

ModoRobot modoRobot = MANUAL;
EstadoRobot estadoRobot = SIGUIENDO;
FaseGiro faseGiro = ARCO_INICIAL;
FaseObstaculo faseObstaculo = AVANZANDO;

int velocidadActual = VEL_MIN;

int candidatoGiro = 0;
int direccionGiroActual = 0;

bool lineaIzq = false;
bool lineaDer = false;

bool estadoAnteriorIzq = false;
bool estadoAnteriorDer = false;

// Últimas lecturas crudas, para poder exponerlas por la API.
int valorSensorIzq = 0;
int valorSensorDer = 0;

float distancia = DISTANCIA_INVALIDA;
float distanciaIzq = DISTANCIA_INVALIDA;
float distanciaDer = DISTANCIA_INVALIDA;

bool sonarFrenteValido = false;
bool sonarIzqValido = false;
bool sonarDerValido = false;

unsigned long selloSonar = 0;

int joystickX = 0;
int joystickY = 0;

int velocidadManual = VEL_MANUAL_DEFECTO;

bool manualMoviendo = false;

int comandoIzq = 0;
int comandoDer = 0;

// Emote en ejecución. Si el nombre es NULL, no hay ninguno.
const char *nombreEmote = NULL;
const PasoEmote *pasosEmote = NULL;

byte cantidadPasosEmote = 0;
byte pasoEmote = 0;

// Buffer del emote improvisado que arma /pulso.
PasoEmote pasoTemporal[1];

bool estadoBlink = false;

unsigned long inicioCandidato = 0;
unsigned long inicioGiro = 0;
unsigned long inicioSensorObjetivo = 0;
unsigned long inicioSobregiro = 0;
unsigned long inicioSalida = 0;
unsigned long inicioRetroceso = 0;
unsigned long inicioEsquive = 0;
unsigned long inicioPasoEmote = 0;
unsigned long ultimaLectura = 0;
unsigned long ultimoComando = 0;
unsigned long ultimoBlink = 0;
unsigned long ultimoReporte = 0;

void setup() {
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  pinMode(SENSOR_IZQ, INPUT);
  pinMode(SENSOR_DER, INPUT);

  pinMode(TRIG, OUTPUT);
  pinMode(ECHO, INPUT);

  pinMode(TRIG_IZQ, OUTPUT);
  pinMode(ECHO_IZQ, INPUT);

  pinMode(TRIG_DER, OUTPUT);
  pinMode(ECHO_DER, INPUT);

#if USAR_LEDS

  pinMode(LED_TRASERO, OUTPUT);
  pinMode(LED_GIRO_IZQ, OUTPUT);
  pinMode(LED_GIRO_DER, OUTPUT);

#endif

  Serial.begin(115200);

  lineaPedido.reserve(LARGO_MAX_PEDIDO);

  parar();

  iniciarRed();

  ultimoComando = millis();
}

void loop() {
  unsigned long ahora = millis();

  // Los pedidos se atienden en todos los modos.
  // Así se puede cambiar de modo o frenar con el auto en movimiento.
  atenderCliente();

  // atenderCliente() puede procesar /sonar y bloquear durante una medición.
  // Refrescamos el reloj antes de alimentar las máquinas de estado.
  ahora = millis();

  // Los sensores de línea se leen siempre, aunque el modo sea otro.
  // Cuestan poco y mantienen la telemetría al día.
  leerSensores();

  switch (modoRobot) {
    case MANUAL:
      controlarManual(ahora);
      break;

    case LINEA:
      controlarLinea(ahora);
      break;

    case OBSTACULOS:
      controlarObstaculos(ahora);
      break;

    case EMOTE:
      controlarEmote(ahora);
      break;
  }

  // Algunos modos pueden haber hecho lecturas bloqueantes. También los timers
  // auxiliares (LEDs y reporte serie) reciben un reloj actualizado.
  ahora = millis();

  actualizarLeds(ahora);

  mostrarDatos(ahora);
}

void cambiarModo(ModoRobot modoNuevo) {
  parar();

  modoRobot = modoNuevo;

  // Cada modo arranca siempre desde cero.
  // Si no, un giro que quedó a medias se retoma al volver.
  estadoRobot = SIGUIENDO;
  faseGiro = ARCO_INICIAL;
  faseObstaculo = AVANZANDO;

  velocidadActual = VEL_MIN;

  estadoAnteriorIzq = false;
  estadoAnteriorDer = false;

  distancia = DISTANCIA_INVALIDA;
  distanciaIzq = DISTANCIA_INVALIDA;
  distanciaDer = DISTANCIA_INVALIDA;

  sonarFrenteValido = false;
  sonarIzqValido = false;
  sonarDerValido = false;

  joystickX = 0;
  joystickY = 0;

  manualMoviendo = false;

  nombreEmote = NULL;
  pasosEmote = NULL;

  ultimaLectura = 0;
  ultimoComando = millis();

  cancelarCandidato();
}

void controlarManual(unsigned long ahora) {
  if (!manualMoviendo) {
    return;
  }

  // Red de seguridad: si se corta el WiFi, el auto no sigue solo.
  if (ahora - ultimoComando < TIEMPO_SIN_COMANDO) {
    return;
  }

  parar();

  manualMoviendo = false;

  joystickX = 0;
  joystickY = 0;
}

// Mezcla diferencial: Y controla el avance y X el giro.
void mezclarJoystick(int x, int y) {
  x = constrain(x, -JOY_MAX, JOY_MAX);
  y = constrain(y, -JOY_MAX, JOY_MAX);

  int izquierda = y + x;
  int derecha = y - x;

  // En las esquinas la suma se pasa del rango.
  // Se reescala manteniendo la proporción entre los dos lados.
  int mayor = max(abs(izquierda), abs(derecha));

  if (mayor > JOY_MAX) {
    izquierda = (long)izquierda * JOY_MAX / mayor;
    derecha = (long)derecha * JOY_MAX / mayor;
  }

  moverRuedas(
    velocidadDesdeJoystick(izquierda),
    velocidadDesdeJoystick(derecha)
  );
}

int velocidadDesdeJoystick(int valor) {
  int magnitud = abs(valor);

  if (magnitud <= JOY_ZONA_MUERTA) {
    return 0;
  }

  magnitud = constrain(
    magnitud,
    JOY_ZONA_MUERTA + 1,
    JOY_MAX
  );

  int velocidad = map(
    magnitud,
    JOY_ZONA_MUERTA + 1,
    JOY_MAX,
    VEL_MANUAL_MIN,
    VEL_MANUAL_MAX
  );

  if (valor < 0) {
    return -velocidad;
  }

  return velocidad;
}

// Control directo de cada rueda. Es la base de todos los comandos manuales.
void moverRuedas(int izquierda, int derecha) {
  moverMotores(izquierda, derecha);

  manualMoviendo = (comandoIzq != 0 || comandoDer != 0);

  ultimoComando = millis();
}

// Comandos direccionales: F, B, L, R y S.
void comandoDireccion(char direccion, int velocidad) {
  velocidad = constrain(velocidad, 0, 255);

  if (direccion == 'F') {
    moverRuedas(velocidad, velocidad);
  }
  else if (direccion == 'B') {
    moverRuedas(-velocidad, -velocidad);
  }
  else if (direccion == 'L') {
    moverRuedas(-velocidad, velocidad);
  }
  else if (direccion == 'R') {
    moverRuedas(velocidad, -velocidad);
  }
  else {
    moverRuedas(0, 0);
  }
}

void comenzarEmote(const Emote &emote, unsigned long ahora) {
  parar();

  modoRobot = EMOTE;

  nombreEmote = emote.nombre;
  pasosEmote = emote.pasos;
  cantidadPasosEmote = emote.cantidad;

  pasoEmote = 0;
  inicioPasoEmote = ahora;

  aplicarPasoEmote();
}

void aplicarPasoEmote() {
  moverMotores(
    pasosEmote[pasoEmote].izq,
    pasosEmote[pasoEmote].der
  );
}

void controlarEmote(unsigned long ahora) {
  if (ahora - inicioPasoEmote < pasosEmote[pasoEmote].duracion) {
    return;
  }

  pasoEmote++;

  // Terminó la secuencia: el auto queda quieto y a la espera.
  if (pasoEmote >= cantidadPasosEmote) {
    terminarEmote();

    return;
  }

  inicioPasoEmote = ahora;

  aplicarPasoEmote();
}

void terminarEmote() {
  parar();

  modoRobot = MANUAL;

  nombreEmote = NULL;
  pasosEmote = NULL;

  cantidadPasosEmote = 0;
  pasoEmote = 0;

  manualMoviendo = false;

  ultimoComando = millis();
}

// Busca un emote por nombre. Devuelve -1 si no existe.
int buscarEmote(const String &nombre) {
  for (byte i = 0; i < CANTIDAD_EMOTES; i++) {
    if (nombre.equals(EMOTES[i].nombre)) {
      return i;
    }
  }

  return -1;
}

void controlarLinea(unsigned long ahora) {
  switch (estadoRobot) {
    case SIGUIENDO:
      seguirLinea(ahora);
      break;

    case GIRANDO_IZQUIERDA:
      controlarGiro(-1, ahora);
      break;

    case GIRANDO_DERECHA:
      controlarGiro(1, ahora);
      break;

    case SOBREGIRANDO:
      controlarSobregiro(ahora);
      break;

    case SALIENDO_GIRO:
      controlarSalida(ahora);
      break;
  }
}

void leerSensores() {
  valorSensorIzq = analogRead(SENSOR_IZQ);
  valorSensorDer = analogRead(SENSOR_DER);

  lineaIzq = actualizarSensor(valorSensorIzq, estadoAnteriorIzq);
  lineaDer = actualizarSensor(valorSensorDer, estadoAnteriorDer);

  estadoAnteriorIzq = lineaIzq;
  estadoAnteriorDer = lineaDer;
}

bool actualizarSensor(int valor, bool estadoAnterior) {
#if NEGRO_ALTO

  if (estadoAnterior) {
    return valor > UMBRAL - HISTERESIS;
  }

  return valor > UMBRAL + HISTERESIS;

#else

  if (estadoAnterior) {
    return valor < UMBRAL + HISTERESIS;
  }

  return valor < UMBRAL - HISTERESIS;

#endif
}

void seguirLinea(unsigned long ahora) {
  // Ningún sensor detecta negro:
  // el robot está centrado entre las líneas.
  if (!lineaIzq && !lineaDer) {
    cancelarCandidato();

    subirVelocidad();
    adelante(velocidadActual);

    return;
  }

  // Ambos sensores detectan negro.
  // Puede ser una intersección o una línea muy ancha.
  if (lineaIzq && lineaDer) {
    cancelarCandidato();

    velocidadActual = VEL_MIN;
    adelante(VEL_MIN);

    return;
  }

  // Solo el sensor izquierdo detecta línea.
  if (lineaIzq && !lineaDer) {
    bajarVelocidad();

    actualizarCandidato(-1, ahora);

    if (ahora - inicioCandidato >= TIEMPO_CONFIRMAR_GIRO) {
      comenzarGiro(-1, ahora);
    }
    else {
      corregirIzquierda();
    }

    return;
  }

  // Solo el sensor derecho detecta línea.
  if (!lineaIzq && lineaDer) {
    bajarVelocidad();

    actualizarCandidato(1, ahora);

    if (ahora - inicioCandidato >= TIEMPO_CONFIRMAR_GIRO) {
      comenzarGiro(1, ahora);
    }
    else {
      corregirDerecha();
    }
  }
}

void actualizarCandidato(int direccion, unsigned long ahora) {
  if (candidatoGiro != direccion) {
    candidatoGiro = direccion;
    inicioCandidato = ahora;
  }
}

void cancelarCandidato() {
  candidatoGiro = 0;
  inicioCandidato = 0;
}

void comenzarGiro(int direccion, unsigned long ahora) {
  if (direccion < 0) {
    estadoRobot = GIRANDO_IZQUIERDA;
  }
  else {
    estadoRobot = GIRANDO_DERECHA;
  }

  direccionGiroActual = direccion;

  faseGiro = ARCO_INICIAL;

  inicioGiro = ahora;
  inicioSensorObjetivo = 0;

  velocidadActual = VEL_MIN;

  cancelarCandidato();
}

void controlarGiro(int direccion, unsigned long ahora) {
  unsigned long tiempoGiro = ahora - inicioGiro;

  bool sensorObjetivo;

  // En un giro izquierdo, esperamos que el sensor derecho
  // vuelva a encontrar la línea.
  if (direccion < 0) {
    sensorObjetivo = lineaDer;
  }
  else {
    sensorObjetivo = lineaIzq;
  }

  // Confirmación de que el sensor objetivo realmente encontró la línea.
  if (tiempoGiro >= TIEMPO_MIN_GIRO && sensorObjetivo) {
    if (inicioSensorObjetivo == 0) {
      inicioSensorObjetivo = ahora;
    }

    if (ahora - inicioSensorObjetivo >= TIEMPO_SENSOR_OBJETIVO) {
      comenzarSobregiro(direccion, ahora);
      return;
    }
  }
  else {
    inicioSensorObjetivo = 0;
  }

  // Primera parte del giro: arco cerrado.
  if (faseGiro == ARCO_INICIAL) {
    giroEnArco(direccion);

    if (tiempoGiro >= TIEMPO_ARCO_INICIAL) {
      faseGiro = PIVOTE_FINAL;
    }
  }
  else {
    // Si todavía no encontró la línea,
    // termina girando sobre su propio eje.
    pivotar(direccion, VEL_PIVOTE);
  }

  // Seguridad por si nunca encuentra la línea.
  if (tiempoGiro >= TIEMPO_MAX_GIRO) {
    parar();

    estadoRobot = SIGUIENDO;
    velocidadActual = VEL_MIN;

    cancelarCandidato();
  }
}

void comenzarSobregiro(int direccion, unsigned long ahora) {
  direccionGiroActual = direccion;

  inicioSobregiro = ahora;
  inicioSensorObjetivo = 0;

  estadoRobot = SOBREGIRANDO;
}

void controlarSobregiro(unsigned long ahora) {
  pivotar(direccionGiroActual, VEL_PIVOTE_FINAL);

  if (ahora - inicioSobregiro >= TIEMPO_SOBREGIRO) {
    parar();

    velocidadActual = VEL_MIN;

#if TIEMPO_SALIDA > 0

    estadoRobot = SALIENDO_GIRO;
    inicioSalida = ahora;

#else

    estadoRobot = SIGUIENDO;

#endif
  }
}

void giroEnArco(int direccion) {
  if (direccion < 0) {
    moverMotores(
      VEL_ARCO_INTERIOR,
      VEL_ARCO_EXTERIOR
    );
  }
  else {
    moverMotores(
      VEL_ARCO_EXTERIOR,
      VEL_ARCO_INTERIOR
    );
  }
}

void pivotar(int direccion, int velocidad) {
  if (direccion < 0) {
    moverMotores(
      -velocidad,
      velocidad
    );
  }
  else {
    moverMotores(
      velocidad,
      -velocidad
    );
  }
}

void controlarSalida(unsigned long ahora) {
  adelante(VEL_SALIDA);

  if (ahora - inicioSalida >= TIEMPO_SALIDA) {
    estadoRobot = SIGUIENDO;

    velocidadActual = VEL_MIN;

    cancelarCandidato();
  }
}

void corregirIzquierda() {
  int motorIzq = velocidadActual - DIFERENCIAL_CORRECCION;

  int motorDer = velocidadActual + DIFERENCIAL_CORRECCION;

  // La rueda interior puede bajar de 90.
  motorIzq = constrain(
    motorIzq,
    VEL_MIN_CORRECCION,
    255
  );

  motorDer = constrain(
    motorDer,
    0,
    255
  );

  moverMotores(
    motorIzq,
    motorDer
  );
}

void corregirDerecha() {
  int motorIzq = velocidadActual + DIFERENCIAL_CORRECCION;

  int motorDer = velocidadActual - DIFERENCIAL_CORRECCION;

  motorIzq = constrain(
    motorIzq,
    0,
    255
  );

  // La rueda interior puede bajar de 90.
  motorDer = constrain(
    motorDer,
    VEL_MIN_CORRECCION,
    255
  );

  moverMotores(
    motorIzq,
    motorDer
  );
}

void subirVelocidad() {
  velocidadActual += RAMPA_SUBIDA;

  if (velocidadActual > VEL_MAX) {
    velocidadActual = VEL_MAX;
  }
}

void bajarVelocidad() {
  velocidadActual -= RAMPA_BAJADA;

  if (velocidadActual < VEL_MIN) {
    velocidadActual = VEL_MIN;
  }
}

void controlarObstaculos(unsigned long ahora) {
  leerDistancias(ahora);

  // leerDistancias() puede bloquear por pulseIn()/delays. Los timers de
  // retroceso y esquive deben compararse contra el tiempo real posterior.
  ahora = millis();

  // Sin una lectura frontal válida no se asume que el camino esté libre.
  if (!sonarFrenteValido) {
    parar();
    return;
  }

  switch (faseObstaculo) {
    case AVANZANDO:
      avanzarLibre(ahora);
      break;

    case CORRIGIENDO_IZQUIERDA:
      corregirObstaculo(-1, ahora);
      break;

    case CORRIGIENDO_DERECHA:
      corregirObstaculo(1, ahora);
      break;

    case ESQUIVANDO_IZQUIERDA:
      controlarEsquive(-1, ahora);
      break;

    case ESQUIVANDO_DERECHA:
      controlarEsquive(1, ahora);
      break;

    case RETROCEDIENDO:
      controlarRetroceso(ahora);
      break;
  }
}

// Corrección lateral: pivota hasta despejar el costado que molestaba.
void corregirObstaculo(int direccion, unsigned long ahora) {
  // Antes que nada: si apareció algo encima del frente, hay que retroceder.
  // Sin esta salida, la corrección seguía pivotando contra la pared.
  if (distancia <= DISTANCIA_OBSTACULO) {
    comenzarRetroceso(ahora);

    return;
  }

  pivotar(direccion, VEL_OBSTACULO_GIRO);

  float distanciaLado;

  // Pivotando a la izquierda se está despejando el lado derecho.
  bool ladoValido;

  if (direccion < 0) {
    distanciaLado = distanciaDer;
    ladoValido = sonarDerValido;
  }
  else {
    distanciaLado = distanciaIzq;
    ladoValido = sonarIzqValido;
  }

  if (!ladoValido) {
    parar();
    return;
  }

  if (distanciaLado > DISTANCIA_PRECAUCION && distancia > DISTANCIA_PRECAUCION) {
    faseObstaculo = AVANZANDO;
  }
}

void leerDistancias(unsigned long ahora) {
  if (ultimaLectura != 0 && ahora - ultimaLectura < TIEMPO_LECTURA_SONAR) {
    return;
  }

  medirTodo();
}

// Lee los tres ultrasónicos. En el peor caso puede bloquear unos 44 ms
// (3 timeouts de 8 ms + 2 pausas de 10 ms).
void medirTodo() {
  // Se leen espaciados para que un eco no contamine al otro.
  distancia = medirDistancia(TRIG, ECHO, sonarFrenteValido);
  delay(10);

  distanciaIzq = medirDistancia(TRIG_IZQ, ECHO_IZQ, sonarIzqValido);
  delay(10);

  distanciaDer = medirDistancia(TRIG_DER, ECHO_DER, sonarDerValido);

  selloSonar = millis();
  ultimaLectura = selloSonar;
}

float medirDistancia(int trig, int echo, bool &valido) {
  digitalWrite(trig, LOW);
  delayMicroseconds(2);

  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  unsigned long duracion = pulseIn(echo, HIGH, SONAR_TIMEOUT);

  if (duracion == 0) {
    valido = false;
    return DISTANCIA_INVALIDA;
  }

  valido = true;
  return duracion / SONAR_DIVISOR;
}

void avanzarLibre(unsigned long ahora) {
  // Primero se decide y después se manda potencia.
  // Al revés, el auto arrancaba para adelante durante toda la vuelta del loop
  // (y el sonar se lleva unos 40 ms) antes de empezar a retroceder.

  // Obstáculo encima: no alcanza con girar, hay que retroceder.
  if (distancia <= DISTANCIA_OBSTACULO) {
    comenzarRetroceso(ahora);

    controlarRetroceso(ahora);

    return;
  }

  // Obstáculo al frente: solo se elige un lado usando lecturas válidas.
  if (distancia < DISTANCIA_PRECAUCION) {
    if (sonarIzqValido && sonarDerValido) {
      if (distanciaIzq > distanciaDer) {
        comenzarEsquive(-1, ahora);
      }
      else {
        comenzarEsquive(1, ahora);
      }
    }
    else if (sonarIzqValido) {
      comenzarEsquive(-1, ahora);
    }
    else if (sonarDerValido) {
      comenzarEsquive(1, ahora);
    }
    else {
      parar();
    }

    return;
  }

  // Obstáculo solo a un costado: alcanza con una corrección. Una lectura
  // lateral inválida no se interpreta como espacio libre.
  if (sonarIzqValido && distanciaIzq < DISTANCIA_PRECAUCION) {
    faseObstaculo = CORRIGIENDO_DERECHA;

    return;
  }

  if (sonarDerValido && distanciaDer < DISTANCIA_PRECAUCION) {
    faseObstaculo = CORRIGIENDO_IZQUIERDA;

    return;
  }

  adelante(VEL_OBSTACULO_AVANCE);
}

void comenzarEsquive(int direccion, unsigned long ahora) {
  if (direccion < 0) {
    faseObstaculo = ESQUIVANDO_IZQUIERDA;
  }
  else {
    faseObstaculo = ESQUIVANDO_DERECHA;
  }

  direccionGiroActual = direccion;

  inicioEsquive = ahora;
}

void controlarEsquive(int direccion, unsigned long ahora) {
  pivotar(direccion, VEL_OBSTACULO_GIRO);

  float distanciaLado;

  bool ladoValido;

  if (direccion < 0) {
    distanciaLado = distanciaIzq;
    ladoValido = sonarIzqValido;
  }
  else {
    distanciaLado = distanciaDer;
    ladoValido = sonarDerValido;
  }

  if (!ladoValido) {
    parar();
    return;
  }

  // Encontró salida: el frente y el lado hacia el que gira están libres.
  if (distancia > DISTANCIA_PRECAUCION && distanciaLado > DISTANCIA_PRECAUCION) {
    faseObstaculo = AVANZANDO;

    return;
  }

  if (ahora - inicioEsquive < TIEMPO_GIRO_ESTRATEGICO) {
    return;
  }

  // Se acabó el tiempo de giro y sigue trabado.
  // Antes probaba para el otro lado reiniciando el reloj, así que un auto
  // encajonado quedaba rebotando entre los dos lados para siempre.
  // Retroceder saca al auto del rincón antes de volver a elegir.
  if (distancia <= DISTANCIA_OBSTACULO) {
    comenzarRetroceso(ahora);

    return;
  }

  faseObstaculo = AVANZANDO;
}

void comenzarRetroceso(unsigned long ahora) {
  faseObstaculo = RETROCEDIENDO;

  inicioRetroceso = ahora;
}

void controlarRetroceso(unsigned long ahora) {
  adelante(-VEL_OBSTACULO_RETROCESO);

  if (ahora - inicioRetroceso < TIEMPO_RETROCESO) {
    return;
  }

  // Después de retroceder, gira hacia donde haya más espacio, pero nunca
  // toma una lectura inválida como si fuese un lateral despejado.
  if (sonarIzqValido && sonarDerValido) {
    if (distanciaIzq > distanciaDer) {
      comenzarEsquive(-1, ahora);
    }
    else {
      comenzarEsquive(1, ahora);
    }
  }
  else if (sonarIzqValido) {
    comenzarEsquive(-1, ahora);
  }
  else if (sonarDerValido) {
    comenzarEsquive(1, ahora);
  }
  else {
    parar();
    faseObstaculo = AVANZANDO;
  }
}

void adelante(int velocidad) {
  moverMotores(
    velocidad,
    velocidad
  );
}

void moverMotores(int velocidadIzq, int velocidadDer) {
  velocidadIzq = constrain(
    velocidadIzq,
    -255,
    255
  );

  velocidadDer = constrain(
    velocidadDer,
    -255,
    255
  );

  velocidadDer = velocidadDer * 0.85;

  // Se guardan para los LEDs y para la telemetría.
  comandoIzq = velocidadIzq;
  comandoDer = velocidadDer;

  controlarMotor(
    IN2, // In 1
    IN1, // In 2
    velocidadIzq
  );

  controlarMotor(
    IN4,// In 3
    IN3, // In 4
    velocidadDer
  );
}

void controlarMotor(
  int pinAdelante,
  int pinAtras,
  int velocidad
) {
  if (velocidad > 0) {
    analogWrite(pinAdelante, velocidad);
    analogWrite(pinAtras, 0);
  }
  else if (velocidad < 0) {
    analogWrite(pinAdelante, 0);
    analogWrite(pinAtras, -velocidad);
  }
  else {
    analogWrite(pinAdelante, 0);
    analogWrite(pinAtras, 0);
  }
}

void parar() {
  moverMotores(0, 0);
}

void actualizarLeds(unsigned long ahora) {
#if USAR_LEDS

  if (ahora - ultimoBlink >= TIEMPO_BLINK) {
    ultimoBlink = ahora;

    estadoBlink = !estadoBlink;
  }

  bool retrocediendo = comandoIzq < 0 && comandoDer < 0;

  // Gira cuando un lado empuja bastante más que el otro.
  bool giroIzquierda = (comandoDer - comandoIzq) > 30;
  bool giroDerecha = (comandoIzq - comandoDer) > 30;

  digitalWrite(LED_GIRO_IZQ, giroIzquierda && estadoBlink ? HIGH : LOW);
  digitalWrite(LED_GIRO_DER, giroDerecha && estadoBlink ? HIGH : LOW);
  digitalWrite(LED_TRASERO, retrocediendo ? HIGH : LOW);

#endif
}

void iniciarRed() {
  // Un módulo con firmware viejo falla de forma silenciosa: conviene saberlo.
  String version = WiFi.firmwareVersion();

  if (version < WIFI_FIRMWARE_LATEST_VERSION) {
    Serial.print("Firmware del modulo WiFi: ");
    Serial.print(version);
    Serial.print(" (conviene actualizar a ");
    Serial.print(WIFI_FIRMWARE_LATEST_VERSION);
    Serial.println(")");
  }

  Serial.print("Creando la red: ");
  Serial.println(ssid);

  int estadoWifi = WiFi.beginAP(ssid, pass);

  // Sin red no hay forma de frenar el auto a distancia.
  if (estadoWifi != WL_AP_LISTENING) {
    Serial.println("Error: no se pudo crear la red.");

    while (true) {
      parar();
      delay(100);
    }
  }

  // WL_AP_LISTENING dice que el pedido se aceptó, no que el AP ya esté arriba.
  // Sin esta espera, server.begin() puede quedar sin socket: el sketch corre
  // normal (los LEDs parpadean) y no contesta un solo pedido.
  delay(ESPERA_AP);

  server.begin();

  Serial.print("Panel de control: http://");
  Serial.println(WiFi.localIP());
}

void atenderCliente() {
  // Se toma un cliente nuevo solo si no hay uno a medio leer.
  if (!clienteActual) {
    clienteActual = server.available();

    if (!clienteActual) {
      return;
    }

    lineaPedido = "";
    inicioCliente = millis();
  }

  // Se lee lo que haya llegado y se vuelve al loop.
  // El pedido se arma entre varias vueltas en vez de bloquear esperándolo.
  while (clienteActual.available()) {
    char c = clienteActual.read();

    if (c == '\n') {
      // Solo interesa la primera línea del pedido.
      if (lineaPedido.length() > 0) {
        procesarPedido(lineaPedido, clienteActual);

        cerrarCliente();

        return;
      }
    }
    else if (c != '\r' && lineaPedido.length() < LARGO_MAX_PEDIDO) {
      lineaPedido += c;
    }
  }

  // Se cortó la conexión o el pedido nunca llegó entero.
  if (!clienteActual.connected() || millis() - inicioCliente >= TIEMPO_CLIENTE) {
    if (clienteActual.connected()) {
      responderError(clienteActual, "pedido vacio");
    }

    cerrarCliente();
  }
}

void cerrarCliente() {
  // Se descarta el resto del pedido (los encabezados que no se leyeron):
  // cerrar con datos sin leer puede terminar en un RST y llevarse la
  // respuesta que el navegador todavía no alcanzó a leer.
  while (clienteActual.available()) {
    clienteActual.read();
  }

  clienteActual.flush();

  // Le da al módulo un respiro para terminar de mandar antes de cerrar.
  delay(1);

  clienteActual.stop();

  clienteActual = WiFiClient();

  lineaPedido = "";
  inicioCliente = 0;
}

// Los comandos de movimiento son los únicos que exigen estar en manual.
bool esComandoManual(const String &pedido) {
  return pedido.indexOf("GET /mov") != -1
    || pedido.indexOf("GET /rueda") != -1
    || pedido.indexOf("GET /vel") != -1
    || pedido.indexOf("GET /freno") != -1
    || pedido.indexOf("GET /pulso") != -1
    || pedido.indexOf("GET /?") != -1;
}

void procesarPedido(const String &pedido, WiFiClient &client) {
  // ---- Modos ----

  if (pedido.indexOf("GET /manual") != -1) {
    cambiarModo(MANUAL);

    responderEstado(client);

    return;
  }

  if (pedido.indexOf("GET /linea") != -1) {
    cambiarModo(LINEA);

    responderEstado(client);

    return;
  }

  if (pedido.indexOf("GET /obstaculo") != -1) {
    cambiarModo(OBSTACULOS);

    responderEstado(client);

    return;
  }

  if (pedido.indexOf("GET /parar") != -1) {
    cambiarModo(MANUAL);

    responderEstado(client);

    return;
  }

  // ---- Telemetría ----

  if (pedido.indexOf("GET /estado") != -1) {
    responderEstado(client);

    return;
  }

  if (pedido.indexOf("GET /sensores") != -1) {
    responderSensores(client);

    return;
  }

  if (pedido.indexOf("GET /motores") != -1) {
    responderMotores(client);

    return;
  }

  // Fuerza una lectura de los tres ultrasónicos en cualquier modo.
  if (pedido.indexOf("GET /sonar") != -1) {
    medirTodo();

    responderSensores(client);

    return;
  }

  // ---- Emotes ----

  if (pedido.indexOf("GET /emotes") != -1) {
    responderEmotes(client);

    return;
  }

  if (pedido.indexOf("GET /emote") != -1) {
    int indice = buscarEmote(parametroTexto(pedido, "e", ""));

    if (indice < 0) {
      responderError(client, "emote inexistente");

      return;
    }

    comenzarEmote(EMOTES[indice], millis());

    responderEstado(client);

    return;
  }

  // ---- Panel ----

  // Va antes del control de modo: el panel se tiene que poder abrir siempre,
  // también con el auto siguiendo una línea o esquivando.
  if (pedido.indexOf("GET / ") != -1) {
    responderPanel(client);

    return;
  }

  // ---- Manual ----

  // Solo bloquea los comandos de movimiento. Antes tapaba también al panel y
  // a la ruta desconocida, así que fuera de manual todo devolvía el mismo error.
  if (esComandoManual(pedido) && modoRobot != MANUAL) {
    responderError(client, "no esta en manual");

    return;
  }

  if (pedido.indexOf("GET /mov") != -1) {
    comandoDireccion(
      parametroLetra(pedido, "d", 'S'),
      parametroEntero(pedido, "v", velocidadManual)
    );

    responderMotores(client);

    return;
  }

  if (pedido.indexOf("GET /rueda") != -1) {
    moverRuedas(
      parametroEntero(pedido, "i", 0),
      parametroEntero(pedido, "d", 0)
    );

    responderMotores(client);

    return;
  }

  if (pedido.indexOf("GET /vel") != -1) {
    velocidadManual = constrain(
      parametroEntero(pedido, "v", velocidadManual),
      0,
      255
    );

    responderMotores(client);

    return;
  }

  if (pedido.indexOf("GET /freno") != -1) {
    moverRuedas(0, 0);

    responderMotores(client);

    return;
  }

  // Movimiento de una sola vez: se mueve un rato y frena solo.
  if (pedido.indexOf("GET /pulso") != -1) {
    int velocidad = constrain(
      parametroEntero(pedido, "v", velocidadManual),
      0,
      255
    );

    unsigned int duracion = constrain(
      parametroEntero(pedido, "t", 300),
      0,
      PULSO_MAX
    );

    armarPulso(
      parametroLetra(pedido, "d", 'S'),
      velocidad,
      duracion
    );

    responderEstado(client);

    return;
  }

  // Joystick de la app: /?X=valor&Y=valor
  if (pedido.indexOf("GET /?") != -1) {
    joystickX = parametroEntero(pedido, "X", joystickX);
    joystickY = parametroEntero(pedido, "Y", joystickY);

    mezclarJoystick(joystickX, joystickY);

    responderMotores(client);

    return;
  }

  responderError(client, "ruta desconocida");
}

// Arma un emote de un solo paso con lo que pide /pulso.
void armarPulso(char direccion, int velocidad, unsigned int duracion) {
  int izquierda = 0;
  int derecha = 0;

  if (direccion == 'F') {
    izquierda = velocidad;
    derecha = velocidad;
  }
  else if (direccion == 'B') {
    izquierda = -velocidad;
    derecha = -velocidad;
  }
  else if (direccion == 'L') {
    izquierda = -velocidad;
    derecha = velocidad;
  }
  else if (direccion == 'R') {
    izquierda = velocidad;
    derecha = -velocidad;
  }

  pasoTemporal[0].izq = izquierda;
  pasoTemporal[0].der = derecha;
  pasoTemporal[0].duracion = duracion;

  Emote pulso = { "pulso", pasoTemporal, 1 };

  comenzarEmote(pulso, millis());
}

int parametroEntero(const String &pedido, const char *nombre, int valorPorDefecto) {
  String valor = parametroTexto(pedido, nombre, "");

  if (valor.length() == 0) {
    return valorPorDefecto;
  }

  return valor.toInt();
}

char parametroLetra(const String &pedido, const char *nombre, char valorPorDefecto) {
  String valor = parametroTexto(pedido, nombre, "");

  if (valor.length() == 0) {
    return valorPorDefecto;
  }

  return valor.charAt(0);
}

String parametroTexto(const String &pedido, const char *nombre, const char *valorPorDefecto) {
  int inicioQuery = pedido.indexOf('?');

  if (inicioQuery == -1) {
    return String(valorPorDefecto);
  }

  String clave = String(nombre) + "=";

  // Se busca a partir del '?' para no confundir la clave
  // con un pedazo del nombre de la ruta.
  int inicio = pedido.indexOf(clave, inicioQuery);

  if (inicio == -1) {
    return String(valorPorDefecto);
  }

  inicio += clave.length();

  // El valor termina en '&' si hay otro parámetro después.
  int fin = pedido.indexOf('&', inicio);

  // Si no, termina en el espacio previo a "HTTP/1.1".
  if (fin == -1) {
    fin = pedido.indexOf(' ', inicio);
  }

  if (fin == -1) {
    fin = pedido.length();
  }

  return pedido.substring(inicio, fin);
}

const char *nombreModo() {
  switch (modoRobot) {
    case MANUAL: return "manual";
    case LINEA: return "linea";
    case OBSTACULOS: return "obstaculo";
    case EMOTE: return "emote";
  }

  return "desconocido";
}

const char *nombreEstadoLinea() {
  switch (estadoRobot) {
    case SIGUIENDO: return "siguiendo";
    case GIRANDO_IZQUIERDA: return "girando_izquierda";
    case GIRANDO_DERECHA: return "girando_derecha";
    case SOBREGIRANDO: return "sobregirando";
    case SALIENDO_GIRO: return "saliendo_giro";
  }

  return "desconocido";
}

const char *nombreFaseGiro() {
  if (faseGiro == ARCO_INICIAL) {
    return "arco_inicial";
  }

  return "pivote_final";
}

const char *nombreFaseObstaculo() {
  switch (faseObstaculo) {
    case AVANZANDO: return "avanzando";
    case CORRIGIENDO_IZQUIERDA: return "corrigiendo_izquierda";
    case CORRIGIENDO_DERECHA: return "corrigiendo_derecha";
    case ESQUIVANDO_IZQUIERDA: return "esquivando_izquierda";
    case ESQUIVANDO_DERECHA: return "esquivando_derecha";
    case RETROCEDIENDO: return "retrocediendo";
  }

  return "desconocido";
}

const char *sentidoMotor(int velocidad) {
  if (velocidad > 0) {
    return "adelante";
  }

  if (velocidad < 0) {
    return "atras";
  }

  return "quieto";
}

void encabezadoJson(WiFiClient &client) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: application/json");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();
}

void responderError(WiFiClient &client, const char *motivo) {
  encabezadoJson(client);

  client.print("{\"ok\":false,\"error\":\"");
  client.print(motivo);
  client.println("\"}");
}

void escribirSensores(WiFiClient &client) {
  client.print("\"linea\":{");

  client.print("\"izq\":{\"crudo\":");
  client.print(valorSensorIzq);
  client.print(",\"negro\":");
  client.print(lineaIzq ? "true" : "false");

  client.print("},\"der\":{\"crudo\":");
  client.print(valorSensorDer);
  client.print(",\"negro\":");
  client.print(lineaDer ? "true" : "false");

  client.print("}},\"sonar\":{\"frente\":");
  client.print(distancia, 1);
  client.print(",\"frenteValido\":");
  client.print(sonarFrenteValido ? "true" : "false");

  client.print(",\"izq\":");
  client.print(distanciaIzq, 1);
  client.print(",\"izqValido\":");
  client.print(sonarIzqValido ? "true" : "false");

  client.print(",\"der\":");
  client.print(distanciaDer, 1);
  client.print(",\"derValido\":");
  client.print(sonarDerValido ? "true" : "false");

  // Hace cuánto se midieron los ultrasónicos.
  client.print(",\"edadMs\":");
  client.print(selloSonar == 0 ? -1 : (long)(millis() - selloSonar));

  client.print("}");
}

void escribirMotores(WiFiClient &client) {
  client.print("\"izq\":{\"pwm\":");
  client.print(comandoIzq);
  client.print(",\"sentido\":\"");
  client.print(sentidoMotor(comandoIzq));

  client.print("\"},\"der\":{\"pwm\":");
  client.print(comandoDer);
  client.print(",\"sentido\":\"");
  client.print(sentidoMotor(comandoDer));

  client.print("\"},\"moviendo\":");
  client.print((comandoIzq != 0 || comandoDer != 0) ? "true" : "false");
}

void responderSensores(WiFiClient &client) {
  encabezadoJson(client);

  client.print("{\"ok\":true,");

  escribirSensores(client);

  client.println("}");
}

void responderMotores(WiFiClient &client) {
  encabezadoJson(client);

  client.print("{\"ok\":true,\"motores\":{");

  escribirMotores(client);

  client.println("}}");
}

void responderEmotes(WiFiClient &client) {
  encabezadoJson(client);

  client.print("{\"ok\":true,\"emotes\":[");

  for (byte i = 0; i < CANTIDAD_EMOTES; i++) {
    if (i > 0) {
      client.print(",");
    }

    client.print("{\"nombre\":\"");
    client.print(EMOTES[i].nombre);

    client.print("\",\"pasos\":");
    client.print(EMOTES[i].cantidad);

    client.print(",\"duracion\":");
    client.print(duracionEmote(EMOTES[i]));

    client.print("}");
  }

  client.println("]}");
}

unsigned long duracionEmote(const Emote &emote) {
  unsigned long total = 0;

  for (byte i = 0; i < emote.cantidad; i++) {
    total += emote.pasos[i].duracion;
  }

  return total;
}

void responderEstado(WiFiClient &client) {
  encabezadoJson(client);

  client.print("{\"ok\":true,\"modo\":\"");
  client.print(nombreModo());

  client.print("\",\"uptime\":");
  client.print(millis());

  // Estado del sigue líneas.
  client.print(",\"linea\":{\"estado\":\"");
  client.print(nombreEstadoLinea());

  client.print("\",\"fase\":\"");
  client.print(nombreFaseGiro());

  client.print("\",\"velocidad\":");
  client.print(velocidadActual);

  client.print(",\"candidato\":");
  client.print(candidatoGiro);

  // Estado del esquiva obstáculos.
  client.print("},\"obstaculos\":{\"fase\":\"");
  client.print(nombreFaseObstaculo());

  client.print("\"},\"manual\":{\"x\":");
  client.print(joystickX);

  client.print(",\"y\":");
  client.print(joystickY);

  client.print(",\"velocidad\":");
  client.print(velocidadManual);

  client.print(",\"desdeComandoMs\":");
  client.print(millis() - ultimoComando);

  // Emote en curso.
  client.print("},\"emote\":{\"activo\":");
  client.print(modoRobot == EMOTE ? "true" : "false");

  client.print(",\"nombre\":\"");
  client.print(nombreEmote == NULL ? "" : nombreEmote);

  client.print("\",\"paso\":");
  client.print(modoRobot == EMOTE ? pasoEmote + 1 : 0);

  client.print(",\"pasos\":");
  client.print(cantidadPasosEmote);

  client.print("},\"sensores\":{");

  escribirSensores(client);

  client.print("},\"motores\":{");

  escribirMotores(client);

  client.println("}}");
}

void responderPanel(WiFiClient &client) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/html; charset=utf-8");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();

  // El panel se manda en pedazos de menos de 1 KB. El módulo WiFi no garantiza
  // una escritura suelta de varios kilobytes y una página cortada a la mitad no
  // se ve distinta de un servidor caído.

  client.print(F(
    "<!DOCTYPE html><html lang=es><head>"
    "<meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1,user-scalable=no'>"
    "<title>Au_Tito</title><style>"
    "*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}"
    "body{margin:0;padding:18px;background:#14161a;color:#e8e6e1;"
    "font-family:ui-monospace,Menlo,Consolas,monospace;text-align:center}"
    "h1{font-size:15px;letter-spacing:.28em;text-transform:uppercase;"
    "font-weight:400;color:#8a8f98;margin:0 0 16px}"
    ".fila{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:18px}"
  ));

  client.print(F(
    ".m{padding:14px 4px;border:1px solid #2c3037;background:#1b1e24;color:#e8e6e1;"
    "border-radius:10px;font:inherit;font-size:12px;letter-spacing:.08em}"
    ".m.on{background:#c4f000;border-color:#c4f000;color:#14161a}"
    ".pad{display:grid;grid-template-columns:repeat(3,86px);grid-auto-rows:86px;"
    "gap:10px;justify-content:center}"
    ".b{border:1px solid #2c3037;background:#1b1e24;color:#e8e6e1;border-radius:14px;"
    "font:inherit;font-size:26px}"
    ".b:active{background:#c4f000;color:#14161a}"
    ".b.stop{color:#ff5c46;font-size:14px;letter-spacing:.1em}"
  ));

  client.print(F(
    ".emotes{display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-top:20px}"
    ".e{padding:10px 14px;border:1px solid #2c3037;background:#1b1e24;color:#e8e6e1;"
    "border-radius:999px;font:inherit;font-size:12px}"
    ".e:active{background:#c4f000;color:#14161a}"
    "#tel{margin-top:20px;font-size:11px;color:#8a8f98;line-height:1.7;text-align:left;"
    "max-width:300px;margin-left:auto;margin-right:auto;white-space:pre-wrap}"
    "</style></head><body>"
    "<h1>Au_Tito</h1>"
  ));

  client.print(F(
    "<div class=fila>"
    "<button class=m id=mmanual onclick=\"modo('manual')\">MANUAL</button>"
    "<button class=m id=mlinea onclick=\"modo('linea')\">LINEA</button>"
    "<button class=m id=mobstaculo onclick=\"modo('obstaculo')\">ESQUIVA</button>"
    "</div>"
    "<div class=pad>"
    "<div></div><button class=b data-d=F>&#9650;</button><div></div>"
    "<button class=b data-d=L>&#9664;</button>"
    "<button class='b stop' data-d=S>STOP</button>"
    "<button class=b data-d=R>&#9654;</button>"
    "<div></div><button class=b data-d=B>&#9660;</button><div></div>"
    "</div>"
    "<div class=emotes id=emotes></div>"
    "<div id=tel>conectando...</div>"
  ));

  client.print(F(
    "<script>"
    "var t=null;"
    "function pedir(u){return fetch(u).catch(function(){});}"
    "function modo(m){pedir('/'+m);}"
    // Mientras el botón esté apretado se repite el comando.
    // Si se corta el WiFi, el auto frena solo por el timeout del Arduino.
    "function mantener(d){pedir('/mov?d='+d);"
    "clearInterval(t);t=setInterval(function(){pedir('/mov?d='+d);},200);}"
    "function soltar(){clearInterval(t);t=null;pedir('/freno');}"
    "function pararTodo(){clearInterval(t);t=null;pedir('/parar');}"
    "var bs=document.querySelectorAll('.b');"
    "for(var i=0;i<bs.length;i++){(function(b){"
    "var d=b.getAttribute('data-d');"
    "if(d=='S'){b.addEventListener('pointerdown',function(e){e.preventDefault();pararTodo();});return;}"
    "b.addEventListener('pointerdown',function(e){e.preventDefault();mantener(d);});"
    "b.addEventListener('pointerup',soltar);"
    "b.addEventListener('pointerleave',soltar);"
    "b.addEventListener('pointercancel',soltar);"
    "})(bs[i]);}"
  ));

  client.print(F(
    "fetch('/emotes').then(function(r){return r.json();}).then(function(j){"
    "var c=document.getElementById('emotes');"
    "j.emotes.forEach(function(em){var b=document.createElement('button');"
    "b.className='e';b.textContent=em.nombre;"
    "b.onclick=function(){pedir('/emote?e='+em.nombre);};c.appendChild(b);});});"
    "function pintar(j){"
    "['manual','linea','obstaculo'].forEach(function(m){"
    "document.getElementById('m'+m).className='m'+(j.modo==m?' on':'');});"
    "var s=j.sensores,mo=j.motores;"
    "document.getElementById('tel').textContent="
    "'modo      '+j.modo+(j.emote.activo?' ('+j.emote.nombre+' '+j.emote.paso+'/'+j.emote.pasos+')':'')+'\\n'+"
    "'linea     '+j.linea.estado+' vel '+j.linea.velocidad+'\\n'+"
    "'esquiva   '+j.obstaculos.fase+'\\n'+"
    "'ir        '+s.linea.izq.crudo+(s.linea.izq.negro?' NEGRO':' blanco')+'\\n'+"
    "'dr        '+s.linea.der.crudo+(s.linea.der.negro?' NEGRO':' blanco')+'\\n'+"
    "'sonar     F'+s.sonar.frente+' I'+s.sonar.izq+' D'+s.sonar.der+'\\n'+"
    "'motores   izq '+mo.izq.pwm+' / der '+mo.der.pwm;}"
    "setInterval(function(){fetch('/estado').then(function(r){return r.json();})"
    ".then(pintar).catch(function(){});},500);"
    "</script></body></html>"
  ));
}

void mostrarDatos(unsigned long ahora) {
  if (ahora - ultimoReporte < 100) {
    return;
  }

  ultimoReporte = ahora;

  // Sin monitor abierto, escribir por USB puede llegar a bloquear el loop.
  if (!Serial) {
    return;
  }

  Serial.print("MODO:");
  Serial.print(nombreModo());

  if (modoRobot == LINEA) {
    Serial.print(" IZQ:");
    Serial.print(lineaIzq);

    Serial.print(" DER:");
    Serial.print(lineaDer);

    Serial.print(" ESTADO:");
    Serial.print(estadoRobot);

    Serial.print(" FASE:");
    Serial.print(faseGiro);

    Serial.print(" VEL:");
    Serial.println(velocidadActual);

    return;
  }

  if (modoRobot == OBSTACULOS) {
    Serial.print(" FASE:");
    Serial.print(faseObstaculo);

    Serial.print(" F:");
    Serial.print(distancia);

    Serial.print(" I:");
    Serial.print(distanciaIzq);

    Serial.print(" D:");
    Serial.println(distanciaDer);

    return;
  }

  if (modoRobot == EMOTE) {
    Serial.print(" EMOTE:");
    Serial.print(nombreEmote);

    Serial.print(" PASO:");
    Serial.print(pasoEmote + 1);

    Serial.print("/");
    Serial.println(cantidadPasosEmote);

    return;
  }

  Serial.print(" MIZQ:");
  Serial.print(comandoIzq);

  Serial.print(" MDER:");
  Serial.println(comandoDer);
}
