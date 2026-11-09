# Hướng dẫn cho người dùng cuối

Bạn có một VPS Windows chạy MT5 và đã nhận từ người quản trị một **mã kết nối** (chuỗi bắt đầu bằng `ocean1.`).

## Cài (một lần)
1. Tải `OceanRelay-Setup.exe` từ trang Release, chạy bằng quyền Administrator. **Bộ cài không hỏi gì**: bấm Next đến hết, nó tự cài Server, Gateway, chép và biên dịch EA vào MT5, tự chạy cùng Windows.
2. Cuối bộ cài, để nguyên ô **Mở trang cài đặt** rồi bấm Finish. Trình duyệt mở trang **Cài đặt** (http://127.0.0.1:8090/#setup).
3. Dán **mã kết nối** vào ô số 1. Nếu MT5 có nhiều tài khoản, điền số tài khoản sẽ nhận tín hiệu vào ô số 2 (ví dụ `900001, 900002`); để trống là mọi tài khoản trên máy.
4. Bấm **Lưu và kiểm tra kết nối**. Vài giây sau trang báo "Đã kết nối Worker thành công" (hoặc nói rõ lý do nếu chưa được). Có hiệu lực ngay, không phải khởi động lại gì.

## Đổi cài đặt sau này (không cần cài lại)
Mở **Start Menu › OCEAN Relay › Cài đặt OCEAN Relay**, hoặc vào http://127.0.0.1:8090/#setup, hoặc bấm nút **⚙ Cài đặt** trên trang chính. Ở đó bạn có thể đổi mã kết nối, tài khoản MT5, đổi tên symbol cho khớp sàn (ví dụ `XAUUSD=GOLD`) và chọn khung giờ nhận tín hiệu. Cài đặt được giữ nguyên khi bạn nâng cấp bộ cài.

Trang Cài đặt **chỉ mở được ngay trên VPS này**. Người xem từ xa (qua địa chỉ công khai) chỉ thấy tín hiệu, không thấy nút Cài đặt.

## Trong MT5 (một lần)
1. Tools → Options → Expert Advisors → **Allow WebRequest** → thêm `http://127.0.0.1:47800`.
2. Kéo EA **OceanRelay** (Navigator) lên **một** chart bất kỳ.
3. EA mặc định **chỉ theo dõi**. Thử trên DEMO, thấy tín hiệu hiện ra rồi mới bật `InpAllowTrading=true` và chỉnh `InpLotPerOrder`.

## Mỗi tín hiệu đánh thế nào
Mỗi tín hiệu vào lệnh mở **3 lệnh cùng chiều, cùng giá vào, cùng SL, chỉ khác TP** (TP1, TP2, TP3). Tên symbol tự ghép theo sàn (XAUUSD → XAUUSDm, XAUUSD.a…); nếu sàn có nhiều tên gần giống thì EA không đánh và ghi log, khi đó đặt ở mục Nâng cao của trang Cài đặt: `XAUUSD=<tên ở sàn>`.

## Xem và kiểm tra
- Tín hiệu và trạng thái: http://127.0.0.1:8090/
- Kiểm tra nhanh: `scripts\check-vps.ps1` trong thư mục cài (mặc định `C:\Program Files\OceanRelay`).
- Log: `C:\ProgramData\OceanRelay\logs`. Cài lỗi: `install.log` trong đó.
- Nâng cấp: chạy bộ cài mới; mã kết nối, tài khoản và các cài đặt khác được giữ nguyên.

## Gặp sự cố
| Hiện tượng | Cách xử lý |
|---|---|
| Log Gateway: HTTP 403 | Số tài khoản MT5 không nằm trong danh sách đã khai. Mở trang Cài đặt, sửa ô tài khoản. |
| Trang Cài đặt báo lỗi 401 / mã kết nối sai | Nhờ quản trị cấp lại mã rồi dán lại ở trang Cài đặt. |
| EA báo `no_symbol` | Sàn không có symbol đó hoặc có nhiều tên gần giống: xem Experts log, rồi đặt "Đổi tên symbol" trong mục Nâng cao của trang Cài đặt. |
| Nút Cài đặt không hiện | Bạn đang xem từ xa. Mở http://127.0.0.1:8090/ ngay trên VPS. |
| Địa chỉ nhận tín hiệu "đang tạo" mãi | Chờ vài chục giây; nếu vẫn vậy kiểm tra VPS ra Internet được. Trong lúc này Server vẫn tự lấy tín hiệu từ Worker (chậm hơn một chút). |
