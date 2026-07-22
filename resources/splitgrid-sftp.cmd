@echo off
rem splitgrid agent SFTP access (Windows). Invoked by an agent as:
rem   splitgrid-sftp.cmd <cmd> [args...]
rem   read:   targets | status | ls <remote> | stat <remote> | cat <remote> | get <remote> [local]
rem   write:  send <local...> [remote-dir] | push <path...> | pull <path...> | sync |
rem           mkdir <remote> | mv <old> <new> | rm <remote> --force
rem   run `splitgrid-sftp.cmd help` for the full list.
rem Moves files between this machine and the remote hosts of the caller's workspace.
rem Forwards the argv to splitgrid and PRINTS the JSON reply. No-op outside splitgrid.
rem Capability hint: %SPLITGRID_SFTP_WRITE%=1 when uploads/changes are permitted.
rem Note: args are JSON-escaped for backslashes; literal double-quotes inside an
rem arg are not escaped, so avoid them in path arguments.
setlocal enabledelayedexpansion
if "%SPLITGRID_TERMINAL%"=="" (
  echo {"ok":false,"error":"not_in_splitgrid"}
  exit /b 0
)
set "ENDPOINT=%SPLITGRID_SFTP_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=http://127.0.0.1:19558/sftp"

set "ARGV="
:loop
if "%~1"=="" goto done
set "A=%~1"
set "A=!A:\=\\!"
if defined ARGV (set "ARGV=!ARGV!,\"!A!\"") else (set "ARGV=\"!A!\"")
shift
goto loop
:done

rem 190s: a transfer runs on the bridge's 180s budget, so outlive it by a margin
rem and report the bridge's own timeout rather than a local one.
curl -s -m 190 -X POST "%ENDPOINT%" -H "content-type: application/json" -d "{\"kind\":\"sftp\",\"terminal\":\"%SPLITGRID_TERMINAL%\",\"token\":\"%SPLITGRID_SFTP_TOKEN%\",\"argv\":[!ARGV!]}"
echo.
exit /b 0
