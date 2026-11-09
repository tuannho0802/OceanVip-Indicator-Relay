# `ui/` — Giao diện công khai

Tĩnh, không đăng nhập, không build: `index.html` + `app.css` + `app.js`. Gói phát hành chép sang `web/`.

- Poll `/api/state` và `/api/info` mỗi 2 giây; hiện tín hiệu, R:R theo TP3, kết quả giao từng terminal, huy hiệu Worker.
- Toàn bộ dữ liệu vào DOM qua `textContent` (không `innerHTML`) → body alert lạ không thể chèn HTML.
- Không script nội tuyến để CSP `default-src 'self'` chặt.
- Tự theo giao diện sáng/tối của hệ thống.
