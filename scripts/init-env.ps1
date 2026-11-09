<#
  Sinh server.env (và gateway.env cho cùng máy) với khóa ngẫu nhiên. Không ghi đè tệp đã có.
  Dùng: .\init-env.ps1 -Dir "C:\Program Files\OceanRelay" [-WorkerUrl https://ocean-relay.xxx.workers.dev -SyncKey <>=32 ký tự>] [-Port 8090]
#>
param(
  [Parameter(Mandatory = $true)][string]$Dir,
  [string]$WorkerUrl = '', [string]$SyncKey = '', [int]$Port = 8090, [string]$WebhookKey = ''
)
$ErrorActionPreference = 'Stop'
function New-Secret([int]$bytes = 24) { $b = New-Object byte[] $bytes; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); ([Convert]::ToBase64String($b) -replace '[^A-Za-z0-9]', 'x') }
if (($WorkerUrl -ne '') -xor ($SyncKey -ne '')) { throw 'WorkerUrl và SyncKey phải đi cùng nhau.' }
if ($SyncKey -ne '' -and $SyncKey.Length -lt 32) { throw 'SyncKey phải từ 32 ký tự.' }
$ea = New-Secret 24
$f = Join-Path $Dir 'server.env'
if (-not (Test-Path -LiteralPath $f)) {
  $lines = @("OCEAN_PORT=$Port", 'OCEAN_HOST=127.0.0.1', "OCEAN_EA_KEY=$ea", 'OCEAN_MAX_AGE_SEC=120', 'OCEAN_DEDUPE_SEC=300')
  if ($WorkerUrl -ne '') { $lines += "OCEAN_WORKER_URL=$($WorkerUrl.TrimEnd('/'))"; $lines += "OCEAN_SYNC_KEY=$SyncKey"; $lines += 'OCEAN_QUICK_TUNNEL=1' }
  if ($WebhookKey -ne '') { $lines += "OCEAN_WEBHOOK_KEY=$WebhookKey" }
  $lines | Set-Content -Encoding ASCII $f
  icacls $f /inheritance:r /grant:r '*S-1-5-18:(R)' '*S-1-5-32-544:(F)' | Out-Null   # chỉ SYSTEM + Administrators
  Write-Host "Đã tạo $f"
} else { Write-Host "Giữ nguyên $f"; $ea = ((Get-Content $f | Where-Object { $_ -match '^OCEAN_EA_KEY=' }) -replace '^OCEAN_EA_KEY=', '').Trim() }
Write-Host "OCEAN_EA_KEY = $ea   (dán vào install-gateway.ps1 -EaKey nếu Gateway ở máy khác)"
