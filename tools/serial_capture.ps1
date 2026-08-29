param(
  [Parameter(Mandatory = $true)][string]$Port,
  [Parameter(Mandatory = $true)][string]$CommandList,
  [double]$Seconds = 2.0,
  [string]$Output = ""
)

$Commands = $CommandList -split "\|"

$serial = New-Object System.IO.Ports.SerialPort $Port,115200,None,8,one
$serial.ReadTimeout = 40
$serial.DtrEnable = $false
$serial.RtsEnable = $false
$serial.Open()
$lines = [System.Collections.Generic.List[string]]::new()
function Add-TextLines([string]$text) {
  if (-not $text) { return }
  foreach ($line in ($text -split "`r?`n")) {
    if ($line) { $lines.Add($line) }
  }
}
try {
  Start-Sleep -Milliseconds 800
  $boot = $serial.ReadExisting()
  Add-TextLines $boot
  foreach ($command in $Commands) {
    $serial.Write($command + "`n")
    Start-Sleep -Milliseconds 100
    $reply = $serial.ReadExisting()
    Add-TextLines $reply
  }
  $end = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $end) {
    $reply = $serial.ReadExisting()
    Add-TextLines $reply
    Start-Sleep -Milliseconds 10
  }
  $reply = $serial.ReadExisting()
  Add-TextLines $reply
}
finally {
  if ($serial.IsOpen) { $serial.Write("stop`n"); Start-Sleep -Milliseconds 80; $serial.Write("stream off`n"); $serial.Close() }
}

if ($Output) { $lines | Set-Content -LiteralPath $Output -Encoding UTF8 }
$lines | ForEach-Object { $_ }
