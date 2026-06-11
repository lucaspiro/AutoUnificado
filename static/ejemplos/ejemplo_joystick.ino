// VALLE - ZABALZA 4ET
// Variante del sketch final: control manual por WiFi y modo automatico esquiva obstaculos.
// En esta version el PWM se aplica directamente sobre el pin IN activo del L298N.

// Libreria oficial para usar WiFi en Arduino UNO R4 WiFi.
#include <WiFiS3.h>

// -------------------------
// Pines de sensores
// -------------------------

// Sensores ultrasonicos.
#define TRIG 9       // Pin que envia el pulso del sensor frontal.
#define ECHO 8       // Pin que recibe el eco del sensor frontal.
#define TRIG_IZQ 7   // Pin trigger del sensor izquierdo.
#define ECHO_IZQ 4   // Pin echo del sensor izquierdo.
#define TRIG_DER 12  // Pin trigger del sensor derecho.
#define ECHO_DER 13  // Pin echo del sensor derecho.

// -------------------------
// Pines de motores
// -------------------------

// Motor izquierdo conectado al L298N.
#define IN1 6  // Entrada IN1 del L298N para el motor izquierdo.
#define IN2 5  // Entrada IN2 del L298N para el motor izquierdo.

// Motor derecho conectado al L298N.
#define IN3 10  // Entrada IN3 del L298N para el motor derecho.
#define IN4 11  // Entrada IN4 del L298N para el motor derecho.

// -------------------------
// Pines de LEDs
// -------------------------

// En Arduino los pines analogicos tambien pueden usarse como pines digitales.
// Se usan A0, A1 y A2 porque los pines digitales principales ya estan ocupados.
#define LED_TRASERO A3   // LED blanco de retroceso.
#define LED_GIRO_IZQ A4  // LED amarillo de giro hacia la izquierda.
#define LED_GIRO_DER A5  // LED amarillo de giro hacia la derecha.

// -------------------------
// Constantes generales
// -------------------------

// Divisor aproximado para convertir microsegundos del ultrasonico a centimetros.
#define SONAR_DIVISOR 58.0

// Tiempo maximo de espera de pulseIn(). 18000 us equivale aprox. a 3 m.
#define SONAR_TIMEOUT 8000UL

// Velocidad del monitor serial.
#define VELOCIDAD_SERIAL 9600

// Constante conservada del sketch original, por si se necesita como tiempo base.
#define TIEMPO_ESPERA 100

// -------------------------
// Constantes del control manual
// -------------------------

// PWM minimo efectivo para que el motor empiece a moverse.
#define PWM_MIN 80

// PWM maximo limitado para no exigir el motor al 100%.
#define PWM_MAX 200

// La app envia valores de joystick entre -127 y 127 aproximadamente.
#define JOY_MAX 127

// Zona muerta muy chica para evitar vibraciones cuando el joystick queda casi centrado.
#define JOY_DEADZONE 4

// -------------------------
// Constantes del modo automatico
// -------------------------

// Distancia frontal en cm a partir de la cual se considera obstaculo cercano.
#define DISTANCIA_OBSTACULO 18

// Distancia frontal en cm donde el auto empieza a corregir antes de chocar.
#define DISTANCIA_PRECAUCION 30

// Distancia usada cuando el ultrasonico no detecta eco.
#define DISTANCIA_LIBRE 250

// Intervalo minimo entre lecturas de sensores en modo automatico.
#define AUTO_INTERVALO_LECTURA 80UL

// Tiempo que retrocede luego de encontrar un obstaculo frontal.
#define AUTO_TIEMPO_RETROCESO 250UL

// Tiempo que gira despues de retroceder.
#define AUTO_TIEMPO_GIRO 380UL

// Velocidad de avance en modo automatico.
#define AUTO_VELOCIDAD_AVANCE 150

// Velocidad de giro en modo automatico.
#define AUTO_VELOCIDAD_GIRO 75

// Velocidad de retroceso en modo automatico.
#define AUTO_VELOCIDAD_RETROCESO 70

// Intervalo de parpadeo de los LEDs de giro.
#define LED_INTERVALO_BLINK 250UL

// -------------------------
// Variables de sensores
// -------------------------

// Distancia medida por el sensor frontal.
float distancia = DISTANCIA_LIBRE;

