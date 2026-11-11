import { mkdtempSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, loadGatewayConfig } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { ConfigError, loadConfig } from '../src/server/config'
import { Store } from '../src/server/db'
import { EA_KEY, WEBHOOK_KEY, baseCfg } from './helpers'

const SELL =
    'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const ea = (login = '900001', acks = '') => `login=${login}\nserver=Demo\nbal=1000\neq=1005\nver=0.1.0\nacks=${acks}`

let app: App
let base = ''
let now = 3_000_000
beforeEach(async () => {
    now = 3_000_000
    app = createApp(baseCfg(), { clock: () => now })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => app.close())

const gwWith = (fetchFn: typeof fetch, key = EA_KEY) => new Gateway({ port: 0, serverUrl: base, key, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetchFn, () => now)
const publish = () => fetch(`${base}/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body: SELL })

describe('EA/Gateway: chỉ nhận tín hiệu do Server của mình ký', () => {
    it('tín hiệu bị sửa giữa đường (đổi SL) bị bỏ và ack bad_sig', async () => {
        const tamper = (async (u: string | URL | Request, init?: RequestInit) => {
            const r = await fetch(u, init)
            const j = (await r.json()) as { signals: { sl: number }[] }
            for (const s of j.signals) s.sl = 1 // kẻ tấn công dời SL
            return new Response(JSON.stringify(j), { status: 200 })
        }) as typeof fetch
        const gw = gwWith(tamper)
        await gw.handlePing(ea())
        now += 1
        await publish()
        expect((await gw.handlePing(ea())).text).toBe('OK') // không có dòng S|...
        await gw.handlePing(ea()) // ack bad_sig đi lên ở ping kế tiếp
        const st = (await (await fetch(`${base}/api/state`)).json()) as { signals: { deliveries: { result: string }[] }[] }
        expect(st.signals[0]?.deliveries[0]?.result).toBe('bad_sig')
    })

    it('tín hiệu ký cho terminal này không dùng lại được ở terminal khác (replay)', async () => {
        const a = gwWith(fetch)
        await a.handlePing(ea('111111'))
        now += 1
        await publish()
        const captured = (await (await fetch(`${base}/api/gw/ping`, {
            method: 'POST', headers: { authorization: `Bearer ${EA_KEY}` }, body: JSON.stringify({ tid: '111111@Demo', login: '111111', server: 'Demo' }),
        })).json()) as { signals: unknown[] }
        expect(captured.signals).toHaveLength(1)
        // Gateway của terminal 222222 nhận lại đúng gói đó (đã bị kẻ xấu chép)
        const replay = (async () => new Response(JSON.stringify({ now, signals: captured.signals }), { status: 200 })) as typeof fetch
        expect((await gwWith(replay).handlePing(ea('222222'))).text).toBe('OK')
    })

    it('Gateway cấu hình sai khóa EA: Server từ chối 401, Gateway báo lỗi 502 và không đưa gì cho EA', async () => {
        const gw = gwWith(fetch, 'sai-khoa-sai-khoa-sai-khoa-12')
        const out = await gw.handlePing(ea())
        expect(out).toEqual({ status: 502, text: 'ERR server_401' })
    })

    it('Server giả (không có khóa) không giao được tín hiệu cho Gateway', async () => {
        const fake = (async () =>
            new Response(JSON.stringify({ now, signals: [{ id: 1, received_at: now, kind: 'entry', side: 'buy', symbol: 'XAUUSD', tf: 'M3', entry: 1, sl: 0.5, tp1: 2, tp2: 3, tp3: 4, tp: null, status: null, sig: 'f'.repeat(64) }] }), { status: 200 })) as typeof fetch
        expect((await gwWith(fake).handlePing(ea())).text).toBe('OK')
    })
})

describe('chống dò khóa', () => {
    it('sai khóa EA nhiều lần → 429', async () => {
        const hit = () => fetch(`${base}/api/gw/ping`, { method: 'POST', headers: { authorization: 'Bearer x' }, body: '{}' })
        for (let i = 0; i < 20; i++) expect((await hit()).status).toBe(401)
        expect((await hit()).status).toBe(429)
    })
    it('IP tính theo cf-connecting-ip khi qua tunnel: chặn một IP không chặn IP khác', async () => {
        const hit = (ip: string) => fetch(`${base}/api/gw/ping`, { method: 'POST', headers: { authorization: 'Bearer x', 'cf-connecting-ip': ip }, body: '{}' })
        for (let i = 0; i < 20; i++) await hit('203.0.113.9')
        expect((await hit('203.0.113.9')).status).toBe(429)
        expect((await hit('198.51.100.7')).status).toBe(401)
    })
    it('hết cửa sổ thời gian thì mở lại', async () => {
        const hit = () => fetch(`${base}/webhook?key=sai-sai-sai-sai-sai`, { method: 'POST', body: SELL })
        for (let i = 0; i < 20; i++) await hit()
        expect((await hit()).status).toBe(429)
        now += 301
        expect((await hit()).status).toBe(401)
    })
    it('không đặt OCEAN_WEBHOOK_KEY thì webhook trực tiếp tắt hẳn (an toàn mặc định)', async () => {
        app.close()
        app = createApp(baseCfg({ webhookKey: '' }), { clock: () => now })
        await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
        base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
        expect((await fetch(`${base}/webhook?key=`, { method: 'POST', body: SELL })).status).toBe(503)
    })
})

describe('tệp tĩnh', () => {
    it('chỉ phục vụ html/css/js/svg trong thư mục giao diện; không đọc được tệp khác hay thoát thư mục', async () => {
        for (const p of ['/server.env', '/..%2fpackage.json', '/%2e%2e/package.json', '/ocean.db', '/index.html/../../package.json', '/package.json']) {
            expect((await fetch(`${base}${p}`)).status).toBe(404)
        }
        const r = await fetch(`${base}/`)
        expect(r.headers.get('content-security-policy')).toContain("default-src 'self'")
        expect(r.headers.get('x-frame-options')).toBe('DENY')
    })
})

describe('cấu hình', () => {
    const ok = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: '/tmp/x' }
    it('thiếu OCEAN_EA_KEY → báo lỗi rõ; khóa ngắn/ký tự lạ bị từ chối', () => {
        expect(() => loadConfig({})).toThrow(ConfigError)
        expect(() => loadConfig({ OCEAN_EA_KEY: 'ngan' })).toThrow(/24-128/)
        expect(() => loadConfig({ ...ok, OCEAN_WEBHOOK_KEY: 'có dấu cách và ký tự lạ!' })).toThrow(ConfigError)
    })
    it('Worker URL và SYNC_KEY phải đi cùng nhau; SYNC_KEY từ 32 ký tự', () => {
        expect(() => loadConfig({ ...ok, OCEAN_WORKER_URL: 'https://w.workers.dev' })).toThrow(/SYNC_KEY/)
        expect(() => loadConfig({ ...ok, OCEAN_SYNC_KEY: 'a'.repeat(32) })).toThrow(/WORKER_URL/)
        expect(() => loadConfig({ ...ok, OCEAN_SYNC_KEY: 'a'.repeat(20), OCEAN_WORKER_URL: 'https://w.workers.dev' })).toThrow(/32-128/)
        expect(() => loadConfig({ ...ok, OCEAN_PUBLIC_URL: 'https://x.com/path' })).toThrow(/OCEAN_PUBLIC_URL/)
    })
    it('chu kỳ kéo bù: mặc định 300s khi Worker đẩy được, 5s khi chỉ kéo; giới hạn 2-600', () => {
        const w = { ...ok, OCEAN_SYNC_KEY: 'a'.repeat(32), OCEAN_WORKER_URL: 'https://w.workers.dev' }
        expect(loadConfig({ ...w, OCEAN_QUICK_TUNNEL: '1' }).pollSec).toBe(300)
        expect(loadConfig({ ...w, OCEAN_PUBLIC_URL: 'https://vps.example.com' }).pollSec).toBe(300)
        expect(loadConfig({ ...w, OCEAN_QUICK_TUNNEL: '1', OCEAN_POLL_SEC: '45' }).pollSec).toBe(45)
        expect(loadConfig(w).pollSec).toBe(5)
        expect(() => loadConfig({ ...w, OCEAN_POLL_SEC: '1' })).toThrow(ConfigError)
    })
    it('Gateway: khóa EA ngắn bị từ chối, URL Server phải là http(s)', () => {
        expect(() => loadGatewayConfig({ OCEAN_EA_KEY: 'ngan', OCEAN_SERVER_URL: 'http://127.0.0.1:8090' })).toThrow(/OCEAN_EA_KEY/)
        expect(() => loadGatewayConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_SERVER_URL: 'ftp://x' })).toThrow(/http/)
        expect(loadGatewayConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_SERVER_URL: 'http://127.0.0.1:8090/', OCEAN_SYMBOL_MAP: 'XAUUSD=GOLD' }).symbolMap).toEqual({ XAUUSD: 'GOLD' })
    })
})

describe('cơ sở dữ liệu', () => {
    it('mở lại cùng một tệp: migration không chạy lại, dữ liệu còn nguyên', () => {
        const dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-db-'))
        try {
            const f = path.join(dir, 'a.db')
            const a = new Store(f)
            a.setMeta('x', '1')
            a.db.close()
            const b = new Store(f)
            expect(b.getMeta('x')).toBe('1')
            expect((b.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(3)
            b.db.close()
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })
})