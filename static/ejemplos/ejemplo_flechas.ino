#include <WiFiS3.h>

char ssid[] = "Robot_Evasor_Grupo10";
char pass[] = "robotica2026";

const int IN1 = 5;
const int IN2 = 6;
const int IN3 = 10;
const int IN4 = 11;

const int TRIG_F = 9;
const int ECHO_F = 8;

const int TRIG_I = 12;
const int ECHO_I = 13;

const int TRIG_D = 7;
const int ECHO_D = 4;

int velocidad = 120;

long sensor_frontal = 100;
long sensor_izquierdo = 100;
long sensor_derecho = 100;

bool modoAutomatico = false;

unsigned long tControl = 0;
unsigned long tDuracion = 0;

WiFiServer server(80);

enum EstadoAuto {
  AVANZAR,
  GIRAR_D,
  GIRAR_I,
  GIRAR_ESTRAT_I,
  GIRAR_ESTRAT_D,
  RETROCEDER
};

EstadoAuto estado = AVANZAR;

long leerDistancia(int trigPin, int echoPin) {
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);

  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  long duracion = pulseIn(echoPin, HIGH, 25000);

  if (duracion == 0) {
    return 100;
  }

  long distancia = duracion * 0.034 / 2;
  return distancia;
}

void leerSensores() {
  sensor_frontal = leerDistancia(TRIG_F, ECHO_F);
  delay(20);
  sensor_izquierdo = leerDistancia(TRIG_I, ECHO_I);
  delay(20);
  sensor_derecho = leerDistancia(TRIG_D, ECHO_D);

  Serial.print("F: ");
  Serial.print(sensor_frontal);
  Serial.print(" | I: ");
  Serial.print(sensor_izquierdo);
  Serial.print(" | D: ");
  Serial.println(sensor_derecho);
}

void leerVelocidad(String request) {
  int pos = request.indexOf("vel=");

  if (pos != -1) {
    String valor = request.substring(pos + 4);
    int fin = valor.indexOf(' ');

    if (fin != -1) {
      valor = valor.substring(0, fin);
    }

    velocidad = valor.toInt();
    velocidad = constrain(velocidad, 0, 255);

    Serial.print("Velocidad recibida: ");
    Serial.println(velocidad);
  }
}

void moverAdelante() {
  analogWrite(IN1, velocidad);
  analogWrite(IN2, 0);
  analogWrite(IN3, velocidad);
  analogWrite(IN4, 0);
}

void moverAtras() {
  analogWrite(IN1, 0);
  analogWrite(IN2, velocidad);
  analogWrite(IN3, 0);
  analogWrite(IN4, velocidad);
}

void girarIzquierda() {
  analogWrite(IN1, 0);
  analogWrite(IN2, velocidad);
  analogWrite(IN3, velocidad);
  analogWrite(IN4, 0);
}

void girarDerecha() {
  analogWrite(IN1, velocidad);
  analogWrite(IN2, 0);
  analogWrite(IN3, 0);
  analogWrite(IN4, velocidad);
}

void detener() {
  analogWrite(IN1, 0);
  analogWrite(IN2, 0);
  analogWrite(IN3, 0);
  analogWrite(IN4, 0);
}

void avanzar() {
  moverAdelante();
}

void retroceder() {
  moverAtras();
}

void girarDer() {
  girarDerecha();
}

void girarIzq() {
  girarIzquierda();
}

