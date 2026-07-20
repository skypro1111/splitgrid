@echo off
rem splitgrid agent SQL control (Windows). Invoked by an agent as:
rem   splitgrid-sql.cmd <cmd> [args...]
rem   read:   connections | schema [conn] | tables [conn] | describe <table> | query <sql>
rem   export: export <sql> <path>
rem   run `splitgrid-sql.cmd help` for the full list.
rem Forwards the argv to splitgrid and PRINTS the JSON reply. No-op outside splitgrid.
rem Capability hint: %SPLITGRID_SQL_WRITE%=1 when write/DDL is permitted (else read-only).
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped, so avoid them in `query` text.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_SQL_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/sql"

set "ARGV="
:loop
if "%~1"=="" goto done
set "A=%~1"
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

curl -s -m 40 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"kind\":\"sql\",\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_SQL_TOKEN%\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
