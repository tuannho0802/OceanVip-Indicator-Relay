import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../src/server/app'
import { signBody } from '../src/shared/hmac'
import { sanitizeAccountReports, sanitizeSwitchItem } from '../src/shared/switch'
import { EA_KEY, SYNC_KEY, WEBHOOK_KEY, baseCfg } from './helpers'

/**
 * Bật/tắt tài khoản MT từ xa — phía Server (VPS): công tắc chặn tín hiệu ở cổng /api/gw/ping nên EA MT4/MT5 không phải sửa gì.
 *  TẮT = không giao tín hiệu nào; BẬT lại = chỉ nhận tín hiệu đến từ lúc bật (không bắn bù tín hiệu đến lúc tắt).
 */
let app: App
let base = ''
let now = 4_000_000
let newAccounts: string[] = []

const setup = async (over: Parameters<typeof baseCfg>[0] = {}) => {
    app = createApp(baseCfg({ syncKey: SYNC_KEY, serverId: 'nam-1', ...over }), { clock: () => now, onNewAccount: (l) => void newAccounts.push(l) })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
}
beforeEach(async () => {
    now = 4_000_000
    newAccounts = []
    await setup()
})
afterEach(() => app.close())

const alert = (entry: number) =>
    `OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: ${entry.toFixed(3)} | SL: ${(entry + 8).toFixed(3)} | TP1 40%: ${(entry - 6).toFixed(3)} | TP2 80%: ${(entry - 12).toFixed(3)} | TP3 100%: ${(entry - 16).toFixed(3)}`
