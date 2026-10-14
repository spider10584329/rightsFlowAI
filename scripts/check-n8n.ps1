<#
.SYNOPSIS
  Local diagnostic for the automation environment: required ports, n8n
  environment, n8n, FastAPI, MariaDB and the automation key (expiry level and
  instance binding). Exit code 1 when anything critical is wrong.

.DESCRIPTION
  This path is independent of n8n's own health workflow, so an expired, revoked
  or wrongly bound key is reported even when n8n can no longer authenticate
  (audit N8N-04). Service availability only: run scripts\test-n8n-smoke.ps1 to
  exercise the workflows.
#>
. "$PSScriptRoot\n8n-common.ps1"

$critical = 0
$warnings = 0
function Fail([string]$m) { Write-Fail $m; $script:critical++ }
function Warn([string]$m) { Write-Warn2 $m; $script:warnings++ }

Write-Step "RightsFlow AI automation check ($N8nHome, port $N8nPort)"

# --- environment
$installed = $null
$pkg = Join-Path $N8nRuntime 'node_modules\n8n\package.json'
if (Test-Path $pkg) { $installed = (Get-Content $pkg -Raw | ConvertFrom-Json).version }
if ($installed -eq $N8nVersion) { Write-Ok "n8n $installed installed ($N8nRuntime)" }
elseif ($installed) { Warn "n8n $installed installed; scripts are pinned to $N8nVersion" }
else { Fail 'n8n not installed (scripts\install-n8n.ps1)' }
$nodeMajor = [int](((& node -v) -replace '^v', '').Split('.')[0])
if ($nodeMajor -eq 24) { Write-Ok "Node.js $(& node -v)" } else { Fail "Node.js 24.x required, found $(& node -v)" }
$secrets = Read-EnvFile $N8nEnvFile
if ($secrets['N8N_ENCRYPTION_KEY'] -and $secrets['N8N_ENCRYPTION_KEY'].Length -ge 32) { Write-Ok 'N8N_ENCRYPTION_KEY present (value not shown)' }
else { Fail "N8N_ENCRYPTION_KEY missing or too short in $N8nEnvFile" }
$settingsFile = Join-Path $RepoRoot 'automation\n8n\n8n.settings.env'
if (Test-Path $settingsFile) { Write-Ok 'automation\n8n\n8n.settings.env present' } else { Fail 'automation\n8n\n8n.settings.env missing' }
foreach ($required in 'N8N_BLOCK_ENV_ACCESS_IN_NODE', 'EXECUTIONS_DATA_PRUNE', 'N8N_PYTHON_ENABLED') {
    if (-not (Read-EnvFile $settingsFile)[$required]) { Warn "$required not set in n8n.settings.env" }
}

# --- ports
foreach ($entry in @(@{ Port = 3306; Name = 'MariaDB' }, @{ Port = 8000; Name = 'FastAPI' }, @{ Port = $N8nPort; Name = 'n8n' },
                     @{ Port = $N8nBrokerPort; Name = 'n8n task broker' }, @{ Port = 3000; Name = 'Next.js (optional)' })) {
    $listener = Get-NetTCPConnection -LocalPort $entry.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) {
        $name = (Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        Write-Ok ("port {0,-5} {1}: listening ({2}, {3})" -f $entry.Port, $entry.Name, $listener.LocalAddress, $name)
        if ($entry.Name -like 'n8n*' -and $listener.LocalAddress -notin '127.0.0.1', '::1') { Fail "$($entry.Name) is not bound to localhost only ($($listener.LocalAddress))" }
    } elseif ($entry.Name -like '*optional*') { Write-Warn2 "port $($entry.Port) $($entry.Name): not listening" }
    else { Fail "port $($entry.Port) $($entry.Name): not listening" }
}

# --- services
if (Test-HttpOk "http://127.0.0.1:$N8nPort/healthz") { Write-Ok "n8n healthy: http://localhost:$N8nPort" } else { Fail "n8n not healthy on port $N8nPort (scripts\start-n8n.ps1)" }
if (Test-HttpOk "$ApiBaseUrl/health") { Write-Ok "FastAPI healthy: $ApiBaseUrl" } else { Fail "FastAPI not reachable at $ApiBaseUrl" }

# --- automation key (separate from n8n: works even when n8n's own calls are rejected)
$keyFile = Join-Path $N8nSecrets 'automation-key.txt'
$connection = Get-N8nConnection
if ($connection) { Write-Ok "Connected: '$($connection.organization_name)' in $($connection.mode) mode" } else { Warn 'No connection recorded (scripts\setup-n8n-automation.ps1)' }
if (Test-Path $keyFile) {
    $token = (Get-Content $keyFile -Raw).Trim()
    $health = Invoke-AutomationApi -Token $token -Path '/api/v1/automation/health' -WithInstance
    switch ($health.Status) {
        200 {
            $b = $health.Body
            $credText = "key $($b.credential.key_id): expiry level '$($b.credential.expiry_level)'" + $(if ($null -ne $b.credential.days_until_expiry) { " ($($b.credential.days_until_expiry) day(s) left)" } else { '' })
            if ($b.credential.expiry_level -eq 'critical') { Fail $credText } elseif ($b.credential.expiry_level -eq 'warning') { Warn $credText } else { Write-Ok $credText }
            foreach ($issue in $b.issues) {
                if ($issue.code -eq 'credential_expiring') { continue }
                if ($issue.severity -eq 'critical') { Fail $issue.message } else { Warn $issue.message }
            }
            Write-Ok "Automation health: $($b.status)"
        }
        401 { Fail 'Automation key REJECTED (expired, revoked or invalid): create or rotate it in Settings > Automation, then run scripts\setup-n8n-automation.ps1' }
        409 { Fail "Automation key bound to another n8n instance ($($health.Body.error.details.bound_instance)): see docs\N8N_TROUBLESHOOTING.md" }
        0 { Fail "Automation API unreachable: $($health.Error)" }
        default { Fail "Automation API error HTTP $($health.Status)" }
    }
} else {
    Warn "No automation key stored ($keyFile)"
}

Write-Host ''
if ($critical) { Write-Host "$critical critical problem(s), $warnings warning(s)." -ForegroundColor Red; exit 1 }
if ($warnings) { Write-Host "No critical problems; $warnings warning(s)." -ForegroundColor Yellow; exit 0 }
Write-Host 'All checks passed.' -ForegroundColor Green
