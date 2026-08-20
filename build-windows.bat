@echo off
setlocal

cd /d "%~dp0"
if errorlevel 1 goto :cd_failed

echo Checking required tools...
where node >nul 2>&1
if errorlevel 1 goto :node_missing
where pnpm >nul 2>&1
if errorlevel 1 goto :pnpm_missing

echo [1/3] Installing dependencies...
call pnpm install --frozen-lockfile
if errorlevel 1 goto :install_failed

echo [2/3] Running tests...
call pnpm test
if errorlevel 1 goto :test_failed

echo [3/3] Building Windows distributables...
call pnpm run dist
if errorlevel 1 goto :dist_failed

echo.
echo Build completed successfully. Generated executable artifacts:
if exist "dist\*.exe" (
    for %%F in ("dist\*.exe") do echo   %%~fF
) else (
    echo   No dist\*.exe artifacts found.
)
set "EXIT_CODE=0"
goto :done

:cd_failed
echo ERROR: Could not change to the script directory.
set "EXIT_CODE=1"
goto :done

:node_missing
echo ERROR: Node.js was not found on PATH. Install Node.js and try again.
set "EXIT_CODE=1"
goto :done

:pnpm_missing
echo ERROR: pnpm was not found on PATH. Install pnpm and try again.
set "EXIT_CODE=1"
goto :done

:install_failed
echo ERROR: Dependency installation failed (stage: pnpm install).
set "EXIT_CODE=1"
goto :done

:test_failed
echo ERROR: Tests failed (stage: pnpm test).
set "EXIT_CODE=1"
goto :done

:dist_failed
echo ERROR: Distribution build failed (stage: pnpm run dist).
set "EXIT_CODE=1"
goto :done

:done
echo.
pause
endlocal & exit /b %EXIT_CODE%
