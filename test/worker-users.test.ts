import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { beforeEach, describe, expect, it } from 'vitest'
import { decodeConnectCode, deriveServerKey } from '../src/shared/connect'
import { signBody } from '../src/shared/hmac'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

const WORKER = 'https://relay.example.workers.dev'
const ADMIN_PW = 'admin-initial-pass'
const ALERT = 'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'

let now = 5_000_000
let env: Env & { DB: ReturnType<typeof fakeD1> }
let pending: Promise<unknown>[] = []
let pushes: { url: string; body: string; sig: string; ts: string }[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
const settle = async () => {
  const p = pending
  pending = []
  await Promise.all(p)
}
/** Worker → VPS giả: ghi lại mọi lần đẩy và trả 200. */
const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
  const h = init?.headers as Record<string, string>
  pushes.push({ url: String(input), body: String(init?.body), sig: h['x-ocean-sig'] ?? '', ts: h['x-ocean-ts'] ?? '' })
  return new Response('{"ok":true}', { status: 200 })
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

/** Đăng nhập, trả về chuỗi cookie. */
async function login(username: string, password: string): Promise<string> {
  const r = await send('POST', '/api/login', { username, password })
  expect(r.status).toBe(200)
  return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
}
/** Đăng nhập + đổi mật khẩu lần đầu → cookie dùng được. */
async function ready(username: string, temp: string, next = `${username}-new-pass-1`): Promise<string> {
  const cookie = await login(username, temp)
  expect((await send('POST', '/api/password', { current: temp, next }, cookie)).status).toBe(200)
  return cookie
}
let admin = ''
async function newUser(name: string, extra: Record<string, unknown> = {}): Promise<{ id: number; cookie: string }> {
  const r = await j(await send('POST', '/api/users', { username: name, ...extra }, admin))
  expect(r.ok).toBe(true)
  return { id: r.id as number, cookie: await ready(name, r.password as string) }
}
const pullAs = (serverId: string, key: string) => call('/api/pull', { headers: { authorization: `Bearer ${key}`, 'x-ocean-server': serverId } })
const keyOf = (id: string) => deriveServerKey(SYNC_KEY, id)

beforeEach(async () => {
  now = 5_000_000
  pending = []
  pushes = []
  env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW }
  const c = await login('admin', ADMIN_PW)
  expect((await send('POST', '/api/password', { current: ADMIN_PW, next: 'admin-real-pass-9' }, c)).status).toBe(200)
  admin = c
})

