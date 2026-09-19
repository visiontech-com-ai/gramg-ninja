@echo off
REM =====================================================================
REM  GramG Ninja - set version + build the Chrome Web Store zip
REM
REM  Usage:
REM    build-webstore.bat                 (asks; suggests next patch version)
REM    build-webstore.bat 2.3.0           (uses that exact version)
REM    build-webstore.bat patch|minor|major   (bumps from current)
REM
REM  Output:  dist\gramg-ninja-<version>.zip   (manifest.json at zip root)
REM
REM  - Writes the chosen "version" into vbg-cert-autofill\manifest.json.
REM  - Zips a staged copy whose manifest has the private "key" REMOVED
REM    (the Web Store rejects "key"; it stays in the source so local
REM    "Load unpacked" keeps its fixed extension ID).
REM =====================================================================
setlocal
set "ARG=%~1"
set "SRC=%~dp0vbg-cert-autofill"
set "DIST=%~dp0dist"
set "MANIFEST=%SRC%\manifest.json"

if not exist "%MANIFEST%" (
  echo ERROR: manifest not found: "%MANIFEST%"
  exit /b 1
)
if not exist "%DIST%" mkdir "%DIST%"

REM --- current version from the manifest ---
set "CURVER="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "(Get-Content -Raw -LiteralPath $env:MANIFEST | ConvertFrom-Json).version"`) do set "CURVER=%%V"
if not defined CURVER (
  echo ERROR: could not read current version from manifest.
  exit /b 1
)

REM --- suggested next version (patch bump) ---
set "SUGGEST="
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=($env:CURVER).Split('.'); ('{0}.{1}.{2}' -f $s[0],$s[1],([int]$s[2]+1))"`) do set "SUGGEST=%%V"

REM --- resolve the new version from the argument (or ask) ---
set "NEWVER="
if /i "%ARG%"=="major" goto :bump
if /i "%ARG%"=="minor" goto :bump
if /i "%ARG%"=="patch" goto :bump
if not "%ARG%"=="" (
  REM explicit version number passed on the command line
  set "NEWVER=%ARG%"
  goto :havever
)

REM no argument: show current + suggested, let the user accept or type their own
echo.
echo   Current version : %CURVER%
set /p "NEWVER=  New version [%SUGGEST%]: "
if not defined NEWVER set "NEWVER=%SUGGEST%"
goto :havever

:bump
for /f "usebackq delims=" %%V in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=($env:CURVER).Split('.'); [int]$a=$s[0]; [int]$b=$s[1]; [int]$c=$s[2]; switch($env:ARG){'major'{$a++;$b=0;$c=0} 'minor'{$b++;$c=0} default{$c++}}; ('{0}.{1}.{2}' -f $a,$b,$c)"`) do set "NEWVER=%%V"

:havever
REM strip surrounding spaces
for /f "tokens=* delims= " %%A in ("%NEWVER%") do set "NEWVER=%%A"
if not defined NEWVER (
  echo ERROR: no version given.
  exit /b 1
)

REM --- validate X.Y.Z ---
echo %NEWVER%| findstr /R "^[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$" >nul
if errorlevel 1 (
  echo ERROR: "%NEWVER%" is not a valid version number ^(expected e.g. 2.3.0^).
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$p=$env:MANIFEST;" ^
  "$o=$env:CURVER; $n=$env:NEWVER;" ^
  "$raw=[IO.File]::ReadAllText($p);" ^
  "$q=[char]34;" ^
  "if($o -ne $n){" ^
  "  $pat='\x22version\x22\s*:\s*\x22'+[regex]::Escape($o)+'\x22';" ^
  "  $rep=$q+'version'+$q+': '+$q+$n+$q;" ^
  "  $raw2=([regex]$pat).Replace($raw,$rep,1);" ^
  "  if($raw2 -eq $raw){ throw ('Could not find version '+$o+' in manifest.json') };" ^
  "  [IO.File]::WriteAllText($p,$raw2,(New-Object Text.UTF8Encoding($false)));" ^
  "} else { Write-Host '  (version unchanged)' };" ^
  "$stage=Join-Path $env:DIST '_stage';" ^
  "if(Test-Path $stage){ Remove-Item $stage -Recurse -Force };" ^
  "Copy-Item -Path $env:SRC -Destination $stage -Recurse -Force;" ^
  "$sm=Join-Path $stage 'manifest.json';" ^
  "$mraw=[IO.File]::ReadAllText($sm);" ^
  "$mraw2=[regex]::Replace($mraw,'(?m)^\s*\x22key\x22\s*:\s*\x22[^\x22]*\x22,[ \t]*\r?\n','');" ^
  "if($mraw2 -eq $mraw){ Write-Host '  (note: no key field found to strip)' };" ^
  "[IO.File]::WriteAllText($sm,$mraw2,(New-Object Text.UTF8Encoding($false)));" ^
  "$null=($mraw2 | ConvertFrom-Json);" ^
  "$zip=Join-Path $env:DIST ('gramg-ninja-'+$n+'.zip');" ^
  "if(Test-Path $zip){ Remove-Item $zip -Force };" ^
  "Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force;" ^
  "Remove-Item $stage -Recurse -Force;" ^
  "Write-Host '';" ^
  "Write-Host ('  Version : '+$o+'  ->  '+$n);" ^
  "Write-Host ('  Zip     : '+$zip);" ^
  "Write-Host '  Manifest key: stripped from zip (kept in source)'"

if errorlevel 1 (
  echo.
  echo Build FAILED.
  exit /b 1
)
echo.
echo Done. Upload the .zip above to the Chrome Web Store dashboard.
endlocal
