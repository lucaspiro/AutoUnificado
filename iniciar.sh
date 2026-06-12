#!/bin/bash

echo "======================================================"
echo "  Iniciando Servidor del Simulador de Auto Unificado"
echo "======================================================"
echo ""

# Comprobar si python3 o python están instalados
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD="python"
else
    echo "[ERROR] No se encontró Python instalado."
    echo "Por favor instale Python 3 e inténtelo de nuevo."
    exit 1
fi

# Intentar importar Flask para ver si ya esta instalado
$PYTHON_CMD -c "import flask" >/dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[+] Flask no esta instalado. Instalando dependencias necesarias..."
    $PYTHON_CMD -m pip install -r requirements.txt
    if [ $? -ne 0 ]; then
        echo "[ADVERTENCIA] Hubo un problema al instalar las dependencias con pip."
        echo "Intentando continuar de todos modos..."
    fi
else
    echo "[+] Dependencias verificadas (Flask ya esta instalado)."
fi

echo ""
echo "[+] Levantando el servidor de Flask..."
echo "(Para detener el servidor, presiona Ctrl+C en esta terminal)"
echo ""
$PYTHON_CMD app.py

echo ""
echo "Servidor detenido."
read -n 1 -s -r -p "Presiona cualquier tecla para salir..."
