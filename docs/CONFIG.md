# Cấu hình

Tệp env: `server.env` / `gateway.env` cạnh chương trình, hoặc `OCEAN_ENV_FILE`. Biến đã có trong môi trường được ưu tiên.

## Server
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OCEAN_EA_KEY` | **bắt buộc** | 24–128 ký tự, khóa EA/Gateway |
| `OCEAN_PORT` / `OCEAN_HOST` | 8090 / 127.0.0.1 | Địa chỉ nghe |
| `OCEAN_SRV_NAME` | OCEAN Relay | Tên hiển thị |
| `OCEAN_WORKER_URL` + `OCEAN_SYNC_KEY` | trống | Dùng Worker; **phải đi cùng nhau**; SYNC_KEY ≥ 32 |
| `OCEAN_QUICK_TUNNEL` | 0 | `1` = tự chạy cloudflared Quick Tunnel và báo địa chỉ lên Worker |
| `OCEAN_PUBLIC_URL` | trống | Địa chỉ HTTPS công khai (tunnel có tên); tắt Quick Tunnel |
| `OCEAN_CLOUDFLARED` | tự tải | Đường dẫn cloudflared tự chỉ định |
| `OCEAN_POLL_SEC` | 30 nếu Worker đẩy được, 5 nếu chỉ kéo | Chu kỳ kéo bù (2–600) |
| `OCEAN_WEBHOOK_KEY` | trống (tắt) | Webhook gọi thẳng Server |
| `OCEAN_MAX_AGE_SEC` | 120 | Quá tuổi này không giao cho EA |
| `OCEAN_DEDUPE_SEC` | 300 | Cửa sổ chống trùng |
| `OCEAN_DATA` / `OCEAN_DB` / `OCEAN_LOG_DIR` | `C:\ProgramData\OceanRelay` | Dữ liệu, DB, log |
| `OCEAN_LOG_LEVEL` | info | debug/info/warn/error |
| `OCEAN_UI_DIR` | tự tìm `web/` hoặc `ui/` | Thư mục giao diện |

## Gateway
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OCEAN_SERVER_URL` | **bắt buộc** | `http(s)://…` của Server |
| `OCEAN_EA_KEY` | **bắt buộc** | Trùng Server |
| `OCEAN_GW_PORT` | 47800 | Cổng cục bộ cho EA |
| `OCEAN_TFS` | trống = tất cả | Khung giờ được phép |
| `OCEAN_SYMBOL_MAP` | trống | `XAUUSD=GOLD,…` |
| `OCEAN_GW_TIMEOUT_MS` | 2500 | Timeout gọi Server |

## Worker
Secret: `WEBHOOK_KEY`, `SYNC_KEY`. Biến: `VPS_ORIGIN` (chỉ khi tunnel có tên). Binding: `DB` (D1 `ocean-relay`).

## Input của EA
`InpGateway`, `InpPingSec`, `InpTimeoutMs`, `InpTerminalId`; đặt lệnh: `InpAllowTrading` (false), `InpLotPerOrder` (0.01), `InpMaxTotalLots` (0.30), `InpMaxAgeSec` (60), `InpMaxDevPoints` (500), `InpSlippagePts` (30), `InpTP3Only`, `InpMagic`, `InpComment`.


## Nhiều Server (v0.1.0)
| Biến | Nơi | Ý nghĩa |
|---|---|---|
| `OCEAN_CONNECT_CODE` | Server | Mã `ocean1.…` do `npm run issue` cấp: điền sẵn Worker URL, Server ID, khóa riêng. Biến lẻ bên dưới (nếu đặt) thắng mã. |
| `OCEAN_SERVER_ID` | Server | Server ID (chữ thường, số, `-`, 3-40 ký tự). Bắt buộc khi dùng Worker nếu không dùng mã. |
| `OCEAN_SYNC_KEY` | Server | Khóa **riêng** của Server (không phải khóa gốc của Worker). |
| `OCEAN_ACCOUNTS` | Server | Số tài khoản MT5 được nhận tín hiệu, cách nhau bằng dấu phẩy. Trống = mọi tài khoản đúng `OCEAN_EA_KEY`. Tài khoản lạ bị 403. |
| `SYNC_KEY` | Worker | Khóa **gốc**; khóa riêng từng Server = HMAC(SYNC_KEY, `server:<id>`). |
| `&to=id1,id2` | Webhook URL | Chỉ giao alert cho các Server nêu tên (mặc định: mọi Server đã đăng ký). |
