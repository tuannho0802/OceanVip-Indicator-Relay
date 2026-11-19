/**
 * Công tắc bật/tắt từ xa cho từng tài khoản MT (login). Dùng chung cho Server (VPS) và Worker.
 *
 *  - Worker (D1) là nơi giữ trạng thái mong muốn: mỗi lần đổi, `rev` tăng 1 và `at` = giờ Worker lúc đổi.
 *  - Server (VPS) áp dụng khi `rev` mới hơn bản đang có (chống áp một lệnh cũ đến muộn), và chỉ giao tín hiệu
 *    có `received_at >= at` cho tài khoản đang BẬT (tín hiệu đến trong lúc TẮT không bao giờ "bắn bù" khi bật lại).
 *  - Không theo dõi tài khoản: chỉ có số tài khoản, tên sàn và công tắc.
 */

import { pickSetup } from './params'

/** Số tài khoản MT4/MT5: chỉ gồm chữ số. */
export const LOGIN_RE = /^\d{1,20}$/
/** Số tài khoản tối đa một VPS báo lên Worker (giữ dưới hạn mức truy vấn D1 mỗi lần gọi). */
export const MAX_ACCOUNTS = 20
export const MAX_REV = 2_000_000_000
const MAX_UNIX = 4_102_444_800

/** Một lệnh công tắc: Worker → Server (đẩy `/api/switch` hoặc kèm trong `/api/pull`). */
export type SwitchItem = { login: string; enabled: boolean; rev: number; at: number }

/** Một tài khoản mà Server báo lên Worker (`POST /api/accounts`); `rev` = bản công tắc Server đang áp dụng. */
export type AccountReport = {
  login: string
  broker: string | null
  enabled: boolean
  rev: number
  /** Tuỳ chỉnh input từ xa: rev bộ ghi đè Server đang giữ / rev EA xác nhận đã áp / input hiện tại của EA (chỉ khóa tuỳ chỉnh được). Server đời cũ không báo. */
  params_rev?: number
  ea_rev?: number
  setup?: Record<string, string>
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

export function sanitizeSwitchItem(v: unknown): SwitchItem | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.login !== 'string' || !LOGIN_RE.test(o.login)) return null
  if (typeof o.enabled !== 'boolean') return null
  if (!isInt(o.rev, 1, MAX_REV) || !isInt(o.at, 0, MAX_UNIX)) return null
  return { login: o.login, enabled: o.enabled, rev: o.rev, at: o.at }
}

export function sanitizeSwitchItems(v: unknown): SwitchItem[] {
  if (!Array.isArray(v)) return []
  const out: SwitchItem[] = []
  for (const x of v.slice(0, MAX_ACCOUNTS * 2)) {
    const it = sanitizeSwitchItem(x)
    if (it) out.push(it)
  }
  return out
}

/** Tên sàn chỉ để hiển thị: bỏ ký tự điều khiển, cắt độ dài. */
const cleanBroker = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64)
  return t === '' ? null : t
}

export function sanitizeAccountReports(v: unknown): AccountReport[] {
  if (!Array.isArray(v)) return []
  const seen = new Set<string>()
  const out: AccountReport[] = []
  for (const x of v) {
    if (out.length >= MAX_ACCOUNTS) break
    if (x === null || typeof x !== 'object' || Array.isArray(x)) continue
    const o = x as Record<string, unknown>
    if (typeof o.login !== 'string' || !LOGIN_RE.test(o.login) || seen.has(o.login)) continue
    if (typeof o.enabled !== 'boolean' || !isInt(o.rev, 0, MAX_REV)) continue
    seen.add(o.login)
    const rep: AccountReport = { login: o.login, broker: cleanBroker(o.broker), enabled: o.enabled, rev: o.rev }
    if (isInt(o.params_rev, 0, MAX_REV)) rep.params_rev = o.params_rev
    if (isInt(o.ea_rev, 0, MAX_REV)) rep.ea_rev = o.ea_rev
    if (o.setup !== undefined && o.setup !== null && typeof o.setup === 'object' && !Array.isArray(o.setup)) {
      const clean = pickSetup(o.setup as Record<string, string>)
      if (Object.keys(clean).length > 0) rep.setup = clean
    }
    out.push(rep)
  }
  return out
}
