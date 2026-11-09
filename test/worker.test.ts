import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { signBody } from '../src/shared/hmac'
import { WorkerSync } from '../src/server/worker-sync'
import { type Env, handle } from '../worker/src/handler'
import { EA_KEY, SYNC_KEY, WEBHOOK_KEY, baseCfg, fakeD1 } from './helpers'

const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const BUY =
  'OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M15 | Entry: 4100.000 | SL: 4092.000 | TP1 40%: 4106.400 | TP2 80%: 4112.800 | TP3 100%: 4116.000'

const WORKER = 'https://worker.test'
const VPS = 'https://vps.test'
const quiet = { debug() {}, info() {}, warn() {}, error() {} }

let app: App
let base = ''
let now = 2_000_000
let env: Env & { DB: ReturnType<typeof fakeD1> }
let pending: Promise<unknown>[] = []
let vpsUp = true
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
const settle = async () => {
  const p = pending
  pending = []
  await Promise.all(p)
}

/** Worker → VPS: https://vps.test được đổi sang cổng thật của Server thử nghiệm; vpsUp=false mô phỏng VPS/tunnel sập. */
const toVps = (async (input: string | URL | Request, init?: RequestInit) => {
  if (!vpsUp) throw new Error('VPS sập')
  return fetch(String(input).replace(VPS, base), init)
}) as typeof fetch

const worker = (path: string, init: RequestInit = {}) => handle(new Request(`${WORKER}${path}`, init), env, ctx, { now: () => now, fetchFn: toVps })
/** Server → Worker (kéo bù, báo địa chỉ): gọi thẳng mã Worker. */
const toWorker = (async (input: string | URL | Request, init?: RequestInit) => worker(String(input).slice(WORKER.length), init)) as typeof fetch
const hook = (body: string, key = WEBHOOK_KEY) => worker(`/webhook?key=${key}`, { method: 'POST', body })
const auth = { authorization: `Bearer ${SYNC_KEY}`, 'content-type': 'application/json' }
const setTunnel = (url: string | null) => worker('/api/tunnel', { method: 'POST', headers: auth, body: JSON.stringify({ url }) })

const mkSync = () => new WorkerSync({ workerUrl: WORKER, syncKey: SYNC_KEY, pollSec: 30, log: quiet, ingest: app.ingestFromWorker, fetchFn: toWorker, clock: () => now })
const mkGateway = (symbolMap: Record<string, string> = {}) => new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap, timeoutMs: 1500 }, fetch, () => now)
const ea = (acks = '') => `login=900001\nserver=Demo\nbal=1000\neq=1005\nver=0.1.0\nacks=${acks}`
const state = async () => (await (await fetch(`${base}/api/state`)).json()) as { signals: { id: number; kind: string; src: string; received_at: number }[] }
const pullItems = async () => ((await (await worker('/api/pull', { headers: auth })).json()) as { items: unknown[] }).items

beforeEach(async () => {
  now = 2_000_000
  vpsUp = true
  pending = []
  env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY }
  app = createApp(baseCfg({ syncKey: SYNC_KEY, workerUrl: WORKER }), { clock: () => now })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => app.close())

describe('Worker: webhook', () => {
  it('sai khóa → 401, thiếu cấu hình → 503, body rỗng/quá lớn bị từ chối, không lưu gì', async () => {
    expect((await hook(SELL, 'sai-khoa')).status).toBe(401)
    expect((await hook('   ')).status).toBe(400)
    expect((await hook('x'.repeat(20_000))).status).toBe(413)
    const noKey = await handle(new Request(`${WORKER}/webhook?key=x`, { method: 'POST', body: SELL }), { DB: env.DB }, ctx)
    expect(noKey.status).toBe(503)
    expect(((await (await worker('/api/recent')).json()) as { signals: unknown[] }).signals).toHaveLength(0)
  })

  it('nhận → lưu D1 → trả 200 ngay, rồi đẩy về VPS và đánh dấu đã nhận', async () => {
    expect((await setTunnel(VPS)).status).toBe(200)
    expect((await hook(SELL)).status).toBe(200)
    await settle()
    expect((await state()).signals).toMatchObject([{ kind: 'entry', src: 'worker' }])
    expect(await pullItems()).toHaveLength(0)
  })

  it('VPS sập đúng lúc alert bắn: tín hiệu không mất, VPS sống lại kéo bù về và ack', async () => {
    await setTunnel(VPS)
    vpsUp = false
    expect((await hook(SELL)).status).toBe(200)
    await settle()
    expect((await state()).signals).toHaveLength(0)
    vpsUp = true
    now += 20
    expect(await mkSync().pullOnce()).toBe(true)
    const st = await state()
    expect(st.signals).toHaveLength(1)
    expect(now - (st.signals[0] as { received_at: number }).received_at).toBe(20) // tuổi tính từ lúc Worker nhận
    expect(await pullItems()).toHaveLength(0)
  })

  it('push và kéo bù cùng chuyển một tín hiệu: Server chỉ nhận một lần (theo wid)', async () => {
    await setTunnel(VPS)
    await hook(SELL)
    await settle()
    env.DB.raw.exec('UPDATE signals SET pushed = 0')
    await mkSync().pullOnce()
    expect((await state()).signals).toHaveLength(1)
  })

  it('tín hiệu kéo bù đã quá hạn thì lưu để xem nhưng không giao cho EA', async () => {
    vpsUp = false
    await hook(BUY)
    await settle()
    vpsUp = true
    now += 300
    const gw = mkGateway()
    await gw.handlePing(ea())
    await mkSync().pullOnce()
    expect((await state()).signals).toHaveLength(1)
    expect((await gw.handlePing(ea())).text).toBe('OK')
  })

  it('đường đi trọn vẹn tới EA: Worker → Server → Gateway → dòng S|… (ánh xạ symbol)', async () => {
    await setTunnel(VPS)
    const gw = mkGateway({ XAUUSD: 'GOLD' })
    await gw.handlePing(ea())
    now += 1
    await hook(SELL)
    await settle()
    expect((await gw.handlePing(ea())).text.split('\n')[1]).toMatch(/^S\|1\|sell\|GOLD\|M3\|4118\|4125\.97\|4111\.624\|4105\.248\|4102\.06\|\d+$/)
  })
})

