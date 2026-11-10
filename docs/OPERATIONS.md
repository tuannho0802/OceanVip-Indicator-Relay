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
| EA `HTTP=-1` / err 4060 | Chưa thêm `http://127.0.0.1:<cổng Gateway>` (mặc định 47860) vào Allow WebRequest, hoặc `InpGateway` của EA khác cổng Gateway đang nghe | Thêm địa chỉ đúng vào Allow WebRequest, sửa `InpGateway`, gắn lại EA |
| MT4: EA báo `Gateway loi, HTTP=-1 err=5200` dù Gateway `/v1/status` vẫn `ok:true` | MT4 không nhận địa chỉ có cổng (`http://127.0.0.1:47860`); MT5 thì nhận | Xem mục "MT4 (cổng 80)" bên dưới |
| Trang Cài đặt báo đỏ "Gateway chưa mở được cổng …"; Gateway log `Cổng … đang bị chương trình khác dùng` | Cổng Gateway trùng chương trình khác trên VPS (ví dụ Gateway AZ Sentinel) | Trang Cài đặt › Nâng cao › Cổng Gateway: chọn cổng khác. Gateway không thoát mà giữ cổng cũ và tự chuyển khi lưu |
| Trang Cài đặt báo "Chưa thấy Gateway báo về" | Tác vụ `Ocean Relay Gateway` chưa chạy, hoặc Gateway là bản cũ (chưa biết đổi cổng) | Chạy lại bộ cài mới nhất; xem `gateway.log` |
| Tín hiệu hiện nhưng không có lệnh, ack `trading_off` | `InpAllowTrading=false` hoặc Algo Trading tắt | Bật có chủ đích |
| Ack `price_dev` / `too_old` | Giá đã chạy / tín hiệu cũ | Chỉnh `InpMaxDevPoints`, `InpMaxAgeSec` (cân nhắc rủi ro) |
| Ack `no_symbol` | Tên symbol sàn khác TradingView | Đặt `OCEAN_SYMBOL_MAP` ở Gateway |
| Server "cổng đang bị chiếm" | Chương trình khác dùng cổng Server | Đổi `OCEAN_PORT` (cổng Gateway: xem hai dòng trên) |
| Tín hiệu tới trễ hoặc hiện “Quá hạn, không giao cho EA” | Worker → VPS đẩy hụt (tunnel chập chờn, lệch giờ VPS > 300 giây, sai khóa) nên tín hiệu phải chờ Cron quét lại (≤ 1 phút) hoặc kéo bù (`OCEAN_POLL_SEC`) | Trang Worker → thẻ VPS: bấm **Đo độ trễ** (hiện min/TB/max, giờ lệch, xác thực khóa) và xem dòng **Lần đẩy gần nhất** (`bad_time` = lệch giờ, `timeout`/`network` = tunnel). Sửa giờ Windows (`w32tm /resync`) hoặc dùng Named Tunnel + `OCEAN_PUBLIC_URL` |
| Tín hiệu chỉ tới sau vài chục giây | Worker chưa biết địa chỉ VPS (Quick Tunnel mới) → đi đường kéo bù | Bình thường (Quick Tunnel mới báo địa chỉ xong là kéo bù ngay); chỉ giảm `OCEAN_POLL_SEC` nếu thật cần, mỗi lần giảm là tốn thêm request Worker |

## MT4 (cổng 80)
MT4 báo `err=5200` (địa chỉ URL không hợp lệ) khi `InpGateway` có cổng. Cho Windows chuyển cổng 80 sang cổng Gateway rồi dùng địa chỉ không cổng trong MT4. Làm trên VPS, PowerShell hoặc CMD chạy bằng Administrator (đổi `47860` nếu Gateway dùng cổng khác):
```
netstat -ano | findstr "127.0.0.1:80 "
netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=80 connectaddress=127.0.0.1 connectport=47860
netsh interface portproxy show all
```
- Lệnh 1 không in gì = cổng 80 còn trống. Có kết quả = chương trình khác (IIS, nginx...) đang giữ, cần giải phóng trước.
- Lệnh 3 phải có dòng `127.0.0.1  80  127.0.0.1  47860`. Mở `http://127.0.0.1/v1/status` (không cổng) phải ra `{"ok":true,...}`.
- MT4 › Tools › Options › Expert Advisors › Allow WebRequest: thêm `http://127.0.0.1` (không cổng, không dấu `/` cuối).
- Input EA: `InpGateway=http://127.0.0.1`, bấm OK hoặc gắn lại EA. Experts hết báo lỗi, trang Cài đặt báo terminal online.
- Rule được giữ sau khi khởi động lại VPS (cần dịch vụ IP Helper). Gỡ: `netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=80`.
- Nếu đổi cổng Gateway thì chạy lại lệnh add với cổng mới. Trang Cài đặt (`#setup`, bước 3, mục "Dùng MT4?") có sẵn các lệnh này kèm nút Chép.

## Dọn log/tín hiệu trên Worker
Admin vào trang quản lý → tab **Tín hiệu → Dọn dẹp tín hiệu**: chọn thời gian Worker tự giữ lại (7 ngày / 1 tháng / 3 tháng / tùy chọn / không tự xóa) hoặc xóa ngay (giữ N ngày gần nhất, theo khoảng ngày, xóa hết). Chi tiết: [worker/README.md](worker/README.md). Dòng "Lần dọn gần nhất" ở đó cho biết cron đã chạy chưa; nếu luôn là "Chưa chạy lần nào" sau hơn một ngày, kiểm tra Cloudflare Dashboard → Workers & Pages → `ocean-relay` → Settings → Triggers có cron `0 20 * * *` (cần chạy lại workflow Deploy Worker).

## Gỡ
`scripts\uninstall.ps1` gỡ tác vụ, giữ dữ liệu.
