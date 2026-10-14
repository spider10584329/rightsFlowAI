<#
.SYNOPSIS
  Automation smoke test: workflow lint, environment check, backend automation
  tests and (optionally) the live n8n test in the separate TEST instance.

.DESCRIPTION
  1. scripts\diagnostics\n8n_workflow_lint.py  (static checks of the workflow JSON)
  2. scripts\check-n8n.ps1                     (operational instance: ports, services, key)
  3. pytest backend\tests\test_automation*.py  (uses the rightsflow_test database)
  4. -Live: scripts\n8n_live_test.py           (test instance on port 5688; throwaway
     organizations; never touches the operational instance or its credential)
  Exit code 1 when any step fails.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\test-n8n-smoke.ps1
  powershell -ExecutionPolicy Bypass -File scripts\test-n8n-smoke.ps1 -Live
#>
param([switch]$Live, [switch]$SkipCheck)

. "$PSScriptRoot\n8n-common.ps1"
$python = Join-Path $RepoRoot 'backend\.venv\Scripts\python.exe'
$failed = @()

function Invoke-Step([string]$Name, [scriptblock]$Body) {
    Write-Step $Name
    & $Body
    if ($LASTEXITCODE -ne 0) { Write-Fail "$Name failed (exit $LASTEXITCODE)"; $script:failed += $Name }
    else { Write-Ok "$Name passed" }
}

Invoke-Step 'Workflow lint' { & $python (Join-Path $RepoRoot 'scripts\diagnostics\n8n_workflow_lint.py') }
if (-not $SkipCheck) {
    Invoke-Step 'Environment check' { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'check-n8n.ps1') }
}
Push-Location (Join-Path $RepoRoot 'backend')
try {
    Invoke-Step 'Backend automation tests' { & $python -m pytest tests/test_automation.py tests/test_automation_reliability.py -q -p no:cacheprovider }
} finally { Pop-Location }
if ($Live) {
    Invoke-Step 'Live n8n test (test instance)' { & $python (Join-Path $RepoRoot 'scripts\n8n_live_test.py') }
}

Write-Host ''
if ($failed) { Write-Host "Failed: $($failed -join ', ')" -ForegroundColor Red; exit 1 }
Write-Host 'Automation smoke test passed.' -ForegroundColor Green
