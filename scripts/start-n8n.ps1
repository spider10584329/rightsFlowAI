<#
.SYNOPSIS
  Starts the local n8n instance (http://localhost:5678, bound to 127.0.0.1 only).

.DESCRIPTION
  Runs the pinned n8n from %LOCALAPPDATA%\RightsFlowAI\n8n\runtime as a hidden
  background process with a process-scoped environment. Output goes to
  %LOCALAPPDATA%\RightsFlowAI\n8n\logs. Does nothing if n8n is already running.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\start-n8n.ps1
#>
param([int]$TimeoutSeconds = 120)

. "$PSScriptRoot\n8n-common.ps1"

if (-not (Test-Path $N8nBin)) {
    Write-Fail "n8n is not installed. Run: powershell -ExecutionPolicy Bypass -File scripts\install-n8n.ps1"
    exit 1
}
Initialize-N8nFolders
Initialize-N8nEnvFile

if (Test-HttpOk "http://127.0.0.1:$N8nPort/healthz") {
    Write-Ok "n8n is already running at http://localhost:$N8nPort"
    exit 0
}
if (Test-PortListening $N8nPort) {
    Write-Fail "Port $N8nPort is in use by another program. n8n was not started (nothing was stopped)."
    exit 1
}

Write-Step "Starting n8n $N8nVersion"
$envVars = Get-N8nEnvironment
$saved = @{}
foreach ($k in $envVars.Keys) {
    $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
    [Environment]::SetEnvironmentVariable($k, $envVars[$k], 'Process')
}
try {
    $stdout = Join-Path $N8nLogs 'n8n.stdout.log'
    $stderr = Join-Path $N8nLogs 'n8n.stderr.log'
    # cmd.exe does the redirection: launched via ShellExecute (no -Redirect* here), the
    # background process inherits no handles from this console, so callers that wait
    # on our output (CI, Python, Git Bash) don't hang while n8n keeps running.
    $command = "`"node`" `"$N8nBin`" start > `"$stdout`" 2> `"$stderr`""
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/d', '/c', "`"$command`"") -WorkingDirectory $N8nHome `
        -WindowStyle Hidden -PassThru
} finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
}
Set-Content -Path $N8nPidFile -Value $process.Id -Encoding ascii

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) {
        Write-Fail "n8n exited with code $($process.ExitCode). See $stderr"
        exit 1
    }
    if (Test-HttpOk "http://127.0.0.1:$N8nPort/healthz") {
        Write-Ok "n8n is running at http://localhost:$N8nPort (pid $($process.Id))"
        Write-Ok "Logs: $N8nLogs"
        exit 0
    }
    Start-Sleep -Seconds 2
}
Write-Fail "n8n did not become healthy within $TimeoutSeconds s. See $stdout and $stderr"
exit 1