describe('khởi tạo Admin và đăng nhập', () => {
  it('chưa có tài khoản và chưa có ADMIN_PASSWORD: báo rõ cách sửa, không đăng nhập được', async () => {
    const bare: Env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), SYNC_KEY }
    const s = await handle(new Request(`${WORKER}/api/session`), bare, ctx)
    expect(await j(s)).toMatchObject({ user: null, setup: 'need_admin_password' })
    const l = await handle(new Request(`${WORKER}/api/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'x'.repeat(10) }) }), bare, ctx)
    expect(l.status).toBe(503)
    expect((await j(l)).message).toContain('ADMIN_PASSWORD')
  })

  it('Admin được tạo từ ADMIN_PASSWORD, phải đổi mật khẩu trước khi dùng bất cứ thứ gì', async () => {
    const e2: Env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW, ADMIN_USER: 'Boss' }
    const go = (path: string, init: RequestInit = {}) => handle(new Request(`${WORKER}${path}`, init), e2, ctx)
    const r = await go('/api/login', { method: 'POST', body: JSON.stringify({ username: 'boss', password: ADMIN_PW }) })
    expect(r.status).toBe(200)
    const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0] as string
    const ov = await go('/api/overview', { headers: { cookie } })
    expect(ov.status).toBe(403)
    expect((await j(ov)).error).toBe('must_change_password')
    expect((await go('/api/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ current: ADMIN_PW, next: 'short' }) })).status).toBe(400)
    expect((await go('/api/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ current: 'sai-mat-khau', next: 'a-new-password' }) })).status).toBe(403)
    expect((await go('/api/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ current: ADMIN_PW, next: ADMIN_PW }) })).status).toBe(400)
    expect((await go('/api/password', { method: 'POST', headers: { cookie }, body: JSON.stringify({ current: ADMIN_PW, next: 'a-new-password' }) })).status).toBe(200)
    expect((await go('/api/overview', { headers: { cookie } })).status).toBe(200)
  })

  it('cookie phiên: HttpOnly + Secure + SameSite=Strict; D1 không lưu token thô; đăng xuất xóa phiên', async () => {
    const r = await send('POST', '/api/login', { username: 'admin', password: 'admin-real-pass-9' })
    const sc = r.headers.get('set-cookie') ?? ''
    expect(sc).toMatch(/HttpOnly/)
    expect(sc).toMatch(/Secure/)
    expect(sc).toMatch(/SameSite=Strict/)
    const token = /ocean_session=([^;]+)/.exec(sc)?.[1] ?? ''
    expect(token.length).toBeGreaterThan(30)
    const rows = env.DB.raw.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]
    expect(rows.some((x) => x.token_hash === token)).toBe(false)
    const cookie = `ocean_session=${token}`
    expect((await get('/api/overview', cookie)).status).toBe(200)
    await send('POST', '/api/logout', undefined, cookie)
    expect((await get('/api/overview', cookie)).status).toBe(401)
  })

  it('sai mật khẩu 5 lần thì bị chặn tạm (kể cả khi nhập đúng), hết hạn thì vào lại được; tên lạ cùng thông báo', async () => {
    for (let i = 0; i < 5; i++) expect((await send('POST', '/api/login', { username: 'admin', password: 'sai-mat-khau' })).status).toBe(401)
    const blocked = await send('POST', '/api/login', { username: 'admin', password: 'admin-real-pass-9' })
    expect(blocked.status).toBe(429)
    now += 301
    expect((await send('POST', '/api/login', { username: 'admin', password: 'admin-real-pass-9' })).status).toBe(200)
    const unknown = await j(await send('POST', '/api/login', { username: 'khong-co', password: 'sai-mat-khau' }))
    const wrong = await j(await send('POST', '/api/login', { username: 'admin', password: 'sai-mat-khau' }))
    expect(unknown.message).toBe(wrong.message)
  })

  it('yêu cầu ghi từ nguồn khác (CSRF) bị từ chối', async () => {
    const r = await call('/api/servers', { method: 'POST', cookie: admin, headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })
    expect(r.status).toBe(403)
    expect((await j(r)).error).toBe('bad_origin')
  })
})

describe('Admin tạo và quản lý người dùng', () => {
  it('chỉ Admin: tạo tài khoản (mật khẩu tạm 1 lần), trùng tên bị từ chối, tên sai bị từ chối', async () => {
    const r = await j(await send('POST', '/api/users', { username: 'Nam', max_servers: 2, max_hooks: 3 }, admin))
    expect(r).toMatchObject({ ok: true, username: 'nam', generated: true })
    expect((r.password as string).length).toBeGreaterThanOrEqual(12)
    expect((await send('POST', '/api/users', { username: 'nam' }, admin)).status).toBe(409)
    for (const bad of ['', 'ab', 'có dấu', 'a b c', '-abc']) expect((await send('POST', '/api/users', { username: bad }, admin)).status).toBe(400)
    expect((await send('POST', '/api/users', { username: 'x1', max_servers: -1 }, admin)).status).toBe(400)
    const u = await ready('nam', r.password as string)
    expect((await send('POST', '/api/users', { username: 'trom' }, u)).status).toBe(403)
    expect((await get('/api/overview', u).then(j)).users).toBeUndefined()
    // Mật khẩu tạm cũ hết tác dụng sau khi đổi.
    expect((await send('POST', '/api/login', { username: 'nam', password: r.password })).status).toBe(401)
  })

  it('User mới chưa đổi mật khẩu thì không làm được gì ngoài đổi mật khẩu', async () => {
    const r = await j(await send('POST', '/api/users', { username: 'lan' }, admin))
    const c = await login('lan', r.password as string)
    expect((await send('POST', '/api/servers', { name: 'x' }, c)).status).toBe(403)
    expect((await get('/api/signals', c)).status).toBe(403)
  })

  it('đặt lại mật khẩu: đá văng phiên cũ, bắt đổi lại; không tự khóa/xóa/hạ quyền mình', async () => {
    const { id, cookie } = await newUser('binh')
    const r = await j(await send('PATCH', `/api/users/${id}`, { reset_password: true }, admin))
    expect(r.password).toBeTruthy()
    expect((await get('/api/overview', cookie)).status).toBe(401)
    const c2 = await login('binh', r.password as string)
    expect((await get('/api/overview', c2)).status).toBe(403)
    const me = (await get('/api/session', admin).then(j)).user.id as number
    expect((await send('PATCH', `/api/users/${me}`, { locked: true }, admin)).status).toBe(400)
    expect((await send('PATCH', `/api/users/${me}`, { role: 'user' }, admin)).status).toBe(400)
    expect((await send('DELETE', `/api/users/${me}`, undefined, admin)).status).toBe(400)
  })
})

describe('hạn mức, khóa/mở khóa thêm VPS và Webhook', () => {
  it('User tạo VPS: mã kết nối đúng Worker URL + ID + khóa riêng; hết hạn mức thì dừng; Admin nâng hạn mức thì tiếp', async () => {
    const { id, cookie } = await newUser('an-user')
    const r = await j(await send('POST', '/api/servers', { name: 'VPS nhà' }, cookie))
    expect(r.ok).toBe(true)
    const code = decodeConnectCode(r.code as string)
    expect(code).toEqual({ workerUrl: WORKER, serverId: r.id, key: await keyOf(r.id as string) })
    expect(r.id).toMatch(/^vps-nha-[0-9a-f]{4}$/)
    const second = await send('POST', '/api/servers', { name: 'VPS 2' }, cookie)
    expect(second.status).toBe(403)
    expect((await j(second)).error).toBe('limit_reached')
    expect((await send('PATCH', `/api/users/${id}`, { max_servers: 2 }, admin)).status).toBe(200)
    expect((await send('POST', '/api/servers', { name: 'VPS 2' }, cookie)).status).toBe(200)
  })

  it('khóa thêm VPS/Webhook: còn hạn mức vẫn không tạo được cho tới khi Admin mở khóa; khóa này không ảnh hưởng cái đã có', async () => {
    const { id, cookie } = await newUser('chi', { max_servers: 5, max_hooks: 5 })
    const s1 = await j(await send('POST', '/api/servers', { name: 'a' }, cookie))
    await send('PATCH', `/api/users/${id}`, { can_add_server: false, can_add_hook: false }, admin)
    const a = await send('POST', '/api/servers', { name: 'b' }, cookie)
    expect(a.status).toBe(403)
    expect((await j(a)).error).toBe('add_locked')
    const b = await send('POST', '/api/hooks', { name: 'h' }, cookie)
    expect((await j(b)).error).toBe('add_locked')
    expect((await get(`/api/servers/${s1.id}/code`, cookie)).status).toBe(200) // cái đã có vẫn dùng được
    await send('PATCH', `/api/users/${id}`, { can_add_server: true, can_add_hook: true }, admin)
    expect((await send('POST', '/api/servers', { name: 'b' }, cookie)).status).toBe(200)
    const h = await j(await send('POST', '/api/hooks', { name: 'h' }, cookie))
    expect(h.url).toMatch(new RegExp(`^${WORKER}/webhook\\?key=oh_[A-Za-z0-9_-]{32}$`))
  })

  it('Admin tạo thay cho User (không bị hạn mức) và gắn đúng chủ; User thường không làm được điều đó', async () => {
    const { id, cookie } = await newUser('dung')
    const s = await j(await send('POST', '/api/servers', { user_id: id, name: 'do admin tạo' }, admin))
    expect(s.ok).toBe(true)
    const h = await j(await send('POST', '/api/hooks', { user_id: id }, admin))
    expect(h.ok).toBe(true)
    const ov = await j(await get('/api/overview', cookie))
    expect(ov.servers).toHaveLength(1)
    expect(ov.hooks).toHaveLength(1)
    expect((await send('POST', '/api/servers', { user_id: 1 }, cookie)).status).toBe(403)
  })

  it('Webhook gắn với một VPS chỉ nhận VPS của chính chủ', async () => {
    const a = await newUser('a-user', { max_servers: 2 })
    const b = await newUser('b-user')
    const sa = await j(await send('POST', '/api/servers', { name: 'a' }, a.cookie))
    const sb = await j(await send('POST', '/api/servers', { name: 'b' }, b.cookie))
    expect((await send('POST', '/api/hooks', { name: 'x', server: sb.id }, a.cookie)).status).toBe(400)
    expect((await send('POST', '/api/hooks', { name: 'x', server: sa.id }, a.cookie)).status).toBe(200)
  })
})

describe('cách ly dữ liệu giữa các User', () => {
  it('mỗi User chỉ thấy/chạm được VPS, Webhook, tín hiệu của mình; Admin thấy hết', async () => {
    const a = await newUser('user-a')
    const b = await newUser('user-b')
    const sa = await j(await send('POST', '/api/servers', { name: 'của A' }, a.cookie))
    const ha = await j(await send('POST', '/api/hooks', { name: 'hook A' }, a.cookie))
    await send('POST', '/api/servers', { name: 'của B' }, b.cookie)
    await call(new URL(ha.url as string).pathname + new URL(ha.url as string).search, { method: 'POST', body: ALERT })
    await settle()

    const ovA = await j(await get('/api/overview', a.cookie))
    const ovB = await j(await get('/api/overview', b.cookie))
    expect(ovA.servers.map((s: any) => s.name)).toEqual(['của A'])
    expect(ovB.servers.map((s: any) => s.name)).toEqual(['của B'])
    expect(ovB.hooks).toHaveLength(0)
    expect((await j(await get('/api/signals', a.cookie))).signals).toHaveLength(1)
    expect((await j(await get('/api/signals', b.cookie))).signals).toHaveLength(0)

    const hookId = ovA.hooks[0].id as number
    for (const [m, path, body] of [
      ['GET', `/api/servers/${sa.id}/code`, undefined],
      ['DELETE', `/api/servers/${sa.id}`, undefined],
      ['PATCH', `/api/servers/${sa.id}`, { name: 'đổi' }],
      ['POST', `/api/hooks/${hookId}/rotate`, undefined],
      ['POST', `/api/hooks/${hookId}/test`, undefined],
      ['DELETE', `/api/hooks/${hookId}`, undefined],
    ] as const) {
      expect((await send(m, path, body, b.cookie)).status, `${m} ${path}`).toBe(404)
    }
    const all = await j(await get('/api/overview', admin))
    expect(all.servers.map((s: any) => s.owner_name).sort()).toEqual(['user-a', 'user-b'])
    expect(all.users).toHaveLength(3)
    expect((await j(await get('/api/signals', admin))).signals).toHaveLength(1)
  })

  it('User không tự khóa/mở khóa VPS, Webhook, hạn mức của mình (chỉ Admin)', async () => {
    const a = await newUser('khong-hack')
    const s = await j(await send('POST', '/api/servers', {}, a.cookie))
    const h = await j(await send('POST', '/api/hooks', {}, a.cookie))
    const hid = (await j(await get('/api/overview', a.cookie))).hooks[0].id
    expect((await send('PATCH', `/api/servers/${s.id}`, { locked: false }, a.cookie)).status).toBe(403)
    expect((await send('PATCH', `/api/hooks/${hid}`, { locked: false }, a.cookie)).status).toBe(403)
    expect((await send('PATCH', `/api/users/${(await j(await get('/api/session', a.cookie))).user.id}`, { max_servers: 999 }, a.cookie)).status).toBe(403)
    expect(h.ok).toBe(true)
  })
})

describe('Webhook của User chỉ giao cho VPS của User đó', () => {
  it('alert từ Webhook của A: VPS của A kéo được, VPS của B và VPS đời cũ không thấy gì', async () => {
    const a = await newUser('giao-a')
    const b = await newUser('giao-b')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    const sb = await j(await send('POST', '/api/servers', {}, b.cookie))
    const ha = await j(await send('POST', '/api/hooks', {}, a.cookie))
    await pullAs(sa.id, await keyOf(sa.id)) // VPS báo "có mặt"
    await pullAs(sb.id, await keyOf(sb.id))
    await call('/api/pull', { headers: { authorization: `Bearer ${SYNC_KEY}` } }) // VPS đời cũ (id rỗng)

    const url = new URL(ha.url as string)
    const res = await call(url.pathname + url.search, { method: 'POST', body: ALERT })
    expect(await j(res)).toMatchObject({ ok: true, servers: 1 })
    await settle()

    const items = async (id: string) => ((await j(await pullAs(id, await keyOf(id)))).items as unknown[]).length
    // Push giả trả 200 nên A đã được đánh dấu giao; xóa đánh dấu để kiểm tra phía kéo bù.
    env.DB.raw.exec('UPDATE deliveries SET pushed = 0')
    expect(await items(sa.id)).toBe(1)
    expect(await items(sb.id)).toBe(0)
    const legacy = (await j(await call('/api/pull', { headers: { authorization: `Bearer ${SYNC_KEY}` } }))).items as unknown[]
    expect(legacy).toHaveLength(0)
  })

  it('đẩy trực tiếp: ký bằng khóa riêng của VPS, về đúng địa chỉ VPS đó', async () => {
    const a = await newUser('push-a')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    const ha = await j(await send('POST', '/api/hooks', {}, a.cookie))
    await call('/api/tunnel', { method: 'POST', headers: { authorization: `Bearer ${await keyOf(sa.id)}`, 'x-ocean-server': sa.id as string }, body: JSON.stringify({ url: 'https://vps-a.trycloudflare.com' }) })
    const url = new URL(ha.url as string)
    await call(url.pathname + url.search, { method: 'POST', body: ALERT })
    await settle()
    expect(pushes).toHaveLength(1)
    expect(pushes[0]?.url).toBe('https://vps-a.trycloudflare.com/api/ingest')
    expect(pushes[0]?.sig).toBe(await signBody(await keyOf(sa.id), Number(pushes[0]?.ts), pushes[0]?.body ?? ''))
  })

  it('khóa chung WEBHOOK_KEY: giao cho VPS đời cũ/Admin, KHÔNG giao cho VPS của User; `to=` chọn đích và bỏ qua VPS bị khóa', async () => {
    const a = await newUser('chung-a')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    await pullAs(sa.id, await keyOf(sa.id))
    await call('/api/pull', { headers: { authorization: `Bearer ${SYNC_KEY}` } }) // VPS đời cũ đăng ký
    const r = await j(await call(`/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body: ALERT }))
    expect(r.servers).toBe(1) // chỉ VPS đời cũ
    const to = await j(await call(`/webhook?key=${WEBHOOK_KEY}&to=${sa.id}`, { method: 'POST', body: ALERT }))
    expect(to.servers).toBe(1)
    const sid = (await j(await get('/api/overview', admin))).servers.find((s: any) => s.id === sa.id)
    expect(sid).toBeTruthy()
    await send('PATCH', `/api/servers/${sa.id}`, { locked: true }, admin)
    expect((await j(await call(`/webhook?key=${WEBHOOK_KEY}&to=${sa.id}`, { method: 'POST', body: ALERT }))).servers).toBe(0)
  })

  it('Webhook không có VPS nào hoạt động: vẫn nhận (200) kèm cảnh báo để dễ gỡ lỗi', async () => {
    const a = await newUser('khong-vps')
    const h = await j(await send('POST', '/api/hooks', {}, a.cookie))
    const url = new URL(h.url as string)
    const r = await j(await call(url.pathname + url.search, { method: 'POST', body: ALERT }))
    expect(r).toMatchObject({ ok: true, servers: 0, warning: 'no_active_server' })
  })

  it('"Gửi thử" tạo tín hiệu OCEAN TEST giao tới VPS của chủ; ghi nhận lần dùng cuối', async () => {
    const a = await newUser('thu-a')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    await send('POST', '/api/hooks', {}, a.cookie)
    const hid = (await j(await get('/api/overview', a.cookie))).hooks[0].id
    await call('/api/tunnel', { method: 'POST', headers: { authorization: `Bearer ${await keyOf(sa.id)}`, 'x-ocean-server': sa.id as string }, body: JSON.stringify({ url: 'https://vps-a.trycloudflare.com' }) })
    const r = await j(await send('POST', `/api/hooks/${hid}/test`, undefined, a.cookie))
    expect(r).toMatchObject({ ok: true, servers: 1 })
    await settle()
    expect(pushes).toHaveLength(1)
    expect(JSON.parse(pushes[0]?.body ?? '{}').raw).toContain('OCEAN TEST')
    const sigs = (await j(await get('/api/signals', a.cookie))).signals
    expect(sigs[0]).toMatchObject({ servers: 1, delivered: 1 })
    // Gửi thử không phải alert thật nên không làm tăng bộ đếm alert của Webhook.
    expect((await j(await get('/api/overview', a.cookie))).hooks[0].hits).toBe(0)
  })

  it('đổi khóa Webhook: URL cũ 401, URL mới chạy; ghi nhận lần dùng và số alert', async () => {
    const a = await newUser('doi-khoa')
    const h = await j(await send('POST', '/api/hooks', {}, a.cookie))
    const hid = (await j(await get('/api/overview', a.cookie))).hooks[0].id
    const old = new URL(h.url as string)
    expect((await call(old.pathname + old.search, { method: 'POST', body: ALERT })).status).toBe(200)
    await settle()
    let hook = (await j(await get('/api/overview', a.cookie))).hooks[0]
    expect(hook).toMatchObject({ hits: 1, last_used_ago: 0 })
    const r = await j(await send('POST', `/api/hooks/${hid}/rotate`, undefined, a.cookie))
    expect((await call(old.pathname + old.search, { method: 'POST', body: ALERT })).status).toBe(401)
    const nu = new URL(r.url as string)
    expect(nu.search).not.toBe(old.search)
    expect((await call(nu.pathname + nu.search, { method: 'POST', body: ALERT })).status).toBe(200)
    hook = (await j(await get('/api/overview', a.cookie))).hooks[0]
    expect(hook.hits).toBe(2)
  })
})

