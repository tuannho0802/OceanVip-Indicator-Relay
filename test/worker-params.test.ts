import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveServerKey } from '../src/shared/connect'
import { verifyBody } from '../src/shared/hmac'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

/**
 * Tuỳ chỉnh input EA từ xa — phía Worker: API chỉnh/xem input theo tài khoản MT, quyền (Admin / chủ VPS / người được cấp),
 * đẩy xuống VPS (ký HMAC), kéo bù qua /api/pull, và trạng thái "VPS đã giữ / EA đã áp" do VPS báo qua /api/accounts.
 */
const WORKER = 'https://relay.example.workers.dev'
const ADMIN_PW = 'admin-initial-pass'
const VPS = 'bot-a21-cabc'
const VPS_URL = 'https://vps-nam.trycloudflare.com'

let now = 7_000_000
let env: Env & { DB: ReturnType<typeof fakeD1> }
let admin = ''
const ctx = { waitUntil: (_p: Promise<unknown>) => { } }
let pushes: { url: string; body: string; headers: Record<string, string> }[] = []
let pushStatus = 200
const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    pushes.push({ url: String(input), body: String(init?.body), headers: (init?.headers ?? {}) as Record<string, string> })
    return new Response('{"ok":true}', { status: pushStatus })
}) as typeof fetch

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const { cookie, ...rest } = init
    const headers = { ...(rest.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) }
    return handle(new Request(`${WORKER}${path}`, { ...rest, headers }), env, ctx, { now: () => now, fetchFn })
}
const send = (method: string, path: string, body?: unknown, cookie?: string) =>
    call(path, { method, cookie, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const get = (path: string, cookie?: string) => call(path, { cookie })
const j = async (r: Response) => (await r.json()) as Record<string, any>

async function login(username: string, password: string): Promise<string> {
    const r = await send('POST', '/api/login', { username, password })
    expect(r.status).toBe(200)
    return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
}
async function newUser(name: string): Promise<{ id: number; cookie: string }> {
    const r = await j(await send('POST', '/api/users', { username: name }, admin))
    const cookie = await login(name, r.password as string)
    expect((await send('POST', '/api/password', { current: r.password, next: `${name}-new-pass-1` }, cookie)).status).toBe(200)
    return { id: r.id as number, cookie }
}
type Rep = { login: string; broker?: string; enabled?: boolean; rev?: number; params_rev?: number; ea_rev?: number; setup?: Record<string, string> }
/** VPS báo tài khoản MT lên Worker (đúng như Server thật làm qua /api/accounts). */
async function vpsReports(accounts: Rep[], id = VPS) {
    const key = await deriveServerKey(SYNC_KEY, id)
    const r = await call('/api/accounts', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'x-ocean-server': id },
        body: JSON.stringify({ accounts: accounts.map((a) => ({ broker: 'OEXNLimited-MT5', enabled: true, rev: 0, ...a })) }),
    })
    expect(r.status).toBe(200)
}
async function vpsPull(id = VPS) {
    const key = await deriveServerKey(SYNC_KEY, id)
    const r = await call('/api/pull', { headers: { authorization: `Bearer ${key}`, 'x-ocean-server': id } })
    expect(r.status).toBe(200)
    return j(r)
}
const P = (login: string, server = VPS) => `/api/ea/${server}/accounts/${login}/params`
const putParams = (cookie: string, login: string, values: unknown, server = VPS) => send('PUT', P(login, server), { values }, cookie)
const grant = (user: number, logins: string[], server = VPS) => send('PUT', `/api/ea/${server}/access/${user}`, { logins }, admin)

beforeEach(async () => {
    now = 7_000_000
    pushes = []
    pushStatus = 200
    env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW }
    const c = await login('admin', ADMIN_PW)
    expect((await send('POST', '/api/password', { current: ADMIN_PW, next: 'admin-real-pass-9' }, c)).status).toBe(200)
    admin = c
    await vpsReports([{ login: '6128952' }, { login: '8033273' }])
    env.DB.raw.exec(`UPDATE servers SET url = '${VPS_URL}' WHERE id = '${VPS}'`)
})

