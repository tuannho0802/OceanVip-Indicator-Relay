import type { Store, PurgeResult, PurgeSpec } from './db'
import type { Logger } from './log'
import { nullLogger } from './log'

/**
 * Dọn tín hiệu đã xong trong DB của Server (bảng signals + deliveries), tương ứng retention của Worker (worker/src/retention.ts).
 *  - Tự động (cron): mỗi ngày một lần vào giờ `retentionHour` (giờ địa phương của VPS, mặc định 03:00, giống Cron 20:00 UTC của Worker),
 *    xóa tín hiệu cũ hơn `retentionDays` ngày (mặc định 7; 0 = không tự xóa). Nếu VPS tắt đúng giờ đó thì dọn bù ngay khi chạy lại.
 *  - Thủ công: nút trên trang xem tín hiệu (chỉ từ chính VPS): xóa cũ hơn N ngày hoặc xóa hết tín hiệu đã xong.
 * Tín hiệu còn trong cửa sổ giao cho EA (maxAgeSec + dự phòng) luôn được giữ.
 */
export const DEFAULT_RETENTION_DAYS = 7
export const MAX_RETENTION_DAYS = 3650
export const DEFAULT_RETENTION_HOUR = 3
/** Cách Server kiểm tra "đến giờ dọn chưa": mỗi 10 phút (rẻ: chỉ so thời gian, không chạm DB nếu chưa đến giờ). */
export const RETENTION_CHECK_MS = 10 * 60 * 1000
/** Dự phòng thêm ngoài maxAgeSec: tín hiệu mới hơn mức này không bao giờ bị xóa. */
export const FRESH_EXTRA_SEC = 60

const META_LAST = 'retention_last'

export type RetentionCfg = { maxAgeSec: number; retentionDays: number; retentionHour: number }
export type RetentionLast = { at: number; deleted: number; auto: boolean }

export function lastRetention(store: Store): RetentionLast | null {
  const raw = store.getMeta(META_LAST)
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<RetentionLast>
    return typeof v.at === 'number' && typeof v.deleted === 'number' ? { at: v.at, deleted: v.deleted, auto: v.auto === true } : null
  } catch {
    return null
  }
}

/** Xóa theo yêu cầu (dùng chung cho cron và nút thủ công) và ghi nhớ lần dọn gần nhất. */
export function purgeNow(store: Store, cfg: RetentionCfg, spec: PurgeSpec, now: number, auto: boolean): PurgeResult {
  const r = store.purgeSignals(spec, now, cfg.maxAgeSec + FRESH_EXTRA_SEC)
  store.setMeta(META_LAST, JSON.stringify({ at: now, deleted: r.deleted, auto } satisfies RetentionLast))
  return r
}

/**
 * Mốc dọn gần nhất đã qua: hôm nay lúc `hour`:00 giờ địa phương nếu đã tới, chưa tới thì hôm qua.
 * Đến giờ dọn khi lần dọn gần nhất cũ hơn mốc này (nên dọn bù được sau khi VPS tắt qua đêm).
 */
export function lastSlot(nowSec: number, hour: number): number {
  const d = new Date(nowSec * 1000)
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0)
  if (slot.getTime() > d.getTime()) slot.setDate(slot.getDate() - 1)
  return Math.floor(slot.getTime() / 1000)
}

export function isDue(nowSec: number, lastAt: number | null, hour: number): boolean {
  return lastAt === null || lastAt < lastSlot(nowSec, hour)
}

/** Cron nội bộ của Server. `cfg` là đối tượng cấu hình đang chạy: đổi số ngày trên trang Cài đặt có hiệu lực ở lần kiểm kế tiếp. */
export class RetentionJob {
  private timer: NodeJS.Timeout | null = null
  private first: NodeJS.Timeout | null = null

  constructor(
    private readonly store: Store,
    private readonly cfg: RetentionCfg,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
    private readonly log: Logger = nullLogger,
  ) {}

  /** Chạy một lượt kiểm tra. Trả về số tín hiệu đã xóa, hoặc null nếu chưa đến giờ / đang tắt. */
  tick(): number | null {
    const days = this.cfg.retentionDays
    if (days <= 0) return null
    const now = this.clock()
    const last = lastRetention(this.store)
    if (!isDue(now, last?.at ?? null, this.cfg.retentionHour)) return null
    try {
      const r = purgeNow(this.store, this.cfg, { kind: 'older', days }, now, true)
      this.log.info(`dọn tín hiệu cũ hơn ${days} ngày: xóa ${r.deleted}`)
      return r.deleted
    } catch (e) {
      this.log.error(`dọn tín hiệu lỗi: ${String(e).slice(0, 200)}`)
      return null
    }
  }

  start(): void {
    this.stop()
    // Lần đầu sau 30 giây (để dọn bù nếu VPS vừa bật), sau đó định kỳ.
    this.first = setTimeout(() => this.tick(), 30_000)
    this.first.unref()
    this.timer = setInterval(() => this.tick(), RETENTION_CHECK_MS)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.first) clearTimeout(this.first)
    this.timer = null
    this.first = null
  }
}
