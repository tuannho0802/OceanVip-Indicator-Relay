<#
  Sinh/cập nhật server.env với khóa ngẫu nhiên. Khóa EA đã có thì giữ nguyên (nâng cấp không làm hỏng Gateway/EA).
  Dùng: .\init-env.ps1 -Dir "C:\Program Files\OceanRelay" [-ConnectCode ocean1.xxxx] [-Accounts 900001,900002] [-Port 8090] [-WebhookKey <>=16 ký tự>] [-GatewayPort 47860]
  Có -GatewayPort: ghi OCEAN_GW_PORT (cổng cục bộ của Gateway cho EA; Gateway hỏi Server rồi tự theo cổng này). Mặc định 47860, không phải 47800.
  Có -ConnectCode: ghi OCEAN_CONNECT_CODE (Worker + Server ID + khóa riêng nằm trong mã) và bật Quick Tunnel.
  Có -Accounts: ghi OCEAN_ACCOUNTS (Server chỉ giao tín hiệu cho các tài khoản MT5 này).
  Hai tham số trên KHÔNG bắt buộc: người dùng cuối thường cài xong rồi dán mã trên trang Cài đặt (http://127.0.0.1:<cổng>/#setup);
  cài đặt đó lưu ở ProgramData\OceanRelay\settings.json và thắng server.env, nên chạy lại bộ cài không làm mất.
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$ConnectCode = '', [string]$Accounts = '', [int]$Port = 8090, [string]$WebhookKey = '', [int]$GatewayPort = 0
)
$ErrorActionPreference = 'Stop'
function New-Secret([int]$bytes = 24) { $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ([Convert]::ToBase64String($b) -replace '[^A-Za-z0-9]', 'x') }
$ConnectCode = ($ConnectCode -replace '[\s"''`]', '')
if ($ConnectCode -ne '' -and $ConnectCode -notmatch '^ocean1\.[A-Za-z0-9_-]{20,}$') { throw 'Mã kết nối không hợp lệ (phải bắt đầu bằng ocean1. và dán đủ, không thiếu ký tự).' }
$Accounts = (($Accounts -split '[,;\s]+' | Where-Object { $_ -ne '' }) -join ',')
if ($Accounts -ne '' -and $Accounts -notmatch '^\d{3,12}(,\d{3,12})*$') { throw 'Số tài khoản MT5 chỉ gồm chữ số, cách nhau bằng dấu phẩy (ví dụ 900001,900002).' }

$f = Join-Path $Dir 'server.env'
function Set-EnvLine([string[]]$lines, [string]$key, [string]$value) {
  $out = @($lines | Where-Object { $_ -notmatch "^$key=" })
  if ($value -ne '') { $out += "$key=$value" }
  return $out
}
if (-not (Test-Path -LiteralPath $f)) {
  $lines = @("OCEAN_PORT=$Port", 'OCEAN_HOST=127.0.0.1', "OCEAN_EA_KEY=$(New-Secret 24)", 'OCEAN_MAX_AGE_SEC=120', 'OCEAN_DEDUPE_SEC=300')
  Write-Host "Đã tạo $f"
} else {
  $lines = @(Get-Content -LiteralPath $f)
  Write-Host "Cập nhật $f (giữ khóa EA cũ)"
}
if ($ConnectCode -ne '') {
  $lines = Set-EnvLine $lines 'OCEAN_CONNECT_CODE' $ConnectCode
  $lines = @($lines | Where-Object { $_ -notmatch '^(OCEAN_WORKER_URL|OCEAN_SYNC_KEY|OCEAN_SERVER_ID|OCEAN_QUICK_TUNNEL)=' })
  $lines += 'OCEAN_QUICK_TUNNEL=1'
}
if ($Accounts -ne '') { $lines = Set-EnvLine $lines 'OCEAN_ACCOUNTS' $Accounts }
if ($WebhookKey -ne '') { $lines = Set-EnvLine $lines 'OCEAN_WEBHOOK_KEY' $WebhookKey }
# Quick Tunnel bật sẵn (không cần tên miền): người dùng dán mã trên trang Cài đặt là Worker đẩy được tín hiệu về ngay.
# Đã có OCEAN_QUICK_TUNNEL (tự đặt) hoặc OCEAN_PUBLIC_URL (tunnel có tên) thì giữ nguyên.
if (-not ($lines | Where-Object { $_ -match '^(OCEAN_QUICK_TUNNEL|OCEAN_PUBLIC_URL)=' })) { $lines += 'OCEAN_QUICK_TUNNEL=1' }
if ($GatewayPort -gt 0) {
  if ($GatewayPort -lt 1024 -or $GatewayPort -gt 65535) { throw 'Cổng Gateway phải từ 1024 đến 65535.' }
  if ($GatewayPort -eq $Port) { throw "Cổng Gateway ($GatewayPort) không được trùng cổng Server ($Port)." }
  $lines = Set-EnvLine $lines 'OCEAN_GW_PORT' "$GatewayPort"
}
$lines = Set-EnvLine $lines 'OCEAN_PORT' "$Port"
$lines | Set-Content -Encoding ASCII $f
icacls $f /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' | Out-Null   # chỉ SYSTEM + Administrators
$ea = ((Get-Content $f | Where-Object { $_ -match '^OCEAN_EA_KEY=' }) -replace '^OCEAN_EA_KEY=', '').Trim()
Write-Host "OCEAN_EA_KEY = $ea   (Gateway cùng máy được cấu hình tự động)"
