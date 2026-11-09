# Cài Ocean Relay Gateway (chạy cùng máy với MT5). PowerShell Administrator.
# Dùng:  .\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -Token <OCEAN_GATEWAY_TOKEN>
param(
  [Parameter(Mandatory)][string]$ServerUrl,
  [Parameter(Mandatory)][string]$Token,
  [string]$InstallDir = "$env:ProgramFiles\OceanRelayGateway",
  [string]$Tfs = 'M3,M5,M15,H1',
  [string]$SymbolMap = ''
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) { throw 'Hãy chạy PowerShell bằng quyền Administrator.' }
if ($Token.Length -lt 16) { throw 'Token quá ngắn.' }
if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl phải bắt đầu bằng http:// hoặc https://' }

$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$src\dist\gateway.mjs")) { throw "Không thấy $src\dist\gateway.mjs." }
$node = if (Test-Path "$src\node.exe") { "$src\node.exe" } else { (Get-Command node -ErrorAction Stop).Source }

New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Item "$src\dist\gateway.mjs" $InstallDir -Force
Copy-Item $node "$InstallDir\node.exe" -Force
$envFile = "$InstallDir\gateway.env"
@"
OCEAN_SERVER_URL=$ServerUrl
OCEAN_GATEWAY_TOKEN=$Token
OCEAN_GW_PORT=47800
OCEAN_TFS=$Tfs
OCEAN_SYMBOL_MAP=$SymbolMap
"@ | Set-Content -Encoding ASCII $envFile
icacls $envFile /inheritance:r /grant:r 'SYSTEM:(R)' 'Administrators:(F)' | Out-Null

$name = 'Ocean Relay Gateway'
Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$InstallDir\node.exe" -Argument 'gateway.mjs' -WorkingDirectory $InstallDir
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $name -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null
Start-ScheduledTask -TaskName $name

# Chép EA vào mọi thư mục MQL5\Experts của các terminal MT5 của người dùng hiện tại (nếu tìm thấy).
$ea = "$src\ea\OceanRelay.mq5"
Get-ChildItem "$env:APPDATA\MetaQuotes\Terminal" -Directory -ErrorAction SilentlyContinue | ForEach-Object {
  $dst = "$($_.FullName)\MQL5\Experts"
  if ((Test-Path $dst) -and (Test-Path $ea)) { Copy-Item $ea $dst -Force; Write-Host "Đã chép EA vào $dst" }
}
Write-Host "`nGateway đang chạy ở 127.0.0.1:47800."
Write-Host "Trong MT5: Tools > Options > Expert Advisors > Allow WebRequest > thêm  http://127.0.0.1:47800"
Write-Host "Rồi mở MetaEditor, biên dịch OceanRelay.mq5 và gắn lên một chart."
