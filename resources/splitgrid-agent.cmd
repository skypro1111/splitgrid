@echo off
rem splitgrid Claude Code pane control (Windows). Invoked by an agent as:
rem   splitgrid-agent.cmd <cmd> [args...]
rem   read:  list | state <s> | events <s> [--tail N] | diag [<s>] [--tail N]
rem   drive: send <s> <text> | interrupt <s> | approve <s> <req> <decision>
rem          answer <s> <req> <label> | mode <s> <mode> | stop <s>
rem   run `splitgrid-agent.cmd help` for the full list.
rem Answered by splitgrid's main process (not the pane's UI), so it still works
rem when a pane is stuck. Forwards the argv and PRINTS the JSON reply. No-op
rem outside splitgrid.
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped, so avoid them in `send` text.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_AGENT_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/agent"

set "ARGV="
:loop
if "%~1"=="" goto done
set "A=%~1"
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

curl -s -m 40 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"kind\":\"agent\",\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_AGENT_TOKEN%\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
