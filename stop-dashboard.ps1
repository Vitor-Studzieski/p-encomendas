$ErrorActionPreference = "Stop"

$pidPath = Join-Path $PSScriptRoot ".dashboard-server.pid"
if (!(Test-Path -LiteralPath $pidPath)) {
  Write-Output "O servidor local da dashboard não está registrado como iniciado."
  exit 0
}

$serverPid = [int](Get-Content -LiteralPath $pidPath -Raw)
$process = Get-CimInstance Win32_Process -Filter "ProcessId = $serverPid" -ErrorAction SilentlyContinue
$vitePath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "node_modules\vite\bin\vite.js"))
if ($process -and $process.CommandLine -like "*$vitePath*") {
  Stop-Process -Id $serverPid -ErrorAction SilentlyContinue
}

Remove-Item -LiteralPath $pidPath -ErrorAction SilentlyContinue
Write-Output "Dashboard local encerrada."
