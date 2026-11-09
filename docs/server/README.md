# `src/server/` — Server (VPS)

Node 22.13+, SQLite (`node:sqlite`), không phụ thuộc thư viện ngoài. Đóng gói bằng `scripts/build.mjs` thành `dist/server.mjs`.

| Tệp | Vai trò |
|---|---|
| `main.ts` | Điểm vào: nạp cấu hình, logger, tạo app, bật `WorkerSync` và `QuickTunnel`, dọn tín hiệu > 30 ngày, lệnh `info`. Lỗi cấu hình ghi vào log tệp rồi thoát mã 2 |
| `config.ts` | `loadConfig(env, settings)` kiểm tra mọi biến `OCEAN_*` rồi áp `settings.json` lên trên (khóa dài/ký tự, Worker URL đi cùng SYNC_KEY, URL dạng `https://host`). Ném `ConfigError` với thông báo rõ |
| `app.ts` | HTTP: webhook trực tiếp, `/api/ingest`, `/api/gw/ping`, `/api/gw/config`, `/api/state|info|health`, tệp tĩnh. Chống dò khóa, che tài khoản, header bảo mật. `createApp(cfg, deps)` nhận `clock` để test |
| `db.ts` | `Store` trên SQLite, migration theo `PRAGMA user_version` (v1 bảng gốc, v2 `wid`/`src`/`meta`). Con trỏ terminal, giao/ack, chống trùng |
| `settings.ts` | Đọc/ghi nguyên tử `settings.json`, kiểm tra dữ liệu người dùng nhập (tiếng Việt, rõ lỗi), gộp vào env |
| `setup.ts` | `SetupController`: lưu cài đặt từ giao diện (kiểm tra → thử dựng cấu hình → ghi tệp → áp vào `cfg` → dựng lại Worker/tunnel) |
| `runtime.ts` | `Runtime`: giữ `WorkerSync` + `QuickTunnel`; `apply()` dựng lại theo cấu hình hiện hành và thử liên lạc Worker một lần |
| `worker-sync.ts` | `WorkerSync`: kéo bù `/api/pull`, ack, báo địa chỉ tunnel. Lỗi thì giãn nhịp (×2, tối đa 120 s) |
| `tunnel.ts` | `QuickTunnel`: tải/chạy `cloudflared`, đọc địa chỉ `*.trycloudflare.com`, gọi `onChange`. Hỗ trợ Windows cũ |
| `ratelimit.ts` | `FailLimiter`: đếm lần sai khóa theo IP trong cửa sổ trượt |
| `log.ts` | Logger console + tệp xoay vòng; không bao giờ nhận khóa |

## Điểm cần biết
- **Một đường nạp tín hiệu** (`ingest` trong `app.ts`) cho cả webhook trực tiếp và Worker.
- **Giờ của tín hiệu từ Worker** = giờ Worker nhận (`now - age`), nên đồng hồ VPS lệch không làm tín hiệu "già" sai.
- **IP thật**: chỉ tin `cf-connecting-ip` khi kết nối đến từ loopback (tunnel).
- **Trang Cài đặt chỉ cho máy cục bộ** (`isLocalAdmin` trong `app.ts`): loopback + không có header của tunnel + Host/Origin đúng + header `x-ocean-setup`. Giao diện bị lộ ra Internet qua tunnel (chỉ xem) nên yêu cầu qua tunnel luôn bị 403.
- **Cấu hình xuống Gateway**: `/api/gw/ping` trả kèm `config: {tfs, symbolMap}` (null = để Gateway dùng `gateway.env`). `/api/gw/config` (Gateway gọi mỗi 5 giây) trả thêm `gatewayPort` và nhận lại cổng Gateway đang nghe thật + lỗi (cổng bị chiếm...), để trang Cài đặt hiện trạng thái Gateway (`/api/info.gateway`, chỉ cho máy cục bộ).
- **Terminal mới** không nhận tín hiệu cũ.
- Đổi schema: thêm phần tử vào `MIGRATIONS`, không sửa phần tử cũ.
