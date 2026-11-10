# Kiểm thử thủ công trên VPS (bộ cài + giao diện + Cloudflare Tunnel)

> Tài liệu cho người kiểm thử/kỹ thuật. **Người dùng cuối không cần các script PowerShell dưới đây**: lấy mã và Webhook URL ở trang quản lý Worker, kiểm tra ở mục Trạng thái trên trang Cài đặt của VPS và nút **Gửi thử** (xem [USER-GUIDE.md](USER-GUIDE.md)).

Chuẩn bị: Worker đã deploy (workflow `[deploy]` hoặc `npm run setup`), có **Worker URL** và tài khoản trên trang quản lý (mã kết nối và Webhook URL lấy ở đó; `WEBHOOK_KEY` chỉ cần cho `test-alert.ps1` với URL chung). Tải `OceanRelay-Setup.exe` từ GitHub Release `server-v<version>` (đối chiếu `SHA256SUMS.txt`: `Get-FileHash .\OceanRelay-Setup.exe`).

## 1. Cài
Chạy bộ cài bằng quyền Administrator, dán mã kết nối (lấy ở trang quản lý Worker: tab Kết nối → Lấy mã kết nối). Hoặc im lặng:
```powershell
.\OceanRelay-Setup.exe /VERYSILENT /CODE=ocean1.xxxx /ACCOUNTS=<số tài khoản MT5>
```
Bộ cài chép file vào `C:\Program Files\OceanRelay`, sinh `server.env` (khóa ngẫu nhiên, chỉ SYSTEM/Administrators đọc), đăng ký tác vụ **Ocean Relay Server** (SYSTEM, tự chạy lúc khởi động, tự bật lại sau 5 giây nếu thoát), rồi chờ `/api/health`. Lỗi cài: `C:\ProgramData\OceanRelay\logs\install.log`.

## 2. Cloudflare Tunnel nhanh (Quick Tunnel, không cần tên miền)
Có Worker + SYNC_KEY thì `server.env` tự có `OCEAN_QUICK_TUNNEL=1`. **Không phải cài cloudflared tay**: lần chạy đầu Server tự tải `cloudflared.exe` về `C:\ProgramData\OceanRelay` (cần ra được `github.com`), mở tunnel tới `127.0.0.1:<port>`, đọc địa chỉ `https://<ngẫu-nhiên>.trycloudflare.com` và báo lên Worker (`POST /api/tunnel`). Địa chỉ **đổi mỗi lần tunnel chạy lại** nhưng Worker luôn được báo địa chỉ mới, nên không cần sửa gì ở TradingView.
Windows cũ (7/8/8.1, Server 2012): Server tự dùng cloudflared 2023.10.0.
Muốn địa chỉ cố định: dùng Cloudflare Tunnel có tên + tên miền, đặt `OCEAN_PUBLIC_URL=https://relay.example.com` trong `server.env` (thay Quick Tunnel), hoặc `VPS_ORIGIN` ở Worker.

## 3. Kiểm tra nhanh
```powershell
cd "C:\Program Files\OceanRelay\scripts"
.\check-vps.ps1
```
Phải thấy `[OK]` cho: Server chạy, địa chỉ công khai (đợi 20-30 giây sau khi cài), Worker kéo bù, Worker sống. Xem khóa/địa chỉ:
```powershell
& "C:\Program Files\OceanRelay\node.exe" "C:\Program Files\OceanRelay\dist\server.mjs" info --show-keys
```

## 4. Thử alert mẫu
```powershell
.\test-alert.ps1 -WebhookUrl "https://ocean-relay.<tên>.workers.dev/webhook?key=<WEBHOOK_KEY>"
```
Script gửi đúng khuôn text một dòng của indicator (giá ngẫu nhiên để không bị chặn trùng). Kết quả mong đợi `{"ok":true,"id":N}` từ Worker; mở `http://127.0.0.1:8090/` trên VPS (hoặc địa chỉ trycloudflare) thấy tín hiệu BUY/SELL ENTRY trong vài giây.

## 5. Checklist giao diện (không đăng nhập)
- [ ] Mở thẳng, không có ô đăng nhập/mật khẩu.
- [ ] Thẻ tín hiệu hiện hướng, symbol, khung, Entry/SL/TP1-3, R:R, và `Worker: thông (…)`.
- [ ] Alert hỏng (gửi `hello`) hiện là `unknown` kèm body gốc, không vỡ trang.
- [ ] Gửi lại alert y hệt trong 5 phút: báo trùng, không thêm dòng mới.
- [ ] Số tài khoản MT5 chỉ hiện 3 số cuối.
- [ ] Tắt tác vụ rồi gửi alert: tín hiệu nằm lại ở Worker; bật lại Server, nó kéo bù về ở nhịp kế tiếp (tối đa `OCEAN_POLL_SEC`, mặc định 300 giây) (tín hiệu quá `OCEAN_MAX_AGE_SEC` hiện là hết hạn, không giao EA).

## 6. Gateway + EA (demo)
```powershell
.\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -EaKey <OCEAN_EA_KEY> -SymbolMap XAUUSD=<tên ở broker>
```
Sau đó theo [DEPLOY.md](DEPLOY.md) bước 4. EA mặc định chỉ theo dõi; thấy ack `trading_off` trên giao diện là thông.

## Gỡ / nâng cấp
Nâng cấp: chạy bộ cài mới (giữ `server.env` và dữ liệu). Gỡ: "Apps & features" → OCEAN Relay Server (gỡ tác vụ, giữ `C:\ProgramData\OceanRelay` và `server.env`).