describe('Worker: bảo mật & công khai', () => {
  it('pull/ack/tunnel cần SYNC_KEY', async () => {
    for (const [path, method] of [['/api/pull', 'GET'], ['/api/ack', 'POST'], ['/api/tunnel', 'POST']] as const) {
      expect((await worker(path, { method })).status).toBe(401)
      expect((await worker(path, { method, headers: { authorization: 'Bearer sai' } })).status).toBe(401)
    }
  })
  it('địa chỉ tunnel chỉ nhận https hợp lệ; null để xóa', async () => {
    for (const bad of ['http://x.com', 'https://x.com/path', 'javascript:alert(1)', 'ftp://x', '']) expect((await setTunnel(bad)).status).toBe(400)
    expect((await setTunnel('https://abc-def.trycloudflare.com/')).status).toBe(200)
    expect((await setTunnel(null)).status).toBe(200)
  })
  it('trang công khai chỉ đọc và thoát ký tự HTML trong body alert (không XSS)', async () => {
    await hook('<script>alert(1)</script> | "><img src=x onerror=alert(2)>')
    await settle()
    const html = await (await worker('/')).text()
    expect(html).not.toContain('<script>alert(1)')
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&#60;script&#62;')
    expect((await worker('/', { method: 'POST' })).status).toBe(404)
  })
})

describe('Server: /api/ingest do Worker đẩy', () => {
  const sendIngest = async (body: string, over: { ts?: number; sig?: string } = {}) => {
    const ts = over.ts ?? now
    return fetch(`${base}/api/ingest`, { method: 'POST', headers: { 'x-ocean-ts': String(ts), 'x-ocean-sig': over.sig ?? (await signBody(SYNC_KEY, ts, body)) }, body })
  }
  const item = JSON.stringify({ wid: 7, age: 1, raw: SELL })

  it('chữ ký đúng → nhận; gửi lại cùng wid → trùng', async () => {
    expect((await (await sendIngest(item)).json()) as object).toMatchObject({ ok: true, duplicate: false })
    expect((await (await sendIngest(item)).json()) as object).toMatchObject({ duplicate: true })
    expect((await state()).signals).toHaveLength(1)
  })
  it('chữ ký sai, thời gian lệch, thân bị sửa → 401, không lưu', async () => {
    expect((await sendIngest(item, { sig: 'a'.repeat(64) })).status).toBe(401)
    expect((await sendIngest(item, { ts: now - 1000 })).status).toBe(401)
    const sig = await signBody(SYNC_KEY, now, item)
    expect((await sendIngest(item.replace('"wid":7', '"wid":8'), { sig })).status).toBe(401)
    expect((await state()).signals).toHaveLength(0)
  })
  it('dò khóa nhiều lần bị chặn 429 (kể cả khóa đúng trong lúc bị chặn)', async () => {
    for (let i = 0; i < 20; i++) await sendIngest(item, { sig: 'b'.repeat(64) })
    expect((await sendIngest(item)).status).toBe(429)
  })
  it('không cấu hình Worker thì đường ingest tắt', async () => {
    app.close()
    app = createApp(baseCfg(), { clock: () => now })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    expect((await fetch(`${base}/api/ingest`, { method: 'POST', body: '{}' })).status).toBe(503)
  })
})

describe('WorkerSync', () => {
  it('Worker báo 401 (SYNC_KEY sai) → ghi lỗi rõ ràng, không ném', async () => {
    const bad = new WorkerSync({ workerUrl: WORKER, syncKey: 'k'.repeat(40), pollSec: 30, log: quiet, ingest: app.ingestFromWorker, fetchFn: toWorker })
    expect(await bad.pullOnce()).toBe(false)
    expect(bad.lastError).toContain('401')
  })
  it('báo địa chỉ tunnel lên Worker, lỗi thì thử lại ở nhịp sau', async () => {
    let down = true
    const flaky = (async (i: string | URL | Request, init?: RequestInit) => {
      if (down) throw new Error('mạng rớt')
      return toWorker(i, init)
    }) as typeof fetch
    const s = new WorkerSync({ workerUrl: WORKER, syncKey: SYNC_KEY, pollSec: 30, log: quiet, ingest: app.ingestFromWorker, fetchFn: flaky })
    s.setPublicUrl('https://abc.trycloudflare.com')
    await s.tick()
    expect(await env.DB.prepare("SELECT v FROM kv WHERE k = 'vps_url'").first()).toBeNull()
    down = false
    await s.tick()
    expect(await env.DB.prepare("SELECT v FROM kv WHERE k = 'vps_url'").first()).toEqual({ v: 'https://abc.trycloudflare.com' })
  })
})
