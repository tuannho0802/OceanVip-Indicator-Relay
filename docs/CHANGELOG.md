# Lịch sử thay đổi

## Server (chưa phát hành) · EA OceanRelay MT5 0.4.0 · MT4 0.3.0
**Bù lệnh (EA MT5 + MT4, mặc định TẮT: `InpMakeupEnable`)**
- Chân TP1/TP2/TP3 còn thiếu (sàn/terminal lỗi hoặc không phản hồi, hết thời gian thử lại, giá đã đi xa Entry quá sai số, tín hiệu đến trễ) thì EA **đặt bù lệnh chờ Limit/Stop tại Entry** của Signal, đúng SL/TP/comment của chân đó. Mua: Entry < Ask → Buy Limit, Entry > Ask → Buy Stop; bán đối xứng. Giá đang sát Entry (trong sai số) thì vào thị trường như thường.
- Hạn thứ hai `InpMakeupExpirySec` (N giây, mặc định 300, tối đa 1800): tín hiệu đã quá `InpMaxAgeSec` nhưng chưa quá N giây vẫn được bù; lệnh chờ tự hủy sau N giây kể từ lúc tín hiệu phát ra (hạn của sàn + EA tự hủy dự phòng).
- Chống mở lặp: mỗi chân được kiểm tra vị thế, lệnh chờ và lịch sử 1 giờ trước khi đặt; số thứ tự lệnh lưu theo id tín hiệu (Global Variable `OCEANID_`). Tín hiệu do EA đời cũ đã xử lý (không có số thứ tự lưu) thì **không bù** để khỏi nhân đôi lệnh khi nâng cấp EA.
- Lệnh chờ tính vào `InpMaxTotalLots`; BreakEven chưa kích hoạt khi chân TP thấp hơn còn đang chờ khớp.
- Ack mới: `pending:P`, `opened:D+pending:P`; `partial:D/N_<lý do>` đếm cả chân đã đặt bù.
- MT4 0.3.0: thêm bù lệnh trên nền logic MT4 hiện có (chưa có hàng đợi thử lại và sai số theo pip như MT5; lỗi tạm thời được bù qua Server giao lại).

**Server / Gateway / giao diện**
- EA báo `cfg=` (các input, mỗi 10 nhịp ping) và `ord=` (lệnh chờ, mỗi nhịp). Server lưu (migration v3: `terminals.setup`, `terminals.orders`) và **giao lại tín hiệu còn dở** cho EA bật bù lệnh: tín hiệu quá hạn thường nhưng còn trong cửa sổ bù mà terminal chưa phản hồi, hoặc ack còn dở vì lỗi tạm thời (`retry:`, `partial:…_<lỗi tạm thời>`, `failed:<mã tạm thời>`), cách nhau ≥ 15 giây. Terminal mới không nhận lại tín hiệu cũ; tín hiệu cập nhật `U|` không bao giờ giao bù.
- Ack `received` không còn ghi đè kết quả cụ thể đã có (`opened:3`...).
- Giao diện: mỗi terminal hiện chip **Đánh lệnh / BreakEven / Bù lệnh: BẬT/TẮT**, bảng **Setup của terminal** (lot, sai số, hạn bù...) và bảng **Lệnh chờ** (Buy Limit/Stop..., hết hạn sau bao lâu). EA đời cũ hiện "EA chưa báo cấu hình". Giá trị lạ hiển thị dạng chữ, không tạo phần tử (không XSS).
- Cần cập nhật cả Server (bộ cài) và EA; EA đời cũ vẫn chạy, chỉ không có bù lệnh/Setup trên giao diện.

## Server v0.1.1 · EA OceanRelay 0.3.0
**EA (MT5)**
- Mất kết nối máy chủ giao dịch (`retcode=6 no connection with trade server`, `10031`, requote, timeout...) khi vào lệnh: EA thử lại mỗi `InpRetrySec` giây (tối đa `InpRetryMaxSec`) cho đủ 3 lệnh TP1/TP2/TP3 nếu giá còn trong sai số; ack `retry:D/N` rồi `opened:N` / `partial:D/N_<lý do>`.
- Khớp đúng giá Signal: `InpMaxDevPips` (mặc định 10 pip = 1.0 giá vàng) thay `InpMaxDevPoints`; kiểm giá mới trước từng lệnh, trượt giá gửi kèm theo phần sai số còn lại, kiểm lại giá khớp (ngừng mở nốt; `InpCloseBadFill` để đóng lệnh khớp lệch), chống mở lặp khi timeout. Chi tiết: [ea/README.md](ea/README.md).
- Bản MT4 chưa đổi.

**Server**
- Cron tự xóa tín hiệu đã xong (mặc định cũ hơn 7 ngày, 03:00 giờ VPS, dọn bù nếu VPS tắt; `OCEAN_RETENTION_DAYS` / trang Cài đặt). Thay cho lần dọn 30 ngày cố định trước đây.
- Nút **Xóa cũ hơn N ngày** và **Xóa tất cả đã xong** ở danh sách Tín hiệu (chỉ hiện khi mở từ chính VPS); luôn giữ tín hiệu còn hạn giao cho EA.
- Sửa Gateway cắt cụt ack có thêm dấu `:` (`opened:3` thành `opened`, `failed:10031` thành `failed`).
