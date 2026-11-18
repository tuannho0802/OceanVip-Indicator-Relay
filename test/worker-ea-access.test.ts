import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { deriveServerKey } from '../src/shared/connect'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

/**
 * Giới hạn bật/tắt EA theo tài khoản MT: Admin gán một VPS cho User và chỉ định User được thấy/bật/tắt tài khoản nào (vd 2/3).
 * Tài khoản không được chọn không được xuất hiện trong bất kỳ phản hồi nào và không bật/tắt được.
 */
const WORKER = 'https://relay.example.workers.dev'
const ADMIN_PW = 'admin-initial-pass'
const VPS = 'bot-a21-cabc'

let now = 6_000_000
let env: Env & { DB: ReturnType<typeof fakeD1> }
let admin = ''
const ctx = { waitUntil: (_p: Promise<unknown>) => {} }
let pushes: { url: string; body: string }[] = []
let pushStatus = 200
const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  pushes.push({ url: String(input), body: String(init?.body) })
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
  expect(r.ok).toBe(true)
  const cookie = await login(name, r.password as string)
  expect((await send('POST', '/api/password', { current: r.password, next: `${name}-new-pass-1` }, cookie)).status).toBe(200)
  return { id: r.id as number, cookie }
}
/** VPS báo 3 tài khoản MT lên Worker (đúng như Server thật làm qua /api/accounts). */
async function vpsReports(id = VPS, logins = ['6128952', '8033273', '8039504']) {
  const key = await deriveServerKey(SYNC_KEY, id)
  const r = await call('/api/accounts', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'x-ocean-server': id },
    body: JSON.stringify({ accounts: logins.map((l) => ({ login: l, broker: 'OEXNLimited-MT5', enabled: true, rev: 0 })) }),
  })
  expect(r.status).toBe(200)
}
const grant = (user: number, logins: string[], server = VPS) => send('PUT', `/api/ea/${server}/access/${user}`, { logins }, admin)
const toggle = (cookie: string, login: string, enabled: boolean, server = VPS) => send('PUT', `/api/ea/${server}/accounts/${login}`, { enabled }, cookie)
const loginsOf = (ov: Record<string, any>, server = VPS): string[] => (ov.servers.find((s: any) => s.id === server)?.accounts ?? []).map((a: any) => a.login)

beforeEach(async () => {
  now = 6_000_000
  pushes = []
  pushStatus = 200
  env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW }
  const c = await login('admin', ADMIN_PW)
  expect((await send('POST', '/api/password', { current: ADMIN_PW, next: 'admin-real-pass-9' }, c)).status).toBe(200)
  admin = c
  await vpsReports()
})

