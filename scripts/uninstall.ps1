# Gỡ tác vụ Ocean Relay (giữ nguyên dữ liệu trong C:\ProgramData\OceanRelay).
foreach ($n in 'Ocean Relay Server', 'Ocean Relay Gateway') {
  Stop-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $n -Confirm:$false -ErrorAction SilentlyContinue
}
Write-Host 'Đã gỡ tác vụ. Xóa thư mục cài tay nếu không cần nữa.'
