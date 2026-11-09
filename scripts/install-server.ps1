# Cài Ocean Relay Server thành tác vụ chạy lúc khởi động máy (Windows, chạy bằng PowerShell Administrator).
# Dùng:  .\install-server.ps1            (thư mục cài mặc định C:\Program Files\OceanRelay)
param([string]$InstallDir = "$env:ProgramFiles\OceanRelay", [int]$Port = 8090)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) { throw 'Hãy chạy PowerShell bằng quyền Administrator.' }

$src = Split-Path -Parent $PSScriptRoot            # thư mục gói phát hành (chứa dist, ui, node.exe)
if (-not (Test-Path "$src\dist\server.mjs")) { throw "Không thấy $src\dist\server.mjs. Hãy chạy từ gói đã build (npm run pack)." }
$node = if (Test-Path "$src\node.exe") { "$src\node.exe" } else { (Get-Command node -ErrorAction Stop).Source }
$ver = [version](& $node -p "process.versions.node")
if ($ver -lt [version]'22.13.0') { throw "Cần Node 22.13 trở lên (đang là $ver)." }

New-Item -ItemType Directory -Force $InstallDir, "$env:ProgramData\OceanRelay" | Out-Null
Copy-Item "$src\dist", "$src\ui" $InstallDir -Recurse -Force
Copy-Item $node "$InstallDir\node.exe" -Force

function New-Secret([int]$bytes = 24) { $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); -join ($b | ForEach-Object { $_.ToString('x2') }) }
$envFile = "$InstallDir\server.env"
if (-not (Test-Path $envFile)) {
  @"
OCEAN_PORT=$Port
OCEAN_HOST=127.0.0.1
OCEAN_DB=$env:ProgramData\OceanRelay\ocean.db
OCEAN_UI_DIR=$InstallDir\ui
OCEAN_WEBHOOK_KEY=$(New-Secret)
OCEAN_GATEWAY_TOKEN=$(New-Secret)
OCEAN_ADMIN_TOKEN=$(New-Secret 12)
OCEAN_MAX_AGE_SEC=120
OCEAN_DEDUPE_SEC=300
"@ | Set-Content -Encoding ASCII $envFile
  # Chỉ SYSTEM và Administrators đọc được file chứa bí mật.
  icacls $envFile /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null
}

$name = 'Ocean Relay Server'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$InstallDir\node.exe" -Argument 'dist\server.mjs' -WorkingDirectory $InstallDir
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName $name

Write-Host "`nĐã cài và chạy. Mở http://127.0.0.1:$Port"
Write-Host "Bí mật nằm trong $envFile (chỉ Administrator đọc được):"
Write-Host "  OCEAN_ADMIN_TOKEN   -> đăng nhập giao diện"
Write-Host "  OCEAN_GATEWAY_TOKEN -> dán vào install-gateway.ps1"
Write-Host "  OCEAN_WEBHOOK_KEY   -> URL webhook TradingView: https://<tunnel>/webhook?key=<giá trị này>"