// Distancia medida por el sensor lateral izquierdo.
float distanciaIzq = DISTANCIA_LIBRE;

// Distancia medida por el sensor lateral derecho.
float distanciaDer = DISTANCIA_LIBRE;

// Clasificacion general de una distancia medida.
enum Distancia {
  CERCA,          // Objeto muy cerca.
  MEDIO,          // Objeto a distancia media.
  LEJOS,          // Objeto lejos pero todavia detectado.
  FUERA_DE_RANGO  // Sin objeto util o fuera del rango elegido.
};

// Modos principales del auto.
enum ModoControl {
  MODO_MANUAL,     // Controlado por joystick desde la app.
  MODO_AUTOMATICO  // Esquiva obstaculos usando los sensores.
};

// Fases internas del modo automatico.
enum FaseAuto {
  AUTO_AVANZA,           // El auto avanza mientras el camino esta libre.
  AUTO_GIRA_DERECHA,     // Corrige hacia la derecha por obstaculo lateral izquierdo.
  AUTO_GIRA_IZQUIERDA,   // Corrige hacia la izquierda por obstaculo lateral derecho.
  AUTO_GIRA_ESTRAT_IZQ,  // Giro estrategico hacia la izquierda por obstaculo frontal.
  AUTO_GIRA_ESTRAT_DER,  // Giro estrategico hacia la derecha por obstaculo frontal.
  AUTO_RETROCEDE         // El auto retrocede por un tiempo corto.
};

// Estado clasificado de la distancia frontal.
Distancia estado = FUERA_DE_RANGO;

// Modo activo al iniciar: manual.
ModoControl modoActual = MODO_MANUAL;

// Fase inicial del modo automatico.
FaseAuto faseAuto = AUTO_AVANZA;

// Ultima vez que se leyeron sensores en automatico.
unsigned long ultimaLecturaAuto = 0;

// Momento en el que termina la fase actual de retroceso o giro.
unsigned long finFaseAuto = 0;

// Ultima vez que cambio el estado de parpadeo de LEDs.
unsigned long ultimoBlinkLed = 0;

// Ultimo valor X recibido desde la app.
int joystickX = 0;

// Ultimo valor Y recibido desde la app.
int joystickY = 0;

// Direccion de giro elegida por el modo automatico: -1 izquierda, 1 derecha.
int direccionGiroAuto = 1;

// Ultimo comando aplicado al motor izquierdo, usado tambien para los LEDs.
int comandoIzq = 0;

// Ultimo comando aplicado al motor derecho, usado tambien para los LEDs.
int comandoDer = 0;

// Estado interno del parpadeo de LEDs.
bool estadoBlinkLed = false;

// Guarda el ultimo estado mostrado por serial para evitar spam.
String ultimoEstadoSerial = "";

// Muestra estados importantes del auto sin repetir mensajes innecesarios.
void imprimirEstado(String estadoNuevo) {
  // Solo imprime si el estado realmente cambio.
  if (estadoNuevo != ultimoEstadoSerial) {
    ultimoEstadoSerial = estadoNuevo;

    Serial.print("[ESTADO] ");
    Serial.println(estadoNuevo);
  }
}

// Nombre de la red WiFi creada por el Arduino en modo AP.
char ssid[] = "Au_Tito";

// Contrasena de la red WiFi creada por el Arduino.
char pass[] = "amcem/mechanics";

// Servidor HTTP en el puerto 80 para recibir ordenes de la app.
WiFiServer server(80);

