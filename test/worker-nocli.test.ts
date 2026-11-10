import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

const WORKER = 'https://relay.example.workers.dev'
const schema = () => readFileSync('worker/schema.sql', 'utf8')
const CLI = /\b(npm|npx|wrangler|powershell|cd worker)\b|\.ps1|\.mjs|--remote/i
const ctx = { waitUntil: () => {} }
const req = (env: Env, path: string, init: RequestInit = {}) => handle(new Request(`${WORKER}${path}`, init), env, ctx)
const post = (env: Env, path: string, body: unknown, cookie = '') =>
  req(env, path, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0] as string

async function adminCookie(env: Env, pw = 'admin-initial-pass', next = 'admin-real-pass-9') {
  const c = cookieOf(await post(env, '/api/login', { username: 'admin', password: pw }))
  expect((await post(env, '/api/password', { current: pw, next }, c)).status).toBe(200)
  return c
}

describe('thông báo lỗi của Worker không bắt gõ lệnh', () => {
  it('thiếu ADMIN_PASSWORD / SYNC_KEY / chưa migrate: thông báo chỉ tới Dashboard hoặc GitHub Actions', async () => {
    const noAdmin: Env = { DB: fakeD1(schema()), SYNC_KEY }
    const l = await post(noAdmin, '/api/login', { username: 'admin', password: 'x'.repeat(10) })
    expect(l.status).toBe(503)
    expect(((await l.json()) as { message: string }).message).not.toMatch(CLI)

    const noSync: Env = { DB: fakeD1(schema()), ADMIN_PASSWORD: 'admin-initial-pass' }
    const c = await adminCookie(noSync)
    const r = await post(noSync, '/api/servers', { name: 'VPS' }, c)
    expect(r.status).toBe(503)
    const m = ((await r.json()) as { message: string }).message
    expect(m).not.toMatch(CLI)
    expect(m).toContain('SYNC_KEY')

    const old: Env = { DB: fakeD1('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);'), SYNC_KEY, WEBHOOK_KEY }
    const w = await post(old, `/webhook?key=${WEBHOOK_KEY}`, 'x')
    const wm = (await w.json()) as { error: string; message: string }
    expect(wm.error).toBe('db_not_migrated')
    expect(wm.message).not.toMatch(CLI)
    expect(wm.message).toContain('Run workflow')
  })
})

describe('trang /help: đường không cần lệnh đứng trước, lệnh chỉ nằm ở mục Nâng cao', () => {
  it('phần trước "Nâng cao" không có lệnh; có hướng dẫn Dashboard + GitHub Actions + khôi phục Admin qua D1 Console', async () => {
    const html = await (await req({ DB: fakeD1(schema()), SYNC_KEY }, '/help')).text()
    const cut = html.indexOf('Nâng cao')
    expect(cut).toBeGreaterThan(0)
    const before = html.slice(0, cut).replace(/<style>[\s\S]*?<\/style>/, '')
    expect(before).not.toMatch(CLI)
    for (const must of ['Run workflow', 'ADMIN_PASSWORD', 'SYNC_KEY', 'Cloudflare Dashboard', 'Console', "DELETE FROM users WHERE role = 'admin'"]) expect(before).toContain(must)
    expect(html.slice(cut)).toContain('npm run setup') // lệnh vẫn có, nhưng chỉ là tùy chọn
  })
})