describe('xem input của một tài khoản', () => {
    it('trả danh sách cho phép (để vẽ form), giá trị ghi đè rỗng, và input hiện tại EA báo', async () => {
        await vpsReports([{ login: '6128952', params_rev: 0, ea_rev: 0, setup: { InpLotPerOrder: '0.10', InpMaxAgeSec: '60' } }])
        const r = await j(await get(P('6128952'), admin))
        expect(r.login).toBe('6128952')
        expect(r.rev).toBe(0)
        expect(r.overrides).toEqual({})
        expect(r.current).toEqual({ InpLotPerOrder: '0.10', InpMaxAgeSec: '60' })
        const keys = (r.spec as { key: string }[]).map((s) => s.key)
        expect(keys).toContain('InpLotPerOrder')
        expect(keys).not.toContain('InpAllowTrading')
    })

    it('tài khoản chưa được VPS báo → 404', async () => {
        expect((await get(P('999'), admin)).status).toBe(404)
    })

    it('chưa đăng nhập → 401', async () => {
        expect((await get(P('6128952'))).status).toBe(401)
    })
})

describe('đổi input: lưu ở D1, tăng rev, đẩy xuống VPS có chữ ký', () => {
    it('đổi lần đầu: rev 1, đẩy tới /api/params của VPS với đúng chữ ký, VPS nhận thì vps_applied', async () => {
        const r = await j(await putParams(admin, '6128952', { InpLotPerOrder: 0.05, InpBEEnable: true }))
        expect(r).toMatchObject({ ok: true, rev: 1, changed: true, vps_applied: true, ea_applied: false, push_error: null })
        expect(r.overrides).toEqual({ InpLotPerOrder: 0.05, InpBEEnable: 1 })
        expect(pushes).toHaveLength(1)
        expect(pushes[0]?.url).toBe(`${VPS_URL}/api/params`)
        expect(JSON.parse(pushes[0]?.body as string)).toEqual({ login: '6128952', rev: 1, values: { InpLotPerOrder: 0.05, InpBEEnable: 1 }, at: now })
        const key = await deriveServerKey(SYNC_KEY, VPS)
        const h = pushes[0]?.headers as Record<string, string>
        expect(await verifyBody(key, Number(h['x-ocean-ts']), pushes[0]?.body as string, h['x-ocean-sig'] as string)).toBe(true)
    })

    it('bản vá gộp vào bộ cũ; null bỏ ghi đè một khóa; lần nào đổi thật mới tăng rev', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05, InpMaxAgeSec: 90 })
        const r2 = await j(await putParams(admin, '6128952', { InpMaxAgeSec: null, InpSLExtend: -0.5 }))
        expect(r2.rev).toBe(2)
        expect(r2.overrides).toEqual({ InpLotPerOrder: 0.05, InpSLExtend: -0.5 })
        pushes = []
        const r3 = await j(await putParams(admin, '6128952', { InpLotPerOrder: 0.05 }))
        expect(r3).toMatchObject({ changed: false, rev: 2 })
        expect(pushes).toHaveLength(0) // không đổi gì thì không đẩy lại
    })

    it('bỏ hết ghi đè → bộ rỗng vẫn tăng rev và đẩy xuống để EA quay về input của nó', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05 })
        pushes = []
        const r = await j(await putParams(admin, '6128952', { InpLotPerOrder: null }))
        expect(r).toMatchObject({ rev: 2, changed: true, overrides: {} })
        expect(JSON.parse(pushes[0]?.body as string)).toMatchObject({ rev: 2, values: {} })
    })

    it('khóa không cho phép / giá trị ngoài khoảng → 400 và KHÔNG đổi gì (không đẩy, không tăng rev)', async () => {
        for (const values of [{ InpAllowTrading: true }, { InpGateway: 'http://x' }, { InpLotPerOrder: 5000 }, { InpMaxAgeSec: 1.5 }, { InpLotPerOrder: 0.1, InpMagic: 1 }, {}, [], 'x']) {
            const r = await putParams(admin, '6128952', values)
            expect(r.status, JSON.stringify(values)).toBe(400)
            expect((await j(r)).error).toMatch(/bad_params|bad_request/)
        }
        expect(pushes).toHaveLength(0)
        expect((await j(await get(P('6128952'), admin))).rev).toBe(0)
    })

    it('VPS không nhận ngay (tunnel rớt): vẫn lưu, báo push_error, và gửi kèm /api/pull cho tới khi VPS xác nhận', async () => {
        pushStatus = 530
        const r = await j(await putParams(admin, '6128952', { InpLotPerOrder: 0.05 }))
        expect(r).toMatchObject({ rev: 1, vps_applied: false })
        expect(r.push_error).toBe('http_530')
        const pull = await vpsPull()
        expect(pull.params).toEqual([{ login: '6128952', rev: 1, values: { InpLotPerOrder: 0.05 }, at: now }])
        expect(pull.poll).toBeGreaterThan(0) // kéo dày trong lúc chờ
        // VPS báo đã giữ rev 1 → hết gửi kèm
        await vpsReports([{ login: '6128952', params_rev: 1, ea_rev: 0 }])
        expect((await vpsPull()).params).toBeUndefined()
    })

    it('VPS chưa có địa chỉ tunnel: lưu và chờ kéo bù', async () => {
        env.DB.raw.exec(`UPDATE servers SET url = NULL WHERE id = '${VPS}'`)
        const r = await j(await putParams(admin, '6128952', { InpLotPerOrder: 0.05 }))
        expect(r).toMatchObject({ rev: 1, vps_applied: false, push_error: 'no_url' })
        expect((await vpsPull()).params).toHaveLength(1)
    })

    it('VPS bị Admin khóa → 403, không đổi', async () => {
        expect((await send('PATCH', `/api/servers/${VPS}`, { locked: true }, admin)).status).toBe(200)
        const r = await putParams(admin, '6128952', { InpLotPerOrder: 0.05 })
        expect(r.status).toBe(403)
        expect((await j(r)).error).toBe('server_locked')
    })
})

