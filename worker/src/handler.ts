import { sameSecret, signBody } from '../../src/shared/hmac'

/**
 * Cloudflare Worker của OCEAN Relay: "hộp thư" công khai đứng trước VPS.
 *
 *  TradingView ──POST /webhook?key=…──► Worker (lưu D1, trả 200 ngay) ──push ký HMAC──► VPS /api/ingest
 *                                                    ▲
 *                              VPS kéo bù GET /api/pull + POST /api/ack khi push hụt (VPS/tunnel sập đúng lúc alert bắn)
 *
 * EA KHÔNG BAO GIỜ gọi Worker: EA chỉ nói chuyện với Gateway/Server trên VPS, nên request Worker chỉ tốn khi có alert,
 * khi VPS kéo bù (mặc định 30 giây/lần) và khi có người mở trang công khai.
 * Worker không phân tích alert (việc của Server) nên đổi khuôn thông báo không phải deploy lại Worker.
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
  /** Khóa chung với Server: ký push, và xác thực /api/pull, /api/ack, /api/tunnel. */
  SYNC_KEY?: string
  /** Địa chỉ VPS đặt tay (Cloudflare Tunnel có tên). Địa chỉ VPS báo lên (Quick Tunnel) thắng giá trị này. */
  VPS_ORIGIN?: string
}
export type Ctx = { waitUntil(p: Promise<unknown>): void }

const MAX_BODY = 16 * 1024
const PULL_WINDOW_SEC = 3600
const KEEP_SEC = 7 * 86400
const PUSH_TIMEOUT_MS = 4000

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}

const json = (code: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status: code, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } })

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

const normalizeOrigin = (u: string | undefined | null): string | null => {
  const v = (u ?? '').trim().replace(/\/+$/, '')
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v) ? v : null
}

async function vpsOrigin(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT v FROM kv WHERE k = 'vps_url'").first<{ v: string }>()
  return normalizeOrigin(row?.v) ?? normalizeOrigin(env.VPS_ORIGIN)
}

/** Đẩy một tín hiệu về VPS; thành công (2xx) thì đánh dấu đã nhận. Lỗi nào cũng nuốt: tín hiệu vẫn nằm trong hàng đợi để VPS kéo bù. */
async function push(env: Env, id: number, created: number, raw: string, now: number, fetchFn: typeof fetch): Promise<void> {
  if (!env.SYNC_KEY) return
  const origin = await vpsOrigin(env)
  if (!origin) return
  const body = JSON.stringify({ wid: id, age: Math.max(0, now - created), raw })
  try {
    const res = await fetchFn(`${origin}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ocean-ts': String(now),
        'x-ocean-sig': await signBody(env.SYNC_KEY, now, body),
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    await res.body?.cancel()
    if (res.ok) await env.DB.prepare('UPDATE signals SET pushed = 1 WHERE id = ?').bind(id).run()
  } catch {
    /* VPS không với tới được: chờ kéo bù */
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

type Row = { id: number; created: number; raw: string; pushed: number }

async function publicPage(env: Env, now: number): Promise<Response> {
  const rows = (await env.DB.prepare('SELECT id, created, raw, pushed FROM signals ORDER BY id DESC LIMIT 20').all<Row>()).results
  const origin = await vpsOrigin(env)
  const items = rows
    .map((r) => `<li><b>#${r.id}</b> <span>${Math.max(0, now - r.created)}s trước · ${r.pushed ? 'VPS đã nhận' : 'chờ VPS'}</span><pre>${esc(r.raw.slice(0, 400))}</pre></li>`)
    .join('')
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCEAN Relay · Worker</title>
<style>body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;background:#07131c;color:#e6f4f8}a{color:#19c3b1}h1{font-size:16px;letter-spacing:.06em}ul{list-style:none;padding:0}li{background:#0d2230;border:1px solid #17394d;border-radius:12px;padding:10px 12px;margin:0 0 10px}span{color:#7fa3b3;font-size:12px}pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace;color:#9fc3d1}</style></head>
<body><h1>OCEAN<span style="color:#19c3b1"> RELAY</span> · Worker</h1><p>Hộp thư dự phòng (công khai, chỉ đọc). ${origin ? `Giao diện đầy đủ: <a href="${esc(origin)}/">${esc(origin)}</a>` : 'VPS chưa báo địa chỉ.'}</p>
<ul>${items || '<li>Chưa có tín hiệu nào.</li>'}</ul></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } })
}

