-- Nhiều Server: mỗi Server có khóa riêng, mỗi tín hiệu theo dõi giao cho từng Server.
CREATE TABLE IF NOT EXISTS servers (
  id TEXT PRIMARY KEY,
  url TEXT,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS deliveries (
  sid INTEGER NOT NULL,
  server TEXT NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sid, server)
);
CREATE INDEX IF NOT EXISTS deliveries_pending ON deliveries (server, pushed, sid);
