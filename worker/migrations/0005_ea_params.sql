-- Tuỳ chỉnh input EA từ xa theo từng tài khoản MT (cùng khóa (server, login) với bảng accounts).
-- Chỉ tạo bảng mới (CREATE ... IF NOT EXISTS) nên chạy lại nhiều lần vẫn an toàn.
--
-- account_params: bộ input ghi đè mong muốn + trạng thái áp. Worker giữ bản mong muốn; VPS lưu khi nhận được (đẩy trực tiếp hoặc kéo bù),
-- EA áp ở nhịp ping kế tiếp rồi báo lại rev đã áp. Khóa nào không có trong `vals` thì EA dùng input của chính nó.
CREATE TABLE IF NOT EXISTS account_params (
  server TEXT NOT NULL,                      -- servers.id
  login TEXT NOT NULL,                       -- số tài khoản MT4/MT5 (chỉ chữ số)
  vals TEXT NOT NULL DEFAULT '{}',           -- JSON { khóa input: giá trị số } đã kiểm theo danh sách cho phép (src/shared/params.ts)
  rev INTEGER NOT NULL DEFAULT 0,            -- tăng 1 mỗi lần đổi bộ ghi đè
  applied_rev INTEGER NOT NULL DEFAULT 0,    -- rev mà VPS đã xác nhận đang giữ (rev > applied_rev = còn chờ VPS)
  ea_rev INTEGER NOT NULL DEFAULT 0,         -- rev mà EA đã xác nhận áp (rev > ea_rev = còn chờ EA)
  setup TEXT NOT NULL DEFAULT '{}',          -- JSON input hiện tại của EA do VPS báo (chỉ các khóa tuỳ chỉnh được)
  changed INTEGER NOT NULL DEFAULT 0,        -- giây Unix lần đổi gần nhất
  changed_by INTEGER,                        -- users.id người đổi
  PRIMARY KEY (server, login)
);