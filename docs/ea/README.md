# `ea/` — Expert Advisor MT5

`OceanRelay.mq5` v0.2.0 (MQL5). **Chưa được biên dịch hay chạy trên MT5 thật** — thử trên DEMO.

## Chế độ
- Mặc định `InpAllowTrading=false`: chỉ ping, hiển thị tín hiệu, ack `trading_off`.
- Bật: với mỗi `S|…` mở 3 lệnh thị trường cùng SL, TP1/TP2/TP3 (hoặc 1 lệnh lot×3 với TP3 nếu `InpTP3Only`).

## Thứ tự kiểm tra trước khi đặt lệnh
Công tắc & Algo Trading → tuổi (`InpMaxAgeSec`) → symbol → lệch giá (`InpMaxDevPoints`) → SL/TP đúng phía theo giá thật → stops level → tổng lot (`InpMaxTotalLots`) → **ghi id vào Global Variable** → gửi lệnh. Mỗi nhánh chặn trả mã ack riêng (xem [PROTOCOL.md](../PROTOCOL.md)).

## Bảo mật
EA chỉ nói chuyện với Gateway cục bộ, không giữ khóa nào; chữ ký do Gateway kiểm. Lệnh mang `InpMagic` và comment `OCEAN#<id>/TPn`. Id đã xử lý nằm ở Global Variable `OCEAN_<login>_<id>` nên khởi động lại không mở lệnh lần hai.

## Chưa làm
Khuôn cập nhật `U|…` chỉ ghi nhận (chưa biết các giá trị `closeStatus`); cần mẫu thật rồi mới dời SL/đóng lệnh.
