$ErrorActionPreference = 'SilentlyContinue'
$healthUrl = 'http://127.0.0.1:8766/_health'
$startScript = Join-Path $PSScriptRoot 'start-dashboard.ps1'
$logPath = Join-Path $env:TEMP 'order-dashboard-watchdog.log'

while ($true) {
    $healthy = $false
    try {
        $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 3
        $healthy = $response.StatusCode -eq 200 -and $response.Content -eq 'ok'
    } catch { }

    if (-not $healthy) {
        try {
            & $startScript 2>&1 | ForEach-Object {
                Add-Content -LiteralPath $logPath -Value ("{0:u} {1}" -f (Get-Date), $_)
            }
        } catch {
            Add-Content -LiteralPath $logPath -Value ("{0:u} {1}" -f (Get-Date), $_.Exception.Message)
        }
    }

    Start-Sleep -Seconds 30
}
