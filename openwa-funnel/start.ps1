$ErrorActionPreference = 'Stop'
$gatewayRoot = $PSScriptRoot
$gatewayData = Join-Path $gatewayRoot '.local'
New-Item -ItemType Directory -Path $gatewayData -Force | Out-Null
$gatewayNode = (Get-Command node -ErrorAction Stop).Source
$gatewayPidFile = Join-Path $gatewayData 'gateway.pid'
$gatewayRunning = $false
if (Test-Path -LiteralPath $gatewayPidFile) {
  $gatewayPid = Get-Content -LiteralPath $gatewayPidFile -Raw
  if ($gatewayPid -match '^\d+$') { $gatewayRunning = $null -ne (Get-Process -Id ([int]$gatewayPid) -ErrorAction SilentlyContinue) }
}
if (-not $gatewayRunning) {
  Start-Process -FilePath $gatewayNode -ArgumentList '--env-file-if-exists=.env gateway.mjs' -WorkingDirectory $gatewayRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $gatewayData 'gateway.log') -RedirectStandardError (Join-Path $gatewayData 'gateway-errors.log') | Out-Null
}
Write-Output 'Private controls: http://127.0.0.1:4341/'
