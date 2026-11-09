# Hướng dẫn cho người dùng cuối

Bạn có một VPS Windows chạy MT5 và đã nhận từ người quản trị một **mã kết nối** (chuỗi bắt đầu bằng `ocean1.`).

## Cài (một lần)
1. Tải `OceanRelay-Setup.exe` từ trang Release, chạy bằng quyền Administrator.
2. Dán **mã kết nối**. Nếu MT5 có nhiều tài khoản, điền số tài khoản sẽ nhận tín hiệu (ví dụ `900001,900002`); để trống là mọi tài khoản trên máy.
3. Bấm Next đến hết. Bộ cài tự cài Server, Gateway, chép và biên dịch EA vào MT5, tự chạy cùng Windows.

## Trong MT5 (một lần)
1. Tools → Options → Expert Advisors → **Allow WebRequest** → thêm `http://127.0.0.1:47800`.
2. Kéo EA **OceanRelay** (Navigator) lên **một** chart bất kỳ.
3. EA mặc định **chỉ theo dõi**. Thử trên DEMO, thấy tín hiệu hiện ra rồi mới bật `InpAllowTrading=true` và chỉnh `InpLotPerOrder`.

## Mỗi tín hiệu đánh thế nào
Mỗi tín hiệu vào lệnh mở **3 lệnh cùng chiều, cùng giá vào, cùng SL, chỉ khác TP** (TP1, TP2, TP3). Tên symbol tự ghép theo sàn (XAUUSD → XAUUSDm, XAUUSD.a…); nếu sàn có nhiều tên gần giống thì EA không đánh và ghi log, khi đó nhờ quản trị đặt `/SYMBOLMAP=XAUUSD=<tên ở sàn>`.

## Xem và kiểm tra
- Tín hiệu và trạng thái: http://127.0.0.1:8090/
- Kiểm tra nhanh: `scripts\check-vps.ps1` trong thư mục cài (mặc định `C:\Program Files\OceanRelay`).
- Log: `C:\ProgramData\OceanRelay\logs`. Cài lỗi: `install.log` trong đó.
- Nâng cấp: chạy bộ cài mới, ô nhập hiện sẵn mã và tài khoản cũ.

## Gặp sự cố
| Hiện tượng | Cách xử lý |
|---|---|
| Log Gateway: HTTP 403 | Số tài khoản MT5 không nằm trong danh sách đã khai. Cài lại bộ cài và sửa ô tài khoản. |
| Log Worker: mã kết nối sai | Nhờ quản trị cấp lại mã. |
| EA báo `no_symbol` | Sàn không có symbol đó hoặc có nhiều tên gần giống: xem Experts log, nhờ quản trị đặt symbol map. |
