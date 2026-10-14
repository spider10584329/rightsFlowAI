<#
.SYNOPSIS
  Stops the RightsFlow AI n8n instance started by scripts\start-n8n.ps1.

.DESCRIPTION
  Only stops the process recorded in n8n.pid, and only if its command line is
  the RightsFlow n8n runtime (plus that process's own child processes, such as
  n8n's task runner). Unrelated node.exe processes are never touched.
#>
. "$PSScriptRoot\n8n-common.ps1"

function Get-ChildProcessIds([int]$ParentId) {
    $ids = @()
    foreach ($child in Get-CimInstance Win32_Process -Filter "ParentProcessId=$ParentId") {
        $ids += Get-ChildProcessIds $child.ProcessId
        $ids += $child.ProcessId
    }
    return $ids
}

if (-not (Test-Path $N8nPidFile)) {
    Write-Warn2 'No n8n.pid file: n8n was not started by start-n8n.ps1 (nothing to stop).'
    exit 0
}
$processId = [int](Get-Content $N8nPidFile -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
if (-not $process) {
    Write-Ok "n8n (pid $processId) is not running."
    Remove-Item $N8nPidFile -Force
    exit 0
}
if ($process.CommandLine -notlike "*$N8nRuntime*") {
    Write-Fail "pid $processId is not the RightsFlow n8n runtime; refusing to stop it."
    Remove-Item $N8nPidFile -Force
    exit 1
}
Write-Step "Stopping n8n (pid $processId)"
$children = Get-ChildProcessIds $processId
Stop-Process -Id $processId -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Process -Id $processId -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
foreach ($id in @($processId) + $children) {
    if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
}
Remove-Item $N8nPidFile -Force
Write-Ok 'n8n stopped.'
