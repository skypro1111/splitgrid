@echo off
rem splitgrid agent workspace history (Windows). Invoked by an agent as:
rem   splitgrid-history.cmd <cmd> [args...]
rem   search <query...> [--limit N] [--since 30d|2026-09-01] | file <path> |
rem   show <chunkId> [--radius N] | sessions [--limit N]
rem   run `splitgrid-history.cmd help` for the full list.
rem Searches the archived Claude Code sessions of the caller's workspace (read-only).
rem Forwards the argv + %CD% (so `file` can resolve a relative path) to splitgrid
rem and PRINTS the JSON reply. No-op outside splitgrid.
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped, so avoid them in search text.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_HISTORY_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/history"

set "ARGV="
:loop
if "%~1"=="" goto done
set "A=%~1"
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

set "CWD=%CD%"
set "CWD=!CWD:\=\\!"

rem 40s: the bridge answers within ~35s (workspace lookup + query), so outlive it
rem and report the bridge's own timeout rather than a local one.
curl -s -m 40 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"kind\":\"history\",\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_HISTORY_TOKEN%\",\"cwd\":\"!CWD!\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
