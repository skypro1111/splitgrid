@echo off
rem splitgrid agent terminal control (Windows). Invoked by an agent as:
rem   splitgrid-terminal.cmd <cmd> [args...]
rem   read:  list | read <id> [--tail N] | info <id> | tree <id>
rem   act:   send <id> <text...> | type <id> <text...> | key <id> <name>
rem   run `splitgrid-terminal.cmd help` for the full list.
rem Forwards the argv to splitgrid and PRINTS the JSON reply. No-op outside splitgrid.
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped, so avoid them in `send`/`type` text.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_TERMINAL_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/terminal"

set "ARGV="
:loop
if "%~1"=="" goto done
set "A=%~1"
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

curl -s -m 35 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"kind\":\"terminal\",\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_TERMINAL_TOKEN%\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