describe('Admin khóa/mở khóa và thu hồi', () => {
  it('khóa User: không đăng nhập, phiên đang mở bị đá, Webhook 403, VPS của họ bị từ chối; mở khóa thì chạy lại', async () => {
    const a = await newUser('bi-khoa')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    const ha = await j(await send('POST', '/api/hooks', {}, a.cookie))
    const url = new URL(ha.url as string)
    await pullAs(sa.id, await keyOf(sa.id))
    expect((await pullAs(sa.id, await keyOf(sa.id))).status).toBe(200)

    await send('PATCH', `/api/users/${a.id}`, { locked: true }, admin)
    expect((await get('/api/overview', a.cookie)).status).toBe(401)
    const l = await send('POST', '/api/login', { username: 'bi-khoa', password: 'bi-khoa-new-pass-1' })
    expect(l.status).toBe(403)
    expect((await j(l)).error).toBe('account_locked')
    const hook = await call(url.pathname + url.search, { method: 'POST', body: ALERT })
    expect(hook.status).toBe(403)
    expect((await j(hook)).error).toBe('user_locked')
    const pull = await pullAs(sa.id, await keyOf(sa.id))
    expect(pull.status).toBe(403)
    expect((await j(pull)).error).toBe('server_locked')

    await send('PATCH', `/api/users/${a.id}`, { locked: false }, admin)
    expect((await pullAs(sa.id, await keyOf(sa.id))).status).toBe(200)
    expect((await call(url.pathname + url.search, { method: 'POST', body: ALERT })).status).toBe(200)
    await login('bi-khoa', 'bi-khoa-new-pass-1')
  })

  it('khóa riêng một VPS hoặc một Webhook', async () => {
    const a = await newUser('khoa-le')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    const ha = await j(await send('POST', '/api/hooks', {}, a.cookie))
    const hid = (await j(await get('/api/overview', a.cookie))).hooks[0].id
    const url = new URL(ha.url as string)

    await send('PATCH', `/api/hooks/${hid}`, { locked: true }, admin)
    const r = await call(url.pathname + url.search, { method: 'POST', body: ALERT })
    expect(r.status).toBe(403)
    expect((await j(r)).error).toBe('hook_locked')
    expect((await send('POST', `/api/hooks/${hid}/test`, undefined, a.cookie)).status).toBe(403)
    await send('PATCH', `/api/hooks/${hid}`, { locked: false }, admin)

    await send('PATCH', `/api/servers/${sa.id}`, { locked: true }, admin)
    expect((await pullAs(sa.id, await keyOf(sa.id))).status).toBe(403)
    expect((await j(await get('/api/overview', a.cookie))).servers[0].locked).toBe(true)
    await send('PATCH', `/api/servers/${sa.id}`, { locked: false }, admin)
    expect((await pullAs(sa.id, await keyOf(sa.id))).status).toBe(200)
  })

  it('xóa VPS: mã cũ bị thu hồi vĩnh viễn (không tự đăng ký lại), Webhook gắn với nó quay về "mọi VPS"', async () => {
    const a = await newUser('xoa-vps', { max_servers: 2 })
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    await send('POST', '/api/hooks', { server: sa.id }, a.cookie)
    expect((await pullAs(sa.id, await keyOf(sa.id))).status).toBe(200)
    expect((await send('DELETE', `/api/servers/${sa.id}`, undefined, a.cookie)).status).toBe(200)
    const gone = await pullAs(sa.id, await keyOf(sa.id))
    expect(gone.status).toBe(403)
    expect((await j(gone)).error).toBe('server_revoked')
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM servers WHERE id = ?').get(sa.id)).toEqual({ c: 0 })
    expect((await j(await get('/api/overview', a.cookie))).hooks[0].server).toBeNull()
  })

  it('xóa User: xóa VPS (thu hồi), Webhook, tín hiệu, phiên của họ; người khác không bị ảnh hưởng', async () => {
    const a = await newUser('bi-xoa')
    const b = await newUser('o-lai')
    const sa = await j(await send('POST', '/api/servers', {}, a.cookie))
    const ha = await j(await send('POST', '/api/hooks', {}, a.cookie))
    await send('POST', '/api/servers', {}, b.cookie)
    const url = new URL(ha.url as string)
    await call(url.pathname + url.search, { method: 'POST', body: ALERT })
    await settle()
    expect((await send('DELETE', `/api/users/${a.id}`, undefined, admin)).status).toBe(200)
    expect((await get('/api/overview', a.cookie)).status).toBe(401)
    expect((await call(url.pathname + url.search, { method: 'POST', body: ALERT })).status).toBe(401)
    expect((await j(await pullAs(sa.id, await keyOf(sa.id)))).error).toBe('server_revoked')
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM signals').get()).toEqual({ c: 0 })
    expect((await j(await get('/api/overview', b.cookie))).servers).toHaveLength(1)
  })
})

