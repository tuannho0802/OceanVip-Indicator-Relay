# Cài đặt từ đầu

Cần: tài khoản Cloudflare (gói free đủ), VPS Windows chạy MT5 cho mỗi người dùng, Node 22.13+ trên máy của chủ Worker.

## 1. Worker (Admin làm MỘT lần)
**Cách A, chỉ dùng trình duyệt (không cần Node/dòng lệnh):** tạo D1 `ocean-relay` + API Token trên Cloudflare Dashboard; ở GitHub thêm các secret `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `D1_DATABASE_ID`, `ADMIN_PASSWORD` (≥ 8 ký tự), `SYNC_KEY` (chuỗi ngẫu nhiên ≥ 32 ký tự), tùy chọn `WEBHOOK_KEY`; rồi Actions → **Deploy Worker** → Run workflow. Workflow tự áp migration, deploy và nạp secret vào Worker. Mở địa chỉ Worker, đăng nhập `admin` + `ADMIN_PASSWORD`, đổi mật khẩu. Trang `/help` của Worker có đủ các bước này.

**Cách B, từ máy dev (nhanh hơn nếu đã quen Node):**
```bash
npm install
cd worker && npm install
npx wrangler login
npm run setup      # tạo D1, áp migration, sinh khóa + mật khẩu Admin, đặt secret, deploy
```
Lệnh in ra **địa chỉ trang quản lý** và **tài khoản Admin + mật khẩu tạm** (đổi ngay ở lần đăng nhập đầu). Khóa gốc `SYNC_KEY` ghi vào `worker/.ocean-master.json` (đã `.gitignore`): **không đưa cho người dùng, không commit**. Chạy lại `npm run setup` không đổi khóa (đổi khóa: `node setup.mjs --new-keys`, mọi mã kết nối cũ mất hiệu lực).

Về sau cập nhật Worker bằng commit có `[deploy]` (secret GitHub trong [CICD.md](CICD.md)): workflow tự áp migration, không cần chạy lệnh nào.

**Nâng cấp Worker đã chạy bản cũ** (chưa có tài khoản): chạy Deploy Worker (hoặc commit `[deploy]`), đặt secret `ADMIN_PASSWORD` (GitHub Secrets hoặc Cloudflare Dashboard → Settings → Variables and Secrets) và mở trang quản lý một lần để Admin được tạo. Không cần dòng lệnh. VPS cấp bằng `npm run issue` vẫn chạy bình thường và thuộc về Admin. Thiếu migration thì Worker trả `db_not_migrated` kèm cách sửa.

> Không nạp `schema.sql` lên D1 thật: nó chỉ dùng cho test/dev. Migration 0003 có `ALTER TABLE` nên phải đi qua `migrations apply`.

## 2. Cấp tài khoản cho người dùng (Admin, không cần dòng lệnh)
Đăng nhập trang quản lý → tab **Người dùng** → **+ Tạo**: đặt tên đăng nhập và hạn mức VPS/Webhook, gửi RIÊNG cho họ địa chỉ trang + tên đăng nhập + mật khẩu tạm (chỉ hiện một lần). Không có đăng ký tự do; người dùng phải tự đổi mật khẩu ở lần đăng nhập đầu.

Admin có thể: tăng/giảm hạn mức; khóa/mở khóa việc **thêm VPS mới** hoặc **tạo Webhook mới**; khóa/mở khóa từng VPS, từng Webhook hoặc cả tài khoản (mọi VPS + Webhook của người đó ngừng chạy ngay); đặt lại mật khẩu; xóa tài khoản; thấy mọi VPS, Webhook, tín hiệu. Người dùng chỉ thấy và thao tác trên của chính mình.

**Người dùng tự làm trên trang** (trong hạn mức): **+ Thêm VPS** → trang sinh mã kết nối `ocean1.…` (nút Sao chép) ; **+ Tạo Webhook URL** → trang sinh URL `…/webhook?key=…` (nút Sao chép), có nút **Gửi thử** và **Đổi khóa**. Tab **Hướng dẫn** có thiết lập 3 bước và bảng sự cố thường gặp.

Xem VPS nào đang kết nối: tab **Kết nối** (trạng thái, chủ sở hữu, lần liên lạc cuối, số tín hiệu đang chờ). Admin cũng thấy Webhook URL chung đời cũ ở đó. Người dùng quên mật khẩu: Admin bấm **Đặt lại mật khẩu**. Admin duy nhất quên mật khẩu: xóa dòng Admin trong D1 Console của Cloudflare Dashboard rồi đặt lại `ADMIN_PASSWORD` (chi tiết ở `/help`).

**Định tuyến tín hiệu.** Webhook của một người chỉ giao cho VPS của chính người đó (hoặc đúng một VPS nếu Webhook gắn với VPS). Webhook URL chung cũ (`WEBHOOK_KEY`) chỉ giao cho VPS của Admin/VPS đời cũ; thêm `&to=<server-id>[,<server-id>]` để chọn đích. Mỗi Server chỉ thấy và chỉ kéo được tín hiệu của chính nó; VPS bị khóa/xóa bị Worker từ chối (HTTP 403 `server_locked` / `server_revoked`).
Trong một Server, chỉ các tài khoản MT5 khai ở `OCEAN_ACCOUNTS` mới nhận tín hiệu; mỗi tín hiệu chỉ đánh một lần cho mỗi tài khoản.

**Cách cũ (vẫn dùng được):** `cd worker && npm run issue -- "Tên VPS"` cấp mã cho VPS thuộc về Admin. Thu hồi VPS kiểu này: đổi khóa gốc.

## 3. Người dùng cuối cài trên VPS
Gửi cho họ `OceanRelay-Setup.exe` (trang Release) và [USER-GUIDE.md](USER-GUIDE.md); mã kết nối họ tự lấy ở trang quản lý (nút **Lấy mã kết nối**). Bộ cài không hỏi gì và làm hết: Server, Quick Tunnel, Gateway, chép và biên dịch EA; cài xong tự mở trang Cài đặt để người dùng dán mã (đổi lại sau này cũng ở đó, không cần cài lại). Cài im lặng (mọi tham số tùy chọn):
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
Người dùng sao chép URL ở trang quản lý (tab Kết nối). Tạo alert từ indicator OCEAN VIP → Notifications → Webhook URL = URL đó; Condition chọn **Any alert() function call**. TradingView chỉ cho Webhook khi tài khoản có gói trả phí và đã bật xác thực 2 lớp (2FA). Bấm **Gửi thử** để kiểm tra đường đi trước khi chờ alert thật.

## Không dùng Worker (tối giản)
Bỏ `OCEAN_WORKER_URL`/`OCEAN_SYNC_KEY`, đặt `OCEAN_WEBHOOK_KEY` và mở Server ra internet bằng tunnel có tên. Mất tín hiệu khi VPS/tunnel sập (TradingView không gửi lại) — đó là lý do Worker tồn tại.
