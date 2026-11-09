# Vận hành

## Nơi xem
- Giao diện: `http://127.0.0.1:8090` (hoặc địa chỉ công khai). Có huy hiệu Worker (thông/lỗi), nguồn tín hiệu (`qua Worker`), kết quả ack từng terminal.
- Log Server: `C:\ProgramData\OceanRelay\logs\server.log` (xoay vòng 5 tệp × 2 MB). Log Gateway: `C:\ProgramData\OceanRelayGateway\logs\gateway.log`. Tab Experts của MT5 cho EA.
- `node dist\server.mjs info [--show-keys]`: in cấu hình/địa chỉ.

## Sự cố thường gặp
| Hiện tượng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| Huy hiệu Worker đỏ "401" | `OCEAN_SYNC_KEY` ≠ `SYNC_KEY` của Worker | Đặt lại cho trùng |
| Gateway log `OCEAN_EA_KEY không khớp` | Khóa EA hai bên khác nhau | Sửa `gateway.env`, khởi động lại tác vụ |
| EA `HTTP=-1` / err 4060 | Chưa thêm `http://127.0.0.1:47800` vào Allow WebRequest | Thêm rồi gắn lại EA |
| Tín hiệu hiện nhưng không có lệnh, ack `trading_off` | `InpAllowTrading=false` hoặc Algo Trading tắt | Bật có chủ đích |
| Ack `price_dev` / `too_old` | Giá đã chạy / tín hiệu cũ | Chỉnh `InpMaxDevPoints`, `InpMaxAgeSec` (cân nhắc rủi ro) |
| Ack `no_symbol` | Tên symbol sàn khác TradingView | Đặt `OCEAN_SYMBOL_MAP` ở Gateway |
| Server "cổng đang bị chiếm" | Chương trình khác dùng cổng | Đổi `OCEAN_PORT` |
| Tín hiệu chỉ tới sau vài chục giây | Worker chưa biết địa chỉ VPS (Quick Tunnel mới) → đi đường kéo bù | Bình thường; giảm `OCEAN_POLL_SEC` nếu cần |

## Gỡ
`scripts\uninstall.ps1` gỡ tác vụ, giữ dữ liệu.
