# Cấu hình

Tệp env: `server.env` / `gateway.env` cạnh chương trình, hoặc `OCEAN_ENV_FILE`. Biến đã có trong môi trường được ưu tiên.

## Cài đặt trên giao diện (`settings.json`)
Người dùng cuối không phải sửa tệp env: trang **Cài đặt** (http://127.0.0.1:8090/#setup) lưu vào `<OCEAN_DATA>\settings.json` (mặc định `C:\ProgramData\OceanRelay`). Trường nào có trong `settings.json` thì **thắng** `server.env`; không có thì dùng `server.env`. Có hiệu lực ngay, không phải khởi động lại; nâng cấp bộ cài không đụng tới tệp này.

| Trường | Tương ứng | Ghi chú |
|---|---|---|
| `connectCode` | `OCEAN_CONNECT_CODE` (thắng cả `OCEAN_WORKER_URL`/`OCEAN_SYNC_KEY`/`OCEAN_SERVER_ID`) | `""` = chủ động ngắt Worker |
| `accounts` | `OCEAN_ACCOUNTS` | `[]` = mọi tài khoản |
| `symbolMap` | `OCEAN_SYMBOL_MAP` của Gateway | Server gửi xuống Gateway qua mỗi ping nên Gateway áp dụng ngay; thiếu = dùng `gateway.env` |
| `tfs` | `OCEAN_TFS` của Gateway | `[]` = mọi khung giờ; thiếu = dùng `gateway.env` |

API (`GET/POST /api/setup`) **chỉ nhận yêu cầu từ chính VPS**: kết nối loopback, không qua Cloudflare Tunnel (`cf-connecting-ip`/`x-forwarded-for`), `Host` là `127.0.0.1`/`localhost`, `Origin` (nếu có) là chính trang đó, và POST phải kèm header `x-ocean-setup: 1` + JSON. Dữ liệu sai bị từ chối trước khi ghi tệp, nên cài đặt hỏng không làm Server hỏng; `settings.json` không áp dụng được lúc khởi động thì bị bỏ qua (Server chạy theo `server.env`).

## Server
| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `OCEAN_EA_KEY` | **bắt buộc** | 24–128 ký tự, khóa EA/Gateway |
| `OCEAN_PORT` / `OCEAN_HOST` | 8090 / 127.0.0.1 | Địa chỉ nghe |
| `OCEAN_SRV_NAME` | OCEAN Relay | Tên hiển thị |
| `OCEAN_WORKER_URL` + `OCEAN_SYNC_KEY` | trống | Dùng Worker; **phải đi cùng nhau**; SYNC_KEY ≥ 32 |
| `OCEAN_QUICK_TUNNEL` | 0 (bộ cài ghi `1`) | `1` = tự chạy cloudflared Quick Tunnel và báo địa chỉ lên Worker |
| `OCEAN_GW_PORT` | 47860 | Cổng Gateway Server yêu cầu Gateway nghe (1024-65535, không trùng `OCEAN_PORT`). Trang Cài đặt › Nâng cao › Cổng Gateway (lưu ở `settings.json`) thắng biến này. Chỉ khi đã đặt rõ thì Server mới ép cổng lên Gateway |
| `OCEAN_PUBLIC_URL` | trống | Địa chỉ HTTPS công khai (tunnel có tên); tắt Quick Tunnel |
| `OCEAN_CLOUDFLARED` | tự tải | Đường dẫn cloudflared tự chỉ định |
| `OCEAN_POLL_SEC` | 300 nếu Worker đẩy được, 5 nếu chỉ kéo | Chu kỳ kéo bù (2–600). Worker tự thử đẩy lại 3 lần khi lỗi; Server còn kéo bù ngay khi báo địa chỉ tunnel mới |
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
| `OCEAN_GW_PORT` | 47860 | Cổng cục bộ cho EA (1024-65535). Cố ý KHÔNG phải 47800 để khỏi đụng Gateway khác cùng VPS. Khi chạy cùng Server, cổng đặt ở trang Cài đặt (hoặc `OCEAN_GW_PORT` trong `server.env`) thắng giá trị này: Gateway hỏi Server mỗi 5 giây và tự đổi cổng; Server chưa đặt cổng thì Gateway giữ cổng của nó |
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
| `OCEAN_SERVER_ID` | Server | Server ID (chữ thường, số, `-`, 3-40 ký tự). Để trống = Server đời cũ dùng thẳng khóa gốc (Worker vẫn nhận, chỉ là chế độ tương thích). |
| `OCEAN_SYNC_KEY` | Server | Khóa **riêng** của Server (không phải khóa gốc của Worker). |
| `OCEAN_ACCOUNTS` | Server | Số tài khoản MT5 được nhận tín hiệu, cách nhau bằng dấu phẩy. Trống = mọi tài khoản đúng `OCEAN_EA_KEY`. Tài khoản lạ bị 403. |
| `SYNC_KEY` | Worker | Khóa **gốc**; khóa riêng từng Server = HMAC(SYNC_KEY, `server:<id>`). |
| `&to=id1,id2` | Webhook URL | Chỉ giao alert cho các Server nêu tên (mặc định: mọi Server đã đăng ký). |
