param(
    [Parameter(Mandatory = $true)]
    [string]$InstanceId
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$device = Get-PnpDevice -InstanceId $InstanceId -ErrorAction Stop
if ($device.FriendlyName -ne 'USB Composite Device') {
    throw "Unexpected target: $($device.FriendlyName)"
}

Disable-PnpDevice -InstanceId $InstanceId -Confirm:$false -ErrorAction Stop
Start-Sleep -Milliseconds 1200
Enable-PnpDevice -InstanceId $InstanceId -Confirm:$false -ErrorAction Stop
Start-Sleep -Seconds 2

$restored = Get-PnpDevice -InstanceId $InstanceId -ErrorAction Stop
if ($restored.Status -ne 'OK') {
    throw "USB composite device did not recover: $($restored.Status)"
}
