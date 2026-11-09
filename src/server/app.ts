import { createHash, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import path from 'node:path'
import { dedupeKey, parseAlert, riskReward } from '../shared/parse'
import type { ServerConfig } from './config'
import { type SignalRow, Store } from './db'

const MAX_BODY = 16 * 1024
const ONLINE_SEC = 20

const sameSecret = (a: string, b: string): boolean => {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let size = 0
    let tooBig = false
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      // Quá lớn: không giữ lại nữa nhưng vẫn đọc cho hết để còn trả được 413 (đóng socket giữa chừng làm client thấy lỗi mạng).
      if (size > MAX_BODY) tooBig = true
      else chunks.push(c)
    })
    req.on('end', () => (tooBig ? reject(new Error('body quá lớn')) : resolve(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

const bearer = (req: IncomingMessage): string => {
  const h = req.headers.authorization ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

export type App = { server: Server; store: Store; close: () => void }

export function createApp(cfg: ServerConfig, clock: () => number = () => Math.floor(Date.now() / 1000)): App {
  const store = new Store(cfg.dbFile)
  const mimes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const p = url.pathname
    const now = clock()

    // 1) Webhook của TradingView: luôn lưu body gốc, trả lời nhanh (TradingView chỉ chờ ~3 giây, không gửi lại).
    if (p === '/webhook' && req.method === 'POST') {
      if (!sameSecret(url.searchParams.get('key') ?? '', cfg.webhookKey)) return json(res, 401, { error: 'bad_key' })
      let raw: string
      try {
        raw = await readBody(req)
      } catch {
        return json(res, 413, { error: 'too_large' })
      }
      const parsed = parseAlert(raw)
      const key = parsed.kind === 'unknown' ? null : dedupeKey(parsed)
      const r = store.insertSignal(parsed, raw, key, now, cfg.dedupeSec)
      if ('duplicateOf' in r) return json(res, 200, { ok: true, duplicate: true, id: r.duplicateOf })
      return json(res, 200, { ok: true, id: r.id, kind: parsed.kind })
    }

    // 2) Gateway: ping (đồng thời nhận tín hiệu) — định dạng trao đổi là JSON.
    if (p === '/api/gw/ping' && req.method === 'POST') {
      if (!sameSecret(bearer(req), cfg.gatewayToken)) return json(res, 401, { error: 'bad_token' })
      let b: Record<string, unknown>
      try {
        b = JSON.parse(await readBody(req)) as Record<string, unknown>
      } catch {
        return json(res, 400, { error: 'bad_json' })
      }
      const tid = String(b.tid ?? '')
      if (!/^[A-Za-z0-9._:@-]{1,64}$/.test(tid)) return json(res, 400, { error: 'bad_tid' })
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
      const t = store.upsertTerminal({
        tid,
        now,
        login: b.login === undefined ? undefined : String(b.login).slice(0, 32),
        server: b.server === undefined ? undefined : String(b.server).slice(0, 64),
        balance: num(b.balance),
        equity: num(b.equity),
        margin: num(b.margin),
        free_margin: num(b.free_margin),
        ea_ver: b.ea_ver === undefined ? undefined : String(b.ea_ver).slice(0, 16),
        positions: Array.isArray(b.positions) ? JSON.stringify(b.positions.slice(0, 200)) : undefined,
      })
      if (Array.isArray(b.acks)) {
        for (const a of b.acks.slice(0, 50) as { id?: unknown; result?: unknown }[]) {
          if (typeof a.id === 'number' && Number.isInteger(a.id)) store.ack(tid, a.id, String(a.result ?? 'ok'), now)
        }
      }
      const rows = store.pending(tid, t.cursor, now - cfg.maxAgeSec, 10)
      return json(res, 200, {
        now,
        signals: rows.map((s) => ({
          id: s.id,
          received_at: s.received_at,
          kind: s.kind,
          side: s.side,
          symbol: s.symbol,
          tf: s.tf,
          entry: s.entry,
          sl: s.sl,
          tp1: s.tp1,
          tp2: s.tp2,
          tp3: s.tp3,
          tp: s.tp,
          status: s.status,
        })),
      })
    }

    // 3) Giao diện web + API cho người xem (token quản trị).
    if (p === '/api/state' && req.method === 'GET') {
      if (!sameSecret(bearer(req), cfg.adminToken)) return json(res, 401, { error: 'bad_token' })
      const signals = store.recentSignals(50)
      const del = store.deliveriesFor(signals.map((s) => s.id))
      const terminals = store.terminals().map((t) => ({
        ...t,
        positions: JSON.parse(t.positions) as unknown,
        online: now - t.last_seen <= ONLINE_SEC,
      }))
      const view = (s: SignalRow) => ({
        ...s,
        expired: now - s.received_at > cfg.maxAgeSec,
        rr: s.kind === 'entry' && s.entry !== null && s.sl !== null && s.tp3 !== null
          ? riskReward({ kind: 'entry', indicator: '', side: 'buy', symbol: '', tf: '', entry: s.entry, sl: s.sl, tp1: 0, tp2: 0, tp3: s.tp3 })
          : null,
        deliveries: del.filter((d) => d.signal_id === s.id).map((d) => ({ tid: d.tid, result: d.result, at: d.at })),
      })
      return json(res, 200, { now, maxAgeSec: cfg.maxAgeSec, signals: signals.map(view), terminals })
    }

    if (p === '/api/health') return json(res, 200, { ok: true, now })

    if (req.method === 'GET') {
      const name = p === '/' ? 'index.html' : p.slice(1)
      if (/^[A-Za-z0-9._-]+$/.test(name)) {
        try {
          const file = path.join(cfg.uiDir, name)
          const data = readFileSync(file)
          res.writeHead(200, {
            'content-type': mimes[path.extname(name)] ?? 'application/octet-stream',
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
          })
          return void res.end(data)
        } catch {
          /* rơi xuống 404 */
        }
      }
    }
    json(res, 404, { error: 'not_found' })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'internal' })
      else res.end()
    })
  })
  return { server, store, close: () => { server.close(); store.db.close() } }
}
