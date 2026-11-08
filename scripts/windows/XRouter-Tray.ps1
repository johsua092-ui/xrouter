param([switch]$NoOpenBrowser)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$xrouterRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$xrouterCreated = $false
$xrouterMutex = [Threading.Mutex]::new($false, 'Local\PAO-XRouter-Tray', [ref]$xrouterCreated)
$xrouterControl = Join-Path $PSScriptRoot 'XRouter-Control.ps1'
function Invoke-XRouterControl([string]$xrouterAction, [bool]$xrouterOpen = $false) {
    $xrouterArgs = @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$xrouterControl+'"'),'-Action',$xrouterAction)
    if ($xrouterOpen) { $xrouterArgs += '-OpenBrowser' }
    Start-Process -FilePath 'powershell.exe' -ArgumentList $xrouterArgs -WindowStyle Hidden -Wait
}
if (-not $xrouterMutex.WaitOne(0)) {
    if (-not $NoOpenBrowser) { Invoke-XRouterControl 'Start' $true }
    $xrouterMutex.Dispose()
    exit 0
}
$xrouterMenu = New-Object Windows.Forms.ContextMenuStrip
$xrouterStatusItem = $xrouterMenu.Items.Add('กำลังตรวจสถานะ…')
$xrouterStatusItem.Enabled = $false
$xrouterOpenItem = $xrouterMenu.Items.Add('เปิด Dashboard')
$xrouterOpenItem.add_Click({ Invoke-XRouterControl 'Start' $true })
$xrouterRestartItem = $xrouterMenu.Items.Add('เริ่ม X Router ใหม่')
$xrouterRestartItem.add_Click({ Invoke-XRouterControl 'Restart' })
$xrouterStopItem = $xrouterMenu.Items.Add('หยุด X Router')
$script:xrouterKeepRunning = $true
$xrouterStopItem.add_Click({ $script:xrouterKeepRunning = $false; Invoke-XRouterControl 'Stop' })
$xrouterStartItem = $xrouterMenu.Items.Add('เริ่ม X Router')
$xrouterStartItem.add_Click({ $script:xrouterKeepRunning = $true; Invoke-XRouterControl 'Start' })
$xrouterBackupItem = $xrouterMenu.Items.Add('สำรองข้อมูลแบบเข้ารหัส')
$xrouterBackupItem.add_Click({ Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @(('"'+(Join-Path $xrouterRoot 'scripts/local-backup.mjs')+'"')) -WorkingDirectory $xrouterRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $xrouterRoot 'logs/backup.log') -RedirectStandardError (Join-Path $xrouterRoot 'logs/backup-error.log') })
[void]$xrouterMenu.Items.Add('-')
$xrouterExit = $xrouterMenu.Items.Add('ปิดตัวควบคุม (แอปยังทำงานต่อ)')
$xrouterExit.add_Click({ [Windows.Forms.Application]::Exit() })
$xrouterIcon = New-Object Windows.Forms.NotifyIcon
$xrouterIcon.Icon = [Drawing.SystemIcons]::Application
$xrouterIcon.Text = 'X Router'
$xrouterIcon.ContextMenuStrip = $xrouterMenu
$xrouterIcon.Visible = $true
$xrouterIcon.add_DoubleClick({ Invoke-XRouterControl 'Start' $true })
$xrouterPort = 20128
foreach ($xrouterLine in Get-Content -LiteralPath (Join-Path $xrouterRoot '.env') -ErrorAction SilentlyContinue) {
    if ($xrouterLine -match '^PORT=(\d+)$') { $xrouterPort = [int]$Matches[1] }
}
function Update-XRouterTrayStatus {
    $xrouterHealthy = $false
    try { $xrouterHealthy = [bool](Invoke-RestMethod -Uri ('http://127.0.0.1:' + $xrouterPort + '/api/health') -NoProxy -TimeoutSec 2).ok } catch {}
    if ($xrouterHealthy) { $xrouterStatusItem.Text = "กำลังทำงาน · พอร์ต $xrouterPort" }
    else { $xrouterStatusItem.Text = 'เซิร์ฟเวอร์ไม่ตอบสนอง' }
    return $xrouterHealthy
}
$xrouterMenu.add_Opening({ [void](Update-XRouterTrayStatus) })
$xrouterTimer = New-Object Windows.Forms.Timer
$xrouterTimer.Interval = 30000
$xrouterTimer.add_Tick({ if (-not (Update-XRouterTrayStatus) -and $script:xrouterKeepRunning) { Invoke-XRouterControl 'Start' } })
try {
    Invoke-XRouterControl 'Start' (-not $NoOpenBrowser)
    [void](Update-XRouterTrayStatus)
    $xrouterTimer.Start()
    [Windows.Forms.Application]::Run()
} finally { $xrouterTimer.Stop(); $xrouterIcon.Visible = $false; $xrouterIcon.Dispose(); $xrouterMutex.ReleaseMutex(); $xrouterMutex.Dispose() }
