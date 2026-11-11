# Giao thức

## Alert TradingView (body text, ngăn bằng `|`)
Body là **một dòng text thuần, không phải JSON**. Mẫu thật và quy tắc đọc: [ALERT-FORMAT.md](ALERT-FORMAT.md).
```
OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M3 | Entry: 4094.540 | SL: 4088.700 | TP1 40%: 4099.212 | TP2 80%: 4103.884 | TP3 100%: 4106.220
```
- Vào lệnh: `NAME | BUY|SELL ENTRY | SYMBOL | TF | Entry: x | SL: x | TP1 40%: x | TP2 80%: x | TP3 100%: x`
- Cập nhật: `NAME | <BUY|SELL> | <closeStatus> | SYMBOL | TF | Entry: x | SL: x | TP: x`
- Khuôn lạ: lưu `kind=unknown` kèm lý do, không giao cho EA. SL/TP sai phía so với Entry bị từ chối (cũng thành `unknown`).

## Worker
| Đường | Auth | Chức năng |
|---|---|---|
| `POST /webhook?key=` | WEBHOOK_KEY | Lưu D1, trả `{ok,id}`, đẩy nền |
| `GET /api/pull` | Bearer SYNC_KEY | `{now, items:[{wid,age,raw}]}` chưa push (≤ 50, trong 1 giờ) |
| `POST /api/ack` | Bearer SYNC_KEY | `{ids:[…]}` đánh dấu đã nhận |
| `POST /api/tunnel` | Bearer SYNC_KEY | `{url}` địa chỉ VPS hoặc `{url:null}` |
| `GET /`, `/api/recent`, `/api/health` | công khai | Trang/JSON chỉ đọc |

## Server
| Đường | Auth | Chức năng |
|---|---|---|
| `POST /webhook?key=` | OCEAN_WEBHOOK_KEY | Webhook trực tiếp (tắt nếu không đặt khóa) |
| `POST /api/ingest` | `x-ocean-ts` + `x-ocean-sig` = HMAC(SYNC_KEY, `ts.body`) | Worker đẩy `{wid,age,raw}` |
| `POST /api/ping` | như `/api/ingest` | Worker đo độ trễ (nút “Đo độ trễ”): không tạo tín hiệu, trả `{ok,now,skew}` để biết VPS lệch giờ |
| `POST /api/gw/ping` | Bearer EA_KEY | Gateway ping, nhận `{now, signals:[…+sig]}` |
| `POST /api/gw/config` | Bearer EA_KEY | Gateway gửi `{port, error}` (cổng đang nghe thật, lý do nếu chưa mở được cổng); nhận `{now, config:{tfs, symbolMap, gatewayPort}}`. `gatewayPort` null = chưa đặt rõ, Gateway dùng cổng trong `gateway.env`. Gateway gọi mỗi 5 giây |
| `POST /api/signals/purge` | chỉ từ chính VPS (như `/api/setup`) + `x-ocean-setup: 1` + JSON | `{mode:"older",days:1..3650}` xóa tín hiệu đã xong cũ hơn N ngày, `{mode:"all"}` xóa mọi tín hiệu đã xong; luôn giữ tín hiệu còn hạn giao cho EA (`maxAgeSec` + 60 giây). Trả `{ok,deleted,kept_fresh,count}` |
| `GET /api/state`, `/api/info`, `/api/health`, tệp tĩnh | công khai | Giao diện. `/api/info` chỉ kèm `retention` (số tín hiệu đang lưu, số ngày giữ, lần dọn gần nhất) cho người xem từ chính VPS |

## EA ⇄ Gateway (`POST /v1/ping`, text `khóa=giá trị`)
Gửi: `login, server, [tid], bal, eq, mg, fm, ver, pos=ticket,symbol,side,vol,open,sl,tp,profit;…, ord=ticket,symbol,type,vol,price,sl,tp,conLaiGiay;…, [cfg=khóa=giá trị;khóa=giá trị;…], acks=id:kết quả,…`. `ord` = lệnh chờ của EA (type: `buylimit|buystop|selllimit|sellstop`; có mặt nhưng rỗng = không có lệnh chờ; vắng = EA đời cũ, Server giữ bản cũ). `cfg` = các input của EA, EA mới gửi mỗi 10 nhịp (vắng = giữ bản đã lưu); Server dùng `InpAllowTrading`, `InpMakeupEnable`, `InpMakeupExpirySec` để quyết định giao bù, các khóa khác chỉ để hiển thị.
Nhận: dòng đầu `OK`, tiếp theo:
- `S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|ageSec`
- `U|id|side|status|symbol|tf|entry|sl|tp|ageSec`

Kết quả ack của EA: `received`, `opened:N`, `trading_off`, `too_old`, `price_dev`, `bad_levels`, `bad_stops`, `no_symbol`, `max_lots`, `failed:<retcode>`. EA 0.3.0 thêm: `retry:D/N` (đang thử lại: D chân đã mở / N chân cần mở), `partial:D/N_<lý do>` (kết thúc thiếu chân; lý do là một mã ở trên hoặc `fill_dev`, `retry_timeout`, `no_connection`, `no_quote`), và các mã kết thúc khi không mở được chân nào (`no_connection`, `retry_timeout`, `fill_dev`...). Ack cùng id gửi lại thì **ghi đè** kết quả cũ ở Server (`retry:1/3` → `opened:3`). Gateway tách ack ở dấu `:` đầu tiên nên phần sau (`opened:3`, `failed:10031`) giữ nguyên. Gateway tự sinh `skipped_tf`, `bad_sig`.

EA MT5 0.4.0 / MT4 0.3.0 (bù lệnh) thêm: `pending:P`, `opened:D+pending:P`; `partial:(D+P)/N_<lý do>` đếm cả chân đã đặt chờ; lý do thêm `makeup_expired`. Ack `received` **không ghi đè** kết quả cụ thể đã có, chỉ làm mới giờ ack.

### Giao lại để bù lệnh (Server → Gateway → EA)
Terminal khai bật bù lệnh (`InpAllowTrading=1` và `InpMakeupEnable=1`, cửa sổ N = `InpMakeupExpirySec`, tối đa 1800) thì ngoài tín hiệu mới, `/api/gw/ping` còn giao lại tín hiệu **vào lệnh** (`S|`, không bao giờ `U|`) mới hơn con trỏ của terminal và tuổi ≤ N: (1) chưa có bản ghi giao nhận và đã quá `maxAgeSec` (terminal không phản hồi lúc tín hiệu đến); (2) ack còn dở vì lỗi tạm thời (`retry:D/N`, `partial:…_<lỗi tạm thời>`, `failed:<mã tạm thời>`, `no_connection`, `retry_timeout`, `no_quote`), ack cuối cách ≥ 15 giây. Tuổi trong dòng `S|` là tuổi thật nên EA tự quyết bù. Tối đa 10 tín hiệu mỗi ping (tín hiệu mới ưu tiên). Danh sách mã tạm thời: `src/shared/makeup.ts`.

## Chữ ký tín hiệu
`sig = hex(HMAC-SHA256(EA_KEY, [tid,id,kind,side,symbol,tf,entry,sl,tp1,tp2,tp3,tp,status].join('|')))`, số null = chuỗi rỗng. Cài đặt: `src/shared/hmac.ts` (`signalCanon`, `signSignal`).
