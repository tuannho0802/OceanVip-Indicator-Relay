# Hướng dẫn cho người dùng cuối

Bạn có một VPS Windows chạy MT5 và một tài khoản do người quản trị cấp (địa chỉ trang quản lý + tên đăng nhập + mật khẩu tạm).

**Lấy mã kết nối và Webhook URL (không cần gõ lệnh):**
1. Mở trang quản lý, đăng nhập, đổi mật khẩu khi được yêu cầu (lần đầu).
2. Tab **Kết nối** → **+ Thêm VPS** → bấm **Sao chép** ở **mã kết nối** (chuỗi bắt đầu bằng `ocean1.`). Mã này dán trên VPS ở bước dưới.
3. Cũng ở tab **Kết nối** → **+ Tạo Webhook URL** → **Sao chép URL** để dán vào alert TradingView (Notifications → Webhook URL; Condition: *Any alert() function call*). Bấm **Gửi thử** để kiểm tra; kết quả xem ở tab **Tín hiệu**.
4. Hết hạn mức hoặc nút bị mờ thì liên hệ quản trị. Gặp lỗi thì xem tab **Hướng dẫn** (bảng sự cố thường gặp).


## Cài (một lần)
1. Tải `OceanRelay-Setup.exe` từ trang Release, chạy bằng quyền Administrator. **Bộ cài không hỏi gì**: bấm Next đến hết, nó tự cài Server, Gateway, chép và biên dịch EA vào MT5, tự chạy cùng Windows.
2. Cuối bộ cài, để nguyên ô **Mở trang cài đặt** rồi bấm Finish. Trình duyệt mở trang **Cài đặt** (http://127.0.0.1:8090/#setup).
3. Dán **mã kết nối** vào ô số 1. Nếu MT5 có nhiều tài khoản, điền số tài khoản sẽ nhận tín hiệu vào ô số 2 (ví dụ `900001, 900002`); để trống là mọi tài khoản trên máy.
4. Bấm **Lưu và kiểm tra kết nối**. Vài giây sau trang báo "Đã kết nối Worker thành công" (hoặc nói rõ lý do nếu chưa được). Có hiệu lực ngay, không phải khởi động lại gì.

## Đổi cài đặt sau này (không cần cài lại)
Mở **Start Menu › OCEAN Relay › Cài đặt OCEAN Relay**, hoặc vào http://127.0.0.1:8090/#setup, hoặc bấm nút **⚙ Cài đặt** trên trang chính. Ở đó bạn có thể đổi mã kết nối, tài khoản MT5, đổi tên symbol cho khớp sàn (ví dụ `XAUUSD=GOLD`) và chọn khung giờ nhận tín hiệu, và đổi **Cổng Gateway** (xem bên dưới). Cài đặt được giữ nguyên khi bạn nâng cấp bộ cài.

Trang Cài đặt **chỉ mở được ngay trên VPS này**. Người xem từ xa (qua địa chỉ công khai) chỉ thấy tín hiệu, không thấy nút Cài đặt.

## Đổi cổng Gateway (khi trùng với chương trình khác trên VPS)
Gateway của OCEAN Relay nghe ở cổng **47860** (cố ý khác 47800 mà nhiều Gateway khác hay dùng). Mục **Trạng thái** trên trang Cài đặt báo "Gateway đang nghe cổng …", hoặc báo đỏ "Gateway chưa mở được cổng …" nếu cổng đang bị chiếm.
1. Mở trang Cài đặt › **Nâng cao** › ô **Cổng Gateway** (hoặc bấm nút "Trùng cổng? Đổi cổng" ở bước 3), nhập cổng khác (1024-65535, ví dụ 47901), bấm **Lưu**. Gateway tự chuyển cổng trong vài giây, không phải cài lại. Để trống ô này = quay về 47860.
2. Trong MT5, làm lại với địa chỉ mới: thêm `http://127.0.0.1:<cổng mới>` vào Allow WebRequest, và ở EA (chuột phải chart › Expert Advisors › Properties › Inputs) sửa **InpGateway** thành đúng địa chỉ đó.
Khi Gateway chưa mở được cổng mới, nó vẫn giữ cổng cũ để EA không bị đứt; mục Trạng thái hiện rõ lý do.

## Trong MT5 (một lần)
1. Tools → Options → Expert Advisors → **Allow WebRequest** → thêm `http://127.0.0.1:47860` (trang Cài đặt, bước 3, luôn ghi đúng địa chỉ đang dùng).
2. Kéo EA **OceanRelay** (Navigator) lên **một** chart bất kỳ.
3. EA mặc định **chỉ theo dõi**. Thử trên DEMO, thấy tín hiệu hiện ra rồi mới bật `InpAllowTrading=true` và chỉnh `InpLotPerOrder`.

## Mỗi tín hiệu đánh thế nào
Mỗi tín hiệu vào lệnh mở **3 lệnh cùng chiều, cùng giá vào, cùng SL, chỉ khác TP** (TP1, TP2, TP3). Tên symbol tự ghép theo sàn (XAUUSD → XAUUSDm, XAUUSD.a…); nếu sàn có nhiều tên gần giống thì EA không đánh và ghi log, khi đó đặt ở mục Nâng cao của trang Cài đặt: `XAUUSD=<tên ở sàn>`.

## Xem và kiểm tra
- Tín hiệu và trạng thái: http://127.0.0.1:8090/
- Kiểm tra nhanh: mở http://127.0.0.1:8090/#setup, mục **Trạng thái** báo Worker, địa chỉ công khai và Gateway đã thông chưa; kèm gợi ý khi chưa thông. Muốn thử cả đường đi: ở trang quản lý Worker bấm **Gửi thử** (tab Kết nối) rồi xem tab **Tín hiệu**. Không cần chạy lệnh nào.
- Log: `C:\ProgramData\OceanRelay\logs`. Cài lỗi: `install.log` trong đó.
- Nâng cấp: chạy bộ cài mới; mã kết nối, tài khoản và các cài đặt khác được giữ nguyên.

## Gặp sự cố
| Hiện tượng | Cách xử lý |
|---|---|
| EA không kết nối được Gateway (`HTTP=-1`/4060), hoặc mục Trạng thái báo "Gateway chưa mở được cổng" | Cổng trùng chương trình khác, hoặc chưa thêm đúng địa chỉ vào Allow WebRequest / `InpGateway`. Xem mục "Đổi cổng Gateway" ở trên. |
| Log Gateway: HTTP 403 | Số tài khoản MT5 không nằm trong danh sách đã khai. Mở trang Cài đặt, sửa ô tài khoản. |
| Trang Cài đặt báo lỗi 401 / mã kết nối sai | Lấy lại mã ở trang quản lý (tab Kết nối → **Lấy mã kết nối**) rồi dán lại ở trang Cài đặt. Nếu VPS đã bị xóa khỏi danh sách thì tạo VPS mới. |
| Trang Cài đặt báo HTTP 403 | Quản trị đang khóa VPS hoặc tài khoản của bạn (hoặc VPS đã bị xóa): hỏi quản trị. |
| EA báo `no_symbol` | Sàn không có symbol đó hoặc có nhiều tên gần giống: xem Experts log, rồi đặt "Đổi tên symbol" trong mục Nâng cao của trang Cài đặt. |
| Nút Cài đặt không hiện | Bạn đang xem từ xa. Mở http://127.0.0.1:8090/ ngay trên VPS. |
| Địa chỉ nhận tín hiệu "đang tạo" mãi | Chờ vài chục giây; nếu vẫn vậy kiểm tra VPS ra Internet được. Trong lúc này Server vẫn tự lấy tín hiệu từ Worker (chậm hơn một chút). |
