import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { WorkerSync } from '../src/server/worker-sync'
import { signBody } from '../src/shared/hmac'
import { EA_KEY, SYNC_KEY, baseCfg } from './helpers'

/**
 * Tuỳ chỉnh input EA từ xa — phía Server (VPS) + Gateway:
 *  Worker đẩy /api/params (ký HMAC) -> Server lưu -> kèm dòng P| vào phản hồi ping khi rev Server > prev EA báo -> EA báo prev -> Server báo lại Worker.
 */
let app: App
let base = ''
let now = 5_000_000
let changed = 0

const setup = async (over: Parameters<typeof baseCfg>[0] = {}) => {
    app = createApp(baseCfg({ syncKey: SYNC_KEY, serverId: 'nam-1', ...over }), { clock: () => now, onParamsChanged: () => void changed++ })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}
beforeEach(async () => {
    now = 5_000_000
    changed = 0
    await setup()
})
afterEach(() => app.close())

const ping = async (login: string, extra: Record<string, unknown> = {}) =>
    (await (await fetch(`${base}/api/gw/ping`, { method: 'POST', headers: { authorization: `Bearer ${EA_KEY}` }, body: JSON.stringify({ tid: `${login}@Demo`, login, server: 'Demo', ...extra }) })).json()) as { signals: unknown[]; remote: boolean; params?: string }

/** Worker → VPS: đúng chữ ký như Worker thật. */
async function pushParams(body: unknown, opts: { ts?: number; key?: string; raw?: string } = {}) {
    const text = opts.raw ?? JSON.stringify(body)
    const ts = opts.ts ?? now
    return fetch(`${base}/api/params`, { method: 'POST', headers: { 'x-ocean-ts': String(ts), 'x-ocean-sig': await signBody(opts.key ?? SYNC_KEY, ts, text) }, body: text })
}
const item = (login: string, rev: number, values: Record<string, number>, at = now) => ({ login, rev, values, at })

describe('/api/params: chỉ Worker (có khóa) mới đổi được input', () => {
    it('sai chữ ký → 401 bad_sig; lệch giờ → 401 bad_time; không lưu gì', async () => {
        expect((await pushParams(item('111', 1, { InpLotPerOrder: 0.5 }), { key: 'khac-khoa-khac-khoa-khac-khoa-123456' })).status).toBe(401)
        const late = await pushParams(item('111', 1, { InpLotPerOrder: 0.5 }), { ts: now - 1000 })
        expect(late.status).toBe(401)
        expect(((await late.json()) as { error: string }).error).toBe('bad_time')
        expect(app.store.getParams('111')).toBeUndefined()
    })

    it('Server không nối Worker → 503; JSON hỏng → 400; login sai → 400', async () => {
        expect((await pushParams(item('111', 1, {}), { raw: '{không phải json' })).status).toBe(400)
        expect((await pushParams({ login: 'abc', rev: 1, at: now, values: {} })).status).toBe(400)
        app.close()
        await setup({ syncKey: '', serverId: '' })
        expect((await pushParams(item('111', 1, {}))).status).toBe(503)
    })

    it('lưu bộ ghi đè; khóa không cho phép bị bỏ ngay ở Server (kể cả khi Worker gửi nhầm)', async () => {
        const r = await pushParams(item('111', 1, { InpLotPerOrder: 0.5, InpAllowTrading: 1, InpMagic: 7 }))
        expect(r.status).toBe(200)
        expect(app.store.paramValues('111')).toEqual({ InpLotPerOrder: 0.5 })
        expect(changed).toBe(1)
    })

    it('chỉ nhận rev MỚI hơn: lệnh cũ đến muộn không ghi đè lệnh mới', async () => {
        await pushParams(item('111', 3, { InpLotPerOrder: 0.3 }))
        const old = await pushParams(item('111', 2, { InpLotPerOrder: 0.2 }))
        expect(((await old.json()) as { changed: boolean }).changed).toBe(false)
        expect(app.store.paramValues('111')).toEqual({ InpLotPerOrder: 0.3 })
        expect(app.store.getParams('111')?.rev).toBe(3)
    })

    it('tài khoản ngoài OCEAN_ACCOUNTS → 403', async () => {
        app.close()
        await setup({ accounts: ['111'] })
        expect((await pushParams(item('222', 1, { InpLotPerOrder: 0.5 }))).status).toBe(403)
        expect((await pushParams(item('111', 1, { InpLotPerOrder: 0.5 }))).status).toBe(200)
    })
})

