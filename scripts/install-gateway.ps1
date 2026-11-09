# Cài OCEAN Relay Gateway (chạy cùng máy với MT5). PowerShell Administrator.
# Dùng: .\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -EaKey <OCEAN_EA_KEY>
param(
  [Parameter(Mandatory)][string]$ServerUrl,
  [Parameter(Mandatory)][string]$EaKey,
  [string]$InstallDir = "$env:ProgramFiles\OceanRelayGateway",
  [string]$Tfs = 'M3,M5,M15,H1',
  [string]$SymbolMap = ''
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) { throw 'Hãy chạy PowerShell bằng quyền Administrator.' }
if ($EaKey.Length -lt 24) { throw 'EaKey quá ngắn (>= 24 ký tự, trùng OCEAN_EA_KEY của Server).' }
if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl phải bắt đầu bằng http:// hoặc https://' }
$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$src\dist\gateway.mjs")) { throw "Không thấy $src\dist\gateway.mjs." }
$node = if (Test-Path "$src\node.exe") { "$src\node.exe" } else { (Get-Command node -ErrorAction Stop).Source }

Stop-ScheduledTask -TaskName 'Ocean Relay Gateway' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*gateway.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item "$src\dist\gateway.mjs" $InstallDir -Force
Copy-Item $node "$InstallDir\node.exe" -Force
$envFile = "$InstallDir\gateway.env"
@"
OCEAN_SERVER_URL=$ServerUrl
OCEAN_EA_KEY=$EaKey
OCEAN_GW_PORT=47800
OCEAN_TFS=$Tfs
OCEAN_SYMBOL_MAP=$SymbolMap
"@ | Set-Content -Encoding ASCII $envFile
icacls $envFile /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' | Out-Null

$name = 'Ocean Relay Gateway'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$InstallDir\node.exe" -Argument 'gateway.mjs' -WorkingDirectory $InstallDir
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name

# Chép EA vào mọi terminal MT5 của người dùng hiện tại và biên dịch (best-effort; không được thì làm tay theo hướng dẫn cuối).
$ea = "$src\ea\OceanRelay.mq5"
$compiled = 0; $copied = 0
$roots = @("$env:APPDATA\MetaQuotes\Terminal")
# Bộ cài chạy bằng Administrator: thêm hồ sơ của các user khác (VPS thường chỉ có một user).
Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue | ForEach-Object { $roots += "$($_.FullName)\AppData\Roaming\MetaQuotes\Terminal" }
foreach ($root in ($roots | Select-Object -Unique)) {
  Get-ChildItem $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $dst = "$($_.FullName)\MQL5\Experts"
    if (-not ((Test-Path $dst) -and (Test-Path $ea))) { return }
    Copy-Item $ea $dst -Force; $copied++; Write-Host "Đã chép EA vào $dst"
    # origin.txt trỏ tới thư mục cài MT5 (có metaeditor64.exe).
    $origin = Join-Path $_.FullName 'origin.txt'
    if (Test-Path $origin) {
      $inst = (Get-Content $origin -Raw -Encoding Unicode).Trim()
      $me = Join-Path $inst 'metaeditor64.exe'
      if (Test-Path $me) {
        Start-Process -FilePath $me -ArgumentList "/compile:`"$dst\OceanRelay.mq5`"", '/log' -Wait -WindowStyle Hidden
        if (Test-Path "$dst\OceanRelay.ex5") { $compiled++; Write-Host 'Đã biên dịch EA (OceanRelay.ex5).' }
      }
    }
  }
}
if ($copied -eq 0) { Write-Host "Chưa thấy thư mục MT5. Mở MT5 một lần, hoặc chép tay $ea vào MQL5\Experts." }
Write-Host "`nGateway đang chạy ở 127.0.0.1:47800 (log: $env:ProgramData\OceanRelayGateway\logs\gateway.log)."
Write-Host "Việc còn lại trong MT5 (làm một lần):"
Write-Host "  1) Tools > Options > Expert Advisors > Allow WebRequest > thêm  http://127.0.0.1:47800"
if ($compiled -eq 0 -and $copied -gt 0) { Write-Host "  2) MetaEditor: mở OceanRelay.mq5 và bấm Compile (F7)" } else { Write-Host "  2) Kéo EA OceanRelay từ Navigator lên MỘT chart (nếu chưa thấy: chuột phải Refresh)" }
Write-Host "  3) Mặc định EA CHỈ THEO DÕI. Khi sẵn sàng, bật InpAllowTrading=true (thử trên DEMO trước)."
