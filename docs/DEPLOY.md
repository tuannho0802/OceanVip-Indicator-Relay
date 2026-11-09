# Cài đặt từ đầu

Cần: tài khoản Cloudflare (gói free đủ), VPS Windows chạy MT5, Node 22.13+ trên máy dev.

## 1. Worker (một lần, trên máy dev)
```bash
npm install
cd worker && npm install
npx wrangler login
npm run setup      # tạo D1, nạp schema, sinh WEBHOOK_KEY + SYNC_KEY, đặt secret, deploy
```
Về sau cập nhật Worker bằng commit có `[deploy]` (secret GitHub trong [CICD.md](CICD.md)). Lệnh in ra: **Webhook URL** (dán vào TradingView), **Worker URL** và **SYNC_KEY** (dùng ở bước 2). Lưu lại, không commit.
Dùng lại khóa cũ: `node setup.mjs --webhook-key … --sync-key …`.

## 2. Server trên VPS Windows
**Cách nhanh:** commit có `[release-server]` để GitHub Actions build `OceanRelay-Server-Setup.exe` (xem [CICD.md](CICD.md)), tải ở trang Release, chạy trên VPS và điền Worker URL + SYNC_KEY. Quy trình kiểm thử: [VPS-TEST.md](VPS-TEST.md).

**Cách tay:** trên máy Windows `npm install && npm run pack`, nén `release/ocean-relay`, chép lên VPS. PowerShell **Administrator**:
```powershell
.\scripts\install-server.ps1 -WorkerUrl https://ocean-relay.<tên>.workers.dev -SyncKey <SYNC_KEY>
```
Script tự sinh `OCEAN_EA_KEY`, bật Quick Tunnel (không cần tên miền), đăng ký tác vụ chạy lúc khởi động và chờ `/api/health`. Xem lại khóa/địa chỉ: `node dist\server.mjs info --show-keys`.
Có tên miền thì dùng Cloudflare Tunnel có tên và đặt `OCEAN_PUBLIC_URL=https://relay.example.com` thay cho Quick Tunnel.

## 3. Gateway cùng máy với MT5
```powershell
.\scripts\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -EaKey <OCEAN_EA_KEY> -SymbolMap XAUUSD=GOLD
```
Gateway ở máy khác: `-ServerUrl` là địa chỉ công khai của Server, `-EaKey` như trên.

## 4. MT5
1. Tools → Options → Expert Advisors → **Allow WebRequest** → thêm `http://127.0.0.1:47800`.
2. MetaEditor: biên dịch `OceanRelay.mq5`, gắn lên **một** chart.
3. Chạy thử trên **DEMO** ở chế độ mặc định (chỉ theo dõi). Thấy tín hiệu và ack `trading_off` trên giao diện là thông.
4. Bật `InpAllowTrading=true`, chỉnh `InpLotPerOrder`, `InpMaxTotalLots`, `InpMaxDevPoints` rồi mới dùng thật.

## 5. TradingView
Tạo alert từ indicator OCEAN VIP → Notifications → Webhook URL = URL ở bước 1; chọn **Any alert() function call**.

## Không dùng Worker (tối giản)
Bỏ `OCEAN_WORKER_URL`/`OCEAN_SYNC_KEY`, đặt `OCEAN_WEBHOOK_KEY` và mở Server ra internet bằng tunnel có tên. Mất tín hiệu khi VPS/tunnel sập (TradingView không gửi lại) — đó là lý do Worker tồn tại.
