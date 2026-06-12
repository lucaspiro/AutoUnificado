@echo off
title Simulador Auto Unificado

echo ======================================================
echo   Iniciando Servidor del Simulador de Auto Unificado
echo ======================================================
echo/

set PYTHON_CMD=

where python >nul 2>&1
if errorlevel 1 goto :CHECK_PY
set PYTHON_CMD=python
goto :PYTHON_OK

:CHECK_PY
where py >nul 2>&1
if errorlevel 1 goto :NO_PYTHON
set PYTHON_CMD=py
goto :PYTHON_OK

:NO_PYTHON
echo [ERROR] No se encontro Python instalado.
echo/
echo Para solucionarlo:
echo 1. Descarga Python desde python.org
echo 2. Al instalarlo, marca "Add Python to PATH".
echo 3. Vuelve a ejecutar este archivo.
echo/
pause
exit /b

:PYTHON_OK
%PYTHON_CMD% -c "import flask" >nul 2>&1
if errorlevel 1 goto :INSTALL_DEPS
echo [+] Dependencias verificadas.
goto :START_SERVER

:INSTALL_DEPS
echo [+] Flask no esta instalado. Instalando dependencias...
%PYTHON_CMD% -m pip install -r requirements.txt
if not errorlevel 1 goto :START_SERVER
echo [ADVERTENCIA] Hubo un problema al instalar con pip.

:START_SERVER
echo/
echo [+] Levantando el servidor de Flask...
echo Nota: Para detener el servidor presiona Ctrl+C en esta ventana.
echo/
%PYTHON_CMD% app.py

echo/
echo Servidor detenido.
pause
