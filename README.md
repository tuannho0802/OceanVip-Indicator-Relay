# OCEAN Relay

Nhận alert của indicator TradingView (OCEAN VIP) qua webhook và chuyển cho EA trên MT5.
Học cơ chế của AZ Sentinel: **EA ⇄ Gateway (localhost) ⇄ Server**.

> **Giai đoạn 1 (bản này): tracking.** Server nhận và lưu tín hiệu, EA ping Gateway, nhận tín hiệu, ghi log và ack.
> **EA chưa gửi lệnh lên sàn.** Giai đoạn 2 mở 3 lệnh (cùng Entry/SL, TP1/TP2/TP3).

## Kiến trúc

```
TradingView ──POST /webhook?key=…──► Server (Node + SQLite) ◄── giao diện web (token admin)
                                         ▲
                       Gateway ──JSON────┘      (lọc khung giờ, ánh xạ symbol, giữ ack khi mất mạng)
                          ▲
   EA (MT5) ──text 127.0.0.1:47800──────┘      (ping mỗi 2 giây: tài khoản, lệnh mở; nhận tín hiệu)
```

- Webhook **luôn lưu body gốc và trả 200 ngay** (TradingView chỉ chờ ~3 giây, không gửi lại). Body lạ được lưu để xem, không giao cho EA.
- Đọc hai khuôn: `BUY/SELL ENTRY` (Entry, SL, TP1/2/3) và khuôn cập nhật (`direction | closeStatus | … | TP`). SL/TP sai phía so với Entry bị từ chối, không đoán.
- Chống trùng theo `symbol+khung+hướng+entry` trong `OCEAN_DEDUPE_SEC`.
- Tín hiệu quá `OCEAN_MAX_AGE_SEC` (mặc định 120s) không giao cho EA. Terminal mới không nhận lại tín hiệu cũ.
- Giao theo kiểu **ít nhất một lần**: chưa ack thì giao lại ở ping sau; EA tự bỏ qua id đã xử lý.
- EA và Gateway nói text `khóa=giá trị` / dòng `S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|age`, nên MQL5 không cần bộ đọc JSON.

## Chạy thử (máy dev, Node 22.13+)

```bash
npm install
npm test            # 17 test: parser, webhook, Gateway+EA, bảo mật
cp scripts/server.env.example server.env     # điền 3 bí mật
cp scripts/gateway.env.example gateway.env   # cùng OCEAN_GATEWAY_TOKEN
npm run server      # http://127.0.0.1:8090
npm run gateway
npm run fake-ea     # giả lập EA khi chưa có MT5
curl -XPOST "http://127.0.0.1:8090/webhook?key=<WEBHOOK_KEY>" --data 'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
```

## Cài trên VPS Windows

1. Trên máy Windows: `npm install && npm run pack` (đính kèm `node.exe`), nén `release/ocean-relay`, chép lên VPS.
2. PowerShell Administrator: `scripts\install-server.ps1` rồi `scripts\install-gateway.ps1 -ServerUrl http://127.0.0.1:8090 -Token <OCEAN_GATEWAY_TOKEN>`.
3. MT5: Tools → Options → Expert Advisors → Allow WebRequest → thêm `http://127.0.0.1:47800`. Biên dịch `OceanRelay.mq5` trong MetaEditor, gắn lên chart.
4. Mở webhook ra internet (HTTPS, cổng 443) bằng Cloudflare Tunnel **có tên + domain** (khuyến nghị) và đặt `https://<domain>/webhook?key=<OCEAN_WEBHOOK_KEY>` vào ô Webhook URL của alert TradingView. Alert chọn "Any alert() function call".

## Giới hạn đã biết của giai đoạn 1

- **Mất tín hiệu khi VPS hoặc tunnel sập**: TradingView không gửi lại. Cách chặn là Worker Cloudflare (D1) đứng trước, lưu tín hiệu rồi Server kéo về; sẽ làm sau.
- **EA chưa từng được biên dịch hay chạy trên MT5** (không có MT5 ở môi trường dựng). Hãy biên dịch và thử trên demo, gửi lại log nếu có lỗi.
- Bộ cài là PowerShell + Task Scheduler, **chưa có bộ cài `.exe` (Inno Setup)** như AZ Sentinel. Script cài cũng chưa chạy thử trên Windows thật.
- Chưa có Whitelist IP, đăng nhập nhiều người dùng, PWA. Giao diện dùng một token admin.
- `node:sqlite` còn ở mức thử nghiệm của Node (có cảnh báo khi chạy).
- Khuôn cập nhật (`closeStatus`) mới chỉ lưu và hiển thị; giá trị cụ thể của `closeStatus` chưa biết nên cần mẫu thật từ tác giả.

## Giai đoạn 2 (kế hoạch)

EA mở 3 lệnh cùng Entry/SL với TP1/TP2/TP3 khi nhận tín hiệu `S|…`: công tắc `InpAllowTrading` mặc định tắt, lot tối đa, tuổi tín hiệu tối đa, ngưỡng lệch giá so với Entry, ghi nhớ id TRƯỚC khi gọi sàn (như AZ Sentinel), kiểm tra symbol/stops level, và xử lý khuôn cập nhật (dời SL, đóng lệnh).
