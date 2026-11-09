# `ui/` — Giao diện công khai

Tĩnh, không đăng nhập, không build: `index.html` + `app.css` + `app.js` + `setup.js`. Gói phát hành chép sang `web/`.

- Poll `/api/state` và `/api/info` mỗi 2 giây; hiện tín hiệu, R:R theo TP3, kết quả giao từng terminal, huy hiệu Worker.
- Toàn bộ dữ liệu vào DOM qua `textContent` (không `innerHTML`) → body alert lạ không thể chèn HTML.
- Không script nội tuyến để CSP `default-src 'self'` chặt.
- Tự theo giao diện sáng/tối của hệ thống.
- **Trang Cài đặt** (`#setup`, `setup.js`): dán mã kết nối, tài khoản MT5, symbol map, khung giờ, **cổng Gateway** (Nâng cao; địa chỉ cho Allow WebRequest ở bước 3 đổi theo cổng, mục Trạng thái hiện Gateway đang nghe cổng nào hoặc lỗi cổng bị chiếm); bấm Lưu là áp dụng và kiểm tra kết nối Worker ngay. Chỉ hiện khi `/api/info` báo `local: true` (xem từ chính VPS); người xem từ xa không thấy nút. Lần đầu (`needsSetup`) tự mở trang này. `setup.js` tự chứa helper, không phụ thuộc `app.js`.
