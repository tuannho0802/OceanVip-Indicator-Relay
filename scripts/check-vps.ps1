\xef\xbb\xbf<#
  Kiểm tra nhanh Server trên VPS sau khi cài (không cần quyền Administrator):
    .\check-vps.ps1 [-Port 8090] [-WorkerUrl https://ocean-relay.xxx.workers.dev]
  In: Server sống?, phiên bản, Quick Tunnel (địa chỉ trycloudflare), Worker kéo bù lần cuối, số tín hiệu gần đây.
  Quick Tunnel do chính Server chạy (tự tải cloudflared về C:\ProgramData\OceanRelay), không phải cài thêm gì.
#>
param([int]$Port = 8090, [string]$WorkerUrl = '')
$ErrorActionPreference = 'Continue'
$base = "http://127.0.0.1:$Port"
function Ok($m) { Write-Host "[OK]   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "[LOI]  $m" -ForegroundColor Red }
function Warn($m) { Write-Host "[CHU Y] $m" -ForegroundColor Yellow }

try { $h = Invoke-RestMethod "$base/api/health" -TimeoutSec 5; Ok "Server dang chay, phien ban $($h.version)" }
catch { Bad "Server khong tra loi o $base. Xem log: $env:ProgramData\OceanRelay\logs\server.log"; exit 1 }

try {
  $i = Invoke-RestMethod "$base/api/info" -TimeoutSec 5
  if ($i.baseUrl) { Ok "Dia chi cong khai cua VPS: $($i.baseUrl)" } else { Warn 'Chua co dia chi cong khai (Quick Tunnel dang khoi dong, hoac chua bat OCEAN_QUICK_TUNNEL=1). Doi 20-30 giay roi chay lai.' }
  if ($i.worker) {
    if ($null -ne $i.worker.lastPollAgoSec) { Ok "Worker $($i.worker.url): keo bu lan cuoi $($i.worker.lastPollAgoSec)s truoc" }
    else { Warn "Worker $($i.worker.url): chua keo bu lan nao. Loi: $($i.worker.error)" }
    if ($i.worker.error) { Warn "Loi Worker gan nhat: $($i.worker.error)" }
    if (-not $WorkerUrl) { $WorkerUrl = $i.worker.url }
  } else { Warn 'Khong dung Worker (chi webhook truc tiep).' }
} catch { Bad "Khong doc duoc /api/info: $($_.Exception.Message)" }

$cf = Join-Path $env:ProgramData 'OceanRelay\cloudflared.exe'
if (Test-Path $cf) { Ok "cloudflared da co: $cf" } else { Warn 'Chua co cloudflared.exe (Server tu tai o lan bat Quick Tunnel dau tien; can ra internet toi github.com).' }
$tf = Join-Path $env:ProgramData 'OceanRelay\tunnel-url.txt'
if (Test-Path $tf) { Write-Host "       tunnel-url.txt: $((Get-Content $tf -Raw).Trim())" }

if ($WorkerUrl) {
  try { $w = Invoke-RestMethod "$($WorkerUrl.TrimEnd('/'))/api/health" -TimeoutSec 8; Ok "Worker song: $($w | ConvertTo-Json -Compress)" }
  catch { Bad "Worker khong tra loi: $($_.Exception.Message)" }
}

try {
  $s = Invoke-RestMethod "$base/api/state" -TimeoutSec 5
  $n = @($s.signals).Count
  Ok "Giao dien: http://127.0.0.1:$Port/  (tin hieu gan day: $n)"
} catch { Warn "Khong doc duoc /api/state: $($_.Exception.Message)" }
Write-Host ''
Write-Host 'Thu that: .\test-alert.ps1 -WebhookUrl "https://<worker>/webhook?key=<WEBHOOK_KEY>"  roi mo giao dien xem tin hieu hien len.'
