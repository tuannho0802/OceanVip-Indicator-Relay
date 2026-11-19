import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { SKEW_SEC, type WireSignal, safeEqual, sameSecret, signBody, signSignal } from '../shared/hmac'
import { MAKEUP_RESEND_SEC, isIncompleteResult, makeupWindow, sanitizeOrders, sanitizeSetup } from '../shared/makeup'
import { dedupeKey, parseAlert, riskReward } from '../shared/parse'
import { type ParamsItem, paramsLine, sanitizeParamsItem } from '../shared/params'
import { LOGIN_RE, type AccountReport, type SwitchItem, sanitizeSwitchItem } from '../shared/switch'
import { APP_VERSION, type ServerConfig } from './config'
import { type PurgeSpec, type SignalRow, Store } from './db'
import { type Logger, nullLogger } from './log'
import { FailLimiter } from './ratelimit'
import { MAX_RETENTION_DAYS, lastRetention, purgeNow } from './retention'
import type { SetupController } from './setup'
import type { TunnelStatus } from './tunnel'
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
  /** Tình trạng Quick Tunnel (trạng thái, địa chỉ, lần kiểm gần nhất) để giao diện luôn hiện đúng tunnel đang chạy. */
  tunnelStatus?: () => TunnelStatus | null
  /** Tình trạng đồng bộ với Worker, để hiện trên giao diện. */
  workerStatus?: () => { lastPollOk: number; lastError: string; pulled: number }
  /** Trang Cài đặt (đổi mã kết nối, tài khoản... ngay trên giao diện). Không có thì các đường /api/setup trả 404. */
  setup?: SetupController
  /** Lần đầu thấy một tài khoản MT: để báo ngay cho Worker (không đợi nhịp kéo kế tiếp). */
  onNewAccount?: (login: string) => void
  /** Worker vừa đẩy một lệnh bật/tắt đã được áp: xác nhận lại cho Worker ngay. */
  onSwitched?: () => void
  /** Worker vừa đẩy bộ input mới (đã áp), hoặc EA vừa báo đã áp rev mới: báo lại Worker ngay (trạng thái "đã áp"). */
  onParamsChanged?: () => void
}

export type App = {
  server: Server
  store: Store
  /** Đưa một tín hiệu do Worker chuyển (đường push hoặc kéo bù) vào Server. */
  ingestFromWorker: (item: WorkerItem) => IngestResult
  /** Áp các lệnh bật/tắt tài khoản MT do Worker gửi (kéo bù). Trả true nếu có thay đổi. */
  applySwitches: (items: SwitchItem[]) => boolean
  /** Danh sách tài khoản MT + công tắc đang áp dụng, để báo lên Worker. */
  accountReports: () => AccountReport[]
  /** Áp các bộ input EA do Worker gửi (kéo bù). Trả true nếu có thay đổi. */
  applyParams: (items: ParamsItem[]) => boolean
  close: () => void
}

type PingPosition = { ticket: number; symbol: string; side: string; volume: number | null; open: number | null; sl: number | null; tp: number | null; profit: number | null }

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Setup EA gửi lên -> JSON để lưu (undefined = ping này không gửi, giữ bản cũ). */
const sanitizeSetupJson = (v: unknown): string | undefined => {
  const s = sanitizeSetup(v)
  return s ? JSON.stringify(s) : undefined
}
const parseSetup = (j: string | null): Record<string, string> | null => {
  if (!j) return null
  try {
    return sanitizeSetup(JSON.parse(j))
  } catch {
    return null
  }
}

