<#
.SYNOPSIS
  Installs the pinned n8n release natively (npm, no Docker) for RightsFlow AI.

.DESCRIPTION
  - Verifies Node.js/npm against n8n's engine requirement (n8n 2.x needs Node >= 24
    for this release; n8n's docs support Node 20.19 - 24.x for npm installs).
  - Installs n8n into %LOCALAPPDATA%\RightsFlowAI\n8n\runtime from
    automation\n8n\runtime\package.json (exact version pin). Nothing is installed
    globally and the system Node.js installation is not modified.
  - Creates the data, log, inbox and secrets folders and a one-time encryption key.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-n8n.ps1
#>
param([switch]$Force)

. "$PSScriptRoot\n8n-common.ps1"

Write-Step 'Checking prerequisites'
$nodeVersion = (& node -v) 2>$null
if (-not $nodeVersion) { Write-Fail 'Node.js is not installed or not on PATH.'; exit 1 }
$major = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($major -lt 24 -or $major -gt 24) {
    Write-Fail "n8n $N8nVersion requires Node.js 24.x; found $nodeVersion. Not changing your Node installation."
    exit 1
}
Write-Ok "Node.js $nodeVersion"
Write-Ok ("npm " + (& npm -v))

Initialize-N8nFolders
Initialize-N8nEnvFile
Write-Ok "Data folder: $N8nData"

$installed = $null
$pkg = Join-Path $N8nRuntime 'node_modules\n8n\package.json'
if (Test-Path $pkg) { $installed = (Get-Content $pkg -Raw | ConvertFrom-Json).version }
if ($installed -eq $N8nVersion -and -not $Force) {
    Write-Ok "n8n $installed already installed in $N8nRuntime"
    exit 0
}

Write-Step "Installing n8n $N8nVersion into $N8nRuntime (this takes several minutes)"
if (-not (Test-Path $N8nRuntime)) { New-Item -ItemType Directory -Path $N8nRuntime | Out-Null }
Copy-Item (Join-Path $RepoRoot 'automation\n8n\runtime\package.json') (Join-Path $N8nRuntime 'package.json') -Force
Push-Location $N8nRuntime
try {
    # n8n has a large dependency tree; retry transient network failures (ECONNRESET etc.).
    $attempt = 0
    do {
        $attempt++
        & npm install --omit=dev --no-audit --no-fund --loglevel=error `
            --fetch-retries=6 --fetch-retry-mintimeout=20000 --fetch-retry-maxtimeout=180000
        $code = $LASTEXITCODE
        if ($code -ne 0) { Write-Warn2 "npm install attempt $attempt failed (exit $code)" }
    } while ($code -ne 0 -and $attempt -lt 3)
    if ($code -ne 0) { Write-Fail "npm install failed after $attempt attempts (exit $code)"; exit $code }
} finally {
    Pop-Location
}
$installed = (Get-Content $pkg -Raw | ConvertFrom-Json).version
if ($installed -ne $N8nVersion) { Write-Fail "Expected n8n $N8nVersion, found $installed"; exit 1 }
Write-Ok "n8n $installed installed"
