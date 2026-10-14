<#
.SYNOPSIS
  Activates (publishes) or deactivates the five RightsFlow business workflows,
  so their schedules run. Requires explicit confirmation of the organization.

.DESCRIPTION
  Safety checks before activating:
  - this instance has a recorded connection (scripts\setup-n8n-automation.ps1);
  - -OrganizationId equals the connected organization (prevents activating for
    the wrong organization);
  - the stored key is accepted by the API for this instance (not expired,
    revoked or bound elsewhere) and is not about to expire (critical);
  - test-mode connections or "n8n E2E" organizations are refused unless
    -AllowTestOrganization is given.
  n8n is restarted so the server registers the schedules.

.EXAMPLE
  scripts\activate-n8n-workflows.ps1 -OrganizationId 0b5c...-... -Confirm
  scripts\activate-n8n-workflows.ps1 -Deactivate
#>
param(
    [string]$OrganizationId,
    [switch]$Confirm,
    [switch]$Deactivate,
    [switch]$AllowTestOrganization,
    [string[]]$Workflows
)

. "$PSScriptRoot\n8n-common.ps1"
$targets = if ($Workflows) { $Workflows } else { $BusinessWorkflowIds }

if (-not $Deactivate) {
    $connection = Get-N8nConnection
    if (-not $connection) { Write-Fail 'No connection recorded. Run scripts\setup-n8n-automation.ps1 first.'; exit 1 }
    if (-not $OrganizationId -or -not $Confirm) {
        Write-Fail "Activation needs explicit authorization: -OrganizationId $($connection.organization_id) -Confirm"
        Write-Host "  Connected organization: '$($connection.organization_name)' ($($connection.mode) mode)" -ForegroundColor Yellow
        exit 1
    }
    if ($OrganizationId -ne $connection.organization_id) {
        Write-Fail "-OrganizationId does not match the connected organization '$($connection.organization_name)' ($($connection.organization_id))."
        exit 1
    }
    $isTest = $connection.mode -eq 'test' -or $connection.organization_name -like 'n8n E2E *'
    if ($isTest -and -not $AllowTestOrganization) {
        Write-Fail "'$($connection.organization_name)' is a test connection; refusing to activate (use -AllowTestOrganization for test instances)."
        exit 1
    }
    $token = (Get-Content (Join-Path $N8nSecrets 'automation-key.txt') -Raw).Trim()
    $who = Invoke-AutomationApi -Token $token -Path '/api/v1/automation/whoami' -WithInstance
    if ($who.Status -ne 200) { Write-Fail "The stored key is not usable by this instance (HTTP $($who.Status)); fix that first (scripts\show-n8n-config.ps1)."; exit 1 }
    if ($who.Body.organization_id -ne $OrganizationId) { Write-Fail 'The stored key belongs to another organization than the recorded connection.'; exit 1 }
    if ($who.Body.expiry_level -eq 'critical') { Write-Fail "The key expires in $($who.Body.days_until_expiry) day(s); rotate it before activating."; exit 1 }
}

$wasRunning = Test-HttpOk "http://127.0.0.1:$N8nPort/healthz"
if ($wasRunning) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-n8n.ps1') }
$failures = 0
try {
    foreach ($id in $targets) {
        $command = if ($Deactivate) { 'unpublish:workflow' } else { 'publish:workflow' }
        $code = Invoke-N8nCli $command "--id=$id"
        if ($code -ne 0) { Write-Fail "$command $id failed (exit $code)"; $failures++ } else { Write-Ok "$(if ($Deactivate) { 'Deactivated' } else { 'Activated' }) $id" }
    }
} finally {
    if ($wasRunning) { & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-n8n.ps1') }
}
if ($failures) { exit 1 }
Write-Host "`nActive workflows: $((Get-ActiveWorkflowIds) -join ', ')" -ForegroundColor Green
