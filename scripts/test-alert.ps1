\xef\xbb\xbf<#
  Gửi một alert mẫu (đúng khuôn text một dòng của indicator OCEAN VIP) vào webhook để thử cả chuỗi
  TradingView -> Worker -> Server -> giao diện. Không đặt lệnh: EA mặc định chỉ theo dõi (InpAllowTrading=false).
    .\test-alert.ps1 -WebhookUrl "https://ocean-relay.xxx.workers.dev/webhook?key=<WEBHOOK_KEY>"
    .\test-alert.ps1 -WebhookUrl "http://127.0.0.1:8090/webhook?key=<OCEAN_WEBHOOK_KEY>" -Side SELL
  Entry/SL/TP được tính lại quanh -Entry để mỗi lần thử là một tín hiệu mới (không bị chặn chống trùng).
#>
param(
  [Parameter(Mandatory)][string]$WebhookUrl,
  [ValidateSet('BUY', 'SELL')][string]$Side = 'BUY',
  [string]$Symbol = 'XAUUSD', [string]$Tf = 'M3',
  [double]$Entry = 0
)
$ErrorActionPreference = 'Stop'
if ($Entry -le 0) { $Entry = 4000 + (Get-Random -Minimum 0 -Maximum 1000) + (Get-Random -Minimum 0 -Maximum 999) / 1000 }
$risk = 5.8
$dir = if ($Side -eq 'BUY') { 1 } else { -1 }
$f = { param($v) $v.ToString('F3', [Globalization.CultureInfo]::InvariantCulture) }
$sl = $Entry - $dir * $risk
$tp1 = $Entry + $dir * $risk * 0.8; $tp2 = $Entry + $dir * $risk * 1.6; $tp3 = $Entry + $dir * $risk * 2
$body = "OCEAN VIP by Duong | $Side ENTRY | $Symbol | $Tf | Entry: $(& $f $Entry) | SL: $(& $f $sl) | TP1 40%: $(& $f $tp1) | TP2 80%: $(& $f $tp2) | TP3 100%: $(& $f $tp3)"
Write-Host "Gui: $body"
$r = Invoke-RestMethod -Method Post -Uri $WebhookUrl -ContentType 'text/plain' -Body $body
Write-Host "Tra loi: $($r | ConvertTo-Json -Compress)"
Write-Host 'Mo giao dien Server, tin hieu phai hien trong vai giay (qua Worker: toi da ~30 giay neu push hut va phai keo bu).'
