import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, parseKv } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'

const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const BUY_M15 =
  'OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M15 | Entry: 4100.000 | SL: 4092.000 | TP1 40%: 4106.400 | TP2 80%: 4112.800 | TP3 100%: 4116.000'

let app: App
let base = ''
let now = 1_000_000
const KEY = 'webhook-key-1234567890'
const TOK = 'gateway-token-1234567890'
const ADM = 'admin-token-123456'

const post = (path: string, body: string) => fetch(base + path, { method: 'POST', body })
const hook = (body: string) => post(`/webhook?key=${KEY}`, body)

const mkGateway = (over: Partial<ConstructorParameters<typeof Gateway>[0]> = {}) =>
  new Gateway({ port: 0, serverUrl: base, token: TOK, tfs: [], symbolMap: {}, timeoutMs: 1500, ...over }, fetch, () => now)

const ea = (acks = '') => `login=900001\nserver=Demo\nbal=1000\neq=1005\nver=0.1.0\nacks=${acks}`

beforeEach(async () => {
  now = 1_000_000
  app = createApp(
    { port: 0, host: '127.0.0.1', dbFile: ':memory:', webhookKey: KEY, gatewayToken: TOK, adminToken: ADM, maxAgeSec: 120, dedupeSec: 300, uiDir: 'ui' },
    () => now,
  )
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => app.close())

describe('webhook', () => {
  it('từ chối sai key, nhận đúng key, chống trùng', async () => {
    expect((await post('/webhook?key=sai', SELL)).status).toBe(401)
    const a = (await (await hook(SELL)).json()) as { id: number; kind: string }
    expect(a.kind).toBe('entry')
    const b = (await (await hook(SELL)).json()) as { duplicate?: boolean; id: number }
    expect(b.duplicate).toBe(true)
    expect(b.id).toBe(a.id)
    now += 400 // quá cửa sổ chống trùng: tín hiệu cùng giá được nhận lại
    expect(((await (await hook(SELL)).json()) as { duplicate?: boolean }).duplicate).toBeUndefined()
  })
  it('body lạ vẫn trả 200 (không để TradingView lặp lỗi) nhưng không giao cho EA', async () => {
    const r = await hook('chuoi la khong dung khuon')
    expect(r.status).toBe(200)
    const gw = mkGateway()
    await gw.handlePing(ea())
    const out = await gw.handlePing(ea())
    expect(out.text).toBe('OK')
  })
})

describe('gateway + EA', () => {
  it('terminal mới không nhận tín hiệu cũ; nhận tín hiệu mới đúng định dạng dòng', async () => {
    await hook(SELL)
    const gw = mkGateway()
    expect((await gw.handlePing(ea())).text).toBe('OK')
    now += 1
    await hook(BUY_M15)
    const out = await gw.handlePing(ea())
    const lines = out.text.split('\n')
    expect(lines[0]).toBe('OK')
    expect(lines[1]).toBe('S|2|buy|XAUUSD|M15|4100|4092|4106.4|4112.8|4116|0')
  })
  it('ack dừng việc giao lại; chưa ack thì giao lại ở ping sau', async () => {
    const gw = mkGateway()
    await gw.handlePing(ea())
    await hook(SELL)
    expect((await gw.handlePing(ea())).text.split('\n')).toHaveLength(2)
    expect((await gw.handlePing(ea())).text.split('\n')).toHaveLength(2)
    expect((await gw.handlePing(ea('1:received'))).text).toBe('OK')
  })
  it('tín hiệu quá hạn không giao nữa', async () => {
    const gw = mkGateway()
    await gw.handlePing(ea())
    await hook(SELL)
    now += 121
    expect((await gw.handlePing(ea())).text).toBe('OK')
  })
  it('lọc khung giờ + ánh xạ symbol; tín hiệu bị lọc hiện ở bảng ack', async () => {
    const gw = mkGateway({ tfs: ['M15'], symbolMap: { XAUUSD: 'GOLD' } })
    await gw.handlePing(ea())
    await hook(SELL) // M3 → bị lọc
    await hook(BUY_M15)
    const out = await gw.handlePing(ea())
    expect(out.text.split('\n')).toEqual(['OK', 'S|2|buy|GOLD|M15|4100|4092|4106.4|4112.8|4116|0'])
    await gw.handlePing(ea('2:received'))
    const st = (await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${ADM}` } })).json()) as {
      signals: { id: number; deliveries: { result: string }[] }[]
      terminals: { online: boolean; login: string }[]
    }
    expect(st.signals.find((s) => s.id === 1)?.deliveries[0]?.result).toBe('skipped_tf')
    expect(st.signals.find((s) => s.id === 2)?.deliveries[0]?.result).toBe('received')
    expect(st.terminals[0]).toMatchObject({ online: true, login: '900001' })
  })
  it('server không với tới: Gateway trả ERR và giữ ack để gửi lại', async () => {
    const gw = mkGateway()
    await gw.handlePing(ea())
    await hook(SELL)
    const dead = mkGateway({ serverUrl: 'http://127.0.0.1:1' })
    expect((await dead.handlePing(ea('1:received'))).status).toBe(502)
    // ack giữ trong bộ nhớ của Gateway "chết"; đổi sang server sống thì được gửi đi
    ;(dead.cfg as { serverUrl: string }).serverUrl = base
    await dead.handlePing(ea())
    const st = (await (await fetch(`${base}/api/state`, { headers: { authorization: `Bearer ${ADM}` } })).json()) as {
      signals: { id: number; deliveries: { result: string }[] }[]
    }
    expect(st.signals[0]?.deliveries[0]?.result).toBe('received')
  })
})

describe('bảo mật', () => {
  it('ping cần token Gateway, state cần token admin', async () => {
    const r = await fetch(`${base}/api/gw/ping`, { method: 'POST', body: '{}' })
    expect(r.status).toBe(401)
    expect((await fetch(`${base}/api/state`)).status).toBe(401)
    expect((await fetch(`${base}/api/health`)).status).toBe(200)
  })
  it('body quá lớn bị từ chối', async () => {
    expect((await hook('x'.repeat(20_000))).status).toBe(413)
  })
})

describe('parseKv', () => {
  it('đọc khóa=giá trị, bỏ dòng rác', () => {
    expect(parseKv('a=1\r\nrac\nb=x=y')).toEqual({ a: '1', b: 'x=y' })
  })
})
