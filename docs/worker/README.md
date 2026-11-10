# `worker/` — Cloudflare Worker

| Tệp | Vai trò |
|---|---|
| `src/index.ts` | Chỉ `export default`: `fetch` (→ `handler.ts`) và `scheduled` (Cron Trigger → `retention.ts`). Cloudflare coi mọi export có tên là entrypoint |
| `src/handler.ts` | Định tuyến: `/webhook`, `/api/pull|ack|tunnel` (VPS), trang quản lý. `handle(req, env, ctx, deps)`; `deps` cho test chèn `now`/`fetch` |
| `src/app.ts` | API quản lý: đăng nhập, người dùng, hạn mức, VPS, Webhook, tín hiệu; khởi tạo Admin từ `ADMIN_PASSWORD` |
| `src/auth.ts` | Băm mật khẩu PBKDF2-SHA256, token phiên (D1 chỉ lưu SHA-256), cookie HttpOnly/Secure/SameSite=Strict |
| `src/retention.ts` | Dọn tín hiệu cũ: cấu hình số ngày giữ (bảng `kv`, khóa `retention_days`), xóa thủ công (giữ N ngày / theo khoảng ngày / xóa hết), job cron hằng ngày |
| `src/deliver.ts` | Lưu tín hiệu, chọn VPS đích theo chủ sở hữu/khóa, đẩy ký HMAC |
| `src/ui.ts` | Trang quản lý (JS thuần, CSP nonce, mọi dữ liệu qua `textContent`) và trang `/help` |
| `migrations/0001..0003` | Nguồn sự thật của DB trên D1 thật. `0003_users.sql`: `users`, `sessions`, `hooks`, `revoked_servers` + cột chủ sở hữu |
| `schema.sql` | Bản gộp của migrations cho test/dev local. `test/worker-schema.test.ts` bắt lỗi nếu hai bên lệch nhau |
| `wrangler.jsonc` | Cấu hình; `database_id` do `npm run setup` điền; `triggers.crons` = lịch dọn tín hiệu (20:00 UTC = 03:00 giờ VN) |
| `setup.mjs` / `issue-code.mjs` | Cài một lần (D1 + migration + secret + deploy) / cách cũ cấp mã cho VPS của Admin, `--list` |

## Secret / biến
`WEBHOOK_KEY` (URL chung cũ), `SYNC_KEY` (khóa gốc), `ADMIN_PASSWORD` (+ `ADMIN_USER`, mặc định `admin`): chỉ dùng khi chưa có tài khoản nào. `PUBLIC_URL` (tùy chọn, domain riêng). `VPS_ORIGIN` (chỉ cho VPS đời cũ).

## Hành vi
- `/webhook`: xác thực khóa (chung hoặc khóa riêng của Webhook) → lưu → 200 → đẩy nền; trả `warning: no_active_server` nếu chưa có VPS nào để giao. Webhook không tự dọn nữa: việc dọn do Cron Trigger làm (xem bên dưới).
- Khóa sai → 401 `bad_key`; Webhook/tài khoản bị khóa → 403 `hook_locked`/`user_locked`.
- Trang `/` chỉ là khung đăng nhập; dữ liệu chỉ có sau khi đăng nhập, mỗi người chỉ thấy phần của mình.
- **EA không bao giờ gọi Worker**; xem ước lượng request ở [ARCHITECTURE.md](../ARCHITECTURE.md).

## Dọn tín hiệu (retention)
Tín hiệu và dòng giao (`signals`, `deliveries`) cũ được xóa để D1 không đầy. Mọi thứ chỉnh được trên trang quản lý, tab **Tín hiệu → Dọn dẹp tín hiệu**, không cần dòng lệnh:
- **Tự động (chỉ Admin đổi):** `Không tự xóa` / `7 ngày` / `1 tháng` (30) / `3 tháng` (90) / `Tùy chọn` (1–3650 ngày). Mặc định **7 ngày** (giữ hành vi cũ). Cron chạy mỗi ngày lúc 03:00 giờ Việt Nam (`0 20 * * *` UTC), tốn 1 request Worker/ngày; cũng xóa phiên đăng nhập đã hết hạn. Cấu hình lưu ở bảng `kv` nên không cần migration.
- **Xóa ngay:** `Giữ 7 ngày / 1 tháng / 3 tháng gần nhất`, `Xóa từ ngày … đến hết ngày …`, hoặc `Xóa hết`. Admin xóa của mọi người, User chỉ xóa tín hiệu đi qua Webhook của mình.
- **An toàn:** tín hiệu nhận trong vòng 1 giờ mà còn VPS chưa nhận **không bị xóa** (tránh mất lệnh); API báo số tín hiệu được giữ lại (`kept_pending`).
- API: `GET|PUT /api/signals/retention`, `POST /api/signals/purge` (`{mode:"older",days}` | `{mode:"range",from,to}` | `{mode:"all"}`; `from`/`to` là giây Unix).
- Lịch cron nằm ở `wrangler.jsonc` → `triggers.crons`, được áp khi `wrangler deploy` (commit `[deploy]`). Đổi giờ chạy thì sửa dòng đó rồi deploy lại.

## Dev local
`cd worker && npx wrangler d1 migrations apply ocean-relay --local` rồi `npm run dev -- --var WEBHOOK_KEY:… --var SYNC_KEY:… --var ADMIN_PASSWORD:…`.
