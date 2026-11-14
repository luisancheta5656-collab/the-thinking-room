@echo off
REM Opens The Thinking Room in its own desktop window (development mode).
REM Sets up everything it needs on first run: it offers to install Node.js,
REM Python 3.11, the Visual C++ runtime and (optionally) Ollama with winget,
REM then installs or updates the app's packages, the OpenSpiel engine and Stockfish.
setlocal EnableExtensions
cd /d "%~dp0"
title The Thinking Room
REM VS Code terminals set this, which would make Electron run as plain Node.
set "ELECTRON_RUN_AS_NODE="
set "WINGET_FLAGS=--exact --accept-source-agreements --accept-package-agreements"

echo.
echo  THE THINKING ROOM - development
echo  -------------------------------
echo.

REM ---- Programs this needs: Node.js 20.9+ and Python 3.11 -------------------
call :FIND_NODE
call :FIND_PYTHON
set "MISSING="
if not defined NODE_OK set "MISSING=%MISSING%  Node.js"
if not exist "engine\.venv\Scripts\python.exe" if not defined PY311 set "MISSING=%MISSING%  Python 3.11"
if defined MISSING (
    call :INSTALL_TOOLS
    if errorlevel 1 goto FAILED
)

REM Only one Next.js dev server can run per project folder.
powershell -NoProfile -Command "$here = (Get-Location).Path; if (Get-CimInstance Win32_Process -Filter \"Name='node.exe' OR Name='electron.exe'\" | Where-Object { $_.CommandLine -like '*next*dev*' -and $_.CommandLine -like ('*' + $here + '*') }) { exit 1 }" >nul 2>&1
if errorlevel 1 goto ALREADY_RUNNING

if not exist ".env.local" (
    if exist ".env.example" (
        copy ".env.example" ".env.local" >nul
        echo Created .env.local from .env.example.
    )
)

REM ---- The app's packages ----------------------------------------------------
REM Installed on first run, and again whenever package-lock.json changes
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

REM ---- The OpenSpiel engine (engine\.venv) -----------------------------------
REM Created on first run; its packages are updated whenever engine\requirements.txt changes.
if exist "engine\.venv\Scripts\python.exe" goto ENGINE_UPDATE
echo Installing the OpenSpiel engine...
%PY311% -m venv engine\.venv
if errorlevel 1 goto ENGINE_INSTALL_FAILED
:ENGINE_UPDATE
fc /b "engine\requirements.txt" "engine\.venv\installed-requirements.txt" >nul 2>&1
if errorlevel 1 (
    echo Installing the OpenSpiel engine packages...
    "engine\.venv\Scripts\python.exe" -m pip install --quiet --disable-pip-version-check -r engine\requirements.txt
    if errorlevel 1 goto ENGINE_INSTALL_FAILED
    copy /y "engine\requirements.txt" "engine\.venv\installed-requirements.txt" >nul
)
REM OpenSpiel needs the Microsoft Visual C++ runtime, which most PCs already have.
"engine\.venv\Scripts\python.exe" -c "import pyspiel" >nul 2>&1
if not errorlevel 1 goto OLLAMA
echo.
echo OpenSpiel needs the Microsoft Visual C++ Redistributable, which this PC doesn't have.
call :ASK_WINGET "Install it now"
if errorlevel 1 goto VCREDIST_MANUAL
winget install %WINGET_FLAGS% --id Microsoft.VCRedist.2015+.x64
"engine\.venv\Scripts\python.exe" -c "import pyspiel" >nul 2>&1
if not errorlevel 1 goto OLLAMA
:VCREDIST_MANUAL
echo Install it from https://aka.ms/vs/17/release/vc_redist.x64.exe and run launch-app.bat again.
echo Until then, the built-in game AI plays instead of the OpenSpiel agent team.
echo.

:OLLAMA
REM ---- Stockfish, for AI vs AI chess (the other agents play without it) -------
if not exist "engine\bin\stockfish\stockfish.exe" (
    call npm run --silent prepare:stockfish
    if errorlevel 1 echo Stockfish could not be downloaded, so it won't appear in AI vs AI this time.
)

