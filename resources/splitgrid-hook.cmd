@echo off
rem splitgrid agent lifecycle hook (Windows). Invoked by an agent's hook config as:
rem   splitgrid-hook.cmd <event>        e.g. prompt-submit | stop | notification
rem Reports the event to splitgrid, tagged with the terminal id injected at spawn.
rem Never fails/stalls the agent: short timeout, output swallowed, always exits 0.
if "%SPLITGRID_TERMINAL%"=="" exit /b 0
set "ENDPOINT=%SPLITGRID_HOOK_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/hook"
rem The agent's hook input (JSON on stdin) is the body, passed along as is:
rem splitgrid takes the line a notification shows from it.
curl -s -m 2 -X POST "%ENDPOINT%?terminal=%SPLITGRID_TERMINAL%&event=%~1" -H "content-type: application/json" --data-binary @- >nul 2>&1
exit /b 0
