Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
function Send-Board([string]$Port, [string]$Command) {
    $body = @{port=$Port;command=$Command;wait_ack=$true} | ConvertTo-Json
    $result = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/api/send' -Method Post -ContentType application/json -Body $body
    if (-not $result.acknowledged) { throw "No acknowledgment: $Port $Command" }
    $records.Add(@{utc=[DateTime]::UtcNow.ToString('o');port=$Port;command=$Command;reply=$result.reply})
    return [string]$result.reply
}
try {
    $positions = @{}
    foreach ($port in @('COM23','COM4')) {
        $null = Send-Board $port 'stop'
        $status = Send-Board $port 'status'
        if ($status -notmatch 'nFAULT=1 awake=1' -or $status -notmatch 'bus=19\.') { throw "Unexpected supply/awake state: $status" }
        if ($status -notmatch '\bmulti=(-?[\d.]+)deg') { throw 'Missing encoder position' }
        $positions[$port] = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    }
    # Five output degrees of virtual relative displacement, 300 mA ceiling.
    # Equal and opposite spring torques using each board's measured Ke proxy.
    $offset = $positions['COM23'] - $positions['COM4'] + 26.0
    if ([Math]::Abs($offset) -gt 360) { throw 'Offset outside firmware range' }
    $fmt = [Globalization.CultureInfo]::InvariantCulture
    $negative = (-$offset).ToString('F4',$fmt)
    $positive = $offset.ToString('F4',$fmt)
    $null = Send-Board 'COM4' "sync force 1 2.7837 0.05413 0 241.25 4095 1000 $negative"
    $null = Send-Board 'COM23' "sync force 184 3.461538 0.067308 0 300 4095 1000 $positive"
    for ($i=0; $i -lt 20; $i++) {
        foreach ($port in @('COM23','COM4')) { $null = Send-Board $port 'status' }
        Start-Sleep -Milliseconds 100
    }
    foreach ($port in @('COM23','COM4')) { $null = Send-Board $port 'sync status' }
} finally {
    $stopErrors = @()
    foreach ($port in @('COM23','COM4')) {
        foreach ($command in @('stop','sync stop','status')) {
            try { $null = Send-Board $port $command } catch { $stopErrors += $_.Exception.Message }
        }
    }
    $out = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../evidence/commissioning/20260908-force-deflection.json'))
    [IO.File]::WriteAllText($out,($records | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
    if ($stopErrors.Count) { throw ($stopErrors -join '; ') }
}
$records | Where-Object { $_.reply -match 'control=current|SYNC mode=force' } | ConvertTo-Json -Depth 4
