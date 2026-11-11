# `ea/` — Expert Advisor MT5

`OceanRelay.mq5` v0.4.0 (MQL5, có thử lại, sai số theo pip, bù lệnh). Bản MT4 (`OceanRelay.mq4`) v0.3.0: logic MT4 cũ (sai số theo point, chưa có hàng đợi thử lại) cộng bù lệnh. **Chưa được biên dịch hay chạy trên MT5 thật** — thử trên DEMO.

## Bản MT4 (`OceanRelay.mq4`)
MT4 báo `err=5200` nếu `InpGateway` có cổng (`http://127.0.0.1:47860`). Dùng `InpGateway=http://127.0.0.1` + Allow WebRequest `http://127.0.0.1`, và chuyển cổng 80 sang cổng Gateway bằng `netsh interface portproxy` (lệnh đầy đủ: [OPERATIONS.md](../OPERATIONS.md), mục "MT4 (cổng 80)").

## Chế độ
- Mặc định `InpAllowTrading=false`: chỉ ping, hiển thị tín hiệu, ack `trading_off`.
- Bật: với mỗi `S|…` mở 3 lệnh thị trường cùng SL, TP1/TP2/TP3 (hoặc 1 lệnh lot×3 với TP3 nếu `InpTP3Only`).

## Thứ tự kiểm tra trước khi đặt lệnh
Công tắc & Algo Trading → tuổi (`InpMaxAgeSec`) → symbol → thứ tự mức (SL < Entry < TP1 ≤ TP2 ≤ TP3 với lệnh mua) → tổng lot (`InpMaxTotalLots`) → **mỗi lượt vào lệnh** (xem mục dưới): kết nối máy chủ giao dịch → giá mới lệch Entry ≤ `InpMaxDevPips` → SL/TP đúng phía theo giá thật → stops level → **ghi id vào Global Variable** → gửi từng lệnh. Mỗi nhánh chặn trả mã ack riêng (xem [PROTOCOL.md](../PROTOCOL.md)).

## Khớp đúng giá Signal (v0.3.0)
Sai số cho phép `InpMaxDevPips` (mặc định 10 pip; vàng 2 số lẻ: 1 pip = 0.1 giá nên 10 pip = 1.0 giá; `InpPipPoints` để ép số point/pip). Giá quá sai số thì **không đánh**:
1. Mỗi lượt đọc **giá mới** rồi mới kiểm: mua so với Ask, bán so với Bid (lệch hai phía đều bị chặn).
2. Kiểm riêng từng chân: giá đã đi qua TP của chân nào thì bỏ chân đó.
3. Trượt giá gửi kèm lệnh = phần sai số còn lại theo hướng bất lợi, tối đa `InpSlippagePts`, để sàn từ chối nếu giá chạy qua (sàn Market execution có thể bỏ qua deviation, nên còn bước 4).
4. Sau khi khớp, đọc lại **giá khớp**: lệch Entry quá sai số thì cảnh báo, ngừng mở nốt các chân còn lại, và đóng lệnh đó nếu `InpCloseBadFill=true` (mặc định false vì đóng lệnh là một giao dịch có spread).
5. Trước mỗi lần thử lại, kiểm lệnh của chân đó đã vào sàn chưa (timeout nhưng lệnh vẫn khớp) để không mở lặp.

## Thử lại khi mất kết nối (v0.3.0)
Lỗi tạm thời (retcode `6` / `10031` mất kết nối, requote, timeout, off quotes, price changed, too many requests…) hoặc terminal đang mất kết nối: chân chưa mở được **thử lại mỗi `InpRetrySec` giây**, tối đa `InpRetryMaxSec` giây kể từ khi nhận tín hiệu, cho tới khi đủ 3 lệnh TP1/TP2/TP3, hoặc giá đi quá `InpMaxDevPips`, hoặc hết hạn. Lỗi không thể khắc phục (hết tiền, thị trường đóng…) thì dừng ngay. Ack: `retry:D/N` khi đang thử lại (D chân đã mở / N chân cần mở); kết thúc `opened:N`, `partial:D/N_<lý do>` hoặc mã lỗi. Hạn chế: khởi động lại/gỡ EA giữa chừng thì các lần thử lại đang chờ bị bỏ (id đã ghi nhận nên không mở lặp).

## Bù lệnh (MT5 v0.4.0 · MT4 v0.3.0, mặc định TẮT)
Chân TP1/TP2/TP3 còn thiếu thì đặt **lệnh chờ Limit/Stop tại Entry** của Signal (cùng SL/TP/comment `OCEAN#<số>/TPn`, nên BreakEven vẫn nhận ra khi khớp).

| Input | Mặc định | Ý nghĩa |
|---|---|---|
| `InpMakeupEnable` | false | Bật/tắt bù lệnh (cần `InpAllowTrading=true`) |
| `InpMakeupExpirySec` | 300 | N giây (30..1800): tín hiệu không quá N giây tuổi (kể cả đã quá `InpMaxAgeSec`) vẫn được bù; lệnh chờ tự hủy sau N giây kể từ lúc tín hiệu phát ra |