// Lee un sensor ultrasonico y devuelve la distancia en centimetros.
float getDistance(int trig, int echo) {
  // Asegura que el trigger empiece apagado.
  digitalWrite(trig, LOW);
  delayMicroseconds(2);

  // Envia el pulso de 10 us que dispara la medicion.
  digitalWrite(trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(trig, LOW);

  // Mide cuanto tarda en volver el eco.
  unsigned long duracion = pulseIn(echo, HIGH, SONAR_TIMEOUT);

  // Si no hubo eco, se interpreta como camino libre.
  if (duracion == 0) {
    return DISTANCIA_LIBRE;
  }

  // Convierte el tiempo medido a centimetros.
  return duracion / SONAR_DIVISOR;
}

// Limita cualquier valor del joystick al rango esperado por la app.
int limitarJoystick(int valor) {
  return constrain(valor, -JOY_MAX, JOY_MAX);
}

// Convierte un comando de joystick a PWM real para el motor.
int pwmDesdeJoystick(int valor) {
  // Solo importa la magnitud para calcular PWM; el signo define direccion.
  int magnitud = abs(valor);

  // Si esta casi en cero, el motor queda detenido.
  if (magnitud <= JOY_DEADZONE) {
    return 0;
  }

  // Evita valores fuera del rango util.
  magnitud = constrain(magnitud, JOY_DEADZONE + 1, JOY_MAX);

  // Mapea proporcionalmente desde el minimo efectivo hasta el maximo permitido.
  return map(magnitud, JOY_DEADZONE + 1, JOY_MAX, PWM_MIN, PWM_MAX);
}

// Controla un motor aplicando PWM directamente sobre el pin IN activo.
// Esta variante sirve si ENA/ENB no estan disponibles o quedan fijos en HIGH.
void controlarMotor(int inA, int inB, int velocidad) {

  velocidad = limitarJoystick(velocidad);

  int pwm = pwmDesdeJoystick(velocidad);

  // Frenado
  if (pwm == 0) {
    analogWrite(inA, 0);
    analogWrite(inB, 0);
    return;
  }

  // Adelante
  if (velocidad > 0) {
    analogWrite(inA, pwm);
    analogWrite(inB, 0);
  }

  // Atras
  else {
    analogWrite(inA, 0);
    analogWrite(inB, pwm);
  }
}

// Mueve el auto con control diferencial: un comando por cada lado.
void moverDiferencial(int izquierda, int derecha) {
  // Guarda los comandos para usarlos tambien en los LEDs de giro y retroceso.
  comandoIzq = limitarJoystick(izquierda);
  comandoDer = limitarJoystick(derecha);

  // Aplica el comando al motor izquierdo.
  controlarMotor(IN1, IN2, izquierda);

  // Aplica el comando al motor derecho.
  controlarMotor(IN3, IN4, derecha);
}

// Detiene ambos motores.
void detenerMotores() {
  imprimirEstado("Motores detenidos");
  moverDiferencial(0, 0);
}

// Convierte las coordenadas X/Y del joystick en velocidades diferenciales.
void controlManual(int x, int y) {
  // Limita X e Y al rango valido.
  x = limitarJoystick(x);
  y = limitarJoystick(y);

  // Mezcla diferencial:
  // Y controla avance/retroceso y X controla giro.
  int izquierda = y + x;
  int derecha = y - x;
  Serial.print("PWM IZQ:");
  Serial.print(pwmDesdeJoystick(izquierda));

  Serial.print(" PWM DER:");
  Serial.println(pwmDesdeJoystick(derecha));
  // Busca el lado con mayor magnitud para saber si hay saturacion.
  int mayor = max(abs(izquierda), abs(derecha));

  // Normaliza sin perder proporcionalidad cuando el joystick llega a una esquina.
  if (mayor > JOY_MAX) {
    izquierda = (long)izquierda * JOY_MAX / mayor;
    derecha = (long)derecha * JOY_MAX / mayor;
  }
  Serial.print("[MANUAL] X:");
  Serial.print(x);
  Serial.print(" Y:");
  Serial.print(y);
  Serial.print(" -> IZQ:");
  Serial.print(izquierda);
  Serial.print(" DER:");
  Serial.println(derecha);
  // Envia los comandos ya calculados a los motores.
  moverDiferencial(izquierda, derecha);
}

// Hace avanzar el auto en modo automatico.
void avanzarAuto(int velocidad) {
  imprimirEstado("Automatico: avanzando");
  moverDiferencial(velocidad, velocidad);
}

// Hace retroceder el auto en modo automatico.
void retrocederAuto(int velocidad) {
  imprimirEstado("Automatico: retrocediendo");
  moverDiferencial(-velocidad, -velocidad);
}

// Hace girar el auto sobre su eje en modo automatico.
void girarAuto(int direccion, int velocidad) {
  // Direccion positiva: giro hacia la derecha.
  if (direccion >= 0) {
    imprimirEstado("Automatico: girando DERECHA");
    moverDiferencial(velocidad, -velocidad);
  }
  // Direccion negativa: giro hacia la izquierda.
  else {
    imprimirEstado("Automatico: girando IZQUIERDA");
    moverDiferencial(-velocidad, velocidad);
  }
}

// Clasifica una distancia en categorias simples.
Distancia clasificarDistancia(float valor) {
  // Menos de 10 cm: obstaculo muy cercano.
  if (valor < 10) {
    return CERCA;
  }

  // Menos de 20 cm: obstaculo cercano.
  if (valor < 20) {
    return MEDIO;
  }

  // Menos de 30 cm: obstaculo lejos pero relevante.
  if (valor < 30) {
    return LEJOS;
  }

  // Si supera 30 cm, para esta logica se toma como libre.
  return FUERA_DE_RANGO;
}

// Ejecuta el modo automatico esquiva obstaculos.
void automatico() {
  unsigned long ahora = millis();

  // Lee sensores solo cada cierto intervalo, pero mantiene activa la maquina de estados.
  if (ultimaLecturaAuto == 0 || ahora - ultimaLecturaAuto >= AUTO_INTERVALO_LECTURA) {
    ultimaLecturaAuto = ahora;

    distancia = getDistance(TRIG, ECHO);
    delay(10);

    distanciaIzq = getDistance(TRIG_IZQ, ECHO_IZQ);
    delay(10);

    distanciaDer = getDistance(TRIG_DER, ECHO_DER);

    estado = clasificarDistancia(distancia);

    Serial.print("F:");
    Serial.print(distancia);
    Serial.print(" I:");
    Serial.print(distanciaIzq);
    Serial.print(" D:");
    Serial.println(distanciaDer);
  }

  switch (faseAuto) {
    case AUTO_AVANZA:
      avanzarAuto(AUTO_VELOCIDAD_AVANCE);

      if (distancia <= DISTANCIA_OBSTACULO) {
        faseAuto = AUTO_RETROCEDE;
        finFaseAuto = ahora + AUTO_TIEMPO_RETROCESO;
      }
      else if (distancia < DISTANCIA_PRECAUCION) {
        if (distanciaIzq > distanciaDer) {
          faseAuto = AUTO_GIRA_ESTRAT_IZQ;
          direccionGiroAuto = -1;
        }
        else {
          faseAuto = AUTO_GIRA_ESTRAT_DER;
          direccionGiroAuto = 1;
        }
        finFaseAuto = ahora + AUTO_TIEMPO_GIRO;
      }
      else if (distanciaIzq < DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_GIRA_DERECHA;
        direccionGiroAuto = 1;
      }
      else if (distanciaDer < DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_GIRA_IZQUIERDA;
        direccionGiroAuto = -1;
      }
      break;

    case AUTO_GIRA_DERECHA:
      girarAuto(1, AUTO_VELOCIDAD_GIRO);

      if (distanciaIzq > DISTANCIA_PRECAUCION && distancia > DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_AVANZA;
      }
      break;

    case AUTO_GIRA_IZQUIERDA:
      girarAuto(-1, AUTO_VELOCIDAD_GIRO);

      if (distanciaDer > DISTANCIA_PRECAUCION && distancia > DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_AVANZA;
      }
      break;

    case AUTO_GIRA_ESTRAT_IZQ:
      girarAuto(-1, AUTO_VELOCIDAD_GIRO);

      if (distancia > DISTANCIA_PRECAUCION && distanciaIzq > DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_AVANZA;
      }
      else if (ahora >= finFaseAuto) {
        if (distancia <= DISTANCIA_OBSTACULO) {
          faseAuto = AUTO_GIRA_ESTRAT_DER;
          direccionGiroAuto = 1;
          finFaseAuto = ahora + AUTO_TIEMPO_GIRO;
        }
        else {
          faseAuto = AUTO_AVANZA;
        }
      }
      break;

    case AUTO_GIRA_ESTRAT_DER:
      girarAuto(1, AUTO_VELOCIDAD_GIRO);

      if (distancia > DISTANCIA_PRECAUCION && distanciaDer > DISTANCIA_PRECAUCION) {
        faseAuto = AUTO_AVANZA;
      }
      else if (ahora >= finFaseAuto) {
        if (distancia <= DISTANCIA_OBSTACULO) {
          faseAuto = AUTO_GIRA_ESTRAT_IZQ;
          direccionGiroAuto = -1;
          finFaseAuto = ahora + AUTO_TIEMPO_GIRO;
        }
        else {
          faseAuto = AUTO_AVANZA;
        }
      }
      break;

    case AUTO_RETROCEDE:
      retrocederAuto(AUTO_VELOCIDAD_RETROCESO);

      if (ahora >= finFaseAuto) {
        if (distanciaIzq > distanciaDer) {
          faseAuto = AUTO_GIRA_ESTRAT_IZQ;
          direccionGiroAuto = -1;
        }
        else {
          faseAuto = AUTO_GIRA_ESTRAT_DER;
          direccionGiroAuto = 1;
        }
        finFaseAuto = ahora + AUTO_TIEMPO_GIRO;
      }

      break;
  }
}

// Controla los LEDs de giro y trasero sin bloquear el programa.
void blinkLeds() {
  // Guarda el tiempo actual.
  unsigned long ahora = millis();

  // Cambia el estado de parpadeo cada LED_INTERVALO_BLINK milisegundos.
  if (ahora - ultimoBlinkLed >= LED_INTERVALO_BLINK) {
    ultimoBlinkLed = ahora;
    estadoBlinkLed = !estadoBlinkLed;
  }

  // Detecta retroceso cuando los dos lados tienen comando negativo.
  bool retrocediendo = comandoIzq < -JOY_DEADZONE && comandoDer < -JOY_DEADZONE;

  // Detecta giro izquierdo cuando el lado derecho empuja mas que el izquierdo.
  bool giroIzquierda = comandoDer - comandoIzq > 20;

  // Detecta giro derecho cuando el lado izquierdo empuja mas que el derecho.
  bool giroDerecha = comandoIzq - comandoDer > 20;

  // Parpadea el LED izquierdo solo si hay giro hacia la izquierda.
  digitalWrite(LED_GIRO_IZQ, giroIzquierda && estadoBlinkLed ? HIGH : LOW);

  // Parpadea el LED derecho solo si hay giro hacia la derecha.
  digitalWrite(LED_GIRO_DER, giroDerecha && estadoBlinkLed ? HIGH : LOW);

  // Enciende fijo el LED trasero cuando el auto retrocede.
  digitalWrite(LED_TRASERO, retrocediendo ? HIGH : LOW);
}

// Extrae un parametro entero desde la primera linea HTTP.
int parametroEntero(String request, const char *nombre, int valorPorDefecto) {
  // Arma la clave que se va a buscar, por ejemplo "X=" o "Y=".
  String clave = String(nombre) + "=";

  // Busca donde empieza el parametro dentro del pedido.
  int inicio = request.indexOf(clave);

  // Si no encuentra el parametro, devuelve el valor anterior.
  if (inicio == -1) {
    return valorPorDefecto;
  }

  // Salta la clave para quedar parado en el numero.
  inicio += clave.length();

  // Busca el final del parametro, que puede ser '&' si hay otro parametro.
  int fin = request.indexOf('&', inicio);

  // Si no hay '&', busca el espacio antes de "HTTP/1.1".
  if (fin == -1) {
    fin = request.indexOf(' ', inicio);
  }

  // Si tampoco hay espacio, usa el final del String.
  if (fin == -1) {
    fin = request.length();
  }

  // Convierte el texto encontrado a entero.
  return request.substring(inicio, fin).toInt();
}

// Procesa la ruta recibida desde la app.
void procesarPedido(String request) {
  // Ruta enviada por la app al entrar en modo manual.
  if (request.indexOf("GET /manual") != -1) {
    Serial.println("Modo manual");
    imprimirEstado("Modo MANUAL activado");
    modoActual = MODO_MANUAL;
    faseAuto = AUTO_AVANZA;
    controlManual(0, 0);
    Serial.println("Modo manual");
    return;
  }

  // Ruta enviada por la app al entrar en modo automatico.
  if (request.indexOf("GET /obstaculo") != -1) {
    Serial.println("Modo automatico");
    imprimirEstado("Modo AUTOMATICO activado");
    modoActual = MODO_AUTOMATICO;
    faseAuto = AUTO_AVANZA;
    ultimaLecturaAuto = 0;
    Serial.println("Modo automatico");
    return;
  }

  // Ruta del joystick: /?X=valor&Y=valor.
  if (request.indexOf("GET /?") != -1) {
    // Actualiza los ultimos valores recibidos.
    joystickY = parametroEntero(request, "X", joystickX);
    joystickX = parametroEntero(request, "Y", joystickY);

    // Solo mueve con joystick si el modo actual es manual.
    if (modoActual == MODO_MANUAL) {
      controlManual(joystickX, joystickY);
    }
  }
}

// Envia una respuesta simple para que la app sepa que el pedido llego.
void responderCliente(WiFiClient &client) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/plain");
  client.println("Connection: close");
  client.println();
  client.println("OK");
}

