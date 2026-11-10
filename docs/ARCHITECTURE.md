# Kiến trúc

```
TradingView ──POST /webhook?key=…──► Worker (D1) ──push ký HMAC──► Server (VPS, SQLite) ◄── Giao diện công khai
                                        ▲                              ▲
                  Server kéo bù /api/pull + /api/ack                   │ HTTPS/HTTP + khóa EA
                                                                   Gateway (127.0.0.1:47860)
                                                                       ▲ text khóa=giá trị
                                                                      EA (MT5)
```

## Mục tiêu thiết kế
1. **Không mất tín hiệu.** Worker lưu body gốc vào D1 rồi mới trả 200 (TradingView chỉ chờ ~3 giây, không gửi lại). VPS/tunnel sập thì tín hiệu nằm lại D1 và Server kéo bù khi sống lại.
2. **EA không làm đầy hạn mức Worker.** EA chỉ nói chuyện với Gateway và Server trên VPS. Request Worker chỉ phát sinh khi: có alert, Server kéo bù (mặc định 300 giây/lần ≈ 288 request/ngày, gói free cho 100 nghìn; không có tunnel thì 5 giây/lần ≈ 17 nghìn), có người mở trang Worker.
3. **Worker mỏng.** Worker không đọc hiểu alert (việc của `src/shared/parse.ts` trên Server), nên đổi khuôn thông báo không cần deploy lại Worker.
4. **Không đăng nhập.** Giao diện và `/api/state` công khai nhưng chỉ đọc và che số tài khoản MT5 (chỉ lộ 3 số cuối). Mọi đường ghi đều cần khóa.
5. **EA chỉ tin Server của mình.** Mỗi tín hiệu giao xuống mang chữ ký HMAC gắn với terminal; Gateway bỏ tín hiệu sai chữ ký.

## Thành phần
- **Worker** (`worker/`): hộp thư công khai, lưu D1, đẩy về VPS, cho Server kéo bù, giữ địa chỉ tunnel hiện tại.
- **Server** (`src/server/`): nhận tín hiệu (từ Worker hoặc webhook trực tiếp), đọc hiểu, chống trùng, lưu SQLite, giao cho terminal, phục vụ giao diện.
- **Gateway** (`src/gateway/`): cầu nối cục bộ cho EA, lọc khung giờ, ánh xạ symbol, kiểm chữ ký, giữ ack khi mất mạng.
- **EA** (`ea/OceanRelay.mq5`): ping Gateway, nhận dòng `S|…`, mở 3 lệnh (hoặc 1) khi được bật.
- **Shared** (`src/shared/`): mã dùng chung cho Node và Worker (parser, HMAC).

## Vòng đời một tín hiệu
1. TradingView POST body text vào `/webhook?key=…` của Worker.
2. Worker lưu D1 (`pushed=0`) → trả `{ok,id}` → (nền) đẩy `POST {vps}/api/ingest` ký `HMAC(SYNC_KEY, "ts.body")`.
3. Server kiểm chữ ký + độ lệch giờ, đọc hiểu, chống trùng theo `wid` và khóa `symbol|tf|side|entry`, lưu với `src='worker'`, `received_at` = giờ Worker nhận.
4. Worker đánh dấu `pushed=1` khi VPS trả 2xx. Lỗi mạng/timeout/5xx/404/429 thì Worker thử lại tối đa 6 lần (chờ 0, 1, 2, 4, 6, 8 giây, trong ngân sách ~26 giây của `waitUntil`); 401/403 (sai khóa, lệch giờ) là lỗi vĩnh viễn nên dừng ngay. Kết quả lần đẩy gần nhất (số lần, mã lỗi như `bad_time`) được lưu ở `kv` (`push:<id>`) và hiện trên thẻ VPS.
   Nếu vẫn hụt, **Worker tự quét lại mỗi phút** bằng Cron (`flushPending`: tín hiệu chưa giao, tuổi 20–170 giây, tối đa 8 lượt/phút). Cuối cùng mới tới đường kéo bù: Server kéo `/api/pull` ở nhịp `OCEAN_POLL_SEC` (hoặc ngay khi báo địa chỉ tunnel mới) rồi `/api/ack`.
5. EA ping Gateway mỗi 2 giây → Gateway ping Server → Server trả các tín hiệu chưa giao, còn hạn (`OCEAN_MAX_AGE_SEC`), kèm chữ ký.
6. Gateway kiểm chữ ký, lọc khung giờ, ánh xạ symbol → dòng `S|…` → EA kiểm lần cuối (tuổi, lệch giá, phía SL/TP, stops level, tổng lot) rồi mở lệnh và ack kết quả.

## Đảm bảo giao nhận
- Worker → Server: **ít nhất một lần**, khử trùng theo `wid` nên thành **đúng một lần**.
- Server → EA: ít nhất một lần (chưa ack thì giao lại ở ping sau); EA ghi id vào Global Variable **trước** khi gọi sàn, nên không mở lệnh lần hai kể cả khi EA khởi động lại.
- Terminal mới không nhận lại tín hiệu cũ (con trỏ khởi tạo tại `MAX(id)`).
