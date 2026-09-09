param([string]$Session='motor-force-0908',[string]$FileName='20260908-auto-tune-report.json')
Set-StrictMode -Version 3.0
$ErrorActionPreference='Stop'
$raw = agent-browser --session $Session --json eval 'JSON.parse(localStorage.getItem("motor-auto-tune-last-report")||"[]")'
if($LASTEXITCODE -ne 0) {throw 'Browser report extraction failed'}
$result = $raw | ConvertFrom-Json
if(-not $result.success) {throw 'Missing report'}
if($FileName -notmatch '^[a-zA-Z0-9_-]+\.json$') {throw 'Expected JSON basename'}
$destination=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('../evidence/commissioning/'+$FileName)))
[IO.File]::WriteAllText($destination,($result.data.result | ConvertTo-Json -Depth 15),[Text.UTF8Encoding]::new($false))
$result.data.result | Select-Object port,passed,error
