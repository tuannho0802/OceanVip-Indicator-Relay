-- Bật/tắt EA từ xa theo từng tài khoản MT + cấp quyền cho người dùng khác.
-- Chỉ tạo bảng mới (CREATE ... IF NOT EXISTS) nên chạy lại nhiều lần vẫn an toàn.
--
-- accounts: tài khoản MT mà từng VPS báo lên (chỉ số tài khoản + tên sàn, KHÔNG có số dư/lệnh) và công tắc mong muốn.
-- Worker là nơi giữ trạng thái; VPS áp dụng khi nhận được (đẩy trực tiếp hoặc kéo bù).
CREATE TABLE IF NOT EXISTS accounts (
  server TEXT NOT NULL,                      -- servers.id
  login TEXT NOT NULL,                       -- số tài khoản MT4/MT5 (chỉ chữ số)
  broker TEXT,                               -- tên máy chủ sàn (để nhận diện)
  seen INTEGER NOT NULL DEFAULT 0,           -- giây Unix lần VPS báo gần nhất
  enabled INTEGER NOT NULL DEFAULT 1,        -- công tắc mong muốn: 1 = nhận tín hiệu, 0 = tắt
  rev INTEGER NOT NULL DEFAULT 0,            -- tăng 1 mỗi lần đổi công tắc
  applied_rev INTEGER NOT NULL DEFAULT 0,    -- rev mà VPS đã xác nhận áp dụng (rev > applied_rev = còn chờ VPS)
  changed INTEGER NOT NULL DEFAULT 0,        -- giây Unix lần đổi công tắc gần nhất
  changed_by INTEGER,                        -- users.id người đổi
  PRIMARY KEY (server, login)
);
-- server_access: Admin cho phép một User thấy VPS này (kèm danh sách tài khoản ở account_grants).
CREATE TABLE IF NOT EXISTS server_access (
  user_id INTEGER NOT NULL,
  server TEXT NOT NULL,
  created INTEGER NOT NULL DEFAULT 0,
  granted_by INTEGER,
  PRIMARY KEY (user_id, server)
);
CREATE INDEX IF NOT EXISTS server_access_server ON server_access (server);
-- account_grants: trong VPS đó, User được thấy và bật/tắt đúng những tài khoản MT này (tài khoản còn lại User không biết có).
CREATE TABLE IF NOT EXISTS account_grants (
  user_id INTEGER NOT NULL,
  server TEXT NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (user_id, server, login)
);
CREATE INDEX IF NOT EXISTS account_grants_server ON account_grants (server, login);
