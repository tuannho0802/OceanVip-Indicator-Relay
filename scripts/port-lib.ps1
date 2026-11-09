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