REM ---- Optional: Ollama for chat and post-game coaching ----------------------
set "OLLAMA_MODEL=llama3.2:3b"
if exist ".env.local" (
    for /f "tokens=1,* delims==" %%A in ('findstr /B /C:"OLLAMA_MODEL=" ".env.local" 2^>nul') do set "OLLAMA_MODEL=%%B"
)
call :FIND_OLLAMA
if defined OLLAMA_EXE goto OLLAMA_SERVE
if exist "node_modules\.skip-ollama" goto START_APP
echo.
echo Optional: Ollama adds the chat and the post-game Coach (about 3 GB with its model).
echo The games work without it.
call :ASK_WINGET "Install Ollama now"
if errorlevel 1 goto SKIP_OLLAMA
winget install %WINGET_FLAGS% --id Ollama.Ollama
call :FIND_OLLAMA
if not defined OLLAMA_EXE goto START_APP
:OLLAMA_SERVE
REM 127.0.0.1, not localhost: Windows PowerShell tries IPv6 first and can time out.
powershell -NoProfile -Command "try { $null = Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 3; exit 0 } catch { exit 1 }" >nul 2>&1
if errorlevel 1 (
    echo Starting the local Ollama service for chat and coaching...
    start "Ollama local service" /min "%OLLAMA_EXE%" serve
    powershell -NoProfile -Command "Start-Sleep -Seconds 3"
)
"%OLLAMA_EXE%" list 2>nul | findstr /I /B /C:"%OLLAMA_MODEL%" >nul
if not errorlevel 1 goto START_APP
if exist "node_modules\.skip-ollama" (
    echo Chat model %OLLAMA_MODEL% is missing. Run "ollama pull %OLLAMA_MODEL%" to enable chat and coaching.
    goto START_APP
)
echo.
choice /c YN /m "Download the chat model %OLLAMA_MODEL% now (about 2 GB)"
if errorlevel 2 goto SKIP_OLLAMA
"%OLLAMA_EXE%" pull %OLLAMA_MODEL%
goto START_APP
:SKIP_OLLAMA
type nul > "node_modules\.skip-ollama"
echo Skipped. Chat and coaching stay off; delete node_modules\.skip-ollama to be asked again.

:START_APP
echo.
echo Starting The Thinking Room... the window opens when the game server is ready.
echo Keep this window open while you play.
echo.
call npm run desktop
goto END

REM ---- Subroutines -----------------------------------------------------------

:FIND_NODE
REM Sets NODE_OK when Node.js 20.9+ and npm are available.
set "NODE_OK="
where node >nul 2>&1
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>&1
if errorlevel 1 exit /b 0
where npm >nul 2>&1
if errorlevel 1 exit /b 0
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 9) ? 0 : 1)"
if errorlevel 1 exit /b 0
set "NODE_OK=1"
exit /b 0

:FIND_PYTHON
REM Sets PY311 to a command that runs Python 3.11 (the py launcher, or python.exe by path).
set "PY311="
py -3.11 -c "import sys" >nul 2>&1
if not errorlevel 1 (
    set "PY311=py -3.11"
    exit /b 0
)
for %%P in ("%LOCALAPPDATA%\Programs\Python\Python311\python.exe" "%ProgramFiles%\Python311\python.exe") do (
    if not defined PY311 if exist %%P set PY311=%%P
)
exit /b 0

:FIND_OLLAMA
set "OLLAMA_EXE="
for /f "delims=" %%I in ('where ollama 2^>nul') do if not defined OLLAMA_EXE set "OLLAMA_EXE=%%I"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
exit /b 0

:ASK_WINGET
REM Asks the question in %1 when winget is available. Exit code 0 = yes, 1 = no or no winget.
where winget >nul 2>&1
if errorlevel 1 (
    echo Windows Package Manager ^(winget^) isn't available on this PC, so this can't be installed automatically.
    exit /b 1
)
choice /c YN /m %1
if errorlevel 2 exit /b 1
exit /b 0

:INSTALL_TOOLS
echo This PC needs:%MISSING%
call :ASK_WINGET "Install them now (Windows may ask for permission)"
if errorlevel 1 (
    echo Install them yourself, then run launch-app.bat again:
    echo   Node.js LTS: https://nodejs.org/
    echo   Python 3.11: https://www.python.org/downloads/release/python-3119/
    exit /b 1
)
if not defined NODE_OK winget install %WINGET_FLAGS% --id OpenJS.NodeJS.LTS
if exist "engine\.venv\Scripts\python.exe" goto TOOLS_RECHECK
if defined PY311 goto TOOLS_RECHECK
REM A per-user install needs no administrator rights; fall back to the default if that fails.
winget install %WINGET_FLAGS% --scope user --id Python.Python.3.11
if errorlevel 1 winget install %WINGET_FLAGS% --id Python.Python.3.11
:TOOLS_RECHECK
call :FIND_NODE
call :FIND_PYTHON
if not defined NODE_OK (
    echo Node.js still isn't available. Close this window and run launch-app.bat again.
    exit /b 1
)
if not exist "engine\.venv\Scripts\python.exe" if not defined PY311 (
    echo Python 3.11 still isn't available. Close this window and run launch-app.bat again.
    exit /b 1
)
echo.
exit /b 0

REM ---- Errors ----------------------------------------------------------------

:ALREADY_RUNNING
echo The Thinking Room is already running from this folder (a Next.js dev server is open).
echo Close the other app window or terminal first, then run launch-app.bat again.
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
