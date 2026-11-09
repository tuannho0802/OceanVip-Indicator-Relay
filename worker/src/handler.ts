import { SERVER_ID_RE, deriveServerKey } from '../../src/shared/connect'
import { sameSecret, signBody } from '../../src/shared/hmac'

/**
 * Cloudflare Worker của OCEAN Relay: "hộp thư" công khai đứng trước VPS.
 *
 * Nhiều Server: mỗi người dùng một Server ID + khóa riêng (suy ra từ SYNC_KEY gốc, xem src/shared/connect.ts).
 * Alert mặc định chia cho MỌI Server đã đăng ký; thêm `&to=id1,id2` vào webhook để chỉ giao cho Server nêu tên.
 * Server nào chỉ thấy và chỉ kéo được tín hiệu của chính nó. Việc chọn tài khoản MT5 nào đánh nằm ở Server (OCEAN_ACCOUNTS).
 *
 *  TradingView ──POST /webhook?key=…──► Worker (lưu D1, trả 200 ngay) ──push ký HMAC (khóa riêng)──► VPS /api/ingest
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
  /** Khóa GỐC của Worker: chỉ dùng để suy ra khóa riêng từng Server (không đưa cho người dùng). */
  SYNC_KEY?: string
  /** Địa chỉ VPS đặt tay cho Server đời cũ (không có Server ID). Server mới tự báo địa chỉ. */
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

/** Khóa của một Server: Server đời cũ (id rỗng) dùng thẳng khóa gốc, Server mới dùng khóa riêng suy ra từ id. */
const serverKey = (env: Env, id: string): Promise<string> => (id === '' ? Promise.resolve(env.SYNC_KEY ?? '') : deriveServerKey(env.SYNC_KEY ?? '', id))

async function serverOrigin(env: Env, id: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT url FROM servers WHERE id = ?').bind(id).first<{ url: string | null }>()
  return normalizeOrigin(row?.url) ?? (id === '' ? normalizeOrigin(env.VPS_ORIGIN) : null)
}

/** Đẩy một tín hiệu về một Server; 2xx thì đánh dấu đã nhận. Lỗi nào cũng nuốt: tín hiệu vẫn nằm trong hàng đợi để Server kéo bù. */
async function push(env: Env, server: string, id: number, created: number, raw: string, now: number, fetchFn: typeof fetch): Promise<void> {
  if (!env.SYNC_KEY) return
  const origin = await serverOrigin(env, server)
  if (!origin) return
  const body = JSON.stringify({ wid: id, age: Math.max(0, now - created), raw })
  try {
    const res = await fetchFn(`${origin}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-ocean-ts': String(now),
        'x-ocean-sig': await signBody(await serverKey(env, server), now, body),
      },
      body,
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    })
    await res.body?.cancel()
    if (res.ok) await env.DB.prepare('UPDATE deliveries SET pushed = 1 WHERE sid = ? AND server = ?').bind(id, server).run()
  } catch {
    /* Server không với tới được: chờ kéo bù */
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

type Row = { id: number; created: number; raw: string; pushed: number; total: number }

/** Tín hiệu gần đây kèm số Server đã nhận / tổng số Server được giao. */
const RECENT_SQL =
  'SELECT s.id, s.created, s.raw, (SELECT COUNT(*) FROM deliveries d WHERE d.sid = s.id) AS total, ' +
  '(SELECT COUNT(*) FROM deliveries d WHERE d.sid = s.id AND d.pushed = 1) AS pushed FROM signals s ORDER BY s.id DESC LIMIT 20'
const state = (r: Row): string => (r.total === 0 ? 'chưa có Server nào' : r.pushed >= r.total ? 'đã giao hết' : `đã giao ${r.pushed}/${r.total} Server`)

async function publicPage(env: Env, now: number): Promise<Response> {
  const rows = (await env.DB.prepare(RECENT_SQL).all<Row>()).results
  const items = rows
    .map((r) => `<li><b>#${r.id}</b> <span>${Math.max(0, now - r.created)}s trước · ${state(r)}</span><pre>${esc(r.raw.slice(0, 400))}</pre></li>`)
    .join('')
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCEAN Relay · Worker</title>
<style>body{margin:0;padding:16px;font:14px/1.45 system-ui,sans-serif;background:#07131c;color:#e6f4f8}a{color:#19c3b1}h1{font-size:16px;letter-spacing:.06em}ul{list-style:none;padding:0}li{background:#0d2230;border:1px solid #17394d;border-radius:12px;padding:10px 12px;margin:0 0 10px}span{color:#7fa3b3;font-size:12px}pre{margin:6px 0 0;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace;color:#9fc3d1}</style></head>
<body><h1>OCEAN<span style="color:#19c3b1"> RELAY</span> · Worker</h1><p>Hộp thư dự phòng (công khai, chỉ đọc). <a href="/help">Hướng dẫn vận hành Worker</a></p>
<ul>${items || '<li>Chưa có tín hiệu nào.</li>'}</ul></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...SECURITY } })
}