void automatico() {
  leerSensores();

  switch (estado) {
    case AVANZAR:
      avanzar();

      if (sensor_frontal < 15) {
        if (sensor_izquierdo > sensor_derecho) {
          estado = GIRAR_ESTRAT_I;
        } else {
          estado = GIRAR_ESTRAT_D;
        }

        tControl = millis();
        tDuracion = 250;
      } 
      else if (sensor_izquierdo < 15) {
        estado = GIRAR_D;
      } 
      else if (sensor_derecho < 15) {
        estado = GIRAR_I;
      }
      break;

    case GIRAR_D:
      girarDer();

      if (sensor_izquierdo > 15 && sensor_frontal > 15) {
        estado = AVANZAR;
      }
      break;

    case GIRAR_I:
      girarIzq();

      if (sensor_derecho > 15 && sensor_frontal > 15) {
        estado = AVANZAR;
      }
      break;

    case GIRAR_ESTRAT_I:
      girarIzq();

      if (sensor_frontal > 15 && sensor_izquierdo > 15) {
        estado = AVANZAR;
      } 
      else if (millis() - tControl >= tDuracion) {
        if (sensor_frontal < 15) {
          estado = GIRAR_ESTRAT_D;
          tControl = millis();
          tDuracion = 220;
        } else {
          estado = AVANZAR;
        }
      }
      break;

    case GIRAR_ESTRAT_D:
      girarDer();

      if (sensor_frontal > 15 && sensor_derecho > 15) {
        estado = AVANZAR;
      } 
      else if (millis() - tControl >= tDuracion) {
        if (sensor_frontal < 15) {
          estado = GIRAR_ESTRAT_I;
          tControl = millis();
          tDuracion = 220;
        } else {
          estado = AVANZAR;
        }
      }
      break;

    case RETROCEDER:
      retroceder();

      if (millis() - tControl >= tDuracion) {
        if (sensor_izquierdo > sensor_derecho) {
          estado = GIRAR_ESTRAT_I;
        } else {
          estado = GIRAR_ESTRAT_D;
        }

        tControl = millis();
        tDuracion = 150;
      }
      break;
  }
}

void responder(WiFiClient client, String mensaje) {
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/plain");
  client.println("Access-Control-Allow-Origin: *");
  client.println("Connection: close");
  client.println();
  client.println(mensaje);
}

void atenderCliente() {
  WiFiClient client = server.available();

  if (client) {
    String request = "";
    unsigned long tiempoInicio = millis();

    while (client.connected() && millis() - tiempoInicio < 1000) {
      if (client.available()) {
        request = client.readStringUntil('\n');
        break;
      }
    }

    Serial.print("Peticion recibida: ");
    Serial.println(request);

    leerVelocidad(request);

    if (request.indexOf("/manual") != -1) {
      modoAutomatico = false;
      detener();
      responder(client, "modo manual");
    } 
    else if (request.indexOf("/automatico") != -1) {
      modoAutomatico = true;
      estado = AVANZAR;
      responder(client, "modo automatico");
    } 
    else if (request.indexOf("/adelante") != -1) {
      modoAutomatico = false;
      moverAdelante();
      responder(client, "adelante");
    } 
    else if (request.indexOf("/atras") != -1) {
      modoAutomatico = false;
      moverAtras();
      responder(client, "atras");
    } 
    else if (request.indexOf("/izquierda") != -1) {
      modoAutomatico = false;
      girarIzquierda();
      responder(client, "izquierda");
    } 
    else if (request.indexOf("/derecha") != -1) {
      modoAutomatico = false;
      girarDerecha();
      responder(client, "derecha");
    } 
    else if (request.indexOf("/stop") != -1) {
      modoAutomatico = false;
      detener();
      responder(client, "stop");
    } 
    else if (request.indexOf("/ping") != -1) {
      responder(client, "pong");
    } 
    else {
      responder(client, "comando no reconocido");
    }

    delay(10);
    client.stop();
  }
}

void setup() {
  Serial.begin(9600);
  delay(1000);

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);

  pinMode(TRIG_F, OUTPUT);
  pinMode(ECHO_F, INPUT);

  pinMode(TRIG_I, OUTPUT);
  pinMode(ECHO_I, INPUT);

  pinMode(TRIG_D, OUTPUT);
  pinMode(ECHO_D, INPUT);

  detener();

  Serial.print("Creando Access Point... ");

  int estadoWiFi = WiFi.beginAP(ssid, pass);

  if (estadoWiFi != WL_AP_LISTENING) {
    Serial.println("ERROR al crear Access Point");
    while (true);
  }

  delay(2000);

  Serial.println("OK");
  Serial.print("Nombre WiFi: ");
  Serial.println(ssid);
  Serial.print("IP del Arduino: ");
  Serial.println(WiFi.localIP());

  server.begin();
  Serial.println("Servidor web iniciado");
}

void loop() {
  atenderCliente();

  if (modoAutomatico) {
    automatico();
  }
}