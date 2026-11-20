@echo off
rem Builds ZawMongo (Release) and runs it. Extra arguments are passed to the app, e.g.:
rem   run.bat --no-browser --port 5480
setlocal
cd /d "%~dp0"

where dotnet >nul 2>nul
if errorlevel 1 (
    echo The .NET SDK was not found. Install .NET 10 from https://dotnet.microsoft.com/download
    pause
    exit /b 1
)

echo Building ZawMongo...
dotnet build src\ZawMongo\ZawMongo.csproj -c Release -nologo -v q
if errorlevel 1 (
    echo.
    echo Build failed.
    pause
    exit /b 1
)

dotnet src\ZawMongo\bin\Release\net10.0\ZawMongo.dll %*
if errorlevel 1 pause
