/**
 * Bù lệnh (makeup) và cấu hình EA: phần dùng chung cho Gateway và Server.
 *
 * - EA báo lên mỗi N nhịp ping một dòng `cfg=` chứa các input của nó và `ord=` chứa lệnh chờ đang đặt.
 * - Server dùng `cfg` để (1) hiển thị Setup của terminal, (2) biết EA có bật bù lệnh không và cửa sổ bù là bao lâu,
 *   từ đó giao lại các tín hiệu còn dở (kể cả đã quá hạn bình thường) cho EA đặt lệnh chờ bù.
 */

/** Cửa sổ bù tối đa Server chấp nhận (giây), bất kể EA khai bao nhiêu. */
export const MAX_MAKEUP_SEC = 1800
/** Cửa sổ bù mặc định của EA (khớp `InpMakeupExpirySec`). */
export const DEFAULT_MAKEUP_SEC = 300
/** Khoảng tối thiểu (giây) giữa hai lần Server giao lại cùng một tín hiệu còn dở cho cùng một terminal. */
export const MAKEUP_RESEND_SEC = 15

const SETUP_MAX_KEYS = 48
const SETUP_MAX_VALUE = 48
const ORDERS_MAX = 100

/** Mã lỗi giao dịch tạm thời (trùng `IsTransientRc` của EA): mất kết nối, requote, timeout, off quotes, quá nhiều yêu cầu... */
const TRANSIENT_RC = new Set([4, 6, 8, 128, 135, 136, 137, 138, 141, 146, 10004, 10006, 10011, 10012, 10020, 10021, 10024, 10028, 10031])
const TRANSIENT_WORDS = new Set(['no_connection', 'retry_timeout', 'no_quote'])

/** `no_connection` / `failed:10031` / `failed_10031` là lỗi tạm thời (đáng bù); `failed:10019` (hết tiền)... thì không. */
function isTransientReason(r: string): boolean {
  if (TRANSIENT_WORDS.has(r)) return true
  const m = /^failed[:_](\d+)$/.exec(r)
  return m !== null && TRANSIENT_RC.has(Number(m[1]))
}

/**
 * Kết quả ack của EA có nghĩa "tín hiệu này chưa xong, còn chân lệnh thiếu vì lỗi tạm thời" không?
 *  - `retry:D/N`                    : đang thử lại (nếu EA chết giữa chừng thì không ai ack tiếp)
 *  - `no_connection`, `retry_timeout`, `no_quote`, `failed:<mã tạm thời>`: không mở được chân nào
 *  - `partial:D/N_<lý do tạm thời>` : thiếu chân
 * Không tính: `opened:*`, `pending:*`, `opened:*+pending:*` (đã đủ hoặc đã đặt bù), `trading_off`, `max_lots`, `bad_levels`,
 * `bad_stops`, `no_symbol`, `skipped_tf`, `bad_sig`, `too_old`, `received`, `fill_dev`, `price_dev` (EA tự xử lý trong tiến trình).
 */
export function isIncompleteResult(result: string): boolean {
  const r = result.trim()
  if (/^retry:\d+\/\d+$/.test(r)) return true
  const m = /^partial:\d+\/\d+_(.+)$/.exec(r)
  return isTransientReason(m ? (m[1] as string) : r)
}

export type EaSetup = Record<string, string>

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/

/** Dữ liệu setup nhận từ EA (qua Gateway) -> bản đã lọc; null nếu không có hoặc sai dạng. */
export function sanitizeSetup(v: unknown): EaSetup | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const out: EaSetup = {}
  let n = 0
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (n >= SETUP_MAX_KEYS) break
    if (!KEY_RE.test(k)) continue
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') continue
    // Bỏ ký tự điều khiển; cắt độ dài. Giá trị chỉ để hiển thị (UI dùng textContent).
    out[k] = String(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, SETUP_MAX_VALUE)
    n++
  }
  return n > 0 ? out : null
}

/** Dòng `cfg=` của EA (`khóa=giá trị;khóa=giá trị`) -> object. Dòng rỗng/sai thì trả null. */
export function parseCfgLine(line: string | undefined): EaSetup | null {
  if (!line) return null
  const o: Record<string, string> = {}
  for (const part of line.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim()
  }
  return sanitizeSetup(o)
}

export type PendingOrder = {
  ticket: number
  symbol: string
  type: string
  volume: number | null
  price: number | null
  sl: number | null
  tp: number | null
  /** Số giây còn lại trước khi lệnh chờ tự hủy (EA tính sẵn, tránh lệch múi giờ sàn); null = không hết hạn. */
  expires: number | null
}

const ORDER_TYPES = new Set(['buylimit', 'buystop', 'selllimit', 'sellstop'])
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function sanitizeOrders(v: unknown): PendingOrder[] {
  if (!Array.isArray(v)) return []
  const out: PendingOrder[] = []
  for (const x of v.slice(0, ORDERS_MAX) as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object') continue
    const type = String(x.type ?? '')
    if (!ORDER_TYPES.has(type)) continue
    out.push({
      ticket: Number.isInteger(x.ticket) ? (x.ticket as number) : 0,
      symbol: String(x.symbol ?? '').slice(0, 32),
      type,
      volume: numOrNull(x.volume),
      price: numOrNull(x.price),
      sl: numOrNull(x.sl),
      tp: numOrNull(x.tp),
      expires: numOrNull(x.expires),
    })
  }
  return out
}

/** Cửa sổ bù (giây) của một terminal theo setup nó khai; 0 = không bật bù lệnh. */
export function makeupWindow(setup: EaSetup | null): number {
  if (!setup) return 0
  if (setup.InpAllowTrading !== '1' || setup.InpMakeupEnable !== '1') return 0
  const n = Number(setup.InpMakeupExpirySec)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAKEUP_SEC
  return Math.min(MAX_MAKEUP_SEC, Math.floor(n))
}
