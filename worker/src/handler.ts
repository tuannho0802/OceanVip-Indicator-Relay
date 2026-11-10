import { SERVER_ID_RE } from '../../src/shared/connect'
import { sameSecret } from '../../src/shared/hmac'
import { appRoute, ensureAdmin } from './app'
import { broadcastTargets, hookTargets, lockedAmong, normalizeOrigin, serverKey, storeAndDeliver } from './deliver'
import { json } from './http'
import { appPage, helpPage } from './ui'

/**
 * Cloudflare Worker của OCEAN Relay: "hộp thư" công khai đứng trước VPS.
 *
 * Nhiều Server: mỗi VPS một Server ID + khóa riêng (suy ra từ SYNC_KEY gốc, xem src/shared/connect.ts).
 * Phân quyền (app.ts): Admin tạo tài khoản User, cấp hạn mức, khóa/mở khóa. Mỗi User tự tạo VPS + Webhook URL của mình (trong hạn mức);
 * Webhook của User CHỈ giao cho VPS của chính User đó. Khóa chung WEBHOOK_KEY (đời cũ) chỉ giao cho VPS của Admin/VPS đời cũ,
 * thêm `&to=id1,id2` để chỉ giao cho Server nêu tên.
 *
 *  TradingView ──POST /webhook?key=…──► Worker (lưu D1, trả 200 ngay) ──push ký HMAC (khóa riêng)──► VPS /api/ingest
 *                                                    ▲
 *                              VPS kéo bù GET /api/pull + POST /api/ack khi push hụt (VPS/tunnel sập đúng lúc alert bắn)
 *
 * EA KHÔNG BAO GIỜ gọi Worker. Worker không phân tích alert (việc của Server) nên đổi khuôn thông báo không phải deploy lại Worker.
 */

/** Phần tối thiểu của D1 mà Worker dùng (khai báo tại chỗ để khỏi cần gói kiểu của Cloudflare; test dùng bản giả trên node:sqlite). */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt
  run(): Promise<unknown>
  first<T = unknown>(): Promise<T | null>
  all<T = unknown>(): Promise<{ results: T[] }>
}
export interface D1Like {
  prepare(sql: string): D1Stmt
}
export type Env = {
  DB: D1Like
  /** Khóa nằm trong URL webhook của TradingView (?key=...). */
  WEBHOOK_KEY?: string
  /** Khóa GỐC của Worker: chỉ dùng để suy ra khóa riêng từng Server (không đưa cho người dùng). */
  SYNC_KEY?: string
  /** Địa chỉ VPS đặt tay cho Server đời cũ (không có Server ID). Server mới tự báo địa chỉ. */
  VPS_ORIGIN?: string
  /** Mật khẩu ban đầu của Admin (secret). Chỉ dùng khi CHƯA có tài khoản nào: tạo Admin rồi bắt đổi mật khẩu ngay. */
  ADMIN_PASSWORD?: string
  /** Tên Admin ban đầu (mặc định `admin`). */
  ADMIN_USER?: string
  /** Địa chỉ https công khai của Worker (domain riêng). Trống = lấy từ địa chỉ đang truy cập. */
  PUBLIC_URL?: string
}
export type Ctx = { waitUntil(p: Promise<unknown>): void }

const MAX_BODY = 16 * 1024
const PULL_WINDOW_SEC = 3600
const KEEP_SEC = 7 * 86400

const bearer = (req: Request): string => {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

/** Đọc body có trần kích thước, kể cả khi client không báo Content-Length. null = quá lớn. */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const len = Number(req.headers.get('content-length') ?? '0')
  if (len > max) return null
  if (!req.body) return ''
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    all.set(c, o)
    o += c.length
  }
  return new TextDecoder().decode(all)
}

type Deps = { now?: () => number; fetchFn?: typeof fetch }