describe('tương thích bản cũ và gỡ lỗi', () => {
  it('VPS cấp bằng dòng lệnh (khóa suy ra, chưa có chủ) tự đăng ký như cũ và hiện trong danh sách của Admin', async () => {
    const id = 'vps-cu-1234'
    expect((await pullAs(id, await keyOf(id))).status).toBe(200)
    const ov = await j(await get('/api/overview', admin))
    const s = ov.servers.find((x: any) => x.id === id)
    expect(s).toMatchObject({ owner: null, status: 'online', locked: false })
    now += 700 // chu kỳ kéo bù tối đa 600s: vẫn còn online
    expect((await j(await get('/api/overview', admin))).servers.find((x: any) => x.id === id).status).toBe('online')
    now += 100
    expect((await j(await get('/api/overview', admin))).servers.find((x: any) => x.id === id).status).toBe('stale')
    await send('PATCH', `/api/servers/${id}`, { locked: true }, admin)
    expect((await pullAs(id, await keyOf(id))).status).toBe(403)
  })

  it('quên chạy migration: báo db_not_migrated kèm lệnh sửa thay vì lỗi chung chung', async () => {
    const old = readdirSync('worker/migrations')
      .filter((f) => f < '0003')
      .map((f) => readFileSync(`worker/migrations/${f}`, 'utf8'))
      .join('\n')
    const e: Env = { DB: fakeD1(old), SYNC_KEY, WEBHOOK_KEY: undefined }
    const r = await handle(new Request(`${WORKER}/webhook?key=${'k'.repeat(24)}`, { method: 'POST', body: ALERT }), e, ctx)
    expect(r.status).toBe(500)
    expect(await j(r)).toMatchObject({ error: 'db_not_migrated' })
  })

  it('schema.sql (cài mới) và migrations (nâng cấp) cho ra cùng một cấu trúc bảng', () => {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')
    const dump = (sql: string) => {
      const db = new DatabaseSync(':memory:')
      db.exec(sql)
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name)
      const out: Record<string, string[]> = {}
      for (const t of tables) {
        out[t] = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[])
          .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`)
          .sort()
      }
      const idx = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((i) => i.name)
      return { out, idx }
    }
    const migrated = readdirSync('worker/migrations')
      .sort()
      .map((f) => readFileSync(`worker/migrations/${f}`, 'utf8'))
      .join('\n')
    expect(dump(readFileSync('worker/schema.sql', 'utf8'))).toEqual(dump(migrated))
  })
})