describe('ping: giao bộ ghi đè cho EA đúng lúc, không giao lặp', () => {
    it('EA mới (báo prev) nhận P| khi rev Server > prev; hết giao khi prev đã bằng rev', async () => {
        await ping('111', { prev: 0 })
        await pushParams(item('111', 2, { InpLotPerOrder: 0.5, InpBEEnable: 1 }))
        expect((await ping('111', { prev: 0 })).params).toBe('P|rev=2;InpLotPerOrder=0.50;InpBEEnable=1')
        expect((await ping('111', { prev: 1 })).params).toBe('P|rev=2;InpLotPerOrder=0.50;InpBEEnable=1')
        expect((await ping('111', { prev: 2 })).params).toBeUndefined()
        await pushParams(item('111', 3, { InpLotPerOrder: 0.7 }))
        expect((await ping('111', { prev: 2 })).params).toBe('P|rev=3;InpLotPerOrder=0.70')
    })

    it('EA khởi động lại (prev=0) nhận lại bộ ghi đè đang có', async () => {
        await pushParams(item('111', 2, { InpMaxAgeSec: 90 }))
        expect((await ping('111', { prev: 2 })).params).toBeUndefined()
        expect((await ping('111', { prev: 0 })).params).toBe('P|rev=2;InpMaxAgeSec=90')
    })

    it('EA đời cũ (không báo prev) không bao giờ nhận P|', async () => {
        await pushParams(item('111', 2, { InpMaxAgeSec: 90 }))
        expect((await ping('111')).params).toBeUndefined()
    })

    it('bộ ghi đè rỗng (Worker bỏ hết ghi đè) vẫn được giao để EA quay về input của nó', async () => {
        await pushParams(item('111', 1, { InpMaxAgeSec: 90 }))
        await pushParams(item('111', 2, {}))
        expect((await ping('111', { prev: 1 })).params).toBe('P|rev=2')
    })

    it('bộ ghi đè của tài khoản này không lọt sang tài khoản khác', async () => {
        await pushParams(item('111', 1, { InpMaxAgeSec: 90 }))
        expect((await ping('222', { prev: 0 })).params).toBeUndefined()
    })

    it('tài khoản TẮT từ xa vẫn nhận input mới (chỉ chặn tín hiệu)', async () => {
        await ping('111', { prev: 0 })
        await fetch(`${base}/api/switch`, { method: 'POST', headers: { 'x-ocean-ts': String(now), 'x-ocean-sig': await signBody(SYNC_KEY, now, JSON.stringify({ login: '111', enabled: false, rev: 1, at: now })) }, body: JSON.stringify({ login: '111', enabled: false, rev: 1, at: now }) })
        await pushParams(item('111', 1, { InpMaxAgeSec: 90 }))
        const r = await ping('111', { prev: 0 })
        expect(r.remote).toBe(false)
        expect(r.params).toBe('P|rev=1;InpMaxAgeSec=90')
    })
})

describe('EA báo prev → Server ghi nhận và báo lại Worker', () => {
    it('prev đổi thì gọi onParamsChanged đúng một lần và accountReports phản ánh ea_rev', async () => {
        await pushParams(item('111', 2, { InpLotPerOrder: 0.5 }))
        changed = 0
        await ping('111', { prev: 0 })
        expect(changed).toBe(0) // chưa áp gì, chưa đổi
        await ping('111', { prev: 2 })
        await ping('111', { prev: 2 })
        expect(changed).toBe(1)
        const rep = app.accountReports().find((r) => r.login === '111')
        expect(rep).toMatchObject({ params_rev: 2, ea_rev: 2 })
    })

    it('accountReports kèm setup của EA nhưng chỉ khóa tuỳ chỉnh được', async () => {
        await ping('111', { prev: 0, setup: { InpLotPerOrder: '0.10', InpMagic: '20261109', InpComment: 'OCEAN', InpGateway: 'http://127.0.0.1:1' } })
        const rep = app.accountReports().find((r) => r.login === '111')
        expect(rep?.setup).toEqual({ InpLotPerOrder: '0.10' })
        expect(JSON.stringify(rep)).not.toContain('20261109')
    })

    it('/api/state cho giao diện: input nào đang bị Worker ghi đè và EA đã áp chưa', async () => {
        await pushParams(item('111', 2, { InpLotPerOrder: 0.5 }))
        await ping('111', { prev: 0 })
        const st = (await (await fetch(`${base}/api/state`)).json()) as { terminals: { remote_params: { rev: number; applied: boolean; keys: string[] } | null }[] }
        expect(st.terminals[0]?.remote_params).toEqual({ rev: 2, applied: false, keys: ['InpLotPerOrder'] })
        await ping('111', { prev: 2 })
        const st2 = (await (await fetch(`${base}/api/state`)).json()) as typeof st
        expect(st2.terminals[0]?.remote_params?.applied).toBe(true)
    })

    it('tài khoản chưa từng được chỉnh: remote_params = null', async () => {
        await ping('111', { prev: 0 })
        const st = (await (await fetch(`${base}/api/state`)).json()) as { terminals: { remote_params: unknown }[] }
        expect(st.terminals[0]?.remote_params).toBeNull()
    })
})

