# Hàm dùng chung cho install-server.ps1 / install-gateway.ps1: tìm cổng Gateway còn rảnh.
# Cổng đang do chính Gateway của OCEAN (nằm trong $InstallDir) giữ KHÔNG tính là bận (nâng cấp tại chỗ).
function Get-PortOwner([int]$Port, [string]$InstallDir) {
  try { $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1 } catch { return $null }
  if (-not $c) { return $null }
  try {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction Stop
    if ($p.CommandLine -and $InstallDir -and $p.CommandLine.IndexOf($InstallDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $p.CommandLine -like '*gateway.mjs*') { return $null }
  } catch { }
  return $c.OwningProcess
}
function Get-FreeGatewayPort([int]$Preferred, [string]$InstallDir, [int[]]$Exclude = @()) {
  foreach ($cand in ($Preferred..($Preferred + 99))) {
    if ($cand -gt 65535) { break }
    if ($Exclude -contains $cand) { continue }
    if ($null -eq (Get-PortOwner $cand $InstallDir)) { return $cand }
  }
  throw "Không tìm được cổng Gateway rảnh trong khoảng $Preferred-$($Preferred + 99). Hãy chỉ định -GatewayPort."
}

# --- Nâng cấp tại chỗ: tắt bản cũ và chép đè file một cách bền, không bao giờ vấp vì tiến trình vừa tự thoát hoặc file đang bị khóa. ---

# Tắt tiến trình `$Name` có dòng lệnh thỏa `$Match`. Không ném lỗi: tiến trình có thể vừa tự thoát giữa lúc liệt kê và lúc tắt.
function Stop-ByCommandLine([string]$Name, [scriptblock]$Match) {
  try {
    Get-CimInstance Win32_Process -Filter "Name = '$Name'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and (& $Match $_.CommandLine) } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  } catch { }
}

# Dừng Server/Gateway cũ cho tới khi chắc chắn không còn tiến trình nào giữ file trong $InstallDir.
# `$Kind` = 'server.mjs' hoặc 'gateway.mjs'. Vòng lặp run-server.cmd (cmd.exe) phải tắt TRƯỚC node.exe, nếu không nó bật node lại sau 5 giây
# và giữ khóa node.exe đúng lúc đang chép đè.
function Stop-OceanProcesses([string]$InstallDir, [string]$Kind) {
  $dir = $InstallDir
  Stop-ByCommandLine 'cmd.exe' { param($c) $c.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c -like '*run-server.cmd*' }
  Stop-ByCommandLine 'node.exe' { param($c) $c.IndexOf($dir, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and $c -like "*$Kind*" }
  if ($Kind -eq 'server.mjs') {
    # cloudflared của Server cũ mồ côi sau khi node bị tắt: dọn đúng tệp của OCEAN (Server mới cũng tự dọn khi khởi động).
    $cf = Join-Path $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }) 'OceanRelay\cloudflared.exe'
    try {
      Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction Stop |
        Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $cf) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    } catch { }
  }
  Start-Sleep -Seconds 2
}

# Chép đè, thử lại tối đa ~15 giây. Tệp đích đang bị khóa (node.exe đang chạy): Windows cho ĐỔI TÊN tệp đang chạy nên đổi sang .old rồi chép tệp mới vào.
function Copy-Retry([string]$From, [string]$To, [switch]$Recurse) {
  $last = $null
  for ($i = 0; $i -lt 15; $i++) {
    try {
      if ($Recurse) { Copy-Item $From $To -Recurse -Force -ErrorAction Stop } else { Copy-Item $From $To -Force -ErrorAction Stop }
      return
    } catch {
      $last = $_
      if (-not $Recurse -and (Test-Path -LiteralPath $To -PathType Leaf)) {
        try {
          $old = "$To.old"
          Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
          Move-Item -LiteralPath $To $old -Force -ErrorAction Stop
          Copy-Item $From $To -Force -ErrorAction Stop
          return
        } catch { $last = $_ }
      }
      Start-Sleep -Seconds 1
    }
  }
  throw "Không chép được $From -> $To (tệp đang bị chương trình khác giữ?): $($last.Exception.Message)"
}
