# `worker/` — Cloudflare Worker

| Tệp | Vai trò |
|---|---|
| `src/index.ts` | Chỉ `export default` (Cloudflare coi mọi export có tên là entrypoint) |
| `src/handler.ts` | Toàn bộ logic: `handle(req, env, ctx, deps)`. `deps` cho phép test chèn `now`/`fetch` |
| `schema.sql`, `migrations/0001_init.sql` | D1: `signals(id, created, raw, pushed)`, `kv` |
| `wrangler.jsonc` | Cấu hình; `database_id` do `npm run setup` điền |
| `setup.mjs` | Cài một lần: D1 + secret + deploy, in URL/khóa |

## Hành vi
- `/webhook`: lưu → 200 → đẩy nền; dọn tín hiệu > 7 ngày mỗi ~50 alert (không cần cron).
- Địa chỉ VPS lấy từ `kv.vps_url` (Server báo), nếu không có thì `VPS_ORIGIN`.
- Trang `/` công khai, chỉ đọc, thoát ký tự HTML.
- **EA không bao giờ gọi Worker**; xem ước lượng request ở [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dev local
`cd worker && npm run dev -- --var WEBHOOK_KEY:… --var SYNC_KEY:…` rồi `wrangler d1 execute ocean-relay --local --file schema.sql`.
