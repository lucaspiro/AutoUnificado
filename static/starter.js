/* Sketch de ejemplo precargado. Estilo Arduino IDE: anda igual aca y en la placa.
   Maneja los 3 modos (manual / ultrasonido / siguelinea) segun el request. */
window.STARTER_SKETCH = [
"void setup() {",
"  Serial.begin(9600);",
"}",
"void loop() {",
"  Serial.println(\"Hello World\");",
"  delay(1000);",
"}",
].join("\n");
