@echo off
rem splitgrid agent browser control (Windows). Invoked by an agent as:
rem   splitgrid-browser.cmd <cmd> [args...]
rem   read:  open <url> | get url^|title^|text^|html^|console | screenshot | eval <js>
rem   act:   snapshot | click <ref> | fill <ref> <text> | type <text> | select <ref> <value>
rem   sync:  wait load | wait selector <css> | wait text <substr> | wait <ms>
rem   net:   network start | network list | network clear | network stop
rem   run `splitgrid-browser.cmd help` for the full list.
rem Forwards the argv to splitgrid and PRINTS the JSON reply. No-op outside splitgrid.
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped (rare for browser commands), so avoid them in eval.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_BROWSER_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/browser"

set "ARGV="
set "CMD=%~1"
set "N=0"
:loop
if "%~1"=="" goto done
set /a N+=1
set "A=%~1"
rem `open <file>`: the pane can't see this shell's cwd, so an existing local
rem path goes over absolute (%~f1); the app turns it into file://.
if !N!==2 if exist "%~1" (
  if /i "!CMD!"=="open" set "A=%~f1"
  if /i "!CMD!"=="navigate" set "A=%~f1"
  if /i "!CMD!"=="goto" set "A=%~f1"
)
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

curl -s -m 35 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_BROWSER_TOKEN%\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