export function createApp(cfg: ServerConfig, deps: AppDeps = {}): App {
  const clock = deps.clock ?? (() => Math.floor(Date.now() / 1000))
  const log = deps.log ?? nullLogger
  const startedAt = clock()
  const store = new Store(cfg.dbFile)
  const fails = new FailLimiter(20, 300)
  /** Gateway báo về qua /api/gw/config: lúc báo, cổng đang nghe thật (0 = chưa nghe được) và lỗi nếu có. Chỉ để trang Cài đặt hiển thị. */
  const gwLink = { at: 0, port: 0, error: '' }

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

  const applySwitches = (items: SwitchItem[]): boolean => {
    const now = clock()
    let changed = false
    for (const it of items) {
      if (cfg.accounts.length > 0 && !cfg.accounts.includes(it.login)) continue
      if (store.applySwitch(it, now)) {
        changed = true
        log.info(`công tắc từ xa: tài khoản ${it.login} -> ${it.enabled ? 'BẬT' : 'TẮT'} (rev ${it.rev})`)
      }
    }
    return changed
  }
  const accountReports = (): AccountReport[] => store.accountReports(cfg.accounts)

  const applyParams = (items: ParamsItem[]): boolean => {
    const now = clock()
    let changed = false
    for (const it of items) {
      if (cfg.accounts.length > 0 && !cfg.accounts.includes(it.login)) continue
      if (store.applyParams(it, now)) {
        changed = true
        log.info(`input EA từ xa: tài khoản ${it.login} nhận ${Object.keys(it.values).length} giá trị ghi đè (rev ${it.rev})`)
      }
    }
    return changed
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

    // 2b) Worker đo độ trễ: cùng chữ ký như /api/ingest nhưng KHÔNG tạo tín hiệu. Trả giờ Server để Worker biết VPS có lệch giờ (bad_time) không.
    if (p === '/api/ping' && req.method === 'POST') {
      if (!cfg.syncKey) return json(res, 503, { error: 'worker_disabled' })
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      let body: string
      try {
        body = await readBody(req, 1024)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const ts = Number(req.headers['x-ocean-ts'])
      const sig = String(req.headers['x-ocean-sig'] ?? '')
      if (!Number.isInteger(ts) || Math.abs(now - ts) > SKEW_SEC) return reject(401, 'bad_time', 'ping')
      if (!safeEqual(sig, await signBody(cfg.syncKey, ts, body))) return reject(401, 'bad_sig', 'ping')
      return json(res, 200, { ok: true, now, skew: now - ts })
    }

    // 2c) Worker bật/tắt một tài khoản MT: cùng chữ ký như /api/ingest, thân JSON {login, enabled, rev, at}.
    // Tắt = ngừng giao tín hiệu cho tài khoản đó; lệnh đang mở vẫn do EA tự quản lý.
    if (p === '/api/switch' && req.method === 'POST') {
      if (!cfg.syncKey) return json(res, 503, { error: 'worker_disabled' })
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      let body: string
      try {
        body = await readBody(req, 2048)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const ts = Number(req.headers['x-ocean-ts'])
      const sig = String(req.headers['x-ocean-sig'] ?? '')
      if (!Number.isInteger(ts) || Math.abs(now - ts) > SKEW_SEC) return reject(401, 'bad_time', 'switch')
      if (!safeEqual(sig, await signBody(cfg.syncKey, ts, body))) return reject(401, 'bad_sig', 'switch')
      let item: SwitchItem | null
      try {
        item = sanitizeSwitchItem(JSON.parse(body))
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      if (!item) return json(res, 400, { error: 'bad_item' })
      if (cfg.accounts.length > 0 && !cfg.accounts.includes(item.login)) return json(res, 403, { error: 'account_not_allowed' })
      const changed = applySwitches([item])
      if (changed) deps.onSwitched?.()
      return json(res, 200, { ok: true, changed, rev: store.getSwitch(item.login)?.rev ?? 0 })
    }

    // 2d) Worker đẩy bộ input EA của một tài khoản MT: cùng chữ ký như /api/switch, thân JSON {login, rev, at, values}.
    // Server chỉ lưu; EA nhận ở nhịp ping kế tiếp (qua Gateway) và báo lại rev đã áp.
    if (p === '/api/params' && req.method === 'POST') {
      if (!cfg.syncKey) return json(res, 503, { error: 'worker_disabled' })
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      let body: string
      try {
        body = await readBody(req, 8192)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const ts = Number(req.headers['x-ocean-ts'])
      const sig = String(req.headers['x-ocean-sig'] ?? '')
      if (!Number.isInteger(ts) || Math.abs(now - ts) > SKEW_SEC) return reject(401, 'bad_time', 'params')
      if (!safeEqual(sig, await signBody(cfg.syncKey, ts, body))) return reject(401, 'bad_sig', 'params')
      let item: ParamsItem | null
      try {
        item = sanitizeParamsItem(JSON.parse(body))
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      if (!item) return json(res, 400, { error: 'bad_item' })
      if (cfg.accounts.length > 0 && !cfg.accounts.includes(item.login)) return json(res, 403, { error: 'account_not_allowed' })
      const changed = applyParams([item])
      if (changed) deps.onParamsChanged?.()
      return json(res, 200, { ok: true, changed, rev: store.getParams(item.login)?.rev ?? 0 })
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
      const loginStr = str(b.login, 32)
      const newAccount = loginStr !== undefined && LOGIN_RE.test(loginStr) && !store.hasLogin(loginStr)
      const t = store.upsertTerminal({
        tid,
        now,
        login: loginStr,
        server: str(b.server, 64),
        balance: num(b.balance),
        equity: num(b.equity),
        margin: num(b.margin),
        free_margin: num(b.free_margin),
        ea_ver: str(b.ea_ver, 16),
        positions: Array.isArray(b.positions) ? JSON.stringify(positions) : undefined,
        // Cấu hình (input) và lệnh chờ của EA: EA đời cũ không gửi thì giữ nguyên giá trị đã lưu (COALESCE).
        setup: sanitizeSetupJson(b.setup),
        orders: Array.isArray(b.orders) ? JSON.stringify(sanitizeOrders(b.orders)) : undefined,
      })
      if (Array.isArray(b.acks)) {
        for (const a of b.acks.slice(0, 50) as { id?: unknown; result?: unknown }[]) {
          if (typeof a.id === 'number' && Number.isInteger(a.id)) store.ack(tid, a.id, String(a.result ?? 'ok'), now)
        }
      }
      if (newAccount && loginStr) deps.onNewAccount?.(loginStr)
      // Input EA từ xa: EA báo `prev` = rev bộ ghi đè nó đang áp (0 = chưa áp gì / vừa khởi động lại). Server giao bộ ghi đè khi rev của Server
      // MỚI hơn `prev`, nên EA khởi động lại tự nhận lại, và EA đã áp rồi thì không nhận lặp.
      const prev = Number.isInteger(b.prev) && (b.prev as number) >= 0 && (b.prev as number) <= 2_000_000_000 ? (b.prev as number) : 0
      if (b.prev !== undefined && store.setEaRev(t.login, prev, now)) deps.onParamsChanged?.()
      // Công tắc từ xa (Worker): tài khoản TẮT thì không nhận tín hiệu nào; BẬT lại thì chỉ nhận tín hiệu đến từ lúc bật (không bắn bù
      // các tín hiệu đến trong lúc tắt). Tín hiệu bị chặn được ghi kết quả `remote_off` để không bao giờ giao lại (kể cả bù lệnh).
      const sw = store.getSwitch(t.login)
      const off = sw !== undefined && sw.enabled === 0
      const since = sw !== undefined && sw.enabled === 1 ? sw.since : 0
      let rows = store.pending(tid, t.cursor, now - cfg.maxAgeSec, 10)
      if (off || since > 0) {
        const keep: SignalRow[] = []
        for (const r of rows) {
          if (off || r.received_at < since) store.ack(tid, r.id, 'remote_off', now)
          else keep.push(r)
        }
        rows = keep
      }
      // Bù lệnh: EA bật bù (khai trong setup) thì giao lại tín hiệu còn dở, kể cả đã quá hạn bình thường, trong cửa sổ N giây của EA.
      const mk = off ? 0 : makeupWindow(parseSetup(t.setup))
      if (mk > 0 && rows.length < 10) {
        const extra = store.makeupCandidates(tid, t.cursor, now, {
          makeupSec: mk, maxAgeSec: cfg.maxAgeSec, resendSec: MAKEUP_RESEND_SEC, isIncomplete: isIncompleteResult, limit: 10 - rows.length,
        }).filter((x) => x.received_at >= since)
        if (extra.length > 0) log.info(`bù lệnh: giao lại ${extra.length} tín hiệu còn dở cho ${tid} (#${extra.map((x) => x.id).join(', #')})`)
        rows.push(...extra)
      }
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
      // `remote: false` = tài khoản đang bị TẮT từ xa: Gateway báo cho EA (EA mới hiện lên biểu đồ; EA cũ bỏ qua).
      const pr = store.getParams(t.login)
      // `params` chỉ có khi EA mới báo `prev` (EA đời cũ không báo thì không gửi) và Server có bộ ghi đè mới hơn.
      const params = pr !== undefined && b.prev !== undefined && pr.rev > prev ? paramsLine(pr.rev, store.paramValues(t.login)) : undefined
      return json(res, 200, { now, signals, remote: !off, ...(params ? { params } : {}), config: { tfs: cfg.tfs, symbolMap: cfg.symbolMap } })
    }

    // 3b) Gateway hỏi cấu hình (cổng Gateway, khung giờ, ánh xạ symbol) và báo cổng đang nghe thật + lỗi. Nhờ vậy đổi cổng trên
    // trang Cài đặt có hiệu lực trong vài giây và trang Cài đặt hiện được "Gateway chưa mở được cổng X" thay vì im lặng.
    if (p === '/api/gw/config' && req.method === 'POST') {
      if (throttled()) return json(res, 429, { error: 'too_many_attempts' })
      if (!(await sameSecret(bearer(req), cfg.eaKey))) return reject(401, 'bad_key', 'gateway')
      let b: Record<string, unknown>
      try {
        b = JSON.parse(await readBody(req, 4 * 1024)) as Record<string, unknown>
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      gwLink.at = now
      gwLink.port = typeof b.port === 'number' && Number.isInteger(b.port) && b.port >= 0 && b.port <= 65535 ? b.port : 0
      gwLink.error = typeof b.error === 'string' ? b.error.slice(0, 200) : ''
      // gatewayPort null = chưa đặt rõ: Gateway dùng cổng trong gateway.env của nó.
      return json(res, 200, { now, config: { tfs: cfg.tfs, symbolMap: cfg.symbolMap, gatewayPort: cfg.gatewayPortSet ? cfg.gatewayPort : null } })
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
        // Setup của EA (input) và lệnh chờ; setup null = EA đời cũ chưa báo.
        setup: parseSetup(t.setup),
        orders: JSON.parse(t.orders || '[]') as unknown,
        online: now - t.last_seen <= ONLINE_SEC,
        // false = tài khoản đang bị TẮT từ xa (Worker): không nhận tín hiệu mới.
        remote: store.getSwitch(t.login)?.enabled !== 0,
        // Input ghi đè từ xa: rev Server giữ, EA đã áp chưa, và các khóa đang bị ghi đè (UI hiện "input này đang do Worker đặt").
        remote_params: (() => {
          const pr = store.getParams(t.login)
          if (!pr || pr.rev === 0) return null
          return { rev: pr.rev, applied: pr.ea_rev >= pr.rev, keys: Object.keys(store.paramValues(t.login)) }
        })(),
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

    // Xóa bớt log tín hiệu đã xong: chỉ từ chính VPS (cùng điều kiện trang Cài đặt), POST + x-ocean-setup + JSON.
    // Body: {mode:'older', days:1..3650} (xóa cũ hơn N ngày) hoặc {mode:'all'} (xóa mọi tín hiệu đã xong). Tín hiệu còn hạn giao cho EA luôn được giữ.
    if (p === '/api/signals/purge') {
      if (!isLocalAdmin(req)) return json(res, 403, { error: 'local_only' })
      if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed' })
      if (req.headers['x-ocean-setup'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 400, { error: 'bad_request' })
      let b: { mode?: unknown; days?: unknown }
      try {
        b = JSON.parse(await readBody(req, 1024)) as typeof b
      } catch {
        return json(res, 400, { ok: false, error: 'Dữ liệu gửi lên không đọc được.' })
      }
      let spec: PurgeSpec
      if (b.mode === 'all') spec = { kind: 'all' }
      else if (b.mode === 'older' && typeof b.days === 'number' && Number.isInteger(b.days) && b.days >= 1 && b.days <= MAX_RETENTION_DAYS) spec = { kind: 'older', days: b.days }
      else return json(res, 400, { ok: false, error: 'Yêu cầu xóa không hợp lệ.' })
      const r = purgeNow(store, cfg, spec, now, false)
      log.info(`xóa tín hiệu từ giao diện (${spec.kind === 'all' ? 'tất cả đã xong' : `cũ hơn ${spec.days} ngày`}): xóa ${r.deleted}, giữ lại ${r.kept_fresh} tín hiệu còn hạn`)
      return json(res, 200, { ok: true, ...r, count: store.signalStats().count })
    }

    if (p === '/api/info' && req.method === 'GET') {
      const w = deps.workerStatus?.()
      const local = deps.setup !== undefined && isLocalAdmin(req)
      return json(res, 200, {
        name: cfg.name, version: APP_VERSION, now, uptimeSec: now - startedAt,
        // local = người xem đang ngồi trên VPS (được mở trang Cài đặt); needsSetup = chưa có đường nhận tín hiệu nào.
        local,
        // Tình trạng cổng Gateway: chỉ cho người ngồi trên VPS (người xem từ xa không cần biết cổng cục bộ).
        gateway: local
          ? { port: cfg.gatewayPortSet || gwLink.at === 0 || gwLink.port === 0 ? cfg.gatewayPort : gwLink.port, listening: gwLink.at > 0 ? gwLink.port : null, error: gwLink.error, lastSeenAgoSec: gwLink.at > 0 ? now - gwLink.at : null }
          : null,
        // Dọn log: chỉ người ngồi trên VPS mới thấy số liệu và nút xóa.
        retention: isLocalAdmin(req)
          ? (() => {
              const st = store.signalStats()
              const last = lastRetention(store)
              return { days: cfg.retentionDays, hour: cfg.retentionHour, count: st.count, oldestAgeSec: st.oldest === null ? null : Math.max(0, now - st.oldest), lastAt: last?.at ?? null, lastDeleted: last?.deleted ?? null, lastAuto: last?.auto ?? null }
            })()
          : null,
        needsSetup: cfg.workerUrl === '' && cfg.webhookKey === '',
        // Chỉ là địa chỉ ĐÃ thông (đã báo Worker). Tunnel đang tạo/đã rớt thì null, trạng thái chi tiết nằm ở `tunnel`.
        baseUrl: cfg.publicUrl || deps.tunnelUrl?.() || null,
        tunnel: (() => {
          const t = cfg.publicUrl ? null : deps.tunnelStatus?.()
          if (!t) return null
          const wall = Date.now()
          return { state: t.state, url: t.url, lastUrl: t.lastUrl, sinceSec: Math.max(0, Math.round((wall - t.since) / 1000)), restarts: t.restarts, error: t.error, checkedAgoSec: t.checkedAt > 0 ? Math.max(0, Math.round((wall - t.checkedAt) / 1000)) : null, rttMs: t.rttMs, connections: t.connections }
        })(),
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
  return { server, store, ingestFromWorker, applySwitches, accountReports, applyParams, close: () => { server.close(); store.db.close() } }
}
