@echo off
setlocal
cd /d "%~dp0"

:: Check git and node
where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] git not found in PATH
    exit /b 1
)
where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] node not found in PATH
    exit /b 1
)

:: Delegate to a robust node script
node scripts\release.mjs %*
exit /b %errorlevel%
