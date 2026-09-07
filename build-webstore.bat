@echo off
REM =====================================================================
REM  GramG Ninja - bump version + build the Chrome Web Store zip
REM
REM  Usage:   build-webstore.bat [patch|minor|major]     (default: patch)
REM  Output:  dist\gramg-ninja-<version>.zip   (manifest.json at zip root)
REM
REM  - Bumps the "version" in vbg-cert-autofill\manifest.json.
REM  - Zips a staged copy whose manifest has the private "key" REMOVED
REM    (the Web Store rejects "key"; it stays in the source so local
REM    "Load unpacked" keeps its fixed extension ID).
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
