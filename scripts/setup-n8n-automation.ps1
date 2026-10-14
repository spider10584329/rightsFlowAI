<#
.SYNOPSIS
  Connects this n8n instance to RightsFlow AI: verifies and stores the automation
  key, creates the n8n credential and imports the workflows (all INACTIVE).

.DESCRIPTION
  1. Create an automation key in RightsFlow (Settings > Automation, admin only).
  2. Run this script with the key. It:
     - verifies the key (GET /api/v1/automation/whoami) *with this instance's id*,
       so a key bound to another n8n instance is detected here, with recovery steps;
     - refuses to switch this instance to a different organization unless
       -AllowOrganizationChange is given (no silent reassignment);
     - keeps the previous key as secrets\automation-key.previous.txt;
     - stores the key (current-user ACL) and records the connection in
       secrets\connection.json (organization, key id, mode; no secrets);
     - creates/updates the n8n credential "RightsFlow automation key" (encrypted by n8n);
     - imports the six workflows with the API URL, inbox folder and instance id
       filled in, and publishes only the error handler (it has no schedule).
  Business workflows stay inactive. Activate them explicitly with
  scripts\activate-n8n-workflows.ps1 once you have authorized it.

  Key rotation: rotate in Settings > Automation (grace period), then run this
  script with the new key. Same organization, so no extra switch is needed.

.PARAMETER Token
  The automation key (rfa_...). If omitted, the stored key is reused. Keep it out of
  shell history:  $key = Read-Host 'Automation key'; ...\setup-n8n-automation.ps1 -Token $key

.PARAMETER Mode
  'operational' (default) or 'test'. Test instances live in a separate
  RIGHTSFLOW_N8N_HOME (see scripts\n8n_live_test.py).
#>
param(
    [string]$Token,
    [ValidateSet('operational', 'test')][string]$Mode = 'operational',
    [switch]$AllowOrganizationChange,
    [switch]$SkipWorkflows
)

. "$PSScriptRoot\n8n-common.ps1"

Initialize-N8nFolders
Initialize-N8nEnvFile
if (-not (Test-Path $N8nBin)) { Write-Fail 'n8n is not installed (scripts\install-n8n.ps1).'; exit 1 }

$keyFile = Join-Path $N8nSecrets 'automation-key.txt'
if (-not $Token) {
    if (-not (Test-Path $keyFile)) { Write-Fail 'No -Token given and no stored key.'; exit 1 }
    $Token = (Get-Content $keyFile -Raw).Trim()
}
if ($Token -notmatch '^rfa_[0-9a-f]{16}_[A-Za-z0-9_\-]{40,64}$') { Write-Fail 'That does not look like a RightsFlow automation key (rfa_...).'; exit 1 }
$instanceId = Get-N8nInstanceId

Write-Step "Verifying the key with the API ($ApiBaseUrl) as instance $($instanceId.Substring(0, 11))..."
$who = Invoke-AutomationApi -Token $Token -Path '/api/v1/automation/whoami' -WithInstance
if ($who.Status -eq 409 -and $who.Body.error.code -eq 'instance_conflict') {
    $d = $who.Body.error.details
    Write-Fail "This key is bound to another n8n instance ($($d.bound_instance), last seen $($d.bound_instance_last_seen_at), stale: $($d.bound_instance_stale))."
    Write-Host '  Recovery: if that instance is gone (data folder reset or moved), an admin opens' -ForegroundColor Yellow
    Write-Host '  Settings > Automation > Keys > Release instance, then re-run this script.' -ForegroundColor Yellow
    Write-Host '  If the other instance is still running, rotate or create a separate key instead.' -ForegroundColor Yellow
    exit 1
}
if ($who.Status -ne 200) {
    $code = if ($who.Body) { $who.Body.error.code } else { $who.Error }
    Write-Fail "The API rejected the key or is unreachable (HTTP $($who.Status): $code)."
    exit 1
}
$org = $who.Body
Write-Ok "Key $($org.key_id) for organization '$($org.organization_name)' ($($org.organization_id)); expiry: $($org.expiry_level)"

$current = Get-N8nConnection
if ($current -and $current.organization_id -ne $org.organization_id -and -not $AllowOrganizationChange) {
    Write-Fail "This n8n instance serves '$($current.organization_name)' ($($current.organization_id)) in $($current.mode) mode."
    Write-Host "  Refusing to switch it to '$($org.organization_name)'. Re-run with -AllowOrganizationChange if intended." -ForegroundColor Yellow
    exit 1
}
if ($Mode -eq 'operational' -and $org.organization_name -like 'n8n E2E *') {
    Write-Warn2 "'$($org.organization_name)' looks like a throwaway test organization; use -Mode test for test instances."
}