describe('Admin giới hạn User chỉ thấy 2/3 tài khoản MT của một VPS', () => {
  it('User chưa được cấp thì không thấy VPS nào và không bật/tắt được', async () => {
    const u = await newUser('nam')
    expect((await j(await get('/api/ea', u.cookie))).servers).toEqual([])
    expect((await toggle(u.cookie, '6128952', false)).status).toBe(404)
  })

  it('cấp 2/3: User chỉ thấy đúng 2 tài khoản, tài khoản thứ 3 không lộ ở bất kỳ đâu', async () => {
    const u = await newUser('nam')
    expect((await grant(u.id, ['6128952', '8033273'])).status).toBe(200)
    const raw = await (await get('/api/ea', u.cookie)).text()
    expect(loginsOf(JSON.parse(raw))).toEqual(['6128952', '8033273'])
    expect(raw).not.toContain('8039504')
    // các API khác của User cũng không lộ VPS/tài khoản được cấp
    const ov = await (await get('/api/overview', u.cookie)).text()
    expect(ov).not.toContain(VPS)
    expect(ov).not.toContain('8039504')
    // Admin thấy đủ 3 + danh sách ai được cấp gì
    const a = await j(await get('/api/ea', admin))
    expect(loginsOf(a)).toEqual(['6128952', '8033273', '8039504'])
    expect(a.servers[0].access).toEqual([{ user_id: u.id, username: 'nam', locked: false, logins: ['6128952', '8033273'] }])
    expect(a.users.map((x: any) => x.username)).toContain('nam')
    // User không có quyền Admin trong phản hồi
    expect(JSON.parse(raw).users).toBeUndefined()
    expect(JSON.parse(raw).servers[0].access).toBeUndefined()
  })

  it('User bật/tắt được tài khoản được cấp (đẩy xuống VPS), còn tài khoản không được cấp thì 404 và không đổi gì', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952', '8033273'])
    const ok = await j(await toggle(u.cookie, '6128952', false))
    expect(ok).toMatchObject({ ok: true, login: '6128952', enabled: false, rev: 1 })
    const row = (await env.DB.prepare("SELECT enabled, rev FROM accounts WHERE server = ? AND login = '6128952'").bind(VPS).first()) as any
    expect(row).toEqual({ enabled: 0, rev: 1 })

    const before = (await env.DB.prepare("SELECT enabled, rev FROM accounts WHERE login = '8039504'").first()) as any
    const denied = await toggle(u.cookie, '8039504', false)
    expect(denied.status).toBe(404) // giống hệt "không tồn tại": không lộ là có tài khoản này
    expect((await env.DB.prepare("SELECT enabled, rev FROM accounts WHERE login = '8039504'").first()) as any).toEqual(before)
  })

  it('đổi danh sách: bỏ tick thì mất quyền ngay, thêm tick thì có quyền ngay', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952', '8033273'])
    await grant(u.id, ['8033273', '8039504'])
    expect(loginsOf(await j(await get('/api/ea', u.cookie)))).toEqual(['8033273', '8039504'])
    expect((await toggle(u.cookie, '6128952', false)).status).toBe(404)
    expect((await toggle(u.cookie, '8039504', false)).status).toBe(200)
  })

  it('User bị khóa/bị thu hồi thì hết quyền; thu hồi xong cấp lại phải chọn lại từ đầu', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952'])
    expect((await send('DELETE', `/api/ea/${VPS}/access/${u.id}`, undefined, admin)).status).toBe(200)
    expect((await j(await get('/api/ea', u.cookie))).servers).toEqual([])
    expect((await toggle(u.cookie, '6128952', false)).status).toBe(404)
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM account_grants').first()) as any).toEqual({ c: 0 })
  })

  it('hai User trên cùng một VPS thấy hai tập tài khoản khác nhau, không lẫn nhau', async () => {
    const a = await newUser('nam')
    const b = await newUser('lan')
    await grant(a.id, ['6128952', '8033273'])
    await grant(b.id, ['8039504'])
    expect(loginsOf(await j(await get('/api/ea', a.cookie)))).toEqual(['6128952', '8033273'])
    expect(loginsOf(await j(await get('/api/ea', b.cookie)))).toEqual(['8039504'])
    expect((await toggle(b.cookie, '6128952', false)).status).toBe(404)
    expect((await toggle(a.cookie, '8039504', false)).status).toBe(404)
  })

  it('được cấp VPS nhưng chưa tick tài khoản nào thì thấy VPS rỗng, không bật/tắt được gì', async () => {
    const u = await newUser('nam')
    expect((await grant(u.id, [])).status).toBe(200)
    const ea = await j(await get('/api/ea', u.cookie))
    expect(ea.servers).toHaveLength(1)
    expect(ea.servers[0].accounts).toEqual([])
    expect((await toggle(u.cookie, '6128952', false)).status).toBe(404)
  })
})

