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
        'tests/wifi_gateway_contract.cjs',
        'tests/scope_filter_test.cjs',
        'tests/manual_pwm_test.cjs',
        'tests/current_sampling_contract.cjs',
        'tests/basic_calibration_test.cjs',
        'tests/outer_tuning_contract.cjs',
        'tests/position_current_authority.cjs',
        'tests/remote_motion_lease_test.mjs',
        'tests/single_usb_step_quality_test.cjs',
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
