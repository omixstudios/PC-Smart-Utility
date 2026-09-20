@echo off
echo ============================================
echo  PC Smart Utility v5.8.7 -- Build Script
echo ============================================
echo.

:: Check Node.js
node --version >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)

echo [1/3] Installing dependencies...
npm install

if errorlevel 1 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/3] Building APPX package for Microsoft Store...
npm run build-appx

if errorlevel 1 (
  echo ERROR: Build failed.
  pause
  exit /b 1
)

echo.
echo [3/3] Done! Check the dist\ folder for the .appx file.
echo Upload the .appx to Microsoft Partner Center.
echo.
pause
