# Bảo mật

Không có đăng nhập người dùng. Mô hình: **mọi thứ đọc được là công khai, mọi thứ ghi/điều khiển cần khóa**.

## Các khóa
| Khóa | Ai giữ | Dùng để | Độ dài |
|---|---|---|---|
| `WEBHOOK_KEY` | Worker (secret), TradingView (trong URL) | Cho phép TradingView gửi alert | ≥ 16 |
| `SYNC_KEY` | Worker (secret), Server | Worker↔Server: ký push, xác thực kéo bù/ack/tunnel | ≥ 32 |
| `EA_KEY` | Server, Gateway | Gateway↔Server: xác thực ping, ký/kiểm tín hiệu giao cho EA | ≥ 24 |
| `OCEAN_WEBHOOK_KEY` | Server (tùy chọn) | Webhook gọi thẳng Server, khi không dùng Worker | ≥ 16 |

Khóa chỉ gồm `A-Za-z0-9_-`. So khóa bằng cách băm HMAC cả hai vế rồi so thời gian không đổi (không lộ độ dài). Khóa không bao giờ được ghi vào log.

## Bảo vệ từng chặng
- **TradingView → Worker/Server**: khóa trong URL; body tối đa 16 KB; Server chặn dò khóa (20 lần sai/5 phút theo IP, trả 429 kể cả khi sau đó nhập đúng).
- **Worker → Server (`/api/ingest`)**: HMAC-SHA256 trên `"{ts}.{body}"`, lệch giờ tối đa 300 giây; sửa thân hoặc giờ đều bị 401.
- **Server → Worker**: `Authorization: Bearer SYNC_KEY` cho `/api/pull`, `/api/ack`, `/api/tunnel`. Địa chỉ tunnel chỉ nhận `https://host[:port]` (không đường dẫn, không scheme khác).
- **Gateway → Server**: `Authorization: Bearer EA_KEY`.
- **Server → Gateway → EA**: mỗi tín hiệu kèm `sig = HMAC(EA_KEY, tid|id|kind|side|symbol|tf|entry|sl|tp1|tp2|tp3|tp|status)`. Chữ ký **gắn với `tid`** nên gói bị chép không phát lại được ở terminal khác. Sai chữ ký → bỏ và ack `bad_sig`.
- **EA ↔ Gateway**: cổng chỉ nghe `127.0.0.1`; Gateway từ chối request có `Origin` (trình duyệt) hoặc `Host` không phải loopback (chống DNS rebinding).
- **EA tự kiểm lần cuối** trước khi đặt lệnh: tuổi tín hiệu, lệch giá so Entry, SL/TP đúng phía theo giá thật, stops level, tổng lot, magic number. Công tắc `InpAllowTrading` mặc định **tắt**.
- **Giao diện công khai**: chỉ `GET`; số tài khoản MT5 bị che (`•••001`); CSP `default-src 'self'`, không script nội tuyến; dữ liệu hiển thị luôn qua `textContent` (body lạ chứa HTML không tạo phần tử). Trang Worker thoát ký tự HTML.
- **Tệp tĩnh**: chỉ `.html/.css/.js/.svg`, tên khớp `^[A-Za-z0-9._-]+$`, không đọc được tệp ngoài thư mục giao diện.
- **Tệp cấu hình**: `server.env`/`gateway.env` chỉ SYSTEM + Administrators đọc được (bộ cài đặt ACL).

## Cái công khai làm lộ gì
Ai biết địa chỉ giao diện đều xem được: tín hiệu (symbol, Entry, SL, TP), số dư/equity/lệnh mở của terminal (tài khoản đã che). Nếu không muốn lộ số dư, đừng công khai địa chỉ VPS; để Server chỉ nghe loopback (mặc định) và chỉ cho Worker/tunnel đi vào.

## Giới hạn đã biết
- Quick Tunnel đổi địa chỉ mỗi lần chạy lại; khi đó Worker không đẩy được tới lúc Server báo địa chỉ mới, tín hiệu đi đường kéo bù (trễ tối đa `OCEAN_POLL_SEC`).
- Chống dò khóa nằm trong bộ nhớ; khởi động lại thì xóa.
- Ai có `EA_KEY` giả được Gateway; ai có `SYNC_KEY` bơm được tín hiệu giả vào Server. Giữ hai khóa này như mật khẩu.
- `closeStatus` của khuôn cập nhật chưa biết giá trị, nên EA chỉ ghi nhận, không tự đóng/dời SL.
