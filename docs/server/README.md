# `src/server/` — Server (VPS)

Node 22.13+, SQLite (`node:sqlite`), không phụ thuộc thư viện ngoài. Đóng gói bằng `scripts/build.mjs` thành `dist/server.mjs`.

| Tệp | Vai trò |
|---|---|
| `main.ts` | Điểm vào: nạp cấu hình, logger, tạo app, bật `WorkerSync` và `QuickTunnel`, dọn tín hiệu > 30 ngày, lệnh `info`. Lỗi cấu hình ghi vào log tệp rồi thoát mã 2 |
| `config.ts` | `loadConfig()` kiểm tra mọi biến `OCEAN_*` (khóa dài/ký tự, Worker URL đi cùng SYNC_KEY, URL dạng `https://host`). Ném `ConfigError` với thông báo rõ |
| `app.ts` | HTTP: webhook trực tiếp, `/api/ingest`, `/api/gw/ping`, `/api/state|info|health`, tệp tĩnh. Chống dò khóa, che tài khoản, header bảo mật. `createApp(cfg, deps)` nhận `clock` để test |
| `db.ts` | `Store` trên SQLite, migration theo `PRAGMA user_version` (v1 bảng gốc, v2 `wid`/`src`/`meta`). Con trỏ terminal, giao/ack, chống trùng |
| `worker-sync.ts` | `WorkerSync`: kéo bù `/api/pull`, ack, báo địa chỉ tunnel. Lỗi thì giãn nhịp (×2, tối đa 120 s) |
| `tunnel.ts` | `QuickTunnel`: tải/chạy `cloudflared`, đọc địa chỉ `*.trycloudflare.com`, gọi `onChange`. Hỗ trợ Windows cũ |
| `ratelimit.ts` | `FailLimiter`: đếm lần sai khóa theo IP trong cửa sổ trượt |
| `log.ts` | Logger console + tệp xoay vòng; không bao giờ nhận khóa |

## Điểm cần biết
- **Một đường nạp tín hiệu** (`ingest` trong `app.ts`) cho cả webhook trực tiếp và Worker.
- **Giờ của tín hiệu từ Worker** = giờ Worker nhận (`now - age`), nên đồng hồ VPS lệch không làm tín hiệu "già" sai.
- **IP thật**: chỉ tin `cf-connecting-ip` khi kết nối đến từ loopback (tunnel).
- **Terminal mới** không nhận tín hiệu cũ.
- Đổi schema: thêm phần tử vào `MIGRATIONS`, không sửa phần tử cũ.
