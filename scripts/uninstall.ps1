# Gỡ tác vụ OCEAN Relay (giữ nguyên dữ liệu trong C:\ProgramData\OceanRelay).
foreach ($n in 'Ocean Relay Server', 'Ocean Relay Gateway') {
  Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -match 'server\.mjs|gateway\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
$cf = Join-Path $(if ($env:ProgramData) { $env:ProgramData } else { 'C:\ProgramData' }) 'OceanRelay\cloudflared.exe'
Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $cf) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Write-Host 'Đã gỡ tác vụ. Xóa thư mục cài tay nếu không cần nữa.'
