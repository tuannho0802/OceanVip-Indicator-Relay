import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { SKEW_SEC, type WireSignal, safeEqual, sameSecret, signBody, signSignal } from '../shared/hmac'
import { dedupeKey, parseAlert, riskReward } from '../shared/parse'
import { APP_VERSION, type ServerConfig } from './config'
import { type SignalRow, Store } from './db'
import { type Logger, nullLogger } from './log'
import { FailLimiter } from './ratelimit'
import type { SetupController } from './setup'
import type { IngestResult, WorkerItem } from './worker-sync'

const MAX_BODY = 16 * 1024
const ONLINE_SEC = 20

const readBody = (req: IncomingMessage, max = MAX_BODY): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    let tooBig = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // Quá lớn: không giữ nữa nhưng vẫn đọc hết để trả được 413 (đóng socket giữa chừng làm client thấy lỗi mạng).
      if (size > max) tooBig = true
      else chunks.push(c)
    })
    req.on('end', () => (tooBig ? reject(new Error('body quá lớn')) : resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })

const SECURITY = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
}

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY })
  res.end(JSON.stringify(body))
}

const bearer = (req: IncomingMessage): string => {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

const isLoopback = (a: string | undefined): boolean => a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'

/**
 * Yêu cầu có đến từ chính người đang ngồi trên VPS không (điều kiện để được dùng trang Cài đặt)?
 * Giao diện còn được lộ ra Internet qua Cloudflare Tunnel (chỉ xem), nên phải loại các yêu cầu đi qua tunnel:
 * tunnel nối vào từ loopback nhưng luôn gắn cf-connecting-ip / x-forwarded-for. Host phải là 127.0.0.1/localhost
 * (chống DNS rebinding) và Origin (nếu có) phải là chính trang này (chống trang web lạ trong trình duyệt gọi lén).
 */
export function isLocalAdmin(req: IncomingMessage): boolean {
  if (!isLoopback(req.socket.remoteAddress)) return false
  if (req.headers['cf-connecting-ip'] !== undefined || req.headers['x-forwarded-for'] !== undefined || req.headers['cf-ray'] !== undefined) return false
  const host = String(req.headers.host ?? '')
  if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return false
  const origin = req.headers.origin
  return origin === undefined || origin === `http://${host}`
}

/**
 * IP thật của bên gọi. Cloudflare Tunnel nối vào từ loopback và gắn cf-connecting-ip; chỉ tin header đó khi kết nối
 * đến từ loopback (kẻ ngoài không tự đặt được vì Cloudflare ghi đè, còn máy khác không vào được cổng loopback).
 */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress
  const cf = req.headers['cf-connecting-ip']
  if (isLoopback(peer) && typeof cf === 'string' && cf.length <= 64) return cf
  return peer ?? 'unknown'
}

/** Giao diện công khai: chỉ lộ 3 số cuối của số tài khoản MT5. */
const maskLogin = (l: string | null): string | null => (l && l.length > 3 ? `${'•'.repeat(l.length - 3)}${l.slice(-3)}` : l)
/** `tid` mặc định là `login@server`, nên che phần login. */
const maskTid = (t: string): string => t.replace(/^(\d+)@/, (_m, d: string) => `${maskLogin(d)}@`)

const MIMES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export type AppDeps = {
  clock?: () => number
  log?: Logger
  /** Địa chỉ Quick Tunnel hiện tại (hoặc null). */
  tunnelUrl?: () => string | null
  /** Tình trạng đồng bộ với Worker, để hiện trên giao diện. */
  workerStatus?: () => { lastPollOk: number; lastError: string; pulled: number }
  /** Trang Cài đặt (đổi mã kết nối, tài khoản... ngay trên giao diện). Không có thì các đường /api/setup trả 404. */
  setup?: SetupController
}

export type App = {
  server: Server
  store: Store
  /** Đưa một tín hiệu do Worker chuyển (đường push hoặc kéo bù) vào Server. */
  ingestFromWorker: (item: WorkerItem) => IngestResult
  close: () => void
}

