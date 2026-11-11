import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { MAX_MAKEUP_SEC, isIncompleteResult, makeupWindow, parseCfgLine, sanitizeOrders, sanitizeSetup } from '../src/shared/makeup'
import { EA_KEY, WEBHOOK_KEY, baseCfg } from './helpers'

const BUY =
  'OCEAN VIP by Duong | BUY ENTRY | XAUUSD | M15 | Entry: 4100.000 | SL: 4092.000 | TP1 40%: 4106.400 | TP2 80%: 4112.800 | TP3 100%: 4116.000'

describe('isIncompleteResult: kết quả nào đáng bù', () => {
  it('lỗi tạm thời và đang thử lại là dở', () => {
    for (const r of ['retry:1/3', 'retry:0/3', 'no_connection', 'retry_timeout', 'no_quote', 'failed:10031', 'failed:6', 'failed:4', 'failed:141', 'failed:10004', 'partial:1/3_no_connection', 'partial:2/3_retry_timeout', 'partial:1/3_failed_10031']) {
      expect(isIncompleteResult(r), r).toBe(true)
    }
  })
  it('đã đủ, đã đặt bù, hoặc dừng có chủ đích/lỗi vĩnh viễn thì không', () => {
    for (const r of ['opened:3', 'pending:3', 'opened:1+pending:2', 'received', 'trading_off', 'max_lots', 'bad_levels', 'bad_stops', 'no_symbol', 'too_old', 'skipped_tf', 'bad_sig', 'price_dev', 'fill_dev', 'failed:10019', 'partial:2/3_max_lots', 'partial:1/3_fill_dev', 'partial:1/3_bad_levels']) {
      expect(isIncompleteResult(r), r).toBe(false)
    }
  })
})

describe('setup và lệnh chờ của EA', () => {
  it('parseCfgLine đọc khóa=giá trị;… và bỏ khóa lạ/giá trị rác', () => {
    expect(parseCfgLine('InpAllowTrading=1;InpLotPerOrder=0.01;bad key=1;InpComment=OCEAN')).toEqual({ InpAllowTrading: '1', InpLotPerOrder: '0.01', InpComment: 'OCEAN' })
    expect(parseCfgLine('')).toBeNull()
    expect(parseCfgLine(undefined)).toBeNull()
    expect(parseCfgLine('khong-co-dau-bang')).toBeNull()
  })
  it('sanitizeSetup giới hạn số khóa, độ dài, ký tự điều khiển', () => {
    const big: Record<string, string> = {}
    for (let i = 0; i < 80; i++) big[`K${i}`] = 'x'
    expect(Object.keys(sanitizeSetup(big) ?? {})).toHaveLength(48)
    expect(sanitizeSetup({ InpComment: 'a\nb\u0000c'.padEnd(200, 'z') })?.InpComment).toHaveLength(48)
    expect(sanitizeSetup({ InpComment: 'a\nb' })?.InpComment).toBe('a b')
    expect(sanitizeSetup([1, 2])).toBeNull()
    expect(sanitizeSetup('x')).toBeNull()
    expect(sanitizeSetup({ __proto__x: 1, ok: 2 })).toEqual({ ok: '2' })
  })
  it('sanitizeOrders chỉ nhận 4 loại lệnh chờ', () => {
    const o = sanitizeOrders([
      { ticket: 5, symbol: 'XAUUSD', type: 'buylimit', volume: 0.01, price: 4100, sl: 4092, tp: 4106, expires: 120 },
      { ticket: 6, symbol: 'XAUUSD', type: 'buy', price: 1 },
      'rac',
    ])
    expect(o).toHaveLength(1)
    expect(o[0]).toMatchObject({ ticket: 5, type: 'buylimit', expires: 120 })
  })
  it('makeupWindow: cần bật cả đánh lệnh và bù lệnh; chặn ở MAX_MAKEUP_SEC', () => {
    expect(makeupWindow(null)).toBe(0)
    expect(makeupWindow({ InpAllowTrading: '0', InpMakeupEnable: '1' })).toBe(0)
    expect(makeupWindow({ InpAllowTrading: '1', InpMakeupEnable: '0' })).toBe(0)
    expect(makeupWindow({ InpAllowTrading: '1', InpMakeupEnable: '1', InpMakeupExpirySec: '300' })).toBe(300)
    expect(makeupWindow({ InpAllowTrading: '1', InpMakeupEnable: '1', InpMakeupExpirySec: '999999' })).toBe(MAX_MAKEUP_SEC)
    expect(makeupWindow({ InpAllowTrading: '1', InpMakeupEnable: '1' })).toBe(300)
  })
})