describe('trạng thái áp: VPS đã giữ → EA đã áp', () => {
    it('overview hiện số khóa ghi đè và từng bước; GET params hiện chờ EA tới khi EA báo ea_rev', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05, InpMaxAgeSec: 90 })
        const acc = async () => ((await j(await get('/api/ea', admin))).servers[0].accounts as any[]).find((a) => a.login === '6128952')
        expect((await acc()).params).toEqual({ overrides: 2, vps_applied: true, ea_applied: false })
        expect((await acc())).not.toHaveProperty('vals')
        // VPS báo: giữ rev 1, EA chưa áp
        await vpsReports([{ login: '6128952', params_rev: 1, ea_rev: 0 }])
        expect((await j(await get(P('6128952'), admin)))).toMatchObject({ vps_applied: true, ea_applied: false })
        // EA áp rev 1 và báo input hiện tại
        await vpsReports([{ login: '6128952', params_rev: 1, ea_rev: 1, setup: { InpLotPerOrder: '0.05', InpMaxAgeSec: '90', InpMagic: '777' } }])
        const d = await j(await get(P('6128952'), admin))
        expect(d).toMatchObject({ rev: 1, vps_applied: true, ea_applied: true })
        expect(d.current).toEqual({ InpLotPerOrder: '0.05', InpMaxAgeSec: '90' }) // InpMagic không lên Worker
        expect((await acc()).params).toEqual({ overrides: 2, vps_applied: true, ea_applied: true })
    })

    it('tài khoản chưa từng chỉnh: params = null', async () => {
        const a = ((await j(await get('/api/ea', admin))).servers[0].accounts as any[]).find((x) => x.login === '6128952')
        expect(a.params).toBeNull()
    })

    it('VPS mất dữ liệu (báo params_rev thấp hơn Worker): Worker gửi lại bộ ghi đè ở lần kéo kế tiếp', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05 })
        await vpsReports([{ login: '6128952', params_rev: 1, ea_rev: 1 }])
        expect((await vpsPull()).params).toBeUndefined()
        await vpsReports([{ login: '6128952', params_rev: 0, ea_rev: 0 }]) // VPS dựng lại từ đầu
        expect((await vpsPull()).params).toEqual([{ login: '6128952', rev: 1, values: { InpLotPerOrder: 0.05 }, at: now }])
    })

    it('VPS báo rev CAO hơn Worker (Worker mất dữ liệu): lần đổi kế tiếp không đụng rev cũ', async () => {
        await vpsReports([{ login: '8033273', params_rev: 5, ea_rev: 5 }])
        const r = await j(await putParams(admin, '8033273', { InpLotPerOrder: 0.05 }))
        expect(r.rev).toBe(6)
    })

    it('báo cáo cũ (không có trường params) không làm mất trạng thái đã lưu', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05 })
        await vpsReports([{ login: '6128952', params_rev: 1, ea_rev: 1, setup: { InpLotPerOrder: '0.05' } }])
        await vpsReports([{ login: '6128952' }]) // VPS đời cũ báo: không có params_rev/setup
        expect((await j(await get(P('6128952'), admin)))).toMatchObject({ rev: 1, current: { InpLotPerOrder: '0.05' } })
    })
})

