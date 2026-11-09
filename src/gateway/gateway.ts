import { createServer, type IncomingMessage, type Server } from 'node:http'
import { type Logger, nullLogger } from '../server/log'
import { safeEqual, signSignal } from '../shared/hmac'

export type GatewayConfig = {
  port: number
  serverUrl: string
  /** Khóa EA (OCEAN_EA_KEY, trùng Server): chứng minh với Server, và kiểm chữ ký từng tín hiệu nhận về. */
  key: string
  /** Khung giờ được phép (rỗng = tất cả). Khung khác được ack `skipped_tf` và không đưa cho EA. */
  tfs: string[]
  /** XAUUSD=GOLD,... ánh xạ tên symbol của TradingView sang tên ở sàn. */
  symbolMap: Record<string, string>
  timeoutMs: number
}

export type CloudSignal = {
  id: number
  received_at: number
  kind: 'entry' | 'update'
  side: 'buy' | 'sell' | null
  symbol: string | null
  tf: string | null
  entry: number | null
  sl: number | null
  tp1: number | null
  tp2: number | null
  tp3: number | null
  tp: number | null
  status: string | null
  /** Chữ ký HMAC của Server (gắn với terminal). */
  sig?: string
}

type Ack = { id: number; result: string }
type FetchFn = typeof fetch

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const map: Record<string, string> = {}
  for (const pair of (env.OCEAN_SYMBOL_MAP ?? '').split(',')) {
    const [a, b] = pair.split('=').map((x) => x?.trim())
    if (a && b) map[a.toUpperCase()] = b
  }
  const key = (env.OCEAN_EA_KEY ?? '').trim()
  if (key.length < 24) throw new Error('OCEAN_EA_KEY chưa đặt hoặc quá ngắn (phải trùng OCEAN_EA_KEY của Server)')
  const serverUrl = (env.OCEAN_SERVER_URL ?? '').replace(/\/+$/, '')
  if (!/^https?:\/\//.test(serverUrl)) throw new Error('OCEAN_SERVER_URL phải bắt đầu bằng http:// hoặc https://')
  return {
    port: Number(env.OCEAN_GW_PORT ?? 47800),
    serverUrl,
    key,
    tfs: (env.OCEAN_TFS ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean),
    symbolMap: map,
    timeoutMs: Number(env.OCEAN_GW_TIMEOUT_MS ?? 2500),
  }
}

/** EA gửi `khóa=giá trị` mỗi dòng (không dùng JSON để MQL5 khỏi phải tự viết bộ đọc JSON). */
export function parseKv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