describe('Server giao lại tín hiệu để EA bù lệnh', () => {
  let app: App
  let base = ''
  let now = 5_000_000

  const hook = (body: string) => fetch(`${base}/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body })
  const gw = () => new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
  const CFG_ON = 'cfg=InpAllowTrading=1;InpMakeupEnable=1;InpMakeupExpirySec=300;InpLotPerOrder=0.01'
  const CFG_OFF = 'cfg=InpAllowTrading=1;InpMakeupEnable=0;InpMakeupExpirySec=300'
  const ping = (g: Gateway, extra = '', acks = '') => g.handlePing(`login=900001\nserver=Demo\nbal=1000\neq=1000\nver=0.4.0\n${extra}\nacks=${acks}`)
  const lines = (t: string) => t.split('\n').slice(1)
  const result = async (id: number) => {
    const st = (await (await fetch(`${base}/api/state`)).json()) as { signals: { id: number; deliveries: { result: string }[] }[] }
    return st.signals.find((s) => s.id === id)?.deliveries[0]?.result
  }

  beforeEach(async () => {
    now = 5_000_000
    app = createApp(baseCfg(), { clock: () => now })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })
  afterEach(() => app.close())

  it('EA không phản hồi lúc tín hiệu đến: quá hạn thường (120s) nhưng còn trong cửa sổ bù 300s thì vẫn giao', async () => {
    const g = gw()
    await ping(g, CFG_ON) // terminal đăng ký, báo bật bù lệnh
    now += 1
    await hook(BUY)
    now += 200 // EA/terminal im lặng 200s: quá hạn thường
    const out = await ping(g, CFG_ON)
    expect(lines(out.text)).toHaveLength(1)
    expect(lines(out.text)[0]).toMatch(/^S\|1\|buy\|XAUUSD\|M15\|4100\|4092\|4106\.4\|4112\.8\|4116\|20[01]$/) // tuổi 200 giây: EA tự quyết đặt lệnh chờ
  })

  it('quá cả cửa sổ bù thì thôi', async () => {
    const g = gw()
    await ping(g, CFG_ON)
    now += 1
    await hook(BUY)
    now += 301
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(0)
  })

  it('EA tắt bù lệnh (hoặc EA đời cũ không báo cấu hình): hành vi cũ, quá hạn thì không giao', async () => {
    const off = gw()
    await ping(off, CFG_OFF)
    now += 1
    await hook(BUY)
    now += 200
    expect(lines((await ping(off, CFG_OFF)).text)).toHaveLength(0)

    app.close()
    app = createApp(baseCfg(), { clock: () => now })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const old = gw()
    await ping(old) // không có cfg=
    now += 1
    await hook(BUY)
    now += 200
    expect(lines((await ping(old)).text)).toHaveLength(0)
  })

  it('đánh lệnh tắt (InpAllowTrading=0) thì không giao bù dù bật bù lệnh', async () => {
    const g = gw()
    const cfg = 'cfg=InpAllowTrading=0;InpMakeupEnable=1;InpMakeupExpirySec=300'
    await ping(g, cfg)
    now += 1
    await hook(BUY)
    now += 200
    expect(lines((await ping(g, cfg)).text)).toHaveLength(0)
  })

  it('kết quả còn dở (retry:1/3) được giao lại sau 15s; đã đủ (opened:3) thì không', async () => {
    const g = gw()
    await ping(g, CFG_ON)
    now += 1
    await hook(BUY)
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(1)
    await ping(g, CFG_ON, '1:retry:1/3') // EA báo đang thử lại (rồi EA chết)
    now += 5
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(0) // chưa tới 15s
    now += 12
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(1) // EA sống lại: được giao lại dù đã quá tuổi thường? (17s < 120s) và còn dở
    await ping(g, CFG_ON, '1:opened:1+pending:2')
    now += 60
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(0)
    expect(await result(1)).toBe('opened:1+pending:2')
  })

  it('ack `received` không ghi đè kết quả cụ thể đã có', async () => {
    const g = gw()
    await ping(g, CFG_ON)
    now += 1
    await hook(BUY)
    await ping(g, CFG_ON, '1:opened:3')
    await ping(g, CFG_ON, '1:received')
    expect(await result(1)).toBe('opened:3')
    // chưa có bản ghi thì `received` vẫn ghi bình thường
    await hook(BUY.replace('4100.000', '4101.000').replace('4092.000', '4093.000'))
    await ping(g, CFG_ON, '2:received')
    expect(await result(2)).toBe('received')
  })

  it('terminal mới không nhận lại tín hiệu cũ dù bật bù lệnh', async () => {
    await hook(BUY)
    now += 200
    const g = gw()
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(0)
  })

  it('tín hiệu cập nhật (U) không bao giờ giao bù', async () => {
    const g = gw()
    await ping(g, CFG_ON)
    now += 1
    await hook('OCEAN VIP by Duong | SELL | TP1 HIT | XAUUSD | M3 | Entry: 4118.000 | SL: 4118.000 | TP: 4111.624')
    now += 200
    expect(lines((await ping(g, CFG_ON)).text)).toHaveLength(0)
  })
})

describe('/api/state hiện setup và lệnh chờ của EA', () => {
  let app: App
  let base = ''
  let now = 6_000_000
  const windows: { close: () => void }[] = []

  beforeEach(async () => {
    now = 6_000_000
    app = createApp(baseCfg(), { clock: () => now })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })
  afterEach(() => {
    for (const w of windows.splice(0)) w.close()
    app.close()
  })

  const gw = () => new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
  const state = async () => (await (await fetch(`${base}/api/state`)).json()) as { terminals: { setup: Record<string, string> | null; orders: { type: string; expires: number | null }[] }[] }
  const CFG = 'cfg=InpAllowTrading=1;InpBEEnable=0;InpMakeupEnable=1;InpMakeupExpirySec=300;InpLotPerOrder=0.01;InpMaxDevPips=10;InpBETrigger=1;InpComment=OCEAN'

  async function render(): Promise<Document> {
    const dom = new JSDOM(readFileSync('ui/index.html', 'utf8').replace(/<script[^>]*><\/script>/, ''), { runScripts: 'outside-only', url: `${base}/` })
    const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void }
    w.fetch = ((u: string, o?: RequestInit) => fetch(`${base}${u}`, o)) as typeof fetch
    w.eval(readFileSync('ui/app.js', 'utf8'))
    await new Promise((r) => setTimeout(r, 400))
    windows.push(w)
    return dom.window.document
  }

  it('Server lưu setup; ping sau không gửi cfg thì giữ bản cũ; EA đời cũ -> setup null', async () => {
    const g = gw()
    await g.handlePing('login=900001\nserver=Demo\nbal=1\neq=1\nver=0.4.0\nord=\n' + CFG)
    expect((await state()).terminals[0]?.setup).toMatchObject({ InpAllowTrading: '1', InpMakeupEnable: '1', InpLotPerOrder: '0.01' })
    await g.handlePing('login=900001\nserver=Demo\nbal=1\neq=1\nver=0.4.0\nord=') // không cfg
    expect((await state()).terminals[0]?.setup).toMatchObject({ InpAllowTrading: '1' })
    await g.handlePing('login=900002\nserver=Demo\nbal=1\neq=1\nver=0.3.0')
    const t = (await state()).terminals.find((x) => x.setup === null)
    expect(t).toBeDefined()
    expect(t?.orders).toEqual([])
  })

  it('lệnh chờ của EA hiện trong state; ping có ord= rỗng thì xóa danh sách', async () => {
    const g = gw()
    await g.handlePing('login=900001\nserver=Demo\nbal=1\neq=1\nver=0.4.0\nord=701,XAUUSD,buylimit,0.01,4100,4092,4106.4,240;702,XAUUSD,buystop,0.01,4100,4092,4112.8,240')
    const o = (await state()).terminals[0]?.orders ?? []
    expect(o.map((x) => x.type)).toEqual(['buylimit', 'buystop'])
    expect(o[0]?.expires).toBe(240)
    await g.handlePing('login=900001\nserver=Demo\nbal=1\neq=1\nver=0.4.0\nord=')
    expect((await state()).terminals[0]?.orders).toEqual([])
  })

  it('giao diện: chip bật/tắt, bảng Setup, bảng lệnh chờ; giá trị lạ không tạo phần tử (không XSS)', async () => {
    const g = gw()
    await g.handlePing(`login=900001\nserver=Demo\nbal=1\neq=1\nver=0.4.0\nord=701,XAUUSD,buylimit,0.01,4100,4092,4106.4,240\n${CFG};InpEvil=<img src=x onerror=alert(1)>`)
    const doc = await render()
    const text = doc.body.textContent ?? ''
    expect(text).toContain('Đánh lệnh: BẬT')
    expect(text).toContain('BreakEven: TẮT')
    expect(text).toContain('Bù lệnh: BẬT')
    expect(text).toContain('Setup của terminal')
    expect(text).toContain('Lot mỗi lệnh')
    expect(text).toContain('Sau TP1')
    expect(text).toContain('Hạn bù / lệnh chờ (s)')
    expect(text).toContain('Lệnh chờ (1)')
    expect(text).toContain('Buy Limit')
    expect(text).toContain('<img src=x onerror=alert(1)>')
    expect(doc.querySelector('img')).toBeNull()
  })

  it('EA đời cũ: báo cần cập nhật EA, không vỡ giao diện', async () => {
    await gw().handlePing('login=900001\nserver=Demo\nbal=1\neq=1\nver=0.3.0')
    const doc = await render()
    expect(doc.body.textContent).toContain('EA chưa báo cấu hình')
    expect(doc.getElementById('conn')?.textContent).toBe('kết nối tốt')
  })
})
