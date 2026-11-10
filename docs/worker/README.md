# `worker/` — Cloudflare Worker

| Tệp | Vai trò |
|---|---|
| `src/index.ts` | Chỉ `export default` (Cloudflare coi mọi export có tên là entrypoint) |
| `src/handler.ts` | Định tuyến: `/webhook`, `/api/pull|ack|tunnel` (VPS), trang quản lý. `handle(req, env, ctx, deps)`; `deps` cho test chèn `now`/`fetch` |
| `src/app.ts` | API quản lý: đăng nhập, người dùng, hạn mức, VPS, Webhook, tín hiệu; khởi tạo Admin từ `ADMIN_PASSWORD` |
| `src/auth.ts` | Băm mật khẩu PBKDF2-SHA256, token phiên (D1 chỉ lưu SHA-256), cookie HttpOnly/Secure/SameSite=Strict |
| `src/deliver.ts` | Lưu tín hiệu, chọn VPS đích theo chủ sở hữu/khóa, đẩy ký HMAC |
| `src/ui.ts` | Trang quản lý (JS thuần, CSP nonce, mọi dữ liệu qua `textContent`) và trang `/help` |
| `migrations/0001..0003` | Nguồn sự thật của DB trên D1 thật. `0003_users.sql`: `users`, `sessions`, `hooks`, `revoked_servers` + cột chủ sở hữu |
| `schema.sql` | Bản gộp của migrations cho test/dev local. `test/worker-schema.test.ts` bắt lỗi nếu hai bên lệch nhau |
| `wrangler.jsonc` | Cấu hình; `database_id` do `npm run setup` điền |
| `setup.mjs` / `issue-code.mjs` | Cài một lần (D1 + migration + secret + deploy) / cách cũ cấp mã cho VPS của Admin, `--list` |

## Secret / biến
`WEBHOOK_KEY` (URL chung cũ), `SYNC_KEY` (khóa gốc), `ADMIN_PASSWORD` (+ `ADMIN_USER`, mặc định `admin`): chỉ dùng khi chưa có tài khoản nào. `PUBLIC_URL` (tùy chọn, domain riêng). `VPS_ORIGIN` (chỉ cho VPS đời cũ).

## Hành vi
- `/webhook`: xác thực khóa (chung hoặc khóa riêng của Webhook) → lưu → 200 → đẩy nền; trả `warning: no_active_server` nếu chưa có VPS nào để giao. Dọn tín hiệu > 7 ngày mỗi ~50 alert (không cần cron).
- Khóa sai → 401 `bad_key`; Webhook/tài khoản bị khóa → 403 `hook_locked`/`user_locked`.
- Trang `/` chỉ là khung đăng nhập; dữ liệu chỉ có sau khi đăng nhập, mỗi người chỉ thấy phần của mình.
- **EA không bao giờ gọi Worker**; xem ước lượng request ở [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dev local
`cd worker && npx wrangler d1 migrations apply ocean-relay --local` rồi `npm run dev -- --var WEBHOOK_KEY:… --var SYNC_KEY:… --var ADMIN_PASSWORD:…`.
