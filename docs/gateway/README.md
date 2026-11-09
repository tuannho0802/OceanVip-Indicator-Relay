# `src/gateway/` — Gateway (cùng máy MT5)

Cầu nối giữa EA (text, MQL5 không cần JSON) và Server (JSON). Chỉ nghe `127.0.0.1`.

| Tệp | Vai trò |
|---|---|
| `gateway.ts` | `Gateway.handlePing(body)`: parse `khóa=giá trị`, gửi ping JSON, kiểm chữ ký từng tín hiệu, lọc khung giờ (`skipped_tf`), ánh xạ symbol, tạo dòng `S|…`/`U|…`. Giữ ack trong bộ nhớ khi mất mạng (tối đa 200) |
| `main.ts` | Nạp `gateway.env`, log tệp, `listen()` |

## Bảo vệ
- Sai chữ ký → bỏ + ack `bad_sig`, ghi log.
- Cổng `/v1/ping`, `/v1/status` từ chối request có `Origin` hoặc `Host` ngoài loopback (403).
- Body tối đa 64 KB.
- Ack tạo ở Gateway (`skipped_tf`, `bad_sig`) đi lên Server ở ping kế tiếp để hiện trên giao diện.
