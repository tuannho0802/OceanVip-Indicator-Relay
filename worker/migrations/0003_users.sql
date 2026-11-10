-- Phân quyền Admin/User. Không có đăng ký: Admin tạo tài khoản, User tự đổi mật khẩu ở lần đăng nhập đầu.
-- LƯU Ý: có ALTER TABLE nên chỉ được chạy qua `wrangler d1 migrations apply` (mỗi migration chạy đúng một lần).
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,            -- chữ thường, số, . _ -  (3-32 ký tự)
  pass_hash TEXT NOT NULL,                  -- p1$<vòng lặp>$<salt>$<hash> (PBKDF2-SHA256)
  role TEXT NOT NULL DEFAULT 'user',        -- 'admin' | 'user'
  must_change INTEGER NOT NULL DEFAULT 1,   -- 1 = phải đổi mật khẩu trước khi dùng
  locked INTEGER NOT NULL DEFAULT 0,        -- 1 = Admin khóa: không đăng nhập, mọi VPS + webhook của user ngừng chạy
  max_servers INTEGER NOT NULL DEFAULT 1,   -- hạn mức VPS
  max_hooks INTEGER NOT NULL DEFAULT 1,     -- hạn mức Webhook URL
  can_add_server INTEGER NOT NULL DEFAULT 1,-- 0 = đang khóa việc thêm VPS mới
  can_add_hook INTEGER NOT NULL DEFAULT 1,  -- 0 = đang khóa việc tạo Webhook URL mới
  fails INTEGER NOT NULL DEFAULT 0,         -- số lần sai mật khẩu liên tiếp
  locked_until INTEGER NOT NULL DEFAULT 0,  -- giây Unix: tạm chặn đăng nhập do sai nhiều lần
  created INTEGER NOT NULL DEFAULT 0,
  last_login INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- SHA-256 của token trong cookie (không lưu token thô)
  user_id INTEGER NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
-- Mỗi Webhook URL là một khóa riêng của một User (hoặc Admin).
CREATE TABLE IF NOT EXISTS hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner INTEGER NOT NULL,                   -- users.id
  name TEXT NOT NULL,
  key TEXT NOT NULL UNIQUE,                 -- khóa trong URL (?key=...)
  server TEXT,                              -- NULL = giao cho mọi VPS của owner; có giá trị = chỉ VPS đó
  locked INTEGER NOT NULL DEFAULT 0,
  last_used INTEGER NOT NULL DEFAULT 0,
  hits INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS hooks_owner ON hooks (owner);
-- VPS bị xóa: ghi lại ID để khóa suy ra từ SYNC_KEY không tự "sống lại" (Worker tự đăng ký Server khi khóa đúng).
CREATE TABLE IF NOT EXISTS revoked_servers (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
ALTER TABLE servers ADD COLUMN owner INTEGER;                          -- NULL = VPS đời cũ/do Admin cấp bằng dòng lệnh
ALTER TABLE servers ADD COLUMN name TEXT;
ALTER TABLE servers ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;      -- 1 = Admin khóa VPS này
ALTER TABLE servers ADD COLUMN created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signals ADD COLUMN owner INTEGER;                          -- users.id của chủ Webhook (NULL = kênh chung)
ALTER TABLE signals ADD COLUMN hook INTEGER;                           -- hooks.id
CREATE INDEX IF NOT EXISTS servers_owner ON servers (owner);
CREATE INDEX IF NOT EXISTS signals_owner ON signals (owner, id);