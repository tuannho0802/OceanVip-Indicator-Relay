/**
 * Bộ đọc thông báo của indicator "OCEAN VIP by Duong" (alert() của TradingView, text thuần ngăn bằng "|").
 * Ba khuôn đã biết:
 *  1. Vào lệnh : NAME | BUY ENTRY | SYMBOL | TF | Entry: x | SL: x | TP1 40%: x | TP2 80%: x | TP3 100%: x
 *  2. Cập nhật : NAME | <direction> | <closeStatus> | SYMBOL | TF | Entry: x | SL: x | TP: x
 *  3. Khuôn lạ : trả về kind "unknown" (vẫn lưu body gốc để xem lại, không bao giờ đoán).
 */
export type Side = 'buy' | 'sell'

export type EntrySignal = {
  kind: 'entry'
  indicator: string
  side: Side
  symbol: string
  tf: string
  entry: number
  sl: number
  tp1: number
  tp2: number
  tp3: number
}

export type UpdateSignal = {
  kind: 'update'
  indicator: string
  side: Side | null
  status: string
  symbol: string
  tf: string
  entry: number | null
  sl: number | null
  tp: number | null
}

export type UnknownSignal = { kind: 'unknown'; reason: string }
export type Parsed = EntrySignal | UpdateSignal | UnknownSignal

const NUM = /^-?\d+(?:\.\d+)?$/

/** Lấy các cặp `Nhãn: số` trong các trường, nhãn chuẩn hóa về entry/sl/tp/tp1/tp2/tp3. */
function labeled(fields: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of fields) {
    const m = /^(Entry|SL|TP\d?)\b[^:]*:\s*(\S+)$/i.exec(f)
    if (!m) continue
    const raw = m[2] as string
    if (!NUM.test(raw)) continue
    out[(m[1] as string).toLowerCase()] = Number(raw)
  }
  return out
}

const sideOf = (s: string): Side | null => {
  const u = s.trim().toUpperCase()
  if (u.startsWith('BUY')) return 'buy'
  if (u.startsWith('SELL')) return 'sell'
  return null
}

/** Symbol/khung chỉ nhận ký tự an toàn (EA tách chuỗi bằng tìm ký tự, nên không cho ký tự lạ lọt qua). */
const SAFE = /^[A-Za-z0-9._#@+-]{1,32}$/

export function parseAlert(body: string): Parsed {
  const fields = body
    .replace(/\r/g, '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x.length > 0)
  if (fields.length < 6) return { kind: 'unknown', reason: 'ít trường hơn khuôn đã biết' }
  const indicator = fields[0] as string
  const second = fields[1] as string

  const entryMatch = /^(BUY|SELL)\s+ENTRY$/i.exec(second)
  if (entryMatch) {
    const side = sideOf(entryMatch[1] as string) as Side
    const symbol = (fields[2] as string).toUpperCase()
    const tf = (fields[3] as string).toUpperCase()
    if (!SAFE.test(symbol) || !SAFE.test(tf)) return { kind: 'unknown', reason: 'symbol/khung có ký tự lạ' }
    const v = labeled(fields.slice(4))
    const { entry, sl, tp1, tp2, tp3 } = v
    if (entry === undefined || sl === undefined || tp1 === undefined || tp2 === undefined || tp3 === undefined) {
      return { kind: 'unknown', reason: 'thiếu Entry/SL/TP1/TP2/TP3' }
    }
    const ok =
      side === 'buy' ? sl < entry && entry < tp1 && tp1 <= tp2 && tp2 <= tp3 : tp3 <= tp2 && tp2 <= tp1 && tp1 < entry && entry < sl
    if (!ok) return { kind: 'unknown', reason: 'SL/TP sai phía so với Entry' }
    return { kind: 'entry', indicator, side, symbol, tf, entry, sl, tp1, tp2, tp3 }
  }

  // Khuôn cập nhật: trường 2 là hướng (BUY/SELL), trường 3 là trạng thái đóng.
  const side = sideOf(second)
  if (side && fields.length >= 7) {
    const status = fields[2] as string
    const symbol = (fields[3] as string).toUpperCase()
    const tf = (fields[4] as string).toUpperCase()
    if (!SAFE.test(symbol) || !SAFE.test(tf)) return { kind: 'unknown', reason: 'symbol/khung có ký tự lạ' }
    const v = labeled(fields.slice(5))
    return {
      kind: 'update',
      indicator,
      side,
      status,
      symbol,
      tf,
      entry: v.entry ?? null,
      sl: v.sl ?? null,
      tp: v.tp ?? null,
    }
  }
  return { kind: 'unknown', reason: 'không khớp khuôn nào' }
}

/** Khóa chống trùng: TradingView có thể gửi lại cùng một tín hiệu. */
export function dedupeKey(p: EntrySignal | UpdateSignal): string {
  if (p.kind === 'entry') return `entry|${p.symbol}|${p.tf}|${p.side}|${p.entry}`
  return `update|${p.symbol}|${p.tf}|${p.side ?? '-'}|${p.status}|${p.entry ?? '-'}`
}

/** R:R theo TP3 (chỉ để hiển thị). */
export function riskReward(p: EntrySignal): number {
  const risk = Math.abs(p.entry - p.sl)
  return risk === 0 ? 0 : Math.abs(p.tp3 - p.entry) / risk
}
