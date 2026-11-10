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

## BreakEven (v0.2.0, mặc định TẮT)

Khi lệnh **TP1** (hoặc **TP2**) của một tín hiệu chốt lời, EA dời SL các lệnh còn lại của tín hiệu đó về gần **giá vào thực tế** N đơn vị.

| Input | Mặc định | Ý nghĩa |
|---|---|---|
| `InpBEEnable` | false | Bật/tắt BreakEven (cần `InpAllowTrading=true`) |
| `InpBETrigger` | `BE_AFTER_TP1` | `BE_AFTER_TP1`: TP1 chốt → dời SL TP2+TP3. `BE_AFTER_TP2`: TP2 chốt → dời SL TP3 |
| `InpBEOffset` | 3.0 | N, khoảng cách từ giá vào tới SL mới |
| `InpBEUnit` | `BE_UNIT_PRICE` | `BE_UNIT_PRICE`: theo giá (XAUUSD 3.0 = 3 USD). `BE_UNIT_PIPS`: 1 pip = 10 point |
| `InpBELockProfit` | false | false: SL phía lỗ (BUY: Entry−N, SELL: Entry+N). true: khóa lãi (BUY: Entry+N, SELL: Entry−N) |

Quy tắc: chỉ kích hoạt khi lệnh trigger **đóng do chạm TP** (đóng do SL/tay thì bỏ qua); chỉ dời SL theo hướng có lợi, không bao giờ nới SL; mỗi tín hiệu làm một lần (Global Variable `OCEANBE_<login>_<id>`, khởi động lại không làm lại); SL mới phải cách giá thị trường tối thiểu stops level, nếu chưa hợp lệ EA thử lại mỗi giây tối đa 300 lần; cần tài khoản hedging; không tác dụng khi `InpTP3Only=true`. Chưa biên dịch/chạy trên MT5 thật — thử trên DEMO.
