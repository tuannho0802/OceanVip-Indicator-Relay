# `src/shared/` — Mã dùng chung

Chạy được trên Node 22 **và** Cloudflare Worker (không dùng API riêng của Node, trừ `env.ts`).

| Tệp | Vai trò |
|---|---|
| `parse.ts` | `parseAlert(body)` → `entry` / `update` / `unknown` (luôn kèm lý do, không đoán). `dedupeKey`, `riskReward`. Symbol/khung chỉ nhận `[A-Za-z0-9._#@+-]{1,32}`; SL/TP sai phía bị từ chối |
| `hmac.ts` | WebCrypto: `hmacHex`, `safeEqual` (thời gian không đổi), `sameSecret` (băm hai vế rồi so), `signBody`/`SKEW_SEC` (Worker→Server), `signalCanon`/`signSignal` (Server→Gateway) |
| `makeup.ts` | Bù lệnh: `isIncompleteResult(ack)` (kết quả nào đáng giao lại), `TRANSIENT_RC`, `makeupWindow(setup)` (cửa sổ bù theo setup EA khai), `parseCfgLine`/`sanitizeSetup`/`sanitizeOrders` (lọc dữ liệu EA báo lên, chỉ để hiển thị) |
| `env.ts` | `loadEnvIfPresent(tên)`: nạp `OCEAN_ENV_FILE` hoặc `./tên` (chỉ Node) |

## Quy ước
- Thêm khuôn alert mới: sửa `parse.ts` + `test/parse.test.ts`; **không cần** deploy lại Worker.
- Đổi `signalCanon` là đổi giao thức: Server và Gateway phải cùng phiên bản (xem [PROTOCOL.md](../PROTOCOL.md)).
- Không import `node:*` vào `parse.ts`/`hmac.ts` (Worker import trực tiếp).