const publish = async (entry: number) => (await fetch(`${base}/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body: alert(entry) })).json() as Promise<{ id: number }>
const ping = async (login: string, extra: Record<string, unknown> = {}) =>
    (await (await fetch(`${base}/api/gw/ping`, { method: 'POST', headers: { authorization: `Bearer ${EA_KEY}` }, body: JSON.stringify({ tid: `${login}@Demo`, login, server: 'Demo', ...extra }) })).json()) as { signals: { id: number }[] }
const state = async () =>
    (await (await fetch(`${base}/api/state`)).json()) as { signals: { id: number; deliveries: { tid: string; result: string }[] }[]; terminals: { login: string | null; remote: boolean }[] }

/** Worker → VPS: đúng chữ ký như Worker thật. */
async function pushSwitch(body: unknown, opts: { ts?: number; key?: string; raw?: string } = {}) {
    const text = opts.raw ?? JSON.stringify(body)
    const ts = opts.ts ?? now
    return fetch(`${base}/api/switch`, { method: 'POST', headers: { 'x-ocean-ts': String(ts), 'x-ocean-sig': await signBody(opts.key ?? SYNC_KEY, ts, text) }, body: text })
}
const sw = (login: string, enabled: boolean, rev: number, at = now) => ({ login, enabled, rev, at })

describe('/api/switch: chỉ Worker (có khóa) mới bật/tắt được', () => {
    it('sai chữ ký → 401 bad_sig; lệch giờ → 401 bad_time; không đổi gì', async () => {
        await ping('111')
        expect((await pushSwitch(sw('111', false, 1), { key: 'khac-khoa-khac-khoa-khac-khoa-123456' })).status).toBe(401)
        const late = await pushSwitch(sw('111', false, 1), { ts: now - 1000 })
        expect(late.status).toBe(401)
        expect(((await late.json()) as { error: string }).error).toBe('bad_time')
        expect(app.store.getSwitch('111')).toBeUndefined()
    })

    it('Server không nối Worker (không có khóa riêng) → 503', async () => {
        app.close()
        await setup({ syncKey: '', serverId: '' })
        expect((await pushSwitch(sw('111', false, 1))).status).toBe(503)
    })

    it('thân sai dạng → 400; tài khoản ngoài danh sách OCEAN_ACCOUNTS → 403', async () => {
        expect((await pushSwitch({ login: 'abc', enabled: false, rev: 1, at: now })).status).toBe(400)
        expect((await pushSwitch({ login: '111', enabled: 'no', rev: 1, at: now })).status).toBe(400)
        expect((await pushSwitch(null, { raw: '{hong' })).status).toBe(400)
        app.close()
        await setup({ accounts: ['111'] })
        expect((await pushSwitch(sw('222', false, 1))).status).toBe(403)
        expect((await pushSwitch(sw('111', false, 1))).status).toBe(200)
    })

    it('lệnh cũ đến muộn (rev thấp hơn) bị bỏ qua', async () => {
        expect(await (await pushSwitch(sw('111', false, 2))).json()).toMatchObject({ ok: true, changed: true, rev: 2 })
        expect(await (await pushSwitch(sw('111', true, 1))).json()).toMatchObject({ ok: true, changed: false, rev: 2 })
        expect(app.store.getSwitch('111')?.enabled).toBe(0)
    })
})

describe('công tắc chặn tín hiệu ở Server', () => {
    it('TẮT: tài khoản đó không nhận tín hiệu, ghi remote_off; tài khoản khác vẫn nhận', async () => {
        await ping('111')
        await ping('222')
        await pushSwitch(sw('111', false, 1))
        now += 1
        const a = await publish(4100)
        expect((await ping('111')).signals).toEqual([])
        expect((await ping('222')).signals.map((s) => s.id)).toEqual([a.id])
        const st = await state()
        const d = st.signals[0]?.deliveries ?? []
        expect(d.find((x) => x.tid.endsWith('@Demo') && x.result === 'remote_off')).toBeTruthy()
        expect(st.terminals.find((t) => t.login === '111')?.remote).toBe(false)
        expect(st.terminals.find((t) => t.login === '222')?.remote).toBe(true)
    })

    it('BẬT lại: tín hiệu đến lúc tắt KHÔNG bắn bù, tín hiệu mới vẫn nhận (EA đang online)', async () => {
        await ping('111')
        await pushSwitch(sw('111', false, 1))
        now += 1
        await publish(4100)
        expect((await ping('111')).signals).toEqual([])
        now += 10
        await pushSwitch(sw('111', true, 2))
        expect((await ping('111')).signals).toEqual([]) // tín hiệu cũ đã ghi remote_off, không giao lại
        now += 1
        const b = await publish(4200)
        expect((await ping('111')).signals.map((s) => s.id)).toEqual([b.id])
    })

    it('EA mất kết nối suốt lúc tắt: bật lại vẫn không nhận tín hiệu đến trước mốc bật (còn trong hạn 120 giây)', async () => {
        await ping('111')
        await pushSwitch(sw('111', false, 1))
        now += 5
        await publish(4100) // đến lúc đang tắt, EA không ping
        now += 5
        await pushSwitch(sw('111', true, 2)) // since = now
        now += 1
        expect((await ping('111')).signals).toEqual([])
        now += 1
        const b = await publish(4200)
        expect((await ping('111')).signals.map((s) => s.id)).toEqual([b.id])
    })

    it('mốc `at` do Worker đặt: tín hiệu đến sau lúc Worker bật nhưng trước lúc VPS nhận được lệnh vẫn được giao', async () => {
        await ping('111')
        await pushSwitch(sw('111', false, 1))
        now += 1
        const a = await publish(4100) // received_at = now
        // Worker bật ở thời điểm `at` = trước tín hiệu này 0 giây; lệnh đến VPS muộn 30 giây (tunnel rớt, kéo bù)
        const at = now
        now += 30
        await pushSwitch(sw('111', true, 2, at))
        expect((await ping('111')).signals.map((s) => s.id)).toEqual([a.id])
    })

    it('tài khoản chưa từng được đặt công tắc: hành vi như cũ (nhận tất cả)', async () => {
        await ping('111')
        now += 1
        const a = await publish(4100)
        expect((await ping('111')).signals.map((s) => s.id)).toEqual([a.id])
    })
})

describe('báo tài khoản cho Worker', () => {
    it('accountReports liệt kê tài khoản + công tắc đang áp dụng, lọc theo OCEAN_ACCOUNTS', async () => {
        await ping('111')
        await ping('222')
        await pushSwitch(sw('222', false, 3))
        expect(app.accountReports()).toEqual(expect.arrayContaining([
            { login: '111', broker: 'Demo', enabled: true, rev: 0 },
            { login: '222', broker: 'Demo', enabled: false, rev: 3 },
        ]))
        app.close()
        await setup({ accounts: ['111'] })
        await ping('111')
        expect(app.accountReports().map((r) => r.login)).toEqual(['111'])
    })

    it('onNewAccount chỉ gọi MỘT lần cho mỗi tài khoản mới', async () => {
        await ping('111')
        await ping('111')
        await ping('222')
        expect(newAccounts).toEqual(['111', '222'])
    })

    it('applySwitches (kéo bù từ Worker) áp lệnh và bỏ lệnh cũ', async () => {
        await ping('111')
        expect(app.applySwitches([sw('111', false, 5)])).toBe(true)
        expect(app.applySwitches([sw('111', false, 5)])).toBe(false)
        expect(app.applySwitches([sw('111', true, 4)])).toBe(false)
        expect(app.store.getSwitch('111')).toMatchObject({ enabled: 0, rev: 5 })
    })
})

describe('bộ lọc dữ liệu dùng chung', () => {
    it('sanitizeSwitchItem / sanitizeAccountReports loại dữ liệu sai', () => {
        expect(sanitizeSwitchItem({ login: '123', enabled: true, rev: 1, at: 5 })).toEqual({ login: '123', enabled: true, rev: 1, at: 5 })
        expect(sanitizeSwitchItem({ login: '12a', enabled: true, rev: 1, at: 5 })).toBeNull()
        expect(sanitizeSwitchItem({ login: '123', enabled: true, rev: 0, at: 5 })).toBeNull()
        expect(sanitizeSwitchItem({ login: '123', enabled: 1, rev: 1, at: 5 })).toBeNull()
        expect(sanitizeSwitchItem('x')).toBeNull()
        const r = sanitizeAccountReports([{ login: '1', broker: 'A\u0000B', enabled: true, rev: 0 }, { login: '1', broker: 'dup', enabled: true, rev: 0 }, { login: 'x', enabled: true, rev: 0 }, { login: '2', enabled: 'yes', rev: 0 }])
        expect(r).toEqual([{ login: '1', broker: 'A B', enabled: true, rev: 0 }])
        expect(sanitizeAccountReports(Array.from({ length: 50 }, (_, i) => ({ login: String(i + 1), enabled: true, rev: 0 })))).toHaveLength(20)
    })
})