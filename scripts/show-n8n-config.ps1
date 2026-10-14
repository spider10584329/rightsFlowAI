<#
.SYNOPSIS
  Shows which RightsFlow organization this n8n instance is connected to, in
  which mode, the key's expiry level and instance binding, and which workflows
  are active. Never prints the key.
#>
. "$PSScriptRoot\n8n-common.ps1"

Write-Step "n8n instance: $N8nHome (port $N8nPort)"
$connection = Get-N8nConnection
if (-not $connection) {
    Write-Warn2 'No connection recorded (run scripts\setup-n8n-automation.ps1).'
} else {
    $modeText = if ($connection.mode -eq 'test') { 'TEST' } else { 'OPERATIONAL' }
    Write-Ok "Mode: $modeText"
    Write-Ok "Organization: '$($connection.organization_name)' ($($connection.organization_id))"
    Write-Ok "Key id: $($connection.key_id) (configured $($connection.configured_at) by $($connection.configured_by))"
    if ($connection.mode -ne 'test' -and $connection.organization_name -like 'n8n E2E *') {
        Write-Warn2 'An operational instance is connected to a throwaway test organization.'
    }
}
Write-Ok "Instance id: $((Get-N8nInstanceId).Substring(0, 11))..."

$keyFile = Join-Path $N8nSecrets 'automation-key.txt'
if (Test-Path $keyFile) {
    $token = (Get-Content $keyFile -Raw).Trim()
    $who = Invoke-AutomationApi -Token $token -Path '/api/v1/automation/whoami' -WithInstance
    switch ($who.Status) {
        200 {
            $b = $who.Body
            $line = "Key accepted: expiry level '$($b.expiry_level)'" + $(if ($null -ne $b.days_until_expiry) { ", $($b.days_until_expiry) day(s) left" } else { '' })
            if ($b.expiry_level -in 'warning', 'critical') { Write-Warn2 $line } else { Write-Ok $line }
            Write-Ok "Bound to this instance: $($b.this_instance_matches) (last seen $($b.instance_last_seen_at))"
            if ($connection -and $b.organization_id -ne $connection.organization_id) { Write-Fail 'The stored key belongs to a different organization than the recorded connection.' }
        }
        409 { Write-Fail "Key bound to another instance ($($who.Body.error.details.bound_instance)); see docs\N8N_TROUBLESHOOTING.md." }
        401 { Write-Fail 'Key rejected (expired, revoked or invalid): create or rotate it in Settings > Automation.' }
        0 { Write-Fail "API unreachable at $ApiBaseUrl." }
        default { Write-Fail "Unexpected API response HTTP $($who.Status)." }
    }
} else {
    Write-Warn2 'No automation key stored.'
}

if (Test-Path $N8nBin) {
    $active = Get-ActiveWorkflowIds
    foreach ($id in @('RfWfErrorHandler') + $BusinessWorkflowIds) {
        $state = if ($active -contains $id) { 'active' } else { 'inactive' }
        Write-Host ("  {0,-18} {1}" -f $id, $state)
    }
}