// Atiende un cliente HTTP si la app envio una orden.
void atenderCliente() {
  // Pregunta si hay un cliente conectado al servidor.
  WiFiClient client = server.available();

  // Si no hay cliente, vuelve al loop principal.
  if (!client) {
    return;
  }

  // Guarda la primera linea del pedido HTTP.
  String lineaActual = "";

  // Tiempo inicial para evitar quedar atrapado esperando un cliente.
  unsigned long inicio = millis();

  // Lee el pedido durante un tiempo corto.
  while (client.connected() && millis() - inicio < 250) {
    // Si todavia no llegaron datos, sigue esperando dentro del limite de tiempo.
    if (!client.available()) {
      continue;
    }

    // Lee un caracter enviado por la app.
    char c = client.read();

    // El salto de linea marca el fin de la primera linea HTTP.
    if (c == '\n') {
      // Si la linea tiene contenido, se procesa.
      if (lineaActual.length() > 0) {
        Serial.println(lineaActual);
        procesarPedido(lineaActual);
      }

      // Responde OK y termina la lectura.
      responderCliente(client);
      break;
    }

    // Ignora '\r' y acumula el resto de caracteres.
    if (c != '\r') {
      lineaActual += c;
    }
  }

  // Cierra la conexion con la app.
  client.stop();
}

