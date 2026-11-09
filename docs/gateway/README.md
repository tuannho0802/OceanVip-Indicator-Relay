# `src/gateway/` — Gateway (cùng máy MT5)

Cầu nối giữa EA (text, MQL5 không cần JSON) và Server (JSON). Chỉ nghe `127.0.0.1`.

| Tệp | Vai trò |
|---|---|
| `gateway.ts` | `Gateway.handlePing(body)`: parse `khóa=giá trị`, gửi ping JSON, kiểm chữ ký từng tín hiệu, lọc khung giờ (`skipped_tf`), ánh xạ symbol, tạo dòng `S|…`/`U|…`. Giữ ack trong bộ nhớ khi mất mạng (tối đa 200) |
| `main.ts` | Nạp `gateway.env`, log tệp; mỗi 5 giây: `syncConfig()` (hỏi Server cổng/khung giờ/symbol, báo cổng đang nghe) rồi `ensureListening()` (mở hoặc đổi cổng) |

## Cổng cục bộ (đổi được, không cần cài lại)
- Mặc định **47860** (không phải 47800, tránh đụng Gateway khác cùng VPS). `OCEAN_GW_PORT` trong `gateway.env` chỉ là cổng ban đầu.
- Người dùng đổi cổng ở trang Cài đặt của Server; Gateway hỏi Server (`POST /api/gw/config`) và chuyển sang cổng mới: mở cổng mới trước, thành công mới đóng cổng cũ.
- Cổng mới đang bị chiếm: Gateway **không thoát**, giữ cổng cũ (EA không đứt), báo lỗi lên Server để trang Cài đặt hiện, và thử lại ở nhịp sau. Lúc khởi động mà cổng bị chiếm cũng vậy (tiến trình sống, chờ người dùng đổi cổng).
- Server chưa đặt cổng rõ ràng thì không ép: Gateway ở máy khác giữ cổng trong `gateway.env` của nó.
- EA/MT5 không đổi theo được tự động: người dùng thêm địa chỉ mới vào Allow WebRequest và sửa `InpGateway` (trang Cài đặt hướng dẫn).

## Bảo vệ
- Sai chữ ký → bỏ + ack `bad_sig`, ghi log.
- Cổng `/v1/ping`, `/v1/status` từ chối request có `Origin` hoặc `Host` ngoài loopback (403).
- Body tối đa 64 KB.
- Ack tạo ở Gateway (`skipped_tf`, `bad_sig`) đi lên Server ở ping kế tiếp để hiện trên giao diện.
