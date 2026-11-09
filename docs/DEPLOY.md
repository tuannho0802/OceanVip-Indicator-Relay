# Cài đặt từ đầu

Cần: tài khoản Cloudflare (gói free đủ), VPS Windows chạy MT5 cho mỗi người dùng, Node 22.13+ trên máy của chủ Worker.

## 1. Worker (một lần, trên máy dev)
```bash
npm install
cd worker && npm install
npx wrangler login
npm run setup      # tạo D1, nạp schema, sinh WEBHOOK_KEY + SYNC_KEY, đặt secret, deploy
```
Về sau cập nhật Worker bằng commit có `[deploy]` (secret GitHub trong [CICD.md](CICD.md)). Lệnh in **Webhook URL** (dán vào TradingView). Khóa gốc `SYNC_KEY` được ghi vào `worker/.ocean-master.json` (đã `.gitignore`): **không đưa cho người dùng, không commit**. Worker đã chạy bản cũ thì chạy lại `npm run setup` (hoặc commit `[deploy]`) để tạo bảng mới; người dùng cũ cần mã kết nối mới.
Dùng lại khóa cũ: `node setup.mjs --webhook-key … --sync-key …`.

## 2. Phát mã kết nối cho từng người dùng (trên máy của chủ Worker)
```bash
cd worker
npm run issue -- "Anh Nam"       # in Server ID + mã ocean1.… gửi RIÊNG cho người đó
npm run issue -- --list          # Server nào đã kết nối, thấy lần cuối khi nào, đang chờ bao nhiêu tín hiệu
```
Mã chứa địa chỉ Worker, Server ID và **khóa riêng** của Server đó (suy ra từ khóa gốc, Worker không phải lưu danh sách khóa). Muốn thu hồi: đổi khóa gốc (`node setup.mjs --webhook-key … --sync-key …`) rồi cấp lại mã cho những người còn dùng.

**Định tuyến tín hiệu.** Mặc định alert đi tới mọi Server đã đăng ký; mỗi Server chỉ thấy và chỉ kéo được tín hiệu của chính nó. Chỉ gửi cho một số Server: thêm `&to=<server-id>[,<server-id>]` vào Webhook URL (mỗi nhóm người dùng một alert riêng). Server chỉ đăng ký sau lần liên lạc đầu tiên, nên tín hiệu bắn trước đó không được giao cho nó (dùng `&to=` nếu muốn giữ chỗ trước).
Trong một Server, chỉ các tài khoản MT5 khai ở `OCEAN_ACCOUNTS` mới nhận tín hiệu; tín hiệu trùng hay nhiều alert về cùng lúc vẫn chỉ vào đúng tài khoản đó, và mỗi tín hiệu chỉ đánh một lần cho mỗi tài khoản.

## 3. Người dùng cuối cài trên VPS
Gửi cho họ `OceanRelay-Setup.exe` (trang Release) cùng mã kết nối, và [USER-GUIDE.md](USER-GUIDE.md). Bộ cài không hỏi gì và làm hết: Server, Quick Tunnel, Gateway, chép và biên dịch EA; cài xong tự mở trang Cài đặt để người dùng dán mã (đổi lại sau này cũng ở đó, không cần cài lại). Cài im lặng (mọi tham số tùy chọn):
```powershell
.\OceanRelay-Setup.exe /VERYSILENT [/CODE=ocean1.xxxx] [/ACCOUNTS=900001] [/GWPORT=47860]
```
Cài tay (bản portable): `.\scripts\install-server.ps1 [-ConnectCode ocean1.xxxx] [-Accounts 900001]` bằng PowerShell Administrator. Kiểm thử: [VPS-TEST.md](VPS-TEST.md).

## 4. MT5 (người dùng làm, chi tiết trong USER-GUIDE)
1. Tools → Options → Expert Advisors → **Allow WebRequest** → thêm `http://127.0.0.1:47860` (cổng mặc định; nếu 47860 đang bị chương trình khác dùng, bộ cài tự chọn cổng rảnh kế tiếp, ví dụ 47861; trang Cài đặt luôn ghi đúng địa chỉ đang dùng). Trùng cổng với chương trình khác trên VPS thì đổi ở trang Cài đặt › Nâng cao › **Cổng Gateway**, rồi thêm địa chỉ mới vào Allow WebRequest và sửa `InpGateway` của EA.
2. MetaEditor: biên dịch `OceanRelay.mq5`, gắn lên **một** chart.
3. Chạy thử trên **DEMO** ở chế độ mặc định (chỉ theo dõi). Thấy tín hiệu và ack `trading_off` trên giao diện là thông.
4. Bật `InpAllowTrading=true`, chỉnh `InpLotPerOrder`, `InpMaxTotalLots`, `InpMaxDevPoints` rồi mới dùng thật.

## 5. TradingView
Tạo alert từ indicator OCEAN VIP → Notifications → Webhook URL = URL ở bước 1; chọn **Any alert() function call**.

## Không dùng Worker (tối giản)
Bỏ `OCEAN_WORKER_URL`/`OCEAN_SYNC_KEY`, đặt `OCEAN_WEBHOOK_KEY` và mở Server ra internet bằng tunnel có tên. Mất tín hiệu khi VPS/tunnel sập (TradingView không gửi lại) — đó là lý do Worker tồn tại.
