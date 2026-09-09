param([string]$Node = 'node')
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    & $Node --check web/dashboard.js
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard syntax check failed' }
    # Explicit allowlist: never glob hardware tests or commissioning scripts.
    $checks = @(
        'tests/position_current_authority.cjs',
        'tests/usb_identity_contract.cjs',
        'tests/connect_recovery_contract.cjs',
        'tests/force_lifecycle_contract_test.cjs',
        'tests/interaction_ui_test.cjs'
    )
    foreach ($check in $checks) {
        & $Node $check
        if ($LASTEXITCODE -ne 0) { throw "Offline check failed: $check" }
    }
    Write-Output "PASS: syntax + $($checks.Count) offline contracts; no hardware IO"
} finally {
    Pop-Location
}
