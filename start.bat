@echo off
rem ============================================================================
rem  Midorii - launcher
rem
rem  Until M6 produces an installer, the app runs from source: Vite serves the
rem  renderer and Electron loads it. This script wires both together and closes
rem  the dev server again when the window is closed.
rem
rem    start.bat          open the app (hot reload)
rem    start.bat /build   run against the production build instead of the dev
rem                       server - use this to check what a user would get
rem ============================================================================

setlocal
title Midorii
cd /d "%~dp0"

set "PORT=5300"
set "USEBUILD="
if /i "%~1"=="/build" set "USEBUILD=1"

echo.
echo   Midorii
echo   ------
echo.

rem --- Node --------------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js was not found on this machine.
  echo   Install Node 20 or newer from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

rem --- Dependencies ------------------------------------------------------
if not exist "node_modules\electron\" (
  echo   Installing dependencies, this happens only once...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   npm install failed. Nothing was started.
    echo.
    pause
    exit /b 1
  )
  echo.
)

rem --- Production build --------------------------------------------------
if defined USEBUILD (
  echo   Building the renderer...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   The build failed. Nothing was started.
    echo.
    pause
    exit /b 1
  )
  echo   Starting Midorii from dist\ ...
  echo.
  call npx electron .
  goto done
)

rem --- Dev server --------------------------------------------------------
rem  Reuse a server that is already up, so a second launch does not fail on
rem  the strict port and does not kill the first one on the way out.
set "STARTEDVITE="
call npx wait-on tcp:%PORT% -t 1500 >nul 2>&1
if errorlevel 1 (
  echo   Starting the dev server on port %PORT% ...
  start "Midorii dev server" /min cmd /c "npx vite"
  set "STARTEDVITE=1"
  call npx wait-on tcp:%PORT% -t 60000
  if errorlevel 1 (
    echo.
    echo   The dev server did not come up on port %PORT%.
    echo   Check the minimised "Midorii dev server" window for the reason.
    echo.
    pause
    goto cleanup
  )
) else (
  echo   Reusing the dev server already running on port %PORT%.
)

echo   Starting Midorii...
echo.
call npx electron .

:cleanup
rem  Only stop the server this script started; one started by hand stays.
rem  Addressed by the port it holds: the window title of a `start`ed cmd does
rem  not survive for taskkill to filter on, and netstat output is localised.
if defined STARTEDVITE (
  echo   Stopping the dev server...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }" >nul 2>&1
)

:done
endlocal
exit /b 0
