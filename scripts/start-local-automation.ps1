<#
.SYNOPSIS
  Brings up the local RightsFlow AI automation stack on Windows (no Docker):
  MariaDB (check only), FastAPI, Next.js and n8n.

.DESCRIPTION
  - MariaDB/XAMPP is only checked: start MySQL from the XAMPP Control Panel.
  - FastAPI (port 8000) and Next.js (port 3000) are started hidden in the
    background only when their port is free; logs and pid files go to
    %LOCALAPPDATA%\RightsFlowAI\logs.
  - n8n is started with scripts\start-n8n.ps1.
  Nothing that is already running is restarted or stopped.

.PARAMETER SkipFrontend
  Don't start Next.js (it isn't needed by the workflows).
#>
param([switch]$SkipFrontend)

. "$PSScriptRoot\n8n-common.ps1"

$stackHome = Join-Path $env:LOCALAPPDATA 'RightsFlowAI'
$stackLogs = Join-Path $stackHome 'logs'
if (-not (Test-Path $stackLogs)) { New-Item -ItemType Directory -Path $stackLogs -Force | Out-Null }

function Start-Detached([string]$Command, [string]$WorkingDirectory, [string]$LogName) {
    # cmd.exe redirects to the log files; launched via ShellExecute, the service
    # inherits no handles from this console (callers waiting on output don't hang).
    $out = Join-Path $stackLogs "$LogName.stdout.log"
    $err = Join-Path $stackLogs "$LogName.stderr.log"
    return Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', "`"$Command > `"$out`" 2> `"$err`"`"") `
        -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru
}

function Wait-Http([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpOk $Url) { return $true }
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-Step 'MariaDB'
if (Test-PortListening 3306) { Write-Ok 'MariaDB is listening on 3306' }
else {
    Write-Fail 'MariaDB is not running. Start MySQL in the XAMPP Control Panel, then re-run this script.'
    exit 1
}

Write-Step 'FastAPI backend'
if (Test-HttpOk "$ApiBaseUrl/health") { Write-Ok "Already running: $ApiBaseUrl" }
elseif (Test-PortListening 8000) { Write-Fail 'Port 8000 is in use by something that is not the RightsFlow API. Not starting.'; exit 1 }
else {
    $python = Join-Path $RepoRoot 'backend\.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) { Write-Fail "Backend virtualenv missing: $python"; exit 1 }
    $api = Start-Detached "`"$python`" -m uvicorn app.main:app --host 127.0.0.1 --port 8000" (Join-Path $RepoRoot 'backend') 'api'
    Set-Content (Join-Path $stackHome 'api.pid') $api.Id -Encoding ascii
    if (Wait-Http "$ApiBaseUrl/health" 60) { Write-Ok "Started (pid $($api.Id)): $ApiBaseUrl" }
    else { Write-Fail "FastAPI did not start; see $stackLogs\api.stderr.log"; exit 1 }
}

if (-not $SkipFrontend) {
    Write-Step 'Next.js frontend'
    if (Test-HttpOk 'http://127.0.0.1:3000/login') { Write-Ok 'Already running: http://localhost:3000' }
    elseif (Test-PortListening 3000) { Write-Warn2 'Port 3000 is in use by another program; frontend not started.' }
    else {
        $web = Start-Detached 'npm run dev' (Join-Path $RepoRoot 'frontend') 'web'
        Set-Content (Join-Path $stackHome 'web.pid') $web.Id -Encoding ascii
        if (Wait-Http 'http://127.0.0.1:3000/login' 120) { Write-Ok "Started (pid $($web.Id)): http://localhost:3000" }
        else { Write-Warn2 "Frontend still starting or failed; see $stackLogs\web.stderr.log" }
    }
}

Write-Step 'n8n'
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-n8n.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check-n8n.ps1')
exit $LASTEXITCODE
