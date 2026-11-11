# Lịch sử thay đổi

## Server v0.1.1 · EA OceanRelay 0.3.0
**EA (MT5)**
- Mất kết nối máy chủ giao dịch (`retcode=6 no connection with trade server`, `10031`, requote, timeout...) khi vào lệnh: EA thử lại mỗi `InpRetrySec` giây (tối đa `InpRetryMaxSec`) cho đủ 3 lệnh TP1/TP2/TP3 nếu giá còn trong sai số; ack `retry:D/N` rồi `opened:N` / `partial:D/N_<lý do>`.
- Khớp đúng giá Signal: `InpMaxDevPips` (mặc định 10 pip = 1.0 giá vàng) thay `InpMaxDevPoints`; kiểm giá mới trước từng lệnh, trượt giá gửi kèm theo phần sai số còn lại, kiểm lại giá khớp (ngừng mở nốt; `InpCloseBadFill` để đóng lệnh khớp lệch), chống mở lặp khi timeout. Chi tiết: [ea/README.md](ea/README.md).
- Bản MT4 chưa đổi.

**Server**
- Cron tự xóa tín hiệu đã xong (mặc định cũ hơn 7 ngày, 03:00 giờ VPS, dọn bù nếu VPS tắt; `OCEAN_RETENTION_DAYS` / trang Cài đặt). Thay cho lần dọn 30 ngày cố định trước đây.
- Nút **Xóa cũ hơn N ngày** và **Xóa tất cả đã xong** ở danh sách Tín hiệu (chỉ hiện khi mở từ chính VPS); luôn giữ tín hiệu còn hạn giao cho EA.
- Sửa Gateway cắt cụt ack có thêm dấu `:` (`opened:3` thành `opened`, `failed:10031` thành `failed`).
