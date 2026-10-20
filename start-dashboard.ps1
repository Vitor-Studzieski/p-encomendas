$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$pidPath = Join-Path $projectRoot ".dashboard-server.pid"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
if (!(Test-Path -LiteralPath $vitePath)) {
  throw "Dependências ausentes. Execute npm install dentro da pasta da dashboard."
}

$listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 8766 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8766/api/auth/session" -TimeoutSec 3
    if ($health -and $health.authenticated -is [bool]) {
      Set-Content -LiteralPath $pidPath -Value $listener.OwningProcess -NoNewline
      Write-Output "Dashboard já está rodando em http://127.0.0.1:8766/"
      exit 0
    }
  } catch { }
  throw "A porta 8766 já está sendo usada por outro processo."
}

$stdoutPath = Join-Path $env:TEMP "order-dashboard.stdout.log"
$stderrPath = Join-Path $env:TEMP "order-dashboard.stderr.log"
$arguments = @($vitePath, "--host", "127.0.0.1", "--port", "8766", "--strictPort")
$process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
Set-Content -LiteralPath $pidPath -Value $process.Id -NoNewline

for ($attempt = 0; $attempt -lt 20; $attempt++) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8766/api/auth/session" -TimeoutSec 2
    if ($health -and $health.authenticated -is [bool]) {
      Write-Output "Dashboard rodando em http://127.0.0.1:8766/"
      exit 0
    }
  } catch { }
  if ($process.HasExited) { break }
  Start-Sleep -Milliseconds 500
}

if (!$process.HasExited) { Stop-Process -Id $process.Id -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
throw "Não foi possível iniciar a dashboard. Consulte $stderrPath. A rota da sessão não respondeu como esperado."
