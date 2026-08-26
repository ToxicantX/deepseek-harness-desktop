@echo off
setlocal
set "EXIT_CODE=1"
set "NO_PAUSE="
set "PNPM_CMD=pnpm"

if /i "%~1"=="--no-pause" set "NO_PAUSE=1"
if defined CI set "NO_PAUSE=1"

cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

echo Checking required tools...
where node >nul 2>&1
if errorlevel 1 goto :node_missing
node -e "const major=Number(process.versions.node.split('.')[0]); if(major!==24||process.arch!=='x64'){console.error('Expected Node.js 24 x64, found '+process.version+' '+process.arch); process.exit(1)}"
if errorlevel 1 goto :environment_invalid

where pnpm >nul 2>&1
if errorlevel 1 (
    where corepack >nul 2>&1
    if errorlevel 1 goto :pnpm_missing
    echo pnpm was not found on PATH; using Corepack.
    set "PNPM_CMD=corepack pnpm"
)

for /f "delims=" %%V in ('node -p "require('./package.json').packageManager.split('@').pop()"') do set "EXPECTED_PNPM=%%V"
for /f "delims=" %%V in ('%PNPM_CMD% --version 2^>nul') do set "PNPM_VERSION=%%V"
if not "%PNPM_VERSION%"=="%EXPECTED_PNPM%" goto :pnpm_version_invalid
for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "APP_VERSION=%%V"

where powershell >nul 2>&1
if errorlevel 1 goto :powershell_missing

echo [1/4] Installing dependencies...
call %PNPM_CMD% install --frozen-lockfile
if errorlevel 1 goto :install_failed

echo [2/4] Running tests...
call %PNPM_CMD% test
if errorlevel 1 goto :test_failed

echo [3/4] Preparing Windows build output...
set "OUTPUT_DIR=dist"
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-windows-dist.ps1" -DistPath "%~dp0%OUTPUT_DIR%"
if "%ERRORLEVEL%"=="2" goto :use_fallback_output
if errorlevel 1 goto :prepare_failed
goto :output_ready

:use_fallback_output
set "OUTPUT_DIR=dist-next"
echo The standard dist directory is in use; building into %OUTPUT_DIR% instead.
powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-windows-dist.ps1" -DistPath "%~dp0%OUTPUT_DIR%"
if errorlevel 1 goto :prepare_failed

:output_ready
echo [4/4] Building Windows distributables into %OUTPUT_DIR%...
call %PNPM_CMD% run build
if errorlevel 1 goto :dist_failed
call %PNPM_CMD% exec electron-builder --win --publish never "--config.directories.output=%OUTPUT_DIR%"
if errorlevel 1 goto :dist_failed

if not exist "%OUTPUT_DIR%\DeepSeek-Harness-Shell-%APP_VERSION%-x64.exe" goto :artifacts_missing
if not exist "%OUTPUT_DIR%\DeepSeek-Harness-Shell-Portable-%APP_VERSION%-x64.exe" goto :artifacts_missing

echo.
echo Build completed successfully. Generated executable artifacts:
for %%F in ("%OUTPUT_DIR%\*.exe") do echo   %%~fF
set "EXIT_CODE=0"
goto :done

:cd_failed
echo ERROR: Could not change to the script directory.
goto :done

:node_missing
echo ERROR: Node.js was not found on PATH. Install Node.js 24 x64 and try again.
goto :done

:environment_invalid
set "EXIT_CODE=%ERRORLEVEL%"
echo ERROR: This build requires Node.js 24 x64.
goto :done

:pnpm_missing
echo ERROR: Neither pnpm nor Corepack was found on PATH. Install Node.js with Corepack and try again.
goto :done

:pnpm_version_invalid
echo ERROR: Expected pnpm %EXPECTED_PNPM%, found %PNPM_VERSION%.
echo ERROR: Enable Corepack or install the pnpm version declared in package.json.
goto :done

:powershell_missing
echo ERROR: Windows PowerShell was not found on PATH.
goto :done

:install_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo ERROR: Dependency installation failed (stage: pnpm install).
goto :done

:test_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo ERROR: Tests failed (stage: pnpm test).
goto :done

:prepare_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo ERROR: Could not prepare the Windows build output directory.
goto :done

:dist_failed
set "EXIT_CODE=%ERRORLEVEL%"
echo ERROR: Distribution build failed (stage: build or electron-builder).
goto :done

:artifacts_missing
echo ERROR: Packaging finished without both expected Windows executables.
set "EXIT_CODE=1"
goto :done

:done
echo.
if not defined NO_PAUSE pause
endlocal & exit /b %EXIT_CODE%
