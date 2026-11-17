@echo off
powershell.exe -NoProfile -NonInteractive -File "%~dp0..\start-infoplus-chrome.ps1" -Check
if errorlevel 1 (
    >&2 echo Start the dedicated Chrome with start-infoplus-chrome.ps1 before connecting.
    exit /b 1
)
call npx.cmd --yes chrome-devtools-mcp@1.12.0 --no-usage-statistics --no-performance-crux --redact-network-headers %*
exit /b %errorlevel%
