@echo off
setlocal
set "EXIT_CODE=1"
set "NO_PAUSE="
set "PNPM_CMD=pnpm"
set "NODE_EXE="
set "NODE_VERSION="
set "NODE_DIR="
set "RUNTIME_ROOT="
set "RUNTIME_PNPM="

if /i "%~1"=="--no-pause" set "NO_PAUSE=1"
if defined CI set "NO_PAUSE=1"

cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

echo Checking required tools...
if defined DSH_DESKTOP_RUNTIME_ROOT if exist "%DSH_DESKTOP_RUNTIME_ROOT%\node\node.exe" (
    set "NODE_EXE=%DSH_DESKTOP_RUNTIME_ROOT%\node\node.exe"
    set "RUNTIME_ROOT=%DSH_DESKTOP_RUNTIME_ROOT%"
)
if not defined NODE_EXE if defined LOCALAPPDATA (
    for /d %%R in ("%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\*") do if exist "%%~fR\node\node.exe" if not defined NODE_EXE (
        set "NODE_EXE=%%~fR\node\node.exe"
        set "RUNTIME_ROOT=%%~fR"
    )
)
if not defined NODE_EXE if defined NVM_HOME (
    for /d %%R in ("%NVM_HOME%\v24*") do if exist "%%~fR\node.exe" if not defined NODE_EXE set "NODE_EXE=%%~fR\node.exe"
)
if not defined NODE_EXE if defined LOCALAPPDATA (
    for /d %%R in ("%LOCALAPPDATA%\nvm\v24*") do if exist "%%~fR\node.exe" if not defined NODE_EXE set "NODE_EXE=%%~fR\node.exe"
)
if not defined NODE_EXE (
    for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fN"
)
if not defined NODE_EXE goto :node_missing
set "NODE_VERSION="
set "NODE_ARCH="
set "NODE_MAJOR="
for /f "delims=" %%V in ('call "%NODE_EXE%" -p "process.versions.node" 2^>nul') do if not defined NODE_VERSION set "NODE_VERSION=%%V"
for /f "delims=" %%A in ('call "%NODE_EXE%" -p "process.arch" 2^>nul') do if not defined NODE_ARCH set "NODE_ARCH=%%A"
for /f "tokens=1 delims=." %%M in ("%NODE_VERSION%") do set "NODE_MAJOR=%%M"
if not "%NODE_MAJOR%"=="24" goto :environment_invalid
if /i not "%NODE_ARCH%"=="x64" goto :environment_invalid
for %%D in ("%NODE_EXE%") do set "NODE_DIR=%%~dpD"
set "PATH=%NODE_DIR%;%PATH%"
echo Using Node.js %NODE_VERSION% x64 from %NODE_EXE%

where pnpm >nul 2>&1
if errorlevel 1 if defined RUNTIME_ROOT call :add_runtime_pnpm_to_path
if defined RUNTIME_PNPM goto :pnpm_ready
where pnpm >nul 2>&1
if errorlevel 1 (
    where corepack >nul 2>&1
    if errorlevel 1 goto :pnpm_missing
    echo pnpm was not found on PATH; using Corepack.
    set "PNPM_CMD=corepack pnpm"
)

:pnpm_ready
set "PNPM_VERSION="
for /f "delims=" %%V in ('call "%NODE_EXE%" -p "require('./package.json').packageManager.split('@').pop()"') do set "EXPECTED_PNPM=%%V"
for /f "delims=" %%V in ('call %PNPM_CMD% --version 2^>nul') do set "PNPM_VERSION=%%V"
if not "%PNPM_VERSION%"=="%EXPECTED_PNPM%" goto :pnpm_version_invalid
for /f "delims=" %%V in ('call "%NODE_EXE%" -p "require('./package.json').version"') do set "APP_VERSION=%%V"

