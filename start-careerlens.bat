@echo off
setlocal EnableDelayedExpansion
title CareerLens - start everything

REM ===========================================================================
REM  EDIT THESE TWO LINES TO CHANGE THE MODEL. Nothing else in here needs touching.
REM
REM  Hosted models get retired on the vendor's schedule. When that happens every
REM  agent call returns 404 and the chat stops working. Put the new name below,
REM  run this file, done -- it writes the value into infra\.env for you.
REM
REM  To see which models your key can actually use right now, run option 3 in the
REM  menu below.
REM ===========================================================================

set "MODEL=accounts/fireworks/models/deepseek-v4-flash-0731"
set "FALLBACK=accounts/fireworks/models/gpt-oss-120b"

REM ===========================================================================

cd /d "%~dp0"

if not exist "infra\.env" (
    echo.
    echo   ERROR: infra\.env not found. Copy it from infra\.env.example first.
    echo.
    pause
    exit /b 1
)

echo.
echo  ================================================================
echo    CareerLens
echo  ================================================================
echo.
echo    Model    : %MODEL%
echo    Fallback : %FALLBACK%
echo.
echo  ----------------------------------------------------------------
echo    1  Start everything          (normal - no rebuild, ~40s)
echo    2  Rebuild and start         (after changing requirements.txt,
echo                                  package.json or a Dockerfile)
echo    3  List models my key can use
echo    4  Stop everything
echo  ----------------------------------------------------------------
echo.
set /p CHOICE=  Pick 1-4 (or Enter for 1):
if "%CHOICE%"=="" set CHOICE=1

if "%CHOICE%"=="3" goto listmodels
if "%CHOICE%"=="4" goto stopall

REM -- Write the model names into infra\.env -----------------------------------
REM PowerShell rather than batch string surgery: the model name contains forward
REM slashes and batch's own find/replace mangles them.
echo.
echo  Writing model settings into infra\.env ...
powershell -NoProfile -Command ^
  "$p='infra\.env';" ^
  "$c=Get-Content $p;" ^
  "if ($c -match '^FIREWORKS_MODEL=') { $c = $c -replace '^FIREWORKS_MODEL=.*', 'FIREWORKS_MODEL=%MODEL%' } else { $c += 'FIREWORKS_MODEL=%MODEL%' };" ^
  "if ($c -match '^FIREWORKS_FALLBACK_MODEL=') { $c = $c -replace '^FIREWORKS_FALLBACK_MODEL=.*', 'FIREWORKS_FALLBACK_MODEL=%FALLBACK%' } else { $c += 'FIREWORKS_FALLBACK_MODEL=%FALLBACK%' };" ^
  "Set-Content -Path $p -Value $c -Encoding ascii"

if errorlevel 1 (
    echo   Could not update infra\.env -- is it open in an editor?
    pause
    exit /b 1
)

REM -- Start ------------------------------------------------------------------
REM --profile bigdata is what brings up Airflow, Kafka UI and HDFS. Without it
REM there is no play button at :8090.
echo.
if "%CHOICE%"=="2" (
    echo  Rebuilding images. First run after a cache prune takes ~10 minutes.
    docker compose -f infra\docker-compose.yml --profile bigdata up -d --build
) else (
    echo  Starting containers ...
    docker compose -f infra\docker-compose.yml --profile bigdata up -d
)

if errorlevel 1 (
    echo.
    echo   Start failed. Common causes:
    echo     - Docker Desktop is not running
    echo     - Port already in use ^(another project on 3000 or 8000^)
    echo     - The kind cluster is running and eating the RAM
    echo.
    pause
    exit /b 1
)

REM Wait for BOTH, not just the frontend. Airflow's webserver takes a good minute longer
REM than everything else, so printing the URLs as soon as :3000 answers means you click
REM :8090, get a connection error, and think it is broken when it is only still booting.
REM Any HTTP response counts -- Airflow answers 302 (redirect to its login), not 200.
echo.
echo  Waiting for services to come up ^(Airflow takes the longest^) ...
powershell -NoProfile -Command ^
  "function Up($u) { try { Invoke-WebRequest $u -TimeoutSec 5 -UseBasicParsing | Out-Null; return $true }" ^
  "                  catch { return ($_.Exception.Response -ne $null) } }" ^
  "$fe=$false; $af=$false;" ^
  "for ($i=0; $i -lt 40; $i++) {" ^
  "  if (-not $fe -and (Up 'http://localhost:3000')) { $fe=$true; Write-Host '  frontend  ready' -ForegroundColor Green }" ^
  "  if (-not $af -and (Up 'http://localhost:8090')) { $af=$true; Write-Host '  airflow   ready' -ForegroundColor Green }" ^
  "  if ($fe -and $af) { break }" ^
  "  Start-Sleep -Seconds 5 }" ^
  "if (-not $fe) { Write-Host '  frontend did not answer -- check: docker compose logs frontend' -ForegroundColor Yellow }" ^
  "if (-not $af) { Write-Host '  airflow did not answer -- check: docker compose logs airflow-webserver' -ForegroundColor Yellow }"

echo.
echo  ================================================================
echo    Everything is up. Open these:
echo  ================================================================
echo.
echo    THE APP        http://localhost:3000
echo.
echo    Airflow        http://localhost:8090     admin / admin
echo                   ^(click the play button on job_pipeline to
echo                    fetch fresh jobs - takes about 17 minutes^)
echo.
echo    Kafka UI       http://localhost:8085
echo    Adminer        http://localhost:8081
echo    HDFS           http://localhost:9870
echo.
echo  ----------------------------------------------------------------
echo    From now on you can just use Docker Desktop: hit stop and
echo    start on the "infra" group. Only come back here to change the
echo    model or to rebuild.
echo.
echo    Do NOT start the kind cluster at the same time - 7.6 GB of RAM
echo    will not carry both, and the website hangs while the container
echo    still shows as running.
echo  ----------------------------------------------------------------
echo.
pause
exit /b 0

REM ---------------------------------------------------------------------------
:listmodels
echo.
echo  Models your FIREWORKS_API_KEY can use:
echo.
powershell -NoProfile -Command ^
  "$k=(Get-Content 'infra\.env' | Select-String '^FIREWORKS_API_KEY=').ToString().Split('=',2)[1];" ^
  "if (-not $k) { Write-Host '  No FIREWORKS_API_KEY in infra\.env' -ForegroundColor Red; exit };" ^
  "try {" ^
  "  $r=Invoke-RestMethod 'https://api.fireworks.ai/inference/v1/models' -Headers @{Authorization=\"Bearer $k\"} -TimeoutSec 30;" ^
  "  $r.data | ForEach-Object { Write-Host ('   ' + $_.id) }" ^
  "} catch { Write-Host '  Request failed. A 401 here means the API key is wrong.' -ForegroundColor Red }"
echo.
echo  Copy one of the above into the MODEL line near the top of this file,
echo  then run it again and pick 1.
echo.
pause
exit /b 0

REM ---------------------------------------------------------------------------
:stopall
echo.
echo  Stopping everything ^(data is kept - volumes are not touched^) ...
docker compose -f infra\docker-compose.yml --profile bigdata stop
echo.
echo  Stopped. Start again with option 1, or from Docker Desktop.
echo.
pause
exit /b 0
