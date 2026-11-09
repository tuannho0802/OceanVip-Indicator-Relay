# `test/` — Kiểm thử (Vitest)

| Tệp | Phạm vi |
|---|---|
| `parse.test.ts` | Parser alert |
| `e2e.test.ts` | Webhook, Gateway+EA, ack, hết hạn, giao diện công khai che tài khoản |
| `worker.test.ts` | Worker thật (D1 giả trên `node:sqlite`) ↔ Server: push, kéo bù, trùng, ingest ký, WorkerSync |
| `security.test.ts` | Chữ ký tín hiệu (sửa/phát lại/Server giả), chống dò khóa, tệp tĩnh, cấu hình, migration |
| `ui.test.ts` | Giao diện bằng jsdom, thử XSS |
| `setup.test.ts` | Trang Cài đặt phía Server: kiểm tra dữ liệu nhập, `settings.json`, API chỉ cho máy cục bộ (qua tunnel/Host/Origin lạ → 403), áp dụng ngay, kết nối Worker thật bằng mã, Gateway nhận cấu hình sống |
| `ui-setup.test.ts` | Trang Cài đặt trên giao diện (jsdom): tự mở lần đầu, dán mã + Lưu, báo lỗi mã sai, ẩn với người xem từ xa |
| `tunnel.test.ts` | Quick Tunnel/cloudflared |
| `helpers.ts` | `baseCfg`, khóa mẫu, `fakeD1` |

Chạy: `npm test`, kiểm kiểu: `npm run typecheck`. `ci.yml` chạy `typecheck` + `npm test` + build thử trên mọi push/PR; `[deploy]` và `[release-server]` chạy lại các bước này trước khi phát hành. `parse.test.ts` có nhóm `alert mẫu thật của indicator`.
