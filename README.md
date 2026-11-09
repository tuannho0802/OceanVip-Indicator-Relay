# OCEAN Relay

TradingView alert (indicator OCEAN VIP) → **Worker Cloudflare** → **Server (VPS)** → **Gateway (localhost)** → **EA MT5** đặt lệnh theo tín hiệu.
Không đăng nhập; giao diện công khai chỉ đọc; bảo mật bằng khóa + chữ ký HMAC. EA chỉ làm việc với Server trên VPS nên không tốn hạn mức Worker.

```
TradingView ──/webhook?key=──► Worker (D1) ──push HMAC──► Server (SQLite) ◄── Giao diện công khai
                                  ▲ kéo bù                     ▲
                                  └──────────────────────────  Gateway ◄── EA (MT5)
```

## Bắt đầu nhanh
```bash
npm install
npm test && npm run typecheck
cp scripts/server.env.example server.env    # điền OCEAN_EA_KEY (>= 24 ký tự)
cp scripts/gateway.env.example gateway.env  # cùng OCEAN_EA_KEY (cổng Gateway mặc định 47860)
npm run server      # http://127.0.0.1:8090
npm run gateway
npm run fake-ea     # giả lập EA khi chưa có MT5
```
Cài thật (Worker + VPS Windows + MT5 + TradingView): [docs/DEPLOY.md](docs/DEPLOY.md).

## An toàn khi giao dịch
EA mặc định **chỉ theo dõi** (`InpAllowTrading=false`) và chưa từng được biên dịch trên MT5 thật. Thử trên DEMO trước. Chi tiết: [docs/ea/README.md](docs/ea/README.md).

## Alert, CI/CD
Alert của indicator là **một dòng text** (không JSON): [docs/ALERT-FORMAT.md](docs/ALERT-FORMAT.md). Commit có `[deploy]` deploy Worker, `[release-server]` build bộ cài Server: [docs/CICD.md](docs/CICD.md).

## Tài liệu
Mục lục: [docs/README.md](docs/README.md) — kiến trúc, bảo mật, cấu hình, giao thức, vận hành, và tài liệu riêng cho `server`, `shared`, `gateway`, `worker`, `ea`, `ui`, `scripts`, `test`.

## Giới hạn đã biết
- EA, script PowerShell và bộ cài `.exe` chưa chạy thử trên máy thật (kiểm thử: [docs/VPS-TEST.md](docs/VPS-TEST.md)).
- Khuôn cập nhật (`closeStatus`) mới chỉ lưu và hiển thị; EA chưa tự đóng/dời SL.
- `node:sqlite` còn ở mức thử nghiệm của Node (có cảnh báo khi chạy).