export async function handle(req: Request, env: Env, ctx: Ctx, deps: { now?: () => number; fetchFn?: typeof fetch } = {}): Promise<Response> {
  const now = (deps.now ?? (() => Math.floor(Date.now() / 1000)))()
  const fetchFn = deps.fetchFn ?? fetch
  const url = new URL(req.url)
  const p = url.pathname

  // 1) Webhook của TradingView. Lưu trước, trả lời ngay (TradingView chỉ chờ ~3 giây và không gửi lại), đẩy về VPS sau.
  if (p === '/webhook' && req.method === 'POST') {
    if (!env.WEBHOOK_KEY) return json(503, { error: 'webhook_disabled' })
    if (!(await sameSecret(url.searchParams.get('key') ?? '', env.WEBHOOK_KEY))) return json(401, { error: 'bad_key' })
    const raw = await readCapped(req, MAX_BODY)
    if (raw === null) return json(413, { error: 'too_large' })
    if (raw.trim() === '') return json(400, { error: 'empty' })
    const row = await env.DB.prepare('INSERT INTO signals (created, raw) VALUES (?, ?) RETURNING id').bind(now, raw).first<{ id: number }>()
    if (!row) return json(500, { error: 'store_failed' })
    ctx.waitUntil(push(env, row.id, now, raw, now, fetchFn))
    // Dọn tín hiệu cũ thỉnh thoảng (không cần cron): mỗi ~1/50 lần nhận.
    if (row.id % 50 === 0) ctx.waitUntil(env.DB.prepare('DELETE FROM signals WHERE created < ?').bind(now - KEEP_SEC).run())
    return json(200, { ok: true, id: row.id })
  }

  // 2) VPS ↔ Worker (xác thực bằng SYNC_KEY).
  if (p === '/api/pull' || p === '/api/ack' || p === '/api/tunnel') {
    if (!env.SYNC_KEY) return json(503, { error: 'sync_disabled' })
    if (!(await sameSecret(bearer(req), env.SYNC_KEY))) return json(401, { error: 'bad_key' })

    if (p === '/api/pull' && req.method === 'GET') {
      const rows = (
        await env.DB.prepare('SELECT id, created, raw FROM signals WHERE pushed = 0 AND created >= ? ORDER BY id ASC LIMIT 50')
          .bind(now - PULL_WINDOW_SEC)
          .all<Omit<Row, 'pushed'>>()
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
      for (const id of list) await env.DB.prepare('UPDATE signals SET pushed = 1 WHERE id = ?').bind(id).run()
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
        await env.DB.prepare("DELETE FROM kv WHERE k = 'vps_url'").run()
        return json(200, { ok: true, url: null })
      }
      const origin = typeof u === 'string' ? normalizeOrigin(u) : null
      if (!origin) return json(400, { error: 'bad_url' })
      await env.DB.prepare("INSERT INTO kv (k, v) VALUES ('vps_url', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(origin).run()
      return json(200, { ok: true, url: origin })
    }
    return json(405, { error: 'method_not_allowed' })
  }

  // 3) Công khai, chỉ đọc.
  if (req.method === 'GET') {
    if (p === '/api/health') return json(200, { status: 'ok', now })
    if (p === '/api/recent') {
      const rows = (await env.DB.prepare('SELECT id, created, raw, pushed FROM signals ORDER BY id DESC LIMIT 20').all<Row>()).results
      return json(200, { now, signals: rows.map((r) => ({ id: r.id, age: Math.max(0, now - r.created), pushed: r.pushed === 1, raw: r.raw.slice(0, 400) })) })
    }
    if (p === '/') return publicPage(env, now)
  }
  return json(404, { error: 'not_found' })
}
