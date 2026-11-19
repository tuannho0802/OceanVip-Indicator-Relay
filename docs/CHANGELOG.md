# Lịch sử thay đổi

## Server (chưa phát hành) · EA OceanRelay MT5 0.5.0 · MT4 0.4.0

- **Bố cục lại nhóm "Lọc giờ" trong form Tuỳ chỉnh input (Worker).** Trước đây 10 ô của Khung 1 và Khung 2 nằm xen kẽ trong lưới 2 cột, khó phân biệt. Nay mỗi khung là một thẻ riêng (màu riêng, công tắc bật/tắt, ô "Từ HH:MM → Đến HH:MM"), có thanh 24 giờ hiện vùng ngừng vào lệnh của từng khung (kể cả qua nửa đêm) và dòng mô tả cập nhật ngay khi gõ. Nút ↺ ở thẻ bỏ ghi đè cả khung. Ô "Nguồn giờ" không còn bị cắt chữ; màn hình hẹp xếp hai thẻ theo chiều dọc. Không đổi API/giao thức: chỉ cần deploy Worker. Test: `test/worker-params-ui.test.ts`.
- **Báo Worker ngay khi EA đổi input tại chỗ.** Trước đây Server chỉ lưu `setup` mới (từ `cfg=`) mà không báo, nên Worker chỉ thấy ở nhịp kéo bù kế tiếp (mặc định `OCEAN_POLL_SEC` = 300 giây). Nay `/api/gw/ping` so sánh phần input Worker thấy được (đã lọc theo `REMOTE_PARAMS`) trước/sau khi lưu; khác thì gọi `notifyAccounts()` (gộp 1 giây, bỏ qua nếu nội dung không đổi) nên Worker thấy sau khoảng 20 giây (EA gửi `cfg=` mỗi 10 nhịp ping). Không đổi giao thức, không cần cập nhật Worker/EA; đổi riêng `InpMagic`/`InpComment` (Worker không thấy) không gây request. Test hồi quy trong `test/ea-params.test.ts`.
- **Tuỳ chỉnh input EA từ xa** theo tài khoản MT (tab "Bật/tắt EA" → "Tuỳ chỉnh input"): Worker → Server → Gateway → EA (dòng `P|`), EA báo `prev=`; hiện trạng thái chờ VPS / chờ EA / đã áp. Danh sách input cho phép ở `src/shared/params.ts`. **EA MT5 0.6.0 / MT4 0.5.0**. Migration Worker `0005_ea_params.sql`, Server schema v5.
**Bật/tắt EA từ xa theo tài khoản MT + cấp quyền cho người dùng khác**
- Tab **Bật/tắt EA** trên Worker: mỗi VPS liệt kê các tài khoản MT4/MT5 (chỉ số tài khoản + tên sàn, không theo dõi số dư/lệnh) với nút Bật/Tắt. TẮT = Server ngừng giao tín hiệu cho tài khoản đó (EA không phải sửa logic); tín hiệu đến lúc tắt bị bỏ (ack `remote_off`), bật lại **không bắn bù**. Lệnh đang mở vẫn do EA tự quản lý.
- Phân quyền: Admin thấy tất cả và là người duy nhất cấp quyền; chủ VPS bật/tắt mọi tài khoản trên VPS của mình; **người được cấp** chỉ thấy VPS được cấp và đúng những tài khoản được tick (VPS có 3 tài khoản, cấp 2 → họ chỉ thấy 2, không biết có tài khoản thứ 3). Tài khoản ngoài quyền trả `no_account` như chưa từng tồn tại.
- Giao diện cấp quyền **một bước**: ở thẻ VPS chọn người dùng, tick các tài khoản MT được thấy (có nút "Chọn tất cả") rồi bấm "+ Cấp cho người dùng"; không còn bước cấp VPS rỗng. Mỗi người hiện nhãn "Thấy N/M tài khoản", sửa bằng tick/bỏ tick ngay trên dòng (khóa ô trong lúc lưu để tick nhanh không bị ghi đè). Thêm test phân quyền (`test/worker-ea-access.test.ts`, `test/worker-ea-ui.test.ts`).
- Tab **Kết nối** (Admin): thẻ VPS có dòng "Đã chia sẻ quyền bật/tắt EA: <người> (N tài khoản)" và nút **Chia sẻ bật/tắt EA** nhảy thẳng tới form cấp quyền của đúng VPS đó. Dùng cho VPS có sẵn của Admin (không có chủ) lẫn VPS do User tự cài; người được chia sẻ có thể đồng thời có VPS riêng.
- Worker giữ trạng thái (migration `0004_ea_access.sql`: `accounts`, `server_access`, `account_grants`), đổi công tắc = `rev + 1` rồi đẩy `POST <tunnel>/api/switch` (ký HMAC như `/api/ingest`); hụt thì Server nhận kèm `switches` trong `/api/pull` (kéo dày 30 giây) và báo lại qua `POST /api/accounts` (`applied_rev`). Tab hiện "Đang chờ VPS áp dụng" tới khi xác nhận.
- Server (migration v4 `switches`): chỉ nhận lệnh có `rev` mới hơn; mốc `at` do Worker đặt nên tín hiệu đến sau lúc Worker bật vẫn được giao dù lệnh đến VPS muộn. Server báo tài khoản MT mới lên Worker ngay lần đầu thấy.
- Gateway thêm dòng `R|0` vào phản hồi ping khi tài khoản bị tắt. **EA MT5 0.5.0 / MT4 0.4.0** hiện "NHAN TIN HIEU: TAT TU XA" trên biểu đồ; EA đời cũ vẫn chạy bình thường (bỏ qua dòng `R|0`, và Server đã chặn tín hiệu rồi).
- Cần cập nhật Server (bộ cài) + Worker (deploy, áp migration 0004). EA nâng cấp là tùy chọn (chỉ để hiện trạng thái).

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
