param([ValidateSet('Start','Stop','Restart','Status')][string]$Action = 'Start', [switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$xrouterRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$xrouterServer = Join-Path $xrouterRoot 'custom-server.js'
$xrouterPort = 20128
foreach ($xrouterLine in Get-Content -LiteralPath (Join-Path $xrouterRoot '.env') -ErrorAction SilentlyContinue) {
    if ($xrouterLine -match '^PORT=(\d+)$') { $xrouterPort = [int]$Matches[1] }
}
$xrouterUrl = 'http://127.0.0.1:' + $xrouterPort
$xrouterLogDir = Join-Path $xrouterRoot 'logs'
New-Item -ItemType Directory -Path $xrouterLogDir -Force | Out-Null
$xrouterPidFile = Join-Path $xrouterRoot 'data/server.pid'
$xrouterListeners = @(Get-NetTCPConnection -State Listen -LocalPort $xrouterPort -ErrorAction SilentlyContinue)
$xrouterProcess = $null
if ($xrouterListeners.Count -gt 0) {
    $xrouterProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($xrouterListeners[0].OwningProcess)"
    if ($xrouterProcess.Name -ne 'node.exe' -or -not $xrouterProcess.CommandLine.Contains($xrouterServer)) { throw 'This port belongs to another application. No process was changed.' }
}
if ($Action -eq 'Status') {
    if ($xrouterProcess) {
        $xrouterHealth = Invoke-RestMethod -Uri ($xrouterUrl + '/api/health') -TimeoutSec 5
        [pscustomobject]@{ Running = [bool]$xrouterHealth.ok; Port = $xrouterPort; ProcessId = $xrouterProcess.ProcessId; Url = $xrouterUrl }
    } else { [pscustomobject]@{ Running = $false; Port = $xrouterPort; Url = $xrouterUrl } }
    exit 0
}
if ($Action -in @('Stop','Restart') -and $xrouterProcess) {
    Stop-Process -Id $xrouterProcess.ProcessId
    Start-Sleep -Milliseconds 500
    $xrouterProcess = $null
    if (Test-Path -LiteralPath $xrouterPidFile) { Remove-Item -LiteralPath $xrouterPidFile }
}
if ($Action -eq 'Stop') { Write-Output 'X Router stopped.'; exit 0 }
if (-not $xrouterProcess) {
    $xrouterNode = (Get-Command node.exe -ErrorAction Stop).Source
    $xrouterStarted = Start-Process -FilePath $xrouterNode -ArgumentList @('--expose-gc','--max-old-space-size=768',('"' + $xrouterServer + '"')) -WorkingDirectory $xrouterRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $xrouterLogDir 'server.log') -RedirectStandardError (Join-Path $xrouterLogDir 'server-error.log') -PassThru
    Set-Content -LiteralPath $xrouterPidFile -Value $xrouterStarted.Id
}
$xrouterReady = $false
for ($xrouterAttempt = 0; $xrouterAttempt -lt 60; $xrouterAttempt++) {
    try { if ((Invoke-RestMethod -Uri ($xrouterUrl + '/api/health') -TimeoutSec 2).ok) { $xrouterReady = $true; break } } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $xrouterReady) { throw 'X Router did not start. See logs/server-error.log.' }
if ($OpenBrowser) { Start-Process ($xrouterUrl + '/dashboard') }
Write-Output ('X Router ready: ' + $xrouterUrl)