describe('quyền: người được cấp chỉ chỉnh được tài khoản của mình', () => {
    it('User chưa được cấp: không thấy, không chỉnh được (404, không phân biệt "không có" với "không được phép")', async () => {
        const u = await newUser('nam')
        expect((await get(P('6128952'), u.cookie)).status).toBe(404)
        expect((await putParams(u.cookie, '6128952', { InpLotPerOrder: 0.05 })).status).toBe(404)
    })

    it('được cấp 1/2 tài khoản: chỉnh được tài khoản đó, tài khoản kia 404 và không lộ', async () => {
        const u = await newUser('nam')
        expect((await grant(u.id, ['6128952'])).status).toBe(200)
        const r = await j(await putParams(u.cookie, '6128952', { InpLotPerOrder: 0.03 }))
        expect(r).toMatchObject({ ok: true, rev: 1 })
        expect((await putParams(u.cookie, '8033273', { InpLotPerOrder: 0.03 })).status).toBe(404)
        expect((await get(P('8033273'), u.cookie)).status).toBe(404)
        const ov = await (await get('/api/ea', u.cookie)).text()
        expect(ov).not.toContain('8033273')
    })

    it('thu hồi quyền thì hết chỉnh được', async () => {
        const u = await newUser('nam')
        await grant(u.id, ['6128952'])
        expect((await send('DELETE', `/api/ea/${VPS}/access/${u.id}`, undefined, admin)).status).toBe(200)
        expect((await putParams(u.cookie, '6128952', { InpLotPerOrder: 0.03 })).status).toBe(404)
    })

    it('chủ VPS chỉnh được mọi tài khoản trên VPS của mình', async () => {
        const u = await newUser('chu')
        const mine = await j(await send('POST', '/api/servers', { name: 'vps-chu' }, u.cookie))
        const id = mine.id as string
        await vpsReports([{ login: '555' }], id)
        env.DB.raw.exec(`UPDATE servers SET url = '${VPS_URL}' WHERE id = '${id}'`)
        expect((await putParams(u.cookie, '555', { InpMaxAgeSec: 45 }, id)).status).toBe(200)
    })
})

describe('xóa VPS dọn luôn bộ ghi đè', () => {
    it('xóa VPS thì bảng account_params của VPS đó sạch', async () => {
        await putParams(admin, '6128952', { InpLotPerOrder: 0.05 })
        expect((await send('DELETE', `/api/servers/${VPS}`, undefined, admin)).status).toBe(200)
        expect(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM account_params WHERE server = ?').get(VPS)).toEqual({ n: 0 })
    })
})