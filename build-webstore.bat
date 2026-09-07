@echo off
REM =====================================================================
REM  GramG Ninja - bump version + build the Chrome Web Store zip
REM
REM  Usage:   build-webstore.bat [patch|minor|major]     (default: patch)
REM  Output:  dist\gramg-ninja-<version>.zip   (manifest.json at zip root)
REM
REM  Bumps the "version" in vbg-cert-autofill\manifest.json, then zips the
REM  CONTENTS of vbg-cert-autofill\ so manifest.json sits at the zip root,
REM  which is what the Chrome Web Store requires.
REM =====================================================================
setlocal
set "PART=%~1"
if "%PART%"=="" set "PART=patch"
set "SRC=%~dp0vbg-cert-autofill"
set "DIST=%~dp0dist"
set "MANIFEST=%SRC%\manifest.json"

if not exist "%MANIFEST%" (
  echo ERROR: manifest not found: "%MANIFEST%"
  exit /b 1
)
if not exist "%DIST%" mkdir "%DIST%"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$p=$env:MANIFEST;" ^
  "$raw=[IO.File]::ReadAllText($p);" ^
  "$j=$raw | ConvertFrom-Json;" ^
  "$o=[string]$j.version;" ^
  "$s=$o.Split('.'); [int]$a=$s[0]; [int]$b=$s[1]; [int]$c=$s[2];" ^
  "switch($env:PART){'major'{$a++;$b=0;$c=0} 'minor'{$b++;$c=0} default{$c++}};" ^
  "$n=[string]::Join('.', @($a,$b,$c));" ^
  "$q=[char]34;" ^
  "$pat='\x22version\x22\s*:\s*\x22'+[regex]::Escape($o)+'\x22';" ^
  "$rep=$q+'version'+$q+': '+$q+$n+$q;" ^
  "$raw2=([regex]$pat).Replace($raw,$rep,1);" ^
  "if($raw2 -eq $raw){ throw ('Could not find version '+$o+' in manifest.json') };" ^
  "[IO.File]::WriteAllText($p,$raw2,(New-Object Text.UTF8Encoding($false)));" ^
  "$zip=Join-Path $env:DIST ('gramg-ninja-'+$n+'.zip');" ^
  "if(Test-Path $zip){ Remove-Item $zip -Force };" ^
  "Compress-Archive -Path (Join-Path $env:SRC '*') -DestinationPath $zip -Force;" ^
  "Write-Host '';" ^
  "Write-Host ('  Version : '+$o+'  ->  '+$n);" ^
  "Write-Host ('  Zip     : '+$zip)"

if errorlevel 1 (
  echo.
  echo Build FAILED.
  exit /b 1
)
echo.
echo Done. Upload the .zip above to the Chrome Web Store dashboard.
endlocal