export async function handle(req: Request, env: Env, ctx: Ctx, deps: Deps = {}): Promise<Response> {
  try {
    return await route(req, env, ctx, deps)
  } catch (e) {
    const msg = String((e as Error)?.message ?? e)
    // Quên chạy migration sau khi cập nhật mã: báo thẳng cách sửa thay vì "internal error" khó hiểu.
    if (/no such (table|column)/i.test(msg)) {
      return json(500, { error: 'db_not_migrated', message: 'D1 chưa được cập nhật bảng mới. Chạy: cd worker && npx wrangler d1 migrations apply ocean-relay --remote (hoặc commit có [deploy]).' })
    }
    return json(500, { error: 'internal', message: 'Lỗi nội bộ của Worker (xem Observability trên Cloudflare)' })
  }
}

async function route(req: Request, env: Env, ctx: Ctx, deps: Deps): Promise<Response> {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))()
  const fetchFn = deps.fetchFn ?? fetch
  const url = new URL(req.url)
  const p = url.pathname

  // 1) Webhook của TradingView. Lưu trước, trả lời ngay (TradingView chỉ chờ ~3 giây và không gửi lại), đẩy về VPS sau.
  if (p === '/webhook' && req.method === 'POST') {
    const key = url.searchParams.get('key') ?? ''
    const legacy = Boolean(env.WEBHOOK_KEY) && (await sameSecret(key, env.WEBHOOK_KEY ?? ''))
    let hook: { id: number; owner: number; server: string | null; locked: number; owner_locked: number } | null = null
    if (!legacy) {
      if (key.length >= 16 && key.length <= 128) {
        hook = await env.DB.prepare('SELECT h.id, h.owner, h.server, h.locked, u.locked AS owner_locked FROM hooks h JOIN users u ON u.id = h.owner WHERE h.key = ?').bind(key).first()
      }
      if (!hook) return json(401, { error: 'bad_key', message: 'Khóa trong Webhook URL sai hoặc đã bị xoay/xóa. Lấy lại URL ở trang quản lý.' })
      if (hook.owner_locked === 1) return json(403, { error: 'user_locked', message: 'Tài khoản đang bị Admin khóa' })
      if (hook.locked === 1) return json(403, { error: 'hook_locked', message: 'Webhook này đang bị Admin khóa' })
    }
    const raw = await readCapped(req, MAX_BODY)
    if (raw === null) return json(413, { error: 'too_large' })
    if (raw.trim() === '') return json(400, { error: 'empty', message: 'Nội dung alert trống: kiểm tra ô Message của alert trên TradingView' })

    let targets: string[]
    if (hook) {
      targets = await hookTargets(env, hook)
    } else {
      const toRaw = url.searchParams.get('to')
      if (toRaw !== null && toRaw.trim() !== '') {
        targets = [...new Set(toRaw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))]
        if (targets.length > 20 || targets.some((t) => !SERVER_ID_RE.test(t))) return json(400, { error: 'bad_to' })
        const locked = await lockedAmong(env, targets)
        targets = targets.filter((t) => !locked.has(t))
      } else {
        targets = await broadcastTargets(env)
      }
    }
    const id = await storeAndDeliver(env, ctx, fetchFn, { raw, owner: hook?.owner ?? null, hook: hook?.id ?? null, targets, now })
    if (id === null) return json(500, { error: 'store_failed' })
    if (hook) ctx.waitUntil(env.DB.prepare('UPDATE hooks SET last_used = ?, hits = hits + 1 WHERE id = ?').bind(now, hook.id).run())
    // Dọn tín hiệu cũ thỉnh thoảng (không cần cron): mỗi ~1/50 lần nhận.
    if (id % 50 === 0) {
      ctx.waitUntil(env.DB.prepare('DELETE FROM deliveries WHERE sid IN (SELECT id FROM signals WHERE created < ?)').bind(now - KEEP_SEC).run())
      ctx.waitUntil(env.DB.prepare('DELETE FROM signals WHERE created < ?').bind(now - KEEP_SEC).run())
    }
    return json(200, { ok: true, id, servers: targets.length, ...(targets.length === 0 ? { warning: 'no_active_server', message: 'Đã nhận alert nhưng chưa có VPS nào đang hoạt động để giao' } : {}) })
  }

  // 2) Server ↔ Worker: header x-ocean-server = Server ID, Bearer = khóa riêng của Server đó (suy ra từ SYNC_KEY gốc).
  if (p === '/api/pull' || p === '/api/ack' || p === '/api/tunnel') {
    if (!env.SYNC_KEY) return json(503, { error: 'sync_disabled' })
    const server = (req.headers.get('x-ocean-server') ?? '').trim().toLowerCase()
    if (server !== '' && !SERVER_ID_RE.test(server)) return json(400, { error: 'bad_server_id' })
    if (!(await sameSecret(bearer(req), await serverKey(env, server)))) return json(401, { error: 'bad_key' })
    if (server !== '') {
      if (await env.DB.prepare('SELECT 1 AS x FROM revoked_servers WHERE id = ?').bind(server).first()) return json(403, { error: 'server_revoked', message: 'VPS này đã bị xóa khỏi Worker' })
      const row = await env.DB.prepare('SELECT s.locked, (SELECT locked FROM users WHERE id = s.owner) AS owner_locked FROM servers s WHERE s.id = ?').bind(server).first<{ locked: number; owner_locked: number | null }>()
      if (row && (row.locked === 1 || row.owner_locked === 1)) return json(403, { error: 'server_locked', message: 'VPS hoặc tài khoản đang bị Admin khóa' })
    }
    await env.DB.prepare('INSERT INTO servers (id, seen, created) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET seen = excluded.seen').bind(server, now, now).run()

    if (p === '/api/pull' && req.method === 'GET') {
      const rows = (
        await env.DB.prepare('SELECT s.id, s.created, s.raw FROM deliveries d JOIN signals s ON s.id = d.sid WHERE d.server = ? AND d.pushed = 0 AND s.created >= ? ORDER BY s.id ASC LIMIT 50')
          .bind(server, now - PULL_WINDOW_SEC)
          .all<{ id: number; created: number; raw: string }>()
      ).results
      return json(200, { now, items: rows.map((r) => ({ wid: r.id, age: Math.max(0, now - r.created), raw: r.raw })) })
    }

    if (p === '/api/ack' && req.method === 'POST') {
      let ids: unknown
      try {
        ids = ((await req.json()) as { ids?: unknown }).ids
      } catch {
        return json(400, { error: 'bad_json' })
      }
      const list = Array.isArray(ids) ? ids.filter((x): x is number => Number.isInteger(x) && x > 0).slice(0, 100) : []
      for (const id of list) await env.DB.prepare('UPDATE deliveries SET pushed = 1 WHERE sid = ? AND server = ?').bind(id, server).run()
      return json(200, { ok: true, acked: list.length })
    }

    if (p === '/api/tunnel' && req.method === 'POST') {
      let u: unknown
      try {
        u = ((await req.json()) as { url?: unknown }).url
      } catch {
        return json(400, { error: 'bad_json' })
      }
      if (u === null) {
        await env.DB.prepare('UPDATE servers SET url = NULL WHERE id = ?').bind(server).run()
        return json(200, { ok: true, url: null })
      }
      const origin = typeof u === 'string' ? normalizeOrigin(u) : null
      if (!origin) return json(400, { error: 'bad_url' })
      await env.DB.prepare('UPDATE servers SET url = ? WHERE id = ?').bind(origin, server).run()
      return json(200, { ok: true, url: origin })
    }
    return json(405, { error: 'method_not_allowed' })
  }

  // 3) API quản lý (đăng nhập, người dùng, VPS, Webhook, tín hiệu) — xem app.ts.
  const managed = await appRoute(req, env, ctx, url, { now, fetchFn })
  if (managed) return managed

  // 4) Công khai: kiểm tra sống, hướng dẫn (không chứa khóa) và trang quản lý (phải đăng nhập mới có dữ liệu).
  if (req.method === 'GET') {
    if (p === '/api/health') return json(200, { status: 'ok', now })
    if (p === '/help') return helpPage()
    if (p === '/') {
      await ensureAdmin(env, now)
      return appPage()
    }
  }
  return json(404, { error: 'not_found' })
}
