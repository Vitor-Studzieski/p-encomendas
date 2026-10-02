$ErrorActionPreference = "Stop"

$serverPath = Join-Path $PSScriptRoot "server.js"
$pidPath = Join-Path $PSScriptRoot ".dashboard-server.pid"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source

$listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  try {
    $health = Invoke-WebRequest -Uri "http://127.0.0.1:8766/_health" -UseBasicParsing -TimeoutSec 2
    if ($health.StatusCode -eq 200 -and $health.Content -eq "ok") {
      Set-Content -Path $pidPath -Value $listener.OwningProcess -NoNewline
      Write-Output "Dashboard já está rodando em http://127.0.0.1:8766/"
      exit 0
    }
  } catch { }

  throw "A porta 8766 já está sendo usada por outro processo."
}

$stdoutPath = Join-Path $env:TEMP "order-dashboard.stdout.log"
$stderrPath = Join-Path $env:TEMP "order-dashboard.stderr.log"
$process = Start-Process -FilePath $nodePath -ArgumentList @($serverPath) -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
Set-Content -Path $pidPath -Value $process.Id -NoNewline

Start-Sleep -Milliseconds 700
try {
  $health = Invoke-WebRequest -Uri "http://127.0.0.1:8766/_health" -UseBasicParsing -TimeoutSec 3
  if ($health.StatusCode -ne 200 -or $health.Content -ne "ok") {
    throw "O servidor não respondeu como esperado."
  }
} catch {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
  throw "Não foi possível iniciar a dashboard. Consulte $stderrPath. $($_.Exception.Message)"
}

Write-Output "Dashboard rodando em http://127.0.0.1:8766/"
