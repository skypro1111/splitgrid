@echo off
rem splitgrid agent lifecycle hook (Windows). Invoked by an agent's hook config as:
rem   splitgrid-hook.cmd <event>        e.g. prompt-submit | stop | notification
rem Reports the event to splitgrid, tagged with the terminal id injected at spawn.
rem Never fails/stalls the agent: short timeout, output swallowed, always exits 0.
if "%SPLITGRID_TERMINAL%"=="" exit /b 0
set "ENDPOINT=%SPLITGRID_HOOK_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/hook"
curl -s -m 2 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"terminal\":\"%SPLITGRID_TERMINAL%\",\"event\":\"%~1\"}" >nul 2>&1
exit /b 0
