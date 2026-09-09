Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$records = [System.Collections.Generic.List[object]]::new()
$deadline = [DateTime]::UtcNow.AddSeconds(25)
while ([DateTime]::UtcNow -lt $deadline) {
    foreach ($port in @('COM23', 'COM4')) {
        foreach ($command in @('status', 'sync status')) {
            $body = @{port=$port;command=$command;wait_ack=$true} | ConvertTo-Json
            $reply = Invoke-RestMethod -Uri 'http://127.0.0.1:8766/api/send' -Method Post -ContentType application/json -Body $body
            $records.Add(@{utc=[DateTime]::UtcNow.ToString('o');port=$port;command=$command;reply=$reply.reply})
        }
    }
    Start-Sleep -Milliseconds 750
}
$outputPath = Join-Path $PSScriptRoot '../evidence/commissioning/20260908-force-live.json'
[System.IO.File]::WriteAllText([System.IO.Path]::GetFullPath($outputPath), ($records | ConvertTo-Json -Depth 4), [System.Text.UTF8Encoding]::new($false))
$records | Select-Object -Last 4 | ConvertTo-Json