describe('khôi phục Admin duy nhất qua D1 Console + ADMIN_PASSWORD', () => {
  it('xóa Admin nhưng vẫn còn User: mở lại trang tạo lại Admin từ ADMIN_PASSWORD, User và dữ liệu của họ giữ nguyên', async () => {
    const env: Env & { DB: ReturnType<typeof fakeD1> } = { DB: fakeD1(schema()), SYNC_KEY, ADMIN_PASSWORD: 'admin-initial-pass' }
    const a = await adminCookie(env)
    const mk = await post(env, '/api/users', { username: 'nam' }, a)
    expect(mk.status).toBe(200)
    expect((await post(env, '/api/servers', { name: 'x', user_id: ((await mk.json()) as { id: number }).id }, a)).status).toBe(200)

    // Quên mật khẩu: chạy câu SQL trong D1 Console như hướng dẫn ở /help.
    env.DB.raw.exec("DELETE FROM users WHERE role = 'admin'")
    expect(await (await req(env, '/api/session')).json()).toMatchObject({ user: null, setup: 'ok' }) // ensureAdmin chạy ở /api/session
    const fresh = await post(env, '/api/login', { username: 'admin', password: 'admin-initial-pass' })
    expect(fresh.status).toBe(200) // Admin được tạo lại, phải đổi mật khẩu
    expect(((await fresh.json()) as { user: { must_change: boolean } }).user.must_change).toBe(true)
    expect(env.DB.raw.prepare("SELECT username FROM users WHERE role='user'").all()).toEqual([{ username: 'nam' }])
    expect(env.DB.raw.prepare('SELECT COUNT(*) AS c FROM servers WHERE owner IS NOT NULL').get()).toEqual({ c: 1 })
  })

  it('còn Admin thì ADMIN_PASSWORD không làm gì (không đặt lại mật khẩu lén, không tạo Admin thứ hai)', async () => {
    const env: Env & { DB: ReturnType<typeof fakeD1> } = { DB: fakeD1(schema()), SYNC_KEY, ADMIN_PASSWORD: 'admin-initial-pass' }
    await adminCookie(env)
    await req(env, '/') // mở trang chủ nhiều lần
    await req(env, '/api/session')
    expect(env.DB.raw.prepare("SELECT COUNT(*) AS c FROM users WHERE role='admin'").get()).toEqual({ c: 1 })
    expect((await post(env, '/api/login', { username: 'admin', password: 'admin-initial-pass' })).status).toBe(401) // mật khẩu ban đầu không còn dùng được
  })
})

describe('overview: bộ cài và Webhook chung', () => {
  it('Admin thấy Webhook chung + installer_url mặc định; User không thấy khóa chung; INSTALLER_URL chỉ nhận https', async () => {
    const env: Env & { DB: ReturnType<typeof fakeD1> } = { DB: fakeD1(schema()), SYNC_KEY, WEBHOOK_KEY, ADMIN_PASSWORD: 'admin-initial-pass' }
    const a = await adminCookie(env)
    const ov = (await (await req(env, '/api/overview', { headers: { cookie: a } })).json()) as { legacy_hook_url?: string; installer_url: string }
    expect(ov.legacy_hook_url).toBe(`${WORKER}/webhook?key=${WEBHOOK_KEY}`)
    expect(ov.installer_url).toMatch(/^https:\/\/github\.com\/.+\/releases$/)

    const mk = (await (await post(env, '/api/users', { username: 'nam' }, a)).json()) as { password: string }
    const uc = cookieOf(await post(env, '/api/login', { username: 'nam', password: mk.password }))
    await post(env, '/api/password', { current: mk.password, next: 'nam-new-pass-1' }, uc)
    const uov = await (await req(env, '/api/overview', { headers: { cookie: uc } })).text()
    expect(uov).not.toContain(WEBHOOK_KEY)
    expect(uov).not.toContain('legacy_hook_url')

    const bad: Env = { ...env, INSTALLER_URL: 'http://insecure.example' }
    expect(((await (await req(bad, '/api/overview', { headers: { cookie: a } })).json()) as { installer_url: string }).installer_url).toMatch(/^https:\/\/github\.com/)
  })
})

describe('workflow deploy nạp secret từ GitHub (thiết lập không cần CLI)', () => {
  it('có bước nạp ADMIN_PASSWORD / SYNC_KEY / WEBHOOK_KEY với kiểm tra độ dài, nằm SAU bước deploy', () => {
    const y = readFileSync('.github/workflows/deploy.yml', 'utf8')
    for (const n of ['ADMIN_PASSWORD', 'SYNC_KEY', 'WEBHOOK_KEY']) expect(y).toContain(`secrets.${n}`)
    expect(y).toContain('put SYNC_KEY 32')
    expect(y).toContain('put ADMIN_PASSWORD 8')
    expect(y.indexOf('wrangler secret put')).toBeGreaterThan(y.indexOf('npx wrangler deploy'))
    expect(y).toContain('printf') // đưa secret qua stdin, không để lộ ở dòng lệnh/log
  })
})
