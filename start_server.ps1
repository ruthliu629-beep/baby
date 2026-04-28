$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$python = "C:\Python314\python.exe"
$logDir = Join-Path $root ".runtime"
$outLog = Join-Path $logDir "server.out.log"
$errLog = Join-Path $logDir "server.err.log"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

$existing = Get-NetTCPConnection -LocalPort 4173 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -ExpandProperty OwningProcess -Unique

if ($existing) {
  foreach ($processId in $existing) {
    try {
      Stop-Process -Id $processId -Force -ErrorAction Stop
    } catch {
    }
  }
  Start-Sleep -Milliseconds 600
}

Start-Process -FilePath $python `
  -ArgumentList "server.py" `
  -WorkingDirectory $root `
  -RedirectStandardOutput $outLog `
  -RedirectStandardError $errLog `
  -WindowStyle Hidden

Start-Sleep -Seconds 2

try {
  $response = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:4173" -TimeoutSec 5
  Write-Output ("READY " + $response.StatusCode)
} catch {
  Write-Output "FAILED"
  if (Test-Path $errLog) {
    Get-Content $errLog
  }
}