set "POWERSHELL_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL_EXE%" (
    set "POWERSHELL_EXE="
    for /f "delims=" %%P in ('"%SystemRoot%\System32\where.exe" powershell.exe 2^>nul') do if not defined POWERSHELL_EXE set "POWERSHELL_EXE=%%P"
)
if not defined POWERSHELL_EXE goto :powershell_missing
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -Command "exit 0" >nul 2>&1
if errorlevel 1 goto :powershell_missing
echo Using Windows PowerShell from %POWERSHELL_EXE%

echo [1/4] Installing dependencies...
call %PNPM_CMD% install --frozen-lockfile
if errorlevel 1 goto :install_failed

echo [2/4] Running tests...
call %PNPM_CMD% test
if errorlevel 1 goto :test_failed

echo [3/4] Preparing Windows build output...
set "OUTPUT_DIR=dist"
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-windows-dist.ps1" -DistPath "%~dp0%OUTPUT_DIR%"
if "%ERRORLEVEL%"=="2" goto :use_fallback_output
if errorlevel 1 goto :prepare_failed
goto :output_ready

:use_fallback_output
set "OUTPUT_DIR=dist-next"
echo The standard dist directory is in use; building into %OUTPUT_DIR% instead.
"%POWERSHELL_EXE%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\prepare-windows-dist.ps1" -DistPath "%~dp0%OUTPUT_DIR%"
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
echo ERROR: Node.js 24 x64 was not found.
echo ERROR: Install Node.js 24 x64, enable it in PATH, or install a DSH Runtime so this script can reuse its bundled Node.js.
goto :done

:environment_invalid
echo ERROR: This build requires Node.js 24 x64.
echo ERROR: Found %NODE_VERSION% %NODE_ARCH% at %NODE_EXE%.
goto :done

:pnpm_missing
echo ERROR: pnpm was not found on PATH, in the selected DSH Runtime, or through Corepack.
echo ERROR: Install the pnpm version declared in package.json, enable Corepack, or install a complete DSH Runtime.
goto :done

:pnpm_version_invalid
echo ERROR: Expected pnpm %EXPECTED_PNPM%, found %PNPM_VERSION%.
echo ERROR: Enable Corepack or install the pnpm version declared in package.json.
goto :done

:powershell_missing
echo ERROR: Windows PowerShell was not found or failed to start.
echo ERROR: Checked the Windows system directory and PATH. Executable: %POWERSHELL_EXE%
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

:add_runtime_pnpm_to_path
if exist "%RUNTIME_ROOT%\runtime-manifest.json" (
    for /f "usebackq delims=" %%P in (`call "%NODE_EXE%" -e "const fs=require('node:fs');const path=require('node:path');const manifest=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof manifest.paths?.pnpm==='string')process.stdout.write(path.resolve(process.argv[2],manifest.paths.pnpm));" "%RUNTIME_ROOT%\runtime-manifest.json" "%RUNTIME_ROOT%" 2^>nul`) do if not defined RUNTIME_PNPM set "RUNTIME_PNPM=%%P"
)
if defined RUNTIME_PNPM if not exist "%RUNTIME_PNPM%" set "RUNTIME_PNPM="
if not defined RUNTIME_PNPM if exist "%RUNTIME_ROOT%\tools\node_modules\@pnpm\exe\pnpm.exe" set "RUNTIME_PNPM=%RUNTIME_ROOT%\tools\node_modules\@pnpm\exe\pnpm.exe"
if not defined RUNTIME_PNPM if exist "%RUNTIME_ROOT%\tools\pnpm.exe" set "RUNTIME_PNPM=%RUNTIME_ROOT%\tools\pnpm.exe"
if not defined RUNTIME_PNPM exit /b 0
for %%D in ("%RUNTIME_PNPM%") do set "PATH=%%~dpD;%PATH%"
set PNPM_CMD="%RUNTIME_PNPM%"
echo pnpm was not found on PATH; using DSH Runtime pnpm from %RUNTIME_PNPM%.
exit /b 0

:done
echo.
if not defined NO_PAUSE pause
endlocal & exit /b %EXIT_CODE%
