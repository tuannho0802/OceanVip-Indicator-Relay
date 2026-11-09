# Định dạng alert của indicator OCEAN VIP

Webhook của indicator **không gửi JSON**. Body là **một dòng text thuần**, các trường ngăn bằng ` | `. Đây là mẫu thật bắt được từ webhook:

```
OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M3 | Entry: 4094.540 | SL: 4088.700 | TP1 40%: 4099.212 | TP2 80%: 4103.884 | TP3 100%: 4106.220
```

TradingView gửi body này với `Content-Type: text/plain` (khi nội dung không phải JSON hợp lệ). Worker lưu nguyên văn vào D1, **không phân tích**; Server mới là nơi đọc (`src/shared/parse.ts`). Vì vậy đổi khuôn thông báo chỉ cần sửa parser và deploy Server, không phải deploy lại Worker.

## Khuôn 1: vào lệnh (đã có mẫu thật)
`<indicator> | <BUY|SELL> ENTRY | <symbol> | <khung> | Entry: <giá> | SL: <giá> | TP1 40%: <giá> | TP2 80%: <giá> | TP3 100%: <giá>`

| Trường | Ví dụ | Ghi chú |
|---|---|---|
| indicator | `OCEAN VIP by Duong` | Chỉ lưu để hiển thị |
| hướng | `BUY ENTRY` / `SELL ENTRY` | Không phân biệt hoa thường |
| symbol | `XAUUSD` | Viết hoa; chỉ nhận `A-Z a-z 0-9 . _ # @ + -` (tối đa 32). Gateway đổi sang tên ở broker bằng `-SymbolMap XAUUSD=XAUUSDm` |
| khung | `M3` | Gateway chỉ giao các khung trong `-Tfs` (mặc định `M3,M5,M15,H1`) |
| `Entry:` | `4094.540` | Số thập phân dùng dấu chấm |
| `SL:` | `4088.700` | BUY: dưới Entry. SELL: trên Entry |
| `TP1 40%:` `TP2 80%:` `TP3 100%:` | `4099.212` … | Phần trăm là mức tiến tới TP3 (chỉ để đọc); parser lấy số sau dấu `:` |

Ý nghĩa mẫu trên: BUY XAUUSD khung M3, vào 4094.540, SL 4088.700 (rủi ro 5.84), TP3 4106.220 (R:R 2.0). EA mở 3 lệnh cùng SL, mỗi lệnh một TP.

Ràng buộc kiểm tra (sai thì tín hiệu thành `unknown`, **không giao cho EA**):
- BUY: `SL < Entry < TP1 ≤ TP2 ≤ TP3`; SELL: `TP3 ≤ TP2 ≤ TP1 < Entry < SL`.
- Đủ cả 5 giá; symbol/khung chỉ chứa ký tự an toàn; ít nhất 6 trường.
- Chịu được khoảng trắng thừa và `\r\n` cuối dòng.

## Khuôn 2: cập nhật (suy ra từ cấu trúc indicator, chưa có mẫu thật)
`<indicator> | <BUY|SELL> | <closeStatus> | <symbol> | <khung> | Entry: x | SL: x | TP: x`

Ví dụ giả định: `OCEAN VIP by Duong | SELL | TP1 HIT | XAUUSD | M3 | Entry: 4118.000 | SL: 4118.000 | TP: 4111.624`.
Server lưu và hiển thị (`kind=update`), EA mới chỉ ghi nhận, **chưa tự đóng lệnh hay dời SL**, vì chưa biết các giá trị `closeStatus` thật. Khi bắt được mẫu thật, thêm vào đây và vào `test/parse.test.ts`.

## Khuôn lạ
Mọi thứ khác (JSON, text khác khuôn, thiếu trường) → `kind=unknown` kèm lý do, vẫn lưu body gốc để xem lại trên giao diện, không giao cho EA.

## Chống trùng
TradingView có thể gửi lại cùng alert. Khóa chống trùng của lệnh vào: `entry|symbol|tf|side|entry` trong `OCEAN_DEDUPE_SEC` (mặc định 300 giây). Tín hiệu cũ hơn `OCEAN_MAX_AGE_SEC` (mặc định 120 giây) không giao cho EA.

## Cách thêm mẫu thật mới
1. Bắt body từ Worker (`GET /api/recent`) hoặc giao diện Server (tín hiệu `unknown` hiển thị body gốc).
2. Dán nguyên văn vào mục này.
3. Thêm test trong `test/parse.test.ts` (mẫu thật hiện có: nhóm `alert mẫu thật của indicator`).
4. Sửa `src/shared/parse.ts`, chạy `npm test`, rồi release Server (`[release-server]`).

Thử nhanh một alert mẫu: `scripts/test-alert.ps1` (xem [VPS-TEST.md](VPS-TEST.md)).