const nz = (s: string | undefined): number | undefined => {
  if (s === undefined || s === '') return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

const clean = (s: string) => s.replace(/[|\n\r;,]/g, ' ').trim().slice(0, 40)
const fmt = (n: number | null) => (n === null ? '' : String(n))

export class Gateway {
  /** Ack chưa gửi được lên Server (mất mạng) hoặc tự sinh do lọc khung giờ. */
  private pendingAcks = new Map<string, Ack[]>()
  lastServerOk = 0
  lastError = ''

  constructor(
    readonly cfg: GatewayConfig,
    private readonly fetchFn: FetchFn = fetch,
    private readonly clock: () => number = () => Math.floor(Date.now() / 1000),
    private readonly log: Logger = nullLogger,
  ) {}

  /** Xử lý một ping của EA. Trả về nội dung text cho EA. */
  async handlePing(body: string): Promise<{ status: number; text: string }> {
    const kv = parseKv(body)
    const login = kv.login ?? ''
    const server = kv.server ?? ''
    const tid = (kv.tid || `${login}@${server}`).replace(/[^A-Za-z0-9._:@-]/g, '_').slice(0, 64)
    if (!login || tid.length < 3) return { status: 400, text: 'ERR bad_ping' }

    const acks = [...(this.pendingAcks.get(tid) ?? [])]
    for (const a of (kv.acks ?? '').split(',')) {
      const [id, result] = a.split(':')
      const n = Number(id)
      if (Number.isInteger(n) && n > 0) acks.push({ id: n, result: clean(result ?? 'ok') || 'ok' })
    }

    const positions = (kv.pos ?? '')
      .split(';')
      .filter(Boolean)
      .map((p) => {
        const [ticket, symbol, side, vol, open, sl, tp, profit] = p.split(',')
        return { ticket: Number(ticket), symbol, side, volume: nz(vol), open: nz(open), sl: nz(sl), tp: nz(tp), profit: nz(profit) }
      })

    let res: Response
    try {
      res = await this.fetchFn(`${this.cfg.serverUrl}/api/gw/ping`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.cfg.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tid, login, server,
          balance: nz(kv.bal), equity: nz(kv.eq), margin: nz(kv.mg), free_margin: nz(kv.fm),
          ea_ver: kv.ver, positions, acks,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      })
    } catch (e) {
      this.lastError = `server: ${(e as Error).message}`
      this.log.warn(`ping lỗi: ${this.lastError}`)
      this.pendingAcks.set(tid, acks.slice(-200))
      return { status: 502, text: 'ERR server_unreachable' }
    }
    if (!res.ok) {
      this.lastError = `server HTTP ${res.status}`
      this.log.warn(`ping bị Server từ chối: HTTP ${res.status}${res.status === 401 ? ' (OCEAN_EA_KEY không khớp Server?)' : ''}`)
      this.pendingAcks.set(tid, acks.slice(-200))
      return { status: 502, text: `ERR server_${res.status}` }
    }
    this.pendingAcks.delete(tid)
    this.lastServerOk = this.clock()
    this.lastError = ''

    const data = (await res.json()) as { now: number; signals: CloudSignal[] }
    const lines = ['OK']
    const skipped: Ack[] = []
    for (const s of data.signals) {
      // Chỉ nhận tín hiệu do chính Server của bạn ký (cùng khóa EA, gắn với terminal): bị sửa/giả/phát lại thì bỏ.
      const want = await signSignal(this.cfg.key, tid, s)
      if (typeof s.sig !== 'string' || !safeEqual(s.sig, want)) {
        this.log.warn(`bỏ tín hiệu #${s.id}: chữ ký sai`)
        skipped.push({ id: s.id, result: 'bad_sig' })
        continue
      }
      const tf = (s.tf ?? '').toUpperCase()
      if (this.cfg.tfs.length > 0 && !this.cfg.tfs.includes(tf)) {
        skipped.push({ id: s.id, result: 'skipped_tf' })
        continue
      }
      const sym = this.cfg.symbolMap[(s.symbol ?? '').toUpperCase()] ?? s.symbol ?? ''
      const age = Math.max(0, data.now - s.received_at)
      if (s.kind === 'entry') {
        lines.push(['S', s.id, s.side, clean(sym), tf, fmt(s.entry), fmt(s.sl), fmt(s.tp1), fmt(s.tp2), fmt(s.tp3), age].join('|'))
      } else {
        lines.push(['U', s.id, s.side ?? '', clean(s.status ?? ''), clean(sym), tf, fmt(s.entry), fmt(s.sl), fmt(s.tp), age].join('|'))
      }
    }
    // Ack do lọc sẽ lên Server ở ping kế tiếp (nhờ vậy tín hiệu bị bỏ cũng hiện trên giao diện).
    if (skipped.length > 0) this.pendingAcks.set(tid, skipped)
    return { status: 200, text: lines.join('\n') }
  }

  listen(): Server {
    const srv = createServer(async (req: IncomingMessage, res) => {
      const reply = (status: number, text: string, type = 'text/plain') => {
        res.writeHead(status, { 'content-type': `${type}; charset=utf-8` })
        res.end(text)
      }
      // Cổng cục bộ chỉ dành cho EA: trình duyệt (có Origin) hoặc Host lạ (DNS rebinding) bị từ chối.
      const host = String(req.headers.host ?? '')
      if (req.headers.origin !== undefined || !/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host)) return reply(403, 'ERR forbidden')
      if (req.method === 'GET' && req.url === '/v1/status') {
        return reply(200, JSON.stringify({ ok: true, lastServerOk: this.lastServerOk, lastError: this.lastError }), 'application/json')
      }
      if (req.method === 'POST' && req.url === '/v1/ping') {
        const chunks: Buffer[] = []
        let size = 0
        for await (const c of req) {
          size += (c as Buffer).length
          if (size > 64 * 1024) return reply(413, 'ERR too_large')
          chunks.push(c as Buffer)
        }
        const r = await this.handlePing(Buffer.concat(chunks).toString('utf8'))
        return reply(r.status, r.text)
      }
      reply(404, 'not found')
    })
    // Chỉ nghe localhost: EA và Gateway cùng máy, không mở ra ngoài.
    srv.listen(this.cfg.port, '127.0.0.1')
    return srv
  }
}