describe('Gateway: chuyển prev lên Server và dòng P| xuống EA', () => {
    const gw = () => new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
    const body = (prev: string) => `login=111\nserver=Demo\nbal=1\neq=1\nver=0.6.0${prev === '' ? '' : `\nprev=${prev}`}`

    it('có bộ ghi đè mới: thêm dòng P|; EA báo prev bằng rev thì hết', async () => {
        const g = gw()
        expect((await g.handlePing(body('0'))).text).toBe('OK')
        await pushParams(item('111', 4, { InpLotPerOrder: 0.25, InpMaxDevPips: 5 }))
        expect((await g.handlePing(body('0'))).text).toBe('OK\nP|rev=4;InpLotPerOrder=0.25;InpMaxDevPips=5.0')
        expect((await g.handlePing(body('4'))).text).toBe('OK')
    })

    it('P| nằm cùng R|0 khi tài khoản tắt; EA cũ (2 trường) bỏ qua cả hai', async () => {
        const g = gw()
        await g.handlePing(body('0'))
        await pushParams(item('111', 1, { InpMaxAgeSec: 30 }))
        const sw = JSON.stringify({ login: '111', enabled: false, rev: 1, at: now })
        await fetch(`${base}/api/switch`, { method: 'POST', headers: { 'x-ocean-ts': String(now), 'x-ocean-sig': await signBody(SYNC_KEY, now, sw) }, body: sw })
        const t = (await g.handlePing(body('0'))).text
        expect(t).toBe('OK\nR|0\nP|rev=1;InpMaxAgeSec=30')
        for (const l of t.split('\n').slice(1)) expect(l.split('|').length).toBeLessThan(3)
    })

    it('EA đời cũ không gửi prev: không nhận P|', async () => {
        const g = gw()
        await pushParams(item('111', 1, { InpMaxAgeSec: 30 }))
        expect((await g.handlePing(body(''))).text).toBe('OK')
    })

    it('prev không phải số nguyên bị bỏ (coi như EA cũ)', async () => {
        const g = gw()
        await pushParams(item('111', 1, { InpMaxAgeSec: 30 }))
        expect((await g.handlePing(body('abc'))).text).toBe('OK')
    })

    it('Server trả dòng params sai (khóa cấm / ngoài khoảng): Gateway KHÔNG chuyển cho EA', async () => {
        for (const bad of ['P|rev=1;InpAllowTrading=1', 'P|rev=1;InpLotPerOrder=9999', 'P|rev=1\nS|9|buy|XAUUSD|M3|1|1|1|1|1|0']) {
            const fake = (async () => new Response(JSON.stringify({ now, signals: [], remote: true, params: bad }), { status: 200 })) as unknown as typeof fetch
            const g = new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fake, () => now)
            expect((await g.handlePing(body('0'))).text).toBe('OK')
        }
    })
})

describe('kéo bù: Worker gửi kèm params trong /api/pull', () => {
    const mk = (pullBody: unknown, applied: unknown[][], reports: string[]) => {
        const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
            const u = String(url)
            if (u.endsWith('/api/pull')) return new Response(JSON.stringify(pullBody), { status: 200 })
            if (u.endsWith('/api/accounts')) reports.push(String(init?.body))
            return new Response('{"ok":true}', { status: 200 })
        }) as unknown as typeof fetch
        return new WorkerSync({
            workerUrl: 'https://w.example', syncKey: 'k', serverId: 'nam-1', pollSec: 30, log: { info() { }, warn() { }, error() { }, debug() { } } as never,
            ingest: () => 'new', applyParams: (items) => (applied.push(items), true), accounts: () => [{ login: '111', broker: 'Demo', enabled: true, rev: 0, params_rev: 2, ea_rev: 0 }], fetchFn,
        })
    }

    it('áp bộ ghi đè rồi báo lại Worker ngay (xác nhận đã giữ), kể cả khi danh sách tài khoản không đổi', async () => {
        const applied: unknown[][] = []
        const reports: string[] = []
        const sync = mk({ now, tunnel: null, items: [], params: [{ login: '111', rev: 2, at: now, values: { InpLotPerOrder: 0.5, InpMagic: 9 } }] }, applied, reports)
        await sync.pullOnce()
        expect(applied).toHaveLength(1)
        // khóa không cho phép bị lọc ngay ở đây (trước cả khi tới Server)
        expect(applied[0]).toEqual([{ login: '111', rev: 2, at: now, values: { InpLotPerOrder: 0.5 } }])
        expect(reports).toHaveLength(1)
        expect(JSON.parse(reports[0] as string).accounts[0]).toMatchObject({ params_rev: 2 })
    })

    it('không có params: không áp, không báo lặp', async () => {
        const applied: unknown[][] = []
        const reports: string[] = []
        const sync = mk({ now, tunnel: null, items: [] }, applied, reports)
        await sync.pullOnce()
        await sync.pullOnce()
        expect(applied).toHaveLength(0)
        expect(reports).toHaveLength(1) // lần đầu báo danh sách; lần hai không đổi nên không báo lại
    })
})