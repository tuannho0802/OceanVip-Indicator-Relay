# Cài OCEAN Relay Server thành tác vụ chạy lúc khởi động máy (Windows, PowerShell Administrator).
# Dùng: .\install-server.ps1 [-InstallDir "C:\Program Files\OceanRelay"] [-Port 8090] [-WorkerUrl https://...workers.dev -SyncKey <>=32 ký tự>]
param([string]$InstallDir = "$env:ProgramFiles\OceanRelay", [int]$Port = 8090, [string]$WorkerUrl = '', [string]$SyncKey = '', [string]$WebhookKey = '')
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) { throw 'Hãy chạy PowerShell bằng quyền Administrator.' }
$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$src\dist\server.mjs")) { throw "Không thấy $src\dist\server.mjs. Hãy chạy từ gói đã build (npm run pack)." }
$node = if (Test-Path "$src\node.exe") { "$src\node.exe" } else { (Get-Command node -ErrorAction Stop).Source }
$env:NODE_SKIP_PLATFORM_CHECK = '1'
$ver = [version](& $node -p "process.versions.node")
if ($ver -lt [version]'22.13.0') { throw "Cần Node 22.13 trở lên (đang là $ver)." }

# Dừng bản cũ trước khi ghi đè (nâng cấp tại chỗ).
Stop-ScheduledTask -TaskName 'Ocean Relay Server' -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

New-Item -ItemType Directory -Force $InstallDir, "$env:ProgramData\OceanRelay\logs" | Out-Null
Copy-Item "$src\dist", "$src\web" $InstallDir -Recurse -Force
Copy-Item "$src\scripts\init-env.ps1" $InstallDir -Force
# Kèm scripts/ea/docs vào thư mục cài: gỡ tác vụ, cài Gateway, kiểm tra VPS và lấy EA đều chạy từ đây (cả khi gỡ bằng bộ cài).
foreach ($d in 'scripts', 'ea', 'docs') { if (Test-Path "$src\$d") { Copy-Item "$src\$d" $InstallDir -Recurse -Force } }
Copy-Item $node "$InstallDir\node.exe" -Force
# Dữ liệu và log: chỉ SYSTEM + Administrators.
icacls "$env:ProgramData\OceanRelay" /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
& "$InstallDir\init-env.ps1" -Dir $InstallDir -Port $Port -WorkerUrl $WorkerUrl -SyncKey $SyncKey -WebhookKey $WebhookKey

@'
@echo off
rem Trình giám sát: chạy OCEAN Relay Server, nếu thoát (lỗi, cập nhật) thì bật lại sau 5 giây.
set "NODE_SKIP_PLATFORM_CHECK=1"
cd /d "%~dp0"
set "OCEAN_ENV_FILE=%~dp0server.env"
:loop
"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0dist\server.mjs"
ping -n 6 127.0.0.1 >nul
goto loop
'@ | Set-Content -Encoding ASCII "$InstallDir\run-server.cmd"

$name = 'Ocean Relay Server'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$InstallDir\run-server.cmd" -WorkingDirectory $InstallDir
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $name

Write-Host "Đang chờ Server lên..."
$up = $false
for ($i = 0; $i -lt 40 -and -not $up; $i++) {
  try { if ((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).status -eq 'ok') { $up = $true } } catch { }
  if (-not $up) { Start-Sleep -Seconds 1 }
}
if ($up) { Write-Host "OK: http://127.0.0.1:$Port  (giao diện công khai, không đăng nhập)" }
else { Write-Host "CHƯA LÊN sau 40 giây. Xem log: $env:ProgramData\OceanRelay\logs\server.log" }
Write-Host "Cấu hình + khóa: $InstallDir\server.env  |  Lệnh xem địa chỉ: `"$InstallDir\node.exe`" `"$InstallDir\dist\server.mjs`" info"
