# `test/` — Kiểm thử (Vitest)

| Tệp | Phạm vi |
|---|---|
| `parse.test.ts` | Parser alert |
| `e2e.test.ts` | Webhook, Gateway+EA, ack, hết hạn, giao diện công khai che tài khoản |
| `worker.test.ts` | Worker thật (D1 giả trên `node:sqlite`) ↔ Server: push, kéo bù, trùng, ingest ký, WorkerSync |
| `security.test.ts` | Chữ ký tín hiệu (sửa/phát lại/Server giả), chống dò khóa, tệp tĩnh, cấu hình, migration |
| `ui.test.ts` | Giao diện bằng jsdom, thử XSS |
| `tunnel.test.ts` | Quick Tunnel/cloudflared |
| `helpers.ts` | `baseCfg`, khóa mẫu, `fakeD1` |

Chạy: `npm test`, kiểm kiểu: `npm run typecheck`. CI chạy `typecheck` + `npm test` trước mỗi `[deploy]` và `[release-server]`. `parse.test.ts` có nhóm `alert mẫu thật của indicator`.
