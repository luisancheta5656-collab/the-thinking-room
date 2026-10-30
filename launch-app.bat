@echo off
REM Opens The Thinking Room in its own desktop window (development mode).
REM Installs or updates the packages and the OpenSpiel engine when needed; the
REM desktop app then starts the engine and the game server itself.
setlocal EnableExtensions
cd /d "%~dp0"
title The Thinking Room
REM VS Code terminals set this, which would make Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="

echo.
echo  THE THINKING ROOM - development
echo  -------------------------------
echo.

where node >nul 2>&1
if errorlevel 1 goto NODE_MISSING
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)"
if errorlevel 1 goto NODE_TOO_OLD
where npm >nul 2>&1
if errorlevel 1 goto NPM_MISSING

REM Only one Next.js dev server can run per project folder.
powershell -NoProfile -Command "$here = (Get-Location).Path; if (Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*next*dev*' -and $_.CommandLine -like ('*' + $here + '*') }) { exit 1 }" >nul 2>&1
if errorlevel 1 goto ALREADY_RUNNING

if not exist ".env.local" (
    if exist ".env.example" (
        copy ".env.example" ".env.local" >nul
        echo Created .env.local from .env.example.
    )
)

REM Install the packages on first run, and again whenever package-lock.json changes
REM (for example after pulling a change that adds a package).
fc /b "package-lock.json" "node_modules\.installed-package-lock.json" >nul 2>&1
if errorlevel 1 (
    echo Installing application packages...
    call npm install
    if errorlevel 1 goto NPM_INSTALL_FAILED
    copy /y "package-lock.json" "node_modules\.installed-package-lock.json" >nul
)
REM npm install sometimes skips Electron's own download.
if not exist "node_modules\electron\dist\electron.exe" (
    echo Downloading Electron...
    call node node_modules\electron\install.js
    if errorlevel 1 goto NPM_INSTALL_FAILED
)

REM The OpenSpiel engine: create engine\.venv on first run, and update its
REM packages whenever engine\requirements.txt changes.
if not exist "engine\.venv\Scripts\python.exe" (
    py -3.11 --version >nul 2>&1
    if errorlevel 1 goto PYTHON_MISSING
    echo Installing the OpenSpiel engine...
    call npm run setup:engine
    if errorlevel 1 goto ENGINE_INSTALL_FAILED
    copy /y "engine\requirements.txt" "engine\.venv\installed-requirements.txt" >nul
)
fc /b "engine\requirements.txt" "engine\.venv\installed-requirements.txt" >nul 2>&1
if errorlevel 1 (
    echo Updating the OpenSpiel engine packages...
    "engine\.venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r engine\requirements.txt
    if errorlevel 1 goto ENGINE_INSTALL_FAILED
    copy /y "engine\requirements.txt" "engine\.venv\installed-requirements.txt" >nul
)

REM Ollama is optional: it only powers chat and post-game coaching.
set "OLLAMA_MODEL=llama3.2:3b"
if exist ".env.local" (
    for /f "tokens=1,* delims==" %%A in ('findstr /B /C:"OLLAMA_MODEL=" ".env.local" 2^>nul') do set "OLLAMA_MODEL=%%B"
)
call :FIND_OLLAMA
if not defined OLLAMA_EXE (
    echo Ollama is not installed, so chat and coaching are off. The games work without it.
    goto START_APP
)
REM 127.0.0.1, not localhost: Windows PowerShell tries IPv6 first and can time out.
powershell -NoProfile -Command "try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo Starting the local Ollama service for chat and coaching...
    start "Ollama local service" /min "%OLLAMA_EXE%" serve
)
"%OLLAMA_EXE%" list 2>nul | findstr /I /B /C:"%OLLAMA_MODEL%" >nul
if errorlevel 1 echo Chat model %OLLAMA_MODEL% is missing. Run "ollama pull %OLLAMA_MODEL%" to enable chat and coaching.

:START_APP
echo.
echo Starting The Thinking Room... the window opens when the game server is ready.
echo Keep this window open while you play.
echo.
call npm run desktop
goto END

:FIND_OLLAMA
set "OLLAMA_EXE="
for /f "delims=" %%I in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%I"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
exit /b 0

:ALREADY_RUNNING
echo The Thinking Room is already running from this folder (a Next.js dev server is open).
echo Close the other app window or terminal first, then run launch-app.bat again.
goto FAILED

:NODE_MISSING
echo Node.js is required. Install Node.js 20.9 or newer, then run launch-app.bat again.
goto FAILED

:NPM_MISSING
echo npm was not found. Reinstall Node.js with npm included, then run launch-app.bat again.
goto FAILED

:NODE_TOO_OLD
echo Your Node.js version is too old. Install Node.js 20.9 or newer, then run launch-app.bat again.
goto FAILED

:PYTHON_MISSING
echo Python 3.11 is required to set up the OpenSpiel engine during development.
echo Install it from https://www.python.org/downloads/release/python-3119/ (tick "py launcher"), then run launch-app.bat again.
goto FAILED

:ENGINE_INSTALL_FAILED
echo Installing OpenSpiel failed. Check your internet connection, then run launch-app.bat again.
goto FAILED

:NPM_INSTALL_FAILED
echo Installing the application packages failed. Check your internet connection, then run launch-app.bat again.
goto FAILED

:FAILED
echo.
pause
exit /b 1

:END
endlocal
