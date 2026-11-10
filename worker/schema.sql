-- Hàng đợi tín hiệu của Worker. Worker không đọc hiểu alert: chỉ lưu body gốc rồi chia cho từng Server.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,           -- giây Unix lúc Worker nhận
  raw TEXT NOT NULL,                  -- body gốc của alert TradingView
  pushed INTEGER NOT NULL DEFAULT 0,  -- (cũ, không dùng nữa: trạng thái giao nằm ở bảng deliveries)
  owner INTEGER,                      -- users.id của chủ Webhook (NULL = kênh chung)
  hook INTEGER                        -- hooks.id
);
CREATE INDEX IF NOT EXISTS signals_pending ON signals (pushed, id);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
-- Mỗi Server (một người dùng/VPS) tự đăng ký khi liên lạc lần đầu bằng khóa riêng suy ra từ mã kết nối.
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,                -- Server ID trong mã kết nối ('' = Server đời cũ dùng khóa gốc)
  url TEXT,                           -- địa chỉ HTTPS hiện tại của VPS (Quick Tunnel đổi mỗi lần chạy)
  seen INTEGER NOT NULL DEFAULT 0,    -- giây Unix lần cuối Server liên lạc
  owner INTEGER,                      -- users.id; NULL = VPS đời cũ/do Admin cấp bằng dòng lệnh
  name TEXT,
  locked INTEGER NOT NULL DEFAULT 0,  -- 1 = Admin khóa VPS này
  created INTEGER NOT NULL DEFAULT 0
);
-- Mỗi tín hiệu x mỗi Server nhận: tín hiệu giao cho Server nào thì Server đó mới thấy.
CREATE TABLE IF NOT EXISTS deliveries (
  sid INTEGER NOT NULL,               -- signals.id
  server TEXT NOT NULL,               -- servers.id
  pushed INTEGER NOT NULL DEFAULT 0,  -- 1 = Server đã nhận (qua push hoặc kéo bù + ack)
  PRIMARY KEY (sid, server)
);
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (server, pushed, sid);
-- ==== Phân quyền Admin/User (khớp migrations/0003_users.sql) ====
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
CREATE TABLE IF NOT EXISTS revoked_servers (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS servers_owner ON servers (owner);
CREATE INDEX IF NOT EXISTS signals_owner ON signals (owner, id);