**Khi nào bù**
1. Tín hiệu đến trễ quá `InpMaxAgeSec` nhưng chưa quá N giây (terminal/EA không phản hồi lúc tín hiệu đến): thay vì `too_old`, bù cả các chân.
2. Giá đã đi xa Entry quá sai số (`price_dev`) hoặc hết thời gian thử lại (`retry_timeout`, MT5): các chân chưa mở được chuyển thành lệnh chờ thay vì bỏ.
3. MT4: chân lỗi tạm thời khi vào lệnh (mất kết nối, requote...) chuyển thành lệnh chờ.
4. Server giao **lại** tín hiệu có ack còn dở (xem [PROTOCOL.md](../PROTOCOL.md)): EA kiểm từng chân, chân nào chưa có vị thế/lệnh chờ thì bù (dùng được cả sau khi EA khởi động lại).

**Loại lệnh**: mua: Entry < Ask → Buy Limit, Entry > Ask → Buy Stop; bán: Entry > Bid → Sell Limit, Entry < Bid → Sell Stop. Giá đang sát Entry (trong sai số, hoặc gần hơn stops level) thì vào thị trường. Giá đã chạm/vượt SL của tín hiệu thì không bù (`bad_levels`). Lệnh chờ tính vào `InpMaxTotalLots`.

**Hết hạn**: lệnh chờ đặt kèm hạn của sàn (`ORDER_TIME_SPECIFIED`; sàn không hỗ trợ thì GTC); EA còn tự hủy mỗi giây theo Global Variable `OCEANPX_<login>_<ticket>` (giờ server hết hạn).

**Chống mở lặp**: trước mỗi chân kiểm vị thế đang mở, lệnh chờ và lịch sử 1 giờ theo comment; số thứ tự lệnh lưu ở Global Variable `OCEANID_<login>_<id>`; kết quả cuối không còn thiếu ghi `OCEANFIN_<login>_<id>`. Tín hiệu do EA đời cũ xử lý (không có `OCEANID_`) **không bù**, tránh nhân đôi lệnh khi nâng cấp.

**Ack**: `pending:P` (P chân đã đặt chờ), `opened:D+pending:P`, `partial:(D+P)/N_<lý do>` (lý do như `no_connection`, `makeup_expired`, `max_lots`, `failed_<mã>`...). Lý do là lỗi tạm thời thì Server giao lại sau ≥ 15 giây để bù tiếp.

**Báo lên Server**: mỗi nhịp `ord=` (lệnh chờ: ticket,symbol,type,vol,price,sl,tp,còn lại giây), mỗi 10 nhịp `cfg=` (các input như lot, sai số, bật/tắt đánh lệnh/BreakEven/bù lệnh; không gồm địa chỉ Gateway hay Terminal ID). Giao diện hiện chip bật/tắt, bảng Setup và bảng lệnh chờ của từng terminal.

Hạn chế: chưa biên dịch/chạy trên MT4/MT5 thật, thử trên DEMO; tín hiệu cập nhật `U|` chưa được dùng để hủy lệnh chờ bù (lệnh chờ chỉ tự hủy theo hạn N giây).

## Bảo mật
EA chỉ nói chuyện với Gateway cục bộ, không giữ khóa nào; chữ ký do Gateway kiểm. Lệnh mang `InpMagic` và comment `OCEAN#<số>/TPn`, trong đó `<số>` là số thứ tự lệnh **trong ngày** (giờ server broker): sang ngày mới đếm lại từ 1 (bộ đếm lưu ở Global Variable `OCEANSEQ_<login>`, khởi động lại EA vẫn đếm tiếp đúng). Id đã xử lý nằm ở Global Variable `OCEAN_<login>_<id>` nên khởi động lại không mở lệnh lần hai.

## Chưa làm
Khuôn cập nhật `U|…` chỉ ghi nhận (chưa biết các giá trị `closeStatus`); cần mẫu thật rồi mới dời SL/đóng lệnh.

## BreakEven (v0.2.0, mặc định TẮT)

Khi lệnh **TP1** (hoặc **TP2**) của một tín hiệu chốt lời, EA dời SL các lệnh còn lại của tín hiệu đó về gần **giá vào thực tế** N đơn vị.

| Input | Mặc định | Ý nghĩa |
|---|---|---|
| `InpBEEnable` | false | Bật/tắt BreakEven (cần `InpAllowTrading=true`) |
| `InpBETrigger` | `BE_AFTER_TP1` | `BE_AFTER_TP1`: TP1 chốt → dời SL TP2+TP3. `BE_AFTER_TP2`: TP2 chốt → dời SL TP3 |
| `InpBEOffset` | 3.0 | N, khoảng cách từ giá vào tới SL mới |
| `InpBEUnit` | `BE_UNIT_PRICE` | `BE_UNIT_PRICE`: theo giá (XAUUSD 3.0 = 3 USD). `BE_UNIT_PIPS`: 1 pip = 10 point |
| `InpBELockProfit` | false | false: SL phía lỗ (BUY: Entry−N, SELL: Entry+N). true: khóa lãi (BUY: Entry+N, SELL: Entry−N) |

Quy tắc: chỉ kích hoạt khi lệnh trigger **đóng do chạm TP** (đóng do SL/tay thì bỏ qua); chỉ dời SL theo hướng có lợi, không bao giờ nới SL; mỗi tín hiệu làm một lần (Global Variable `OCEANBE_<login>_<ngày×10000+số>`, khởi động lại không làm lại; khóa có kèm ngày nên số thứ tự trùng giữa các ngày không bị nhầm); SL mới phải cách giá thị trường tối thiểu stops level, nếu chưa hợp lệ EA thử lại mỗi giây tối đa 300 lần; cần tài khoản hedging; không tác dụng khi `InpTP3Only=true`. Chưa biên dịch/chạy trên MT5 thật — thử trên DEMO.