$wasRunning = Test-HttpOk "http://127.0.0.1:$N8nPort/healthz"
if ($wasRunning) {
    if (-not (Test-Path $N8nPidFile)) {
        Write-Fail "n8n on port $N8nPort was not started by scripts\start-n8n.ps1; stop it first."
        exit 1
    }
    & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'stop-n8n.ps1')
}

$failed = $false
$importDir = Join-Path $N8nSecrets 'import'
if (Test-Path $importDir) { Remove-Item $importDir -Recurse -Force }
New-Item -ItemType Directory -Path $importDir | Out-Null
try {
    Write-Step 'Creating the n8n credential "RightsFlow automation key"'
    $credential = @(@{
        id = 'RfAutomationKey1'
        name = 'RightsFlow automation key'
        type = 'httpHeaderAuth'
        data = @{ name = 'Authorization'; value = "Bearer $Token" }
    })
    $credFile = Join-Path $importDir 'credential.json'
    Write-Utf8NoBom $credFile (ConvertTo-Json -InputObject $credential -Depth 5)
    $code = Invoke-N8nCli 'import:credentials' "--input=$credFile"
    Remove-Item $credFile -Force
    if ($code -ne 0) { throw "Credential import failed (exit $code)" }
    Write-Ok 'Credential stored (encrypted by n8n)'

    if (Test-Path $keyFile) {
        $previous = (Get-Content $keyFile -Raw).Trim()
        if ($previous -ne $Token) {
            $backup = Join-Path $N8nSecrets 'automation-key.previous.txt'
            Set-Content -Path $backup -Value $previous -Encoding ascii -NoNewline
            Protect-UserOnly $backup
        }
    }
    Set-Content -Path $keyFile -Value $Token -Encoding ascii -NoNewline
    Protect-UserOnly $keyFile

    if (-not $SkipWorkflows) {
        Write-Step 'Importing workflows (inactive)'
        $inbox = $N8nInbox.Replace('\', '/')
        $wfDir = Join-Path $importDir 'workflows'
        New-Item -ItemType Directory -Path $wfDir | Out-Null
        foreach ($file in Get-ChildItem (Join-Path $RepoRoot 'automation\n8n\workflows\*.json')) {
            $text = (Get-Content $file.FullName -Raw).
                Replace('__RIGHTSFLOW_API_URL__', $ApiBaseUrl).
                Replace('__RIGHTSFLOW_INBOX__', $inbox).
                Replace('__RIGHTSFLOW_N8N_URL__', "http://127.0.0.1:$N8nPort").
                Replace('__RIGHTSFLOW_INSTANCE_ID__', $instanceId)
            Write-Utf8NoBom (Join-Path $wfDir $file.Name) $text
        }
        $active = Get-ActiveWorkflowIds
        $code = Invoke-N8nCli 'import:workflow' '--separate' "--input=$wfDir"
        if ($code -ne 0) { throw "Workflow import failed (exit $code)" }
        Write-Ok "Imported $((Get-ChildItem $wfDir).Count) workflows"
        # n8n only runs an *active* error workflow; it has no schedule of its own.
        $code = Invoke-N8nCli 'publish:workflow' '--id=RfWfErrorHandler'
        if ($code -ne 0) { throw "Could not publish the error handler workflow (exit $code)" }
        Write-Ok 'Error handler workflow published'
        # Re-importing must not change which business workflows are active.
        foreach ($id in $BusinessWorkflowIds) {
            if ($active -contains $id) { [void](Invoke-N8nCli 'publish:workflow' "--id=$id") }
        }
    }

    $connection = [ordered]@{
        mode = $Mode
        organization_id = $org.organization_id
        organization_name = $org.organization_name
        credential_id = $org.credential_id
        key_id = $org.key_id
        instance_id = $instanceId
        api_url = $ApiBaseUrl
        n8n_url = "http://localhost:$N8nPort"
        configured_at = (Get-Date).ToUniversalTime().ToString('o')
        configured_by = $env:USERNAME
    }
    Write-Utf8NoBom $N8nConnectionFile ($connection | ConvertTo-Json)
    Write-Ok "Connection recorded: $Mode mode, organization '$($org.organization_name)'"
} catch {
    Write-Fail $_.Exception.Message
    $failed = $true
} finally {
    if (Test-Path $importDir) { Remove-Item $importDir -Recurse -Force }
    if ($wasRunning) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-n8n.ps1')
    }
}
if ($failed) { exit 1 }
Write-Host "`nDone. Business workflows are inactive; activate them with scripts\activate-n8n-workflows.ps1 when authorized." -ForegroundColor Green