// Configuracion inicial del Arduino.
void setup() {
  // Inicia el monitor serial.
  Serial.begin(VELOCIDAD_SERIAL);

  // Configura pines del sensor frontal.
  pinMode(ECHO, INPUT);
  pinMode(TRIG, OUTPUT);

  // Configura pines del sensor izquierdo.
  pinMode(ECHO_IZQ, INPUT);
  pinMode(TRIG_IZQ, OUTPUT);

  // Configura pines del sensor derecho.
  pinMode(ECHO_DER, INPUT);
  pinMode(TRIG_DER, OUTPUT);

  // Configura pines del motor izquierdo.
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);

  // Configura pines del motor derecho.
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  // Configura pines de los LEDs.
  pinMode(LED_GIRO_IZQ, OUTPUT);
  pinMode(LED_GIRO_DER, OUTPUT);
  pinMode(LED_TRASERO, OUTPUT);

  // Asegura que el auto arranque detenido.
  detenerMotores();

  // Muestra por serial el nombre de la red que se va a crear.
  Serial.print("Creando la red:");
  Serial.println(ssid);

  // Crea el punto de acceso WiFi.
  int estadoWifi = WiFi.beginAP(ssid, pass);

  // Si falla el AP, se queda detenido para evitar movimientos inesperados.
  if (estadoWifi != WL_AP_LISTENING) {
    Serial.println("Error critico: no se pudo crear la red wifi.");

    // Bucle de seguridad: mantiene motores apagados.
    while (true) {
      detenerMotores();
      delay(100);
    }
  }

  // Informa que la red esta lista.
  Serial.println("La red esta activa. Buscala en los ajustes del celular.");

  // Muestra la IP que debe usar la app.
  Serial.print("IP para controlar el robot: ");
  Serial.println(WiFi.localIP());

  // Inicia el servidor HTTP.
  server.begin();
}

// Bucle principal del programa.
void loop() {
  // Atiende mensajes de la app si llegan.
  atenderCliente();

  // Si el modo actual es automatico, ejecuta la logica esquiva obstaculos.
  if (modoActual == MODO_AUTOMATICO) {
    automatico();
  }

  // Actualiza los LEDs en cualquier modo.
  blinkLeds();
}