/** Trang hướng dẫn vận hành Worker (công khai, chỉ có lệnh mẫu, KHÔNG chứa khóa nào) để quên thì mở lại xem. */
function helpPage(): Response {
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OCEAN Relay · Hướng dẫn Worker</title>
<style>body{margin:0;padding:16px;font:14px/1.5 system-ui,sans-serif;background:#07131c;color:#e6f4f8;max-width:760px}a{color:#19c3b1}h1{font-size:16px;letter-spacing:.06em}h2{font-size:14px;margin:22px 0 6px;color:#19c3b1}pre{background:#0d2230;border:1px solid #17394d;border-radius:10px;padding:10px 12px;white-space:pre-wrap;word-break:break-all;font:12px ui-monospace,monospace;color:#cfe8f0}code{font:12px ui-monospace,monospace;color:#9fc3d1}.warn{border-left:3px solid #e0a43a;padding:4px 10px;color:#f0d9a8}</style></head>
<body><h1>OCEAN<span style="color:#19c3b1"> RELAY</span> · Hướng dẫn Worker</h1>
<p>Các lệnh dưới đây chạy trên <b>máy dev</b> (máy có mã nguồn và đã đăng nhập Cloudflare), không chạy trên VPS. <a href="/">Về hộp thư tín hiệu</a></p>

<h2>1 · Tạo Worker (chỉ làm một lần)</h2>
<pre>npm install
cd worker
npm install
npx wrangler login
npm run setup</pre>
<p><code>setup</code> tạo database D1, sinh khóa, deploy Worker, in <b>Webhook URL</b> (dán vào TradingView) và ghi khóa gốc vào <code>worker/.ocean-master.json</code>. Tệp này <b>không commit, không gửi cho ai</b>. Chưa có tệp này thì lệnh <code>issue</code> báo "Chưa có worker/.ocean-master.json".</p>

<h2>2 · Cấp mã kết nối cho một VPS</h2>
<pre>cd worker
npm run issue -- "Tên VPS"</pre>
<p>In ra Server ID và mã <code>ocean1.…</code>. Mỗi VPS một mã riêng, gửi RIÊNG cho người dùng VPS đó. Chọn Server ID tự đặt: thêm <code>--id ten-vps</code> (chữ thường, số, gạch ngang, 3-40 ký tự).</p>

<h2>3 · Dán mã trên VPS</h2>
<p>Mở <code>http://127.0.0.1:8090/#setup</code> <b>ngay trên VPS</b> (xem từ xa sẽ không thấy nút Cài đặt), dán mã vào ô "Mã kết nối", bấm <b>Lưu và kiểm tra kết nối</b>. Huy hiệu Worker báo thông là xong.</p>

<h2>4 · Xem VPS nào đã kết nối</h2>
<pre>cd worker
npm run issue -- --list</pre>
<p>Hiện từng Server: thấy lần cuối khi nào, đã báo địa chỉ chưa, đang chờ bao nhiêu tín hiệu.</p>

<h2>5 · TradingView</h2>
<p>Alert của indicator → Notifications → Webhook URL = URL do <code>setup</code> in ra (dạng <code>https://…workers.dev/webhook?key=…</code>), chọn <i>Any alert() function call</i>. Không đăng URL này ở nơi công khai.</p>

<h2>Sự cố thường gặp</h2>
<pre>Missing script: "issue"        -> bạn đang ở thư mục gốc; chạy: cd worker
Chưa có .ocean-master.json     -> chạy npm run setup trước
Trang Cài đặt báo 401 / sai mã -> cấp lại mã bằng npm run issue
Thu hồi một VPS                -> đổi SYNC_KEY gốc rồi cấp lại mã cho các VPS còn dùng
                                  (node setup.mjs --webhook-key ... --sync-key ...)</pre>
<p class="warn">Worker lỗi hoặc cần deploy lại: <code>cd worker</code> rồi <code>npm run deploy</code>.</p>
</body></html>`
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
    // Giao cho ai: `to=id1,id2` (chỉ các Server nêu tên) hoặc mọi Server đã đăng ký.
    const toRaw = url.searchParams.get('to')
    let targets: string[]
    if (toRaw !== null && toRaw.trim() !== '') {
      targets = [...new Set(toRaw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))]
      if (targets.length > 20 || targets.some((t) => !SERVER_ID_RE.test(t))) return json(400, { error: 'bad_to' })
    } else {
      targets = (await env.DB.prepare('SELECT id FROM servers').all<{ id: string }>()).results.map((r) => r.id)
    }
    const row = await env.DB.prepare('INSERT INTO signals (created, raw) VALUES (?, ?) RETURNING id').bind(now, raw).first<{ id: number }>()
    if (!row) return json(500, { error: 'store_failed' })
    for (const t of targets) await env.DB.prepare('INSERT OR IGNORE INTO deliveries (sid, server, pushed) VALUES (?, ?, 0)').bind(row.id, t).run()
    for (const t of targets) ctx.waitUntil(push(env, t, row.id, now, raw, now, fetchFn))
    // Dọn tín hiệu cũ thỉnh thoảng (không cần cron): mỗi ~1/50 lần nhận.
    if (row.id % 50 === 0) {
      ctx.waitUntil(env.DB.prepare('DELETE FROM deliveries WHERE sid IN (SELECT id FROM signals WHERE created < ?)').bind(now - KEEP_SEC).run())
      ctx.waitUntil(env.DB.prepare('DELETE FROM signals WHERE created < ?').bind(now - KEEP_SEC).run())
    }
    return json(200, { ok: true, id: row.id, servers: targets.length })
  }

  // 2) Server ↔ Worker: header x-ocean-server = Server ID, Bearer = khóa riêng của Server đó (suy ra từ SYNC_KEY gốc).
  if (p === '/api/pull' || p === '/api/ack' || p === '/api/tunnel') {
    if (!env.SYNC_KEY) return json(503, { error: 'sync_disabled' })
    const server = (req.headers.get('x-ocean-server') ?? '').trim().toLowerCase()
    if (server !== '' && !SERVER_ID_RE.test(server)) return json(400, { error: 'bad_server_id' })
    if (!(await sameSecret(bearer(req), await serverKey(env, server)))) return json(401, { error: 'bad_key' })
    // Khóa đúng nghĩa là Server do chủ Worker cấp: tự đăng ký / cập nhật lần liên lạc cuối.
    await env.DB.prepare('INSERT INTO servers (id, seen) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET seen = excluded.seen').bind(server, now).run()

    if (p === '/api/pull' && req.method === 'GET') {
      const rows = (
        await env.DB.prepare(
          'SELECT s.id, s.created, s.raw FROM deliveries d JOIN signals s ON s.id = d.sid WHERE d.server = ? AND d.pushed = 0 AND s.created >= ? ORDER BY s.id ASC LIMIT 50',
        )
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

  // 3) Công khai, chỉ đọc.
  if (req.method === 'GET') {
    if (p === '/api/health') return json(200, { status: 'ok', now })
    if (p === '/api/recent') {
      const rows = (await env.DB.prepare(RECENT_SQL).all<Row>()).results
      return json(200, {
        now,
        signals: rows.map((r) => ({ id: r.id, age: Math.max(0, now - r.created), servers: r.total, delivered: r.pushed, pushed: r.total > 0 && r.pushed >= r.total, raw: r.raw.slice(0, 400) })),
      })
    }
    if (p === '/') return publicPage(env, now)
    if (p === '/help') return helpPage()
  }
  return json(404, { error: 'not_found' })
}
