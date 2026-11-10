import type { Env } from './handler'

/**
 * Dọn tín hiệu cũ (bảng signals + deliveries) trong D1.
 *  - Tự động: Cron Trigger của Worker chạy mỗi ngày (worker/wrangler.jsonc → triggers.crons) và xóa tín hiệu cũ hơn số ngày Admin chọn.
 *    Mặc định 7 ngày (như bản trước); 0 = không tự xóa. Cấu hình nằm ở bảng kv (khóa `retention_days`) nên KHÔNG cần migration.
 *  - Thủ công (trang quản lý, tab Tín hiệu): giữ N ngày gần nhất, xóa theo khoảng ngày, hoặc xóa hết. Admin xóa của mọi người, User chỉ xóa của mình.
 * Không bao giờ xóa tín hiệu vừa nhận (trong PENDING_GRACE_SEC) mà còn VPS chưa nhận: xóa nhầm sẽ làm mất lệnh chưa kịp giao.
 */
/** Lịch dọn hằng ngày; phải khớp một dòng trong worker/wrangler.jsonc → triggers.crons (Cloudflare gửi chính chuỗi này vào event.cron). */
export const RETENTION_CRON = '0 20 * * *'
export const DEFAULT_RETENTION_DAYS = 7
export const MAX_RETENTION_DAYS = 3650
/** Khớp PULL_WINDOW_SEC của handler.ts: tín hiệu chưa giao nhưng đã quá một giờ thì VPS cũng không kéo bù nữa nên xóa được. */
export const PENDING_GRACE_SEC = 3600

const DAY = 86400
const KEY_DAYS = 'retention_days'
const KEY_LAST = 'retention_last'

export type PurgeSpec = { kind: 'older'; days: number } | { kind: 'range'; from: number; to: number } | { kind: 'all' }
export type PurgeResult = { deleted: number; kept_pending: number }

export async function getRetentionDays(env: Env): Promise<number> {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(KEY_DAYS).first<{ v: string }>()
  if (!row) return DEFAULT_RETENTION_DAYS
  const n = Number(row.v)
  return Number.isInteger(n) && n >= 0 && n <= MAX_RETENTION_DAYS ? n : DEFAULT_RETENTION_DAYS
}

export async function setRetentionDays(env: Env, days: number): Promise<void> {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(KEY_DAYS, String(days)).run()
}

export async function lastRun(env: Env): Promise<{ at: number; deleted: number } | null> {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(KEY_LAST).first<{ v: string }>()
  if (!row) return null
  try {
    const v = JSON.parse(row.v) as { at?: unknown; deleted?: unknown }
    return typeof v.at === 'number' && typeof v.deleted === 'number' ? { at: v.at, deleted: v.deleted } : null
  } catch {
    return null
  }
}

/** Số tín hiệu đang lưu và tuổi (giây) của tín hiệu cũ nhất. owner = chỉ đếm của User đó; bỏ trống = tất cả (Admin). */
export async function stats(env: Env, now: number, owner?: number): Promise<{ count: number; oldest_age: number | null }> {
  const st = env.DB.prepare(`SELECT COUNT(*) AS c, MIN(created) AS oldest FROM signals${owner === undefined ? '' : ' WHERE owner = ?'}`)
  const row = await (owner === undefined ? st : st.bind(owner)).first<{ c: number; oldest: number | null }>()
  return { count: row?.c ?? 0, oldest_age: row?.oldest == null ? null : Math.max(0, now - row.oldest) }
}

/** Điều kiện chọn tín hiệu theo yêu cầu xóa (chưa tính phần bảo vệ tín hiệu đang chờ giao). */
function selector(spec: PurgeSpec, now: number, owner?: number): { sql: string; args: number[] } {
  const parts: string[] = []
  const args: number[] = []
  if (spec.kind === 'older') {
    parts.push('created < ?')
    args.push(now - spec.days * DAY)
  } else if (spec.kind === 'range') {
    parts.push('created >= ? AND created <= ?')
    args.push(spec.from, spec.to)
  } else {
    parts.push('1 = 1')
  }
  if (owner !== undefined) {
    parts.push('owner = ?')
    args.push(owner)
  }
  return { sql: parts.join(' AND '), args }
}

/** Tín hiệu mới nhận mà vẫn còn VPS chưa nhận: cần giữ lại để VPS còn kéo bù/được đẩy. */
const FRESH_PENDING = '(created >= ? AND EXISTS (SELECT 1 FROM deliveries d WHERE d.sid = signals.id AND d.pushed = 0))'

export async function purge(env: Env, now: number, spec: PurgeSpec, owner?: number): Promise<PurgeResult> {
  const { sql, args } = selector(spec, now, owner)
  const fresh = now - PENDING_GRACE_SEC
  const count = async (extra: string): Promise<number> =>
    (await env.DB.prepare(`SELECT COUNT(*) AS c FROM signals WHERE ${sql} AND ${extra}`).bind(...args, fresh).first<{ c: number }>())?.c ?? 0
  const deleted = await count(`NOT ${FRESH_PENDING}`)
  const kept = await count(FRESH_PENDING)
  if (deleted > 0) {
    await env.DB.prepare(`DELETE FROM deliveries WHERE sid IN (SELECT id FROM signals WHERE ${sql} AND NOT ${FRESH_PENDING})`).bind(...args, fresh).run()
    await env.DB.prepare(`DELETE FROM signals WHERE ${sql} AND NOT ${FRESH_PENDING}`).bind(...args, fresh).run()
  }
  return { deleted, kept_pending: kept }
}

/** Việc của Cron Trigger: dọn theo cấu hình + xóa phiên đăng nhập hết hạn. Trả về số tín hiệu đã xóa. */
export async function runRetention(env: Env, now: number): Promise<number> {
  const days = await getRetentionDays(env)
  const deleted = days > 0 ? (await purge(env, now, { kind: 'older', days })).deleted : 0
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run()
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(KEY_LAST, JSON.stringify({ at: now, deleted })).run()
  return deleted
}
