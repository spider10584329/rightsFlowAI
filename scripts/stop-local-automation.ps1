<#
.SYNOPSIS
  Stops what scripts\start-local-automation.ps1 started: the FastAPI and Next.js
  processes recorded in %LOCALAPPDATA%\RightsFlowAI\*.pid, and n8n.

.DESCRIPTION
  A recorded process is only stopped if its command line is the expected one
  (uvicorn app.main:app / npm run dev); its child processes are stopped with it.
  Servers you started yourself (no pid file) and unrelated processes are left alone.
#>
param([switch]$KeepN8n)

. "$PSScriptRoot\n8n-common.ps1"
$stackHome = Join-Path $env:LOCALAPPDATA 'RightsFlowAI'

function Get-Tree([int]$ParentId) {
    $ids = @()
    foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId") {
        $ids += Get-Tree $child.ProcessId
        $ids += $child.ProcessId
    }
    return $ids
}

function Stop-Recorded([string]$Name, [string]$Expected) {
    $pidFile = Join-Path $stackHome "$Name.pid"
    if (-not (Test-Path $pidFile)) { Write-Ok "$Name: not started by start-local-automation.ps1 (nothing to stop)"; return }
    $processId = [int](Get-Content $pidFile -Raw)
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    if (-not $process) { Write-Ok "$Name (pid $processId) already stopped"; Remove-Item $pidFile -Force; return }
    if ($process.CommandLine -notlike "*$Expected*") {
        Write-Warn2 "$Name pid $processId is no longer the RightsFlow process; leaving it alone"
        Remove-Item $pidFile -Force
        return
    }
    $tree = Get-Tree $processId
    foreach ($id in @($tree) + $processId) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
    Remove-Item $pidFile -Force
    Write-Ok "$Name stopped (pid $processId and $(@($tree).Count) child process(es))"
}

Write-Step 'Stopping local automation services'
Stop-Recorded 'web' 'npm run dev'
Stop-Recorded 'api' 'uvicorn app.main:app'
if (-not $KeepN8n) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-n8n.ps1') }