describe('chỉ Admin được cấp quyền, và cấp sai thì bị từ chối', () => {
  it('User thường không tự cấp/thu hồi quyền cho mình hay người khác', async () => {
    const a = await newUser('nam')
    const b = await newUser('lan')
    expect((await send('PUT', `/api/ea/${VPS}/access/${a.id}`, { logins: ['6128952'] }, a.cookie)).status).toBe(403)
    expect((await send('PUT', `/api/ea/${VPS}/access/${b.id}`, { logins: ['6128952'] }, a.cookie)).status).toBe(403)
    await grant(b.id, ['6128952'])
    expect((await send('DELETE', `/api/ea/${VPS}/access/${b.id}`, undefined, a.cookie)).status).toBe(403)
    expect(loginsOf(await j(await get('/api/ea', b.cookie)))).toEqual(['6128952'])
  })

  it('tài khoản MT lạ, danh sách sai, VPS/người không tồn tại, cấp cho Admin hoặc chủ VPS đều bị từ chối', async () => {
    const u = await newUser('nam')
    expect((await j(await grant(u.id, ['999']))).error).toBe('unknown_account')
    expect((await j(await grant(u.id, ['abc']))).error).toBe('bad_logins')
    expect((await grant(u.id, ['1'.repeat(21)])).status).toBe(400)
    expect((await send('PUT', `/api/ea/${VPS}/access/${u.id}`, { logins: '6128952' }, admin)).status).toBe(400)
    expect((await grant(u.id, ['6128952'], 'khong-co-vps')).status).toBe(404)
    expect((await grant(99999, ['6128952'])).status).toBe(404)
    const adminId = ((await env.DB.prepare("SELECT id FROM users WHERE username = 'admin'").first()) as any).id
    expect((await j(await grant(adminId, ['6128952']))).error).toBe('admin_has_all')
    // chủ VPS đã có toàn quyền
    const owner = await newUser('chu')
    const s = await j(await send('POST', '/api/servers', { user_id: owner.id, name: 'VPS chu' }, admin))
    await vpsReports(s.id, ['111'])
    expect((await j(await grant(owner.id, ['111'], s.id))).error).toBe('owner_has_all')
  })

  it('chủ VPS thấy mọi tài khoản trên VPS của mình nhưng không thấy VPS người khác', async () => {
    const owner = await newUser('chu')
    const s = await j(await send('POST', '/api/servers', { user_id: owner.id, name: 'VPS chu' }, admin))
    await vpsReports(s.id, ['111', '222'])
    expect(loginsOf(await j(await get('/api/ea', owner.cookie)), s.id)).toEqual(['111', '222'])
    expect((await j(await get('/api/ea', owner.cookie))).servers.map((x: any) => x.id)).toEqual([s.id])
    expect((await toggle(owner.cookie, '6128952', false)).status).toBe(404)
  })

  it('Admin gán VPS của một User cho User khác dùng chung: người được gán chỉ thấy phần được chọn', async () => {
    const owner = await newUser('chu')
    const guest = await newUser('khach')
    const s = await j(await send('POST', '/api/servers', { user_id: owner.id, name: 'VPS chu' }, admin))
    await vpsReports(s.id, ['111', '222', '333'])
    expect((await grant(guest.id, ['111', '333'], s.id)).status).toBe(200)
    expect(loginsOf(await j(await get('/api/ea', guest.cookie)), s.id)).toEqual(['111', '333'])
    expect((await toggle(guest.cookie, '222', false, s.id)).status).toBe(404)
    expect((await toggle(guest.cookie, '111', false, s.id)).status).toBe(200)
    // chủ vẫn thấy đủ và thấy thay đổi của khách
    const o = await j(await get('/api/ea', owner.cookie))
    expect(o.servers[0].accounts.find((a: any) => a.login === '111').enabled).toBe(false)
  })
})

describe('VPS bị khóa, User bị khóa/xóa', () => {
  it('VPS bị Admin khóa: User được cấp không bật/tắt được (403) nhưng vẫn thấy trạng thái', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952'])
    await send('PATCH', `/api/servers/${VPS}`, { locked: true }, admin)
    expect((await toggle(u.cookie, '6128952', false)).status).toBe(403)
    expect((await j(await get('/api/ea', u.cookie))).servers[0].locked).toBe(true)
  })

  it('User bị khóa: phiên bị đá; mở khóa vẫn giữ nguyên quyền đã cấp', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952'])
    await send('PATCH', `/api/users/${u.id}`, { locked: true }, admin)
    expect((await get('/api/ea', u.cookie)).status).toBe(401)
    expect((await j(await get('/api/ea', admin))).servers[0].access[0].locked).toBe(true)
    await send('PATCH', `/api/users/${u.id}`, { locked: false }, admin)
    const again = await login('nam', 'nam-new-pass-1')
    expect(loginsOf(await j(await get('/api/ea', again)))).toEqual(['6128952'])
  })

  it('xóa User dọn sạch quyền đã cấp; xóa VPS dọn quyền + tài khoản của VPS đó', async () => {
    const u = await newUser('nam')
    await grant(u.id, ['6128952'])
    await send('DELETE', `/api/users/${u.id}`, undefined, admin)
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM server_access').first()) as any).toEqual({ c: 0 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM account_grants').first()) as any).toEqual({ c: 0 })
    const v = await newUser('lan')
    await grant(v.id, ['6128952'])
    expect((await send('DELETE', `/api/servers/${VPS}`, undefined, admin)).status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM accounts').first()) as any).toEqual({ c: 0 })
    expect((await env.DB.prepare('SELECT COUNT(*) AS c FROM account_grants').first()) as any).toEqual({ c: 0 })
    expect((await j(await get('/api/ea', v.cookie))).servers).toEqual([])
  })
})