type PingPosition = { ticket: number; symbol: string; side: string; volume: number | null; open: number | null; sl: number | null; tp: number | null; profit: number | null }

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function createApp(cfg: ServerConfig, deps: AppDeps = {}): App {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000))
  const log = deps.log ?? nullLogger
  const startedAt = clock()
  const store = new Store(cfg.dbFile)
  const fails = new FailLimiter(20, 300)

  /** Một đường duy nhất để một body alert thành một dòng tín hiệu, dù đến từ webhook trực tiếp hay từ Worker. */
  const ingest = (raw: string, now: number, ext?: { wid: number; receivedAt: number }) => {
    const parsed = parseAlert(raw)
    const key = parsed.kind === 'unknown' ? null : dedupeKey(parsed)
    const r = store.insertSignal(parsed, raw, key, now, cfg.dedupeSec, ext)
    const via = ext ? `worker wid=${ext.wid}` : 'webhook'
    if ('duplicateOf' in r) log.info(`${via}: trùng tín hiệu #${r.duplicateOf}`)
    else if (parsed.kind === 'unknown') log.warn(`${via}: không đọc được body (${parsed.reason}) -> lưu #${r.id}`)
    else log.info(`${via}: nhận ${parsed.kind} #${r.id} ${parsed.symbol} ${parsed.tf}`)
    return { r, parsed }
  }

  const ingestFromWorker = (item: WorkerItem): IngestResult => {
    const now = clock()
    // Tuổi do Worker tính (giờ của Worker) nên không phụ thuộc đồng hồ VPS lệch hay không.
    const { r } = ingest(item.raw, now, { wid: item.wid, receivedAt: Math.max(0, now - Math.floor(item.age)) })
    return 'duplicateOf' in r ? 'dup' : 'new'
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    const now = clock()
    const ip = clientIp(req)

    /** Sai khóa: ghi nhận để chặn dò khóa. */
    const reject = (code: number, error: string, what: string) => {
      fails.fail(ip, now)
      log.warn(`${what}: ${error} từ ${ip}`)
      return json(res, code, { error })
    }
    const throttled = (): boolean => fails.blocked(ip, now)

    // 1) Webhook gọi thẳng vào Server (khi không dùng Worker). Lưu body gốc, trả lời nhanh: TradingView chỉ chờ ~3 giây, không gửi lại.
    if (p === '/webhook' && req.method === 'POST') {
      if (!cfg.webhookKey) return json(res, 503, { error: 'webhook_disabled' })
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      if (!(await sameSecret(url.searchParams.get('key') ?? '', cfg.webhookKey))) return reject(401, 'bad_key', 'webhook')
      let raw: string
      try {
        raw = await readBody(req)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const { r, parsed } = ingest(raw, now)
      if ('duplicateOf' in r) return json(res, 200, { ok: true, duplicate: true, id: r.duplicateOf })
      return json(res, 200, { ok: true, id: r.id, kind: parsed.kind })
    }

    // 2) Worker đẩy tín hiệu về: thân JSON {wid, age, raw}, ký HMAC(SYNC_KEY, "ts.body").
    if (p === '/api/ingest' && req.method === 'POST') {
      if (!cfg.syncKey) return json(res, 503, { error: 'worker_disabled' })
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      let body: string
      try {
        body = await readBody(req, MAX_BODY + 1024)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const ts = Number(req.headers['x-ocean-ts'])
      const sig = String(req.headers['x-ocean-sig'] ?? '')
      if (!Number.isInteger(ts) || Math.abs(now - ts) > SKEW_SEC) return reject(401, 'bad_time', 'ingest')
      if (!safeEqual(sig, await signBody(cfg.syncKey, ts, body))) return reject(401, 'bad_sig', 'ingest')
      let b: Partial<WorkerItem>
      try {
        b = JSON.parse(body) as Partial<WorkerItem>
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      if (!Number.isInteger(b.wid) || (b.wid as number) <= 0 || typeof b.raw !== 'string' || b.raw.length > MAX_BODY) return json(res, 400, { error: 'bad_item' })
      const age = typeof b.age === 'number' && Number.isFinite(b.age) ? Math.max(0, b.age) : 0
      const r = ingestFromWorker({ wid: b.wid as number, age, raw: b.raw })
      return json(res, 200, { ok: true, duplicate: r === 'dup' })
    }

    // 3) Gateway (EA): ping + nhận tín hiệu. Khóa EA để biết đúng là EA của mình; tín hiệu giao xuống có chữ ký.
    if (p === '/api/gw/ping' && req.method === 'POST') {
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      if (!(await sameSecret(bearer(req), cfg.eaKey))) return reject(401, 'bad_key', 'gateway')
      let b: Record<string, unknown>
      try {
        b = JSON.parse(await readBody(req, 64 * 1024)) as Record<string, unknown>
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      const tid = String(b.tid ?? '')
      if (!/^[A-Za-z0-9._:@-]{1,64}$/.test(tid)) return json(res, 400, { error: 'bad_tid' })
      // Mỗi Server chỉ phục vụ các tài khoản MT5 đã khai (OCEAN_ACCOUNTS): tài khoản lạ không nhận tín hiệu dù trùng khóa EA.
      if (cfg.accounts.length > 0 && !cfg.accounts.includes(String(b.login ?? '').trim())) {
        log.warn(`gateway: tài khoản ${String(b.login ?? '?').slice(0, 12)} không nằm trong danh sách tài khoản của Server (thêm ở trang Cài đặt)`)
        return json(res, 403, { error: 'account_not_allowed' })
      }
      const num = (v: unknown) => numOrNull(v) ?? undefined
      const str = (v: unknown, n: number) => (v === undefined ? undefined : String(v).slice(0, n))
      const positions: PingPosition[] = Array.isArray(b.positions)
        ? (b.positions.slice(0, 200) as Record<string, unknown>[])
            .filter((x) => x && typeof x === 'object')
            .map((x) => ({
              ticket: Number.isInteger(x.ticket) ? (x.ticket as number) : 0,
              symbol: String(x.symbol ?? '').slice(0, 32),
              side: x.side === 'sell' ? 'sell' : 'buy',
              volume: numOrNull(x.volume),
              open: numOrNull(x.open),
              sl: numOrNull(x.sl),
              tp: numOrNull(x.tp),
              profit: numOrNull(x.profit),
            }))
        : []
      const t = store.upsertTerminal({
        tid,
        now,
        login: str(b.login, 32),
        server: str(b.server, 64),
        balance: num(b.balance),
        equity: num(b.equity),
        margin: num(b.margin),
        free_margin: num(b.free_margin),
        ea_ver: str(b.ea_ver, 16),
        positions: Array.isArray(b.positions) ? JSON.stringify(positions) : undefined,
      })
      if (Array.isArray(b.acks)) {
        for (const a of b.acks.slice(0, 50) as { id?: unknown; result?: unknown }[]) {
          if (typeof a.id === 'number' && Number.isInteger(a.id)) store.ack(tid, a.id, String(a.result ?? 'ok'), now)
        }
      }
      const rows = store.pending(tid, t.cursor, now - cfg.maxAgeSec, 10)
      const signals = await Promise.all(
        rows.map(async (s) => {
          const wire: WireSignal = {
            id: s.id, kind: s.kind, side: s.side, symbol: s.symbol, tf: s.tf,
            entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, tp: s.tp, status: s.status,
          }
          return { ...wire, received_at: s.received_at, sig: await signSignal(cfg.eaKey, tid, wire) }
        }),
      )
      // Kèm cấu hình người dùng đặt trên trang Cài đặt: Gateway áp dụng ngay, không phải sửa gateway.env hay chạy lại.
      return json(res, 200, { now, signals, config: { tfs: cfg.tfs, symbolMap: cfg.symbolMap } })
    }

    // 4) Công khai, chỉ đọc: giao diện xem tín hiệu và terminal (không đăng nhập).
    if (p === '/api/state' && req.method === 'GET') {
      const signals = store.recentSignals(50)
      const del = store.deliveriesFor(signals.map((s) => s.id))
      const terminals = store.terminals().map((t) => ({
        tid: maskTid(t.tid),
        login: maskLogin(t.login), server: t.server, balance: t.balance, equity: t.equity,
        margin: t.margin, free_margin: t.free_margin, ea_ver: t.ea_ver, last_seen: t.last_seen,
        positions: JSON.parse(t.positions) as unknown,
        online: now - t.last_seen <= ONLINE_SEC,
      }))
      const view = (s: SignalRow) => ({
        id: s.id, received_at: s.received_at, kind: s.kind, side: s.side, symbol: s.symbol, tf: s.tf,
        entry: s.entry, sl: s.sl, tp1: s.tp1, tp2: s.tp2, tp3: s.tp3, tp: s.tp, status: s.status,
        src: s.src,
        raw: s.kind === 'unknown' ? s.raw : undefined,
        note: s.note,
        expired: now - s.received_at > cfg.maxAgeSec,
        rr:
          s.kind === 'entry' && s.entry !== null && s.sl !== null && s.tp3 !== null
            ? riskReward({ kind: 'entry', indicator: '', side: 'buy', symbol: '', tf: '', entry: s.entry, sl: s.sl, tp1: 0, tp2: 0, tp3: s.tp3 })
            : null,
        deliveries: del
          .filter((d) => d.signal_id === s.id)
          .map((d) => ({ tid: maskTid(d.tid), result: d.result, at: d.at })),
      })
      return json(res, 200, { now, maxAgeSec: cfg.maxAgeSec, signals: signals.map(view), terminals })
    }

    // Trang Cài đặt: chỉ từ chính VPS (xem isLocalAdmin). POST còn phải kèm header x-ocean-setup (trình duyệt buộc preflight
    // với header lạ nên trang web khác không gọi lén được) và là JSON.
    if (p === '/api/setup' && deps.setup) {
      if (!isLocalAdmin(req)) return json(res, 403, { error: 'local_only' })
      if (req.method === 'GET') return json(res, 200, deps.setup.view())
      if (req.method === 'POST') {
        if (req.headers['x-ocean-setup'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 400, { error: 'bad_request' })
        let body: unknown
        try {
          body = JSON.parse(await readBody(req, 8 * 1024))
        } catch {
          return json(res, 400, { ok: false, error: 'Dữ liệu gửi lên không đọc được.' })
        }
        const r = await deps.setup.save(body)
        return json(res, r.ok ? 200 : 400, r)
      }
      return json(res, 405, { error: 'method_not_allowed' })
    }

    if (p === '/api/info' && req.method === 'GET') {
      const w = deps.workerStatus?.()
      return json(res, 200, {
        name: cfg.name, version: APP_VERSION, now, uptimeSec: now - startedAt,
        // local = người xem đang ngồi trên VPS (được mở trang Cài đặt); needsSetup = chưa có đường nhận tín hiệu nào.
        local: deps.setup !== undefined && isLocalAdmin(req),
        needsSetup: cfg.workerUrl === '' && cfg.webhookKey === '',
        baseUrl: cfg.publicUrl || deps.tunnelUrl?.() || null,
        serverId: cfg.serverId || null,
        accounts: cfg.accounts.map(maskLogin),
        worker: cfg.workerUrl
          ? { url: cfg.workerUrl, lastPollAgoSec: w && w.lastPollOk > 0 ? now - w.lastPollOk : null, error: w?.lastError ?? '', pulled: w?.pulled ?? 0 }
          : null,
      })
    }

    // /api/health: bộ cài và script kiểm tra dùng `status === 'ok'`.
    if (p === '/api/health') return json(res, 200, { status: 'ok', version: APP_VERSION, now })

    if (req.method === 'GET') {
      const name = p === '/' ? 'index.html' : p.slice(1)
      if (/^[A-Za-z0-9._-]+$/.test(name) && MIMES[path.extname(name)]) {
        try {
          const data = readFileSync(path.join(cfg.uiDir, name))
          res.writeHead(200, { 'content-type': MIMES[path.extname(name)] as string, 'cache-control': 'no-cache', ...SECURITY })
          return void res.end(data)
        } catch {
          /* rơi xuống 404 */
        }
      }
    }
    json(res, 404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error(`lỗi xử lý ${req.method} ${req.url?.split('?')[0]}: ${String(e).slice(0, 200)}`)
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.end()
    })
  })
  return { server, store, ingestFromWorker, close: () => { server.close(); store.db.close() } }
}
