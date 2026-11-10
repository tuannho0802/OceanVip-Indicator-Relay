# Cài OCEAN Relay Gateway (chạy cùng máy với MT5). PowerShell Administrator.
# Dùng: .\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -EaKey <OCEAN_EA_KEY> [-Port 47860]
# Cổng cục bộ cho EA: mặc định 47860 (KHÔNG dùng 47800 để khỏi đụng Gateway khác cùng VPS, ví dụ AZ Sentinel).
# Đổi được sau này ở trang Cài đặt (mục Nâng cao), không phải cài lại; -Port chỉ là giá trị ban đầu.
param(
  [Parameter(Mandatory)][string]$ServerUrl,
  [Parameter(Mandatory)][string]$EaKey,
  [string]$InstallDir = "$env:ProgramFiles\OceanRelayGateway",
  [string]$Tfs = 'M3,M5,M15,H1',
  [string]$SymbolMap = '',
  [int]$Port = 0
)
$ErrorActionPreference = 'Stop'
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole('Administrator')) { throw 'Hãy chạy PowerShell bằng quyền Administrator.' }
if ($EaKey.Length -lt 24) { throw 'EaKey quá ngắn (>= 24 ký tự, trùng OCEAN_EA_KEY của Server).' }
if ($ServerUrl -notmatch '^https?://') { throw 'ServerUrl phải bắt đầu bằng http:// hoặc https://' }
# Cổng: tham số > cổng người dùng đã đặt trên trang Cài đặt (settings.json, nâng cấp không làm mất) > mặc định 47860.
$defaultGwPort = 47860
if ($Port -le 0) {
  try {
    $sj = Get-Content "$env:ProgramData\OceanRelay\settings.json" -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($sj.gatewayPort) { $Port = [int]$sj.gatewayPort }
  } catch { }
}
$autoPort = ($Port -le 0)
if ($autoPort) { $Port = $defaultGwPort }
if ($Port -lt 1024 -or $Port -gt 65535) { throw "Cổng Gateway phải từ 1024 đến 65535 (đang là $Port)." }
$src = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path "$src\dist\gateway.mjs")) { throw "Không thấy $src\dist\gateway.mjs." }
$node = if (Test-Path "$src\node.exe") { "$src\node.exe" } else { (Get-Command node -ErrorAction Stop).Source }

. "$PSScriptRoot\port-lib.ps1"
Stop-ScheduledTask -TaskName 'Ocean Relay Gateway' -ErrorAction SilentlyContinue
# Chỉ dừng Gateway của OCEAN (nằm trong thư mục cài này), KHÔNG đụng Gateway khác cùng máy (ví dụ AZ Sentinel cũng chạy node.exe).
Stop-OceanProcesses $InstallDir 'gateway.mjs'
# Không ai chỉ định cổng: nếu cổng mặc định đang bị chương trình khác giữ thì tự lấy cổng rảnh kế tiếp.
if ($autoPort) {
  $free = Get-FreeGatewayPort $defaultGwPort $InstallDir
  if ($free -ne $Port) { Write-Host "Cổng $Port đang bị chương trình khác dùng: tự chọn cổng Gateway $free." -ForegroundColor Yellow; $Port = $free }
}
# Cổng đang bị chương trình khác giữ? Chỉ cảnh báo (Gateway vẫn cài; vào trang Cài đặt > Nâng cao đổi cổng là chạy).
try {
  $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  if ($busy) { Write-Host "CHÚ Ý: cổng $Port đang bị chương trình khác dùng (PID $($busy.OwningProcess)). Mở $ServerUrl/#setup > Nâng cao và đổi Cổng Gateway." -ForegroundColor Yellow }
} catch { }
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Copy-Retry "$src\dist\gateway.mjs" $InstallDir
Copy-Retry $node "$InstallDir\node.exe"
$envFile = "$InstallDir\gateway.env"
@"
OCEAN_SERVER_URL=$ServerUrl
OCEAN_EA_KEY=$EaKey
OCEAN_GW_PORT=$Port
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
    if ($Port -eq $defaultGwPort) { Copy-Item $ea $dst -Force }
    else {
      # Đặt sẵn InpGateway theo cổng đã chọn (EA đọc giá trị mặc định này khi gắn lên chart mới).
      $txt = [IO.File]::ReadAllText($ea).Replace("http://127.0.0.1:$defaultGwPort", "http://127.0.0.1:$Port")
      [IO.File]::WriteAllText("$dst\OceanRelay.mq5", $txt, (New-Object Text.UTF8Encoding($false)))
    }
    $copied++; Write-Host "Đã chép EA vào $dst"
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
Write-Host "`nGateway đang chạy ở 127.0.0.1:$Port (log: $env:ProgramData\OceanRelayGateway\logs\gateway.log)."
Write-Host "Việc còn lại trong MT5 (làm một lần):"
Write-Host "  1) Tools > Options > Expert Advisors > Allow WebRequest > thêm  http://127.0.0.1:$Port"
if ($compiled -eq 0 -and $copied -gt 0) { Write-Host "  2) MetaEditor: mở OceanRelay.mq5 và bấm Compile (F7)" } else { Write-Host "  2) Kéo EA OceanRelay từ Navigator lên MỘT chart (nếu chưa thấy: chuột phải Refresh)" }
Write-Host "  3) Mặc định EA CHỈ THEO DÕI. Khi sẵn sàng, bật InpAllowTrading=true (thử trên DEMO trước)."
