-- Hàng đợi tín hiệu của Worker. Worker không đọc hiểu alert: chỉ lưu body gốc rồi chia cho từng Server.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,           -- giây Unix lúc Worker nhận
  raw TEXT NOT NULL,                  -- body gốc của alert TradingView
  pushed INTEGER NOT NULL DEFAULT 0   -- (cũ, không dùng nữa: trạng thái giao nằm ở bảng deliveries)
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
  seen INTEGER NOT NULL DEFAULT 0     -- giây Unix lần cuối Server liên lạc
);
-- Mỗi tín hiệu x mỗi Server nhận: tín hiệu giao cho Server nào thì Server đó mới thấy.
CREATE TABLE IF NOT EXISTS deliveries (
  sid INTEGER NOT NULL,               -- signals.id
  server TEXT NOT NULL,               -- servers.id
  pushed INTEGER NOT NULL DEFAULT 0,  -- 1 = Server đã nhận (qua push hoặc kéo bù + ack)
  PRIMARY KEY (sid, server)
);
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (server, pushed, sid);
