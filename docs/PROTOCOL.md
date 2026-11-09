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
| `POST /api/gw/ping` | Bearer EA_KEY | Gateway ping, nhận `{now, signals:[…+sig]}` |
| `POST /api/gw/config` | Bearer EA_KEY | Gateway gửi `{port, error}` (cổng đang nghe thật, lý do nếu chưa mở được cổng); nhận `{now, config:{tfs, symbolMap, gatewayPort}}`. `gatewayPort` null = chưa đặt rõ, Gateway dùng cổng trong `gateway.env`. Gateway gọi mỗi 5 giây |
| `GET /api/state`, `/api/info`, `/api/health`, tệp tĩnh | công khai | Giao diện |

## EA ⇄ Gateway (`POST /v1/ping`, text `khóa=giá trị`)
Gửi: `login, server, [tid], bal, eq, mg, fm, ver, pos=ticket,symbol,side,vol,open,sl,tp,profit;…, acks=id:kết quả,…`
Nhận: dòng đầu `OK`, tiếp theo:
- `S|id|side|symbol|tf|entry|sl|tp1|tp2|tp3|ageSec`
- `U|id|side|status|symbol|tf|entry|sl|tp|ageSec`

Kết quả ack của EA: `received`, `opened:N`, `trading_off`, `too_old`, `price_dev`, `bad_levels`, `bad_stops`, `no_symbol`, `max_lots`, `failed:<retcode>`. Gateway tự sinh `skipped_tf`, `bad_sig`.

## Chữ ký tín hiệu
`sig = hex(HMAC-SHA256(EA_KEY, [tid,id,kind,side,symbol,tf,entry,sl,tp1,tp2,tp3,tp,status].join('|')))`, số null = chuỗi rỗng. Cài đặt: `src/shared/hmac.ts` (`signalCanon`, `signSignal`).
