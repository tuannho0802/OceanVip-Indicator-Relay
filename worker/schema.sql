-- Hàng đợi tín hiệu của Worker. Worker không đọc hiểu alert: chỉ lưu body gốc, đẩy về VPS, và giữ lại cho đến khi VPS nhận.
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created INTEGER NOT NULL,           -- giây Unix lúc Worker nhận
  raw TEXT NOT NULL,                  -- body gốc của alert TradingView
  pushed INTEGER NOT NULL DEFAULT 0   -- 1 = VPS đã nhận (qua push hoặc kéo bù + ack)
);
CREATE INDEX IF NOT EXISTS signals_pending ON signals (pushed, id);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
