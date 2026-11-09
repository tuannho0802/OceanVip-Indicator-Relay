<#
  Sinh/cập nhật server.env với khóa ngẫu nhiên. Khóa EA đã có thì giữ nguyên (nâng cấp không làm hỏng Gateway/EA).
  Dùng: .\init-env.ps1 -Dir "C:\Program Files\OceanRelay" [-ConnectCode ocean1.xxxx] [-Accounts 900001,900002] [-Port 8090] [-WebhookKey <>=16 ký tự>]
  Có -ConnectCode: ghi OCEAN_CONNECT_CODE (Worker + Server ID + khóa riêng nằm trong mã) và bật Quick Tunnel.
  Có -Accounts: ghi OCEAN_ACCOUNTS (Server chỉ giao tín hiệu cho các tài khoản MT5 này).
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$ConnectCode = '', [string]$Accounts = '', [int]$Port = 8090, [string]$WebhookKey = ''
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
$lines = Set-EnvLine $lines 'OCEAN_PORT' "$Port"
$lines | Set-Content -Encoding ASCII $f
icacls $f /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' | Out-Null   # chỉ SYSTEM + Administrators
$ea = ((Get-Content $f | Where-Object { $_ -match '^OCEAN_EA_KEY=' }) -replace '^OCEAN_EA_KEY=', '').Trim()
Write-Host "OCEAN_EA_KEY = $ea   (Gateway cùng máy được cấu hình tự động)"
