import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import worker from '../worker/src/index'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

const WORKER = 'https://relay.example.workers.dev'
const ADMIN_PW = 'admin-initial-pass'
const DAY = 86400
const ALERT = 'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'

let now = 50_000_000
let env: Env & { DB: ReturnType<typeof fakeD1> }
let pending: Promise<unknown>[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
const noPush = (async () => new Response('x', { status: 500 })) as typeof fetch

const send = (method: string, path: string, body?: unknown, cookie?: string) =>
  handle(
    new Request(`${WORKER}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    ctx,
    { now: () => now, fetchFn: noPush, retryMs: [0] },
  )
const j = async (r: Response) => (await r.json()) as Record<string, any>
const sql = env_sql()
function env_sql() {
  return {
    all: (q: string, ...a: unknown[]) => env.DB.raw.prepare(q).all(...(a as never[])) as Record<string, any>[],
    run: (q: string, ...a: unknown[]) => void env.DB.raw.prepare(q).run(...(a as never[])),
    count: (t: string) => (env.DB.raw.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c,
  }
}

async function login(username: string, password: string): Promise<string> {
  const r = await send('POST', '/api/login', { username, password })
  expect(r.status).toBe(200)
  return (r.headers.get('set-cookie') ?? '').split(';')[0] as string
}
let admin = ''
let user = { id: 0, cookie: '' }

/** Thêm tín hiệu giả `ageSec` giây tuổi (tính từ `now`), kèm một dòng giao cho server 'vps-a' (pushed hay chưa). */
function addSignal(ageSec: number, opts: { owner?: number | null; pushed?: 0 | 1 } = {}): number {
  sql.run('INSERT INTO signals (created, raw, owner) VALUES (?, ?, ?)', now - ageSec, ALERT, opts.owner ?? null)
  const id = (env.DB.raw.prepare('SELECT last_insert_rowid() AS id').get() as { id: number }).id
  sql.run('INSERT INTO deliveries (sid, server, pushed) VALUES (?, ?, ?)', id, 'vps-a', opts.pushed ?? 1)
  return id
}

beforeEach(async () => {
  now = 50_000_000
  pending = []
  env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW }
  const c = await login('admin', ADMIN_PW)
  expect((await send('POST', '/api/password', { current: ADMIN_PW, next: 'admin-real-pass-9' }, c)).status).toBe(200)
  admin = c
  const r = await j(await send('POST', '/api/users', { username: 'nam' }, admin))
  const uc = await login('nam', r.password as string)
  expect((await send('POST', '/api/password', { current: r.password, next: 'nam-new-pass-1' }, uc)).status).toBe(200)
  user = { id: r.id as number, cookie: uc }
})

describe('Cron Trigger: tự dọn theo số ngày đã chọn', () => {
  it('mặc định giữ 7 ngày: xóa tín hiệu + dòng giao cũ hơn 7 ngày, giữ phần còn lại, ghi lại lần dọn', async () => {
    const old = addSignal(8 * DAY)
    const keep = addSignal(6 * DAY)
    sql.run('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)', 'het-han', 1, now - 9 * DAY, now - DAY)
    await worker.scheduled({ scheduledTime: now * 1000 }, env)
    expect(sql.all('SELECT id FROM signals').map((r) => r.id)).toEqual([keep])
    expect(sql.all('SELECT sid FROM deliveries').map((r) => r.sid)).toEqual([keep])
    expect(old).not.toBe(keep)
    expect(sql.all("SELECT 1 FROM sessions WHERE token_hash = 'het-han'")).toHaveLength(0) // phiên hết hạn cũng được dọn
    const ret = await j(await send('GET', '/api/signals/retention', undefined, admin))
    expect(ret).toMatchObject({ days: 7, count: 1, last: { ago: 0, deleted: 1 } })
  })

  it('đổi sang 1 tháng / 3 tháng / tùy chọn: cron giữ đúng số ngày đó', async () => {
    for (const [days, expected] of [[30, 1], [90, 3], [45, 2]] as const) {
      sql.run('DELETE FROM signals')
      sql.run('DELETE FROM deliveries')
      addSignal(20 * DAY)
      addSignal(40 * DAY)
      addSignal(80 * DAY)
      addSignal(120 * DAY)
      expect((await send('PUT', '/api/signals/retention', { days }, admin)).status).toBe(200)
      await worker.scheduled({ scheduledTime: now * 1000 }, env)
      const left = sql.all('SELECT created FROM signals').map((r) => Math.round((now - r.created) / DAY))
      expect(left.every((d) => d <= days)).toBe(true)
      expect(left).toHaveLength(expected) // tín hiệu 20/40/80/120 ngày tuổi: giữ những cái không quá `days` ngày
    }
  })

  it('0 = không tự xóa: cron không đụng vào tín hiệu nào', async () => {
    addSignal(400 * DAY)
    expect((await send('PUT', '/api/signals/retention', { days: 0 }, admin)).status).toBe(200)
    await worker.scheduled({ scheduledTime: now * 1000 }, env)
    expect(sql.count('signals')).toBe(1)
  })

  it('webhook không còn tự xóa tín hiệu 7 ngày nữa (đã giao cho cron + cấu hình)', async () => {
    expect((await send('PUT', '/api/signals/retention', { days: 90 }, admin)).status).toBe(200)
    for (let i = 0; i < 49; i++) addSignal(30 * DAY)
    const r = await send('POST', `/webhook?key=${WEBHOOK_KEY}`, ALERT)
    expect(((await j(r)) as { id: number }).id).toBe(50) // id chia hết cho 50: ngày trước sẽ kích hoạt dọn 7 ngày
    await Promise.all(pending.splice(0))
    expect(sql.count('signals')).toBe(50)
  })
})

describe('API cấu hình tự dọn', () => {
  it('chỉ Admin đổi được; số ngày phải từ 0 đến 3650', async () => {
    expect((await send('PUT', '/api/signals/retention', { days: 30 }, user.cookie)).status).toBe(403)
    for (const days of [-1, 3651, 1.5, '30', null]) expect((await send('PUT', '/api/signals/retention', { days }, admin)).status).toBe(400)
    expect((await send('PUT', '/api/signals/retention', { days: 3650 }, admin)).status).toBe(200)
    expect((await send('GET', '/api/signals/retention')).status).toBe(401) // phải đăng nhập
    expect(((await j(await send('GET', '/api/signals/retention', undefined, user.cookie))) as { days: number }).days).toBe(3650) // User xem được, không đổi được
  })
})

describe('Xóa thủ công', () => {
  beforeEach(() => {
    addSignal(2 * DAY, { owner: user.id })
    addSignal(10 * DAY, { owner: user.id })
    addSignal(40 * DAY, { owner: user.id })
    addSignal(10 * DAY, { owner: null })
    addSignal(100 * DAY, { owner: null })
  })
  const purge = (body: unknown, cookie = admin) => send('POST', '/api/signals/purge', body, cookie)

  it('giữ N ngày gần nhất (older)', async () => {
    expect(await j(await purge({ mode: 'older', days: 7 }))).toMatchObject({ ok: true, deleted: 4, kept_pending: 0 })
    expect(sql.count('signals')).toBe(1)
    expect(sql.count('deliveries')).toBe(1)
  })

  it('xóa theo khoảng thời gian (range), tính cả hai đầu', async () => {
    const r = await j(await purge({ mode: 'range', from: now - 50 * DAY, to: now - 10 * DAY }))
    expect(r.deleted).toBe(3) // 10d, 40d, 10d
    expect(sql.all('SELECT created FROM signals ORDER BY created').map((x) => Math.round((now - x.created) / DAY))).toEqual([100, 2])
  })

  it('xóa hết (all)', async () => {
    expect(await j(await purge({ mode: 'all' }))).toMatchObject({ deleted: 5 })
    expect(sql.count('signals')).toBe(0)
    expect(sql.count('deliveries')).toBe(0)
  })

  it('User chỉ xóa được tín hiệu của chính mình, không đụng tín hiệu người khác', async () => {
    expect(await j(await purge({ mode: 'all' }, user.cookie))).toMatchObject({ deleted: 3 })
    expect(sql.all('SELECT owner FROM signals').every((r) => r.owner === null)).toBe(true)
    expect(sql.count('signals')).toBe(2)
    const ret = await j(await send('GET', '/api/signals/retention', undefined, user.cookie))
    expect(ret.count).toBe(0) // User chỉ thấy số lượng của mình
  })

  it('yêu cầu sai bị từ chối, không xóa gì', async () => {
    const bad: unknown[] = [{}, { mode: 'nope' }, { mode: 'older' }, { mode: 'older', days: 0 }, { mode: 'older', days: 99999 }, { mode: 'range', from: 10 }, { mode: 'range', from: 20, to: 10 }, { mode: 'range', from: -1, to: 5 }]
    for (const b of bad) expect((await purge(b)).status).toBe(400)
    expect((await send('POST', '/api/signals/purge', { mode: 'all' })).status).toBe(401)
    expect(sql.count('signals')).toBe(5)
  })

  it('không xóa tín hiệu vừa nhận mà VPS chưa nhận (tránh mất lệnh); tín hiệu chờ quá 1 giờ thì xóa được', async () => {
    sql.run('DELETE FROM signals')
    sql.run('DELETE FROM deliveries')
    const fresh = addSignal(60, { pushed: 0 }) // 1 phút trước, chưa giao: phải giữ
    addSignal(120, { pushed: 1 }) // đã giao: xóa được
    addSignal(2 * 3600, { pushed: 0 }) // quá cửa sổ kéo bù 1 giờ: xóa được
    const r = await j(await purge({ mode: 'all' }))
    expect(r).toMatchObject({ deleted: 2, kept_pending: 1 })
    expect(sql.all('SELECT id FROM signals').map((x) => x.id)).toEqual([fresh])
    expect(sql.count('deliveries')).toBe(1)
    // VPS vẫn kéo bù được tín hiệu được giữ lại
    const pull = await handle(new Request(`${WORKER}/api/pull`, { headers: { authorization: `Bearer ${SYNC_KEY}` } }), env, ctx, { now: () => now })
    expect(pull.status).toBe(200)
  })
})

describe('Giao diện tab Tín hiệu', () => {
  const windows: { close: () => void }[] = []
  afterEach(() => {
    for (const w of windows.splice(0)) w.close()
  })

  async function openAs(username: string, password: string) {
    const res = await handle(new Request(`${WORKER}/`), env, ctx, { now: () => now })
    const page = await res.text()
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page)?.[1] ?? ''
    const dom = new JSDOM(page.replace(/<script[\s\S]*<\/script>/, ''), { runScripts: 'outside-only', url: `${WORKER}/` })
    const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void; confirm: (m: string) => boolean; Event: typeof Event }
    let cookie = ''
    const confirms: string[] = []
    w.confirm = (m: string) => (confirms.push(m), true)
    w.fetch = (async (u: string, o: RequestInit = {}) => {
      const r = await handle(new Request(`${WORKER}${u}`, { ...o, headers: { ...(o.headers as object), origin: WORKER, ...(cookie ? { cookie } : {}) } }), env, ctx, { now: () => now })
      const sc = r.headers.get('set-cookie')
      if (sc) cookie = sc.split(';')[0] ?? ''
      return r
    }) as typeof fetch
    w.eval(script)
    windows.push(w)
    const doc = dom.window.document
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 200; i++) {
        if (cond()) return
        await new Promise((r) => setTimeout(r, 15))
      }
      throw new Error(`Chờ quá lâu: ${what}\n${doc.body.textContent?.slice(0, 500)}`)
    }
    const text = () => doc.body.textContent ?? ''
    const form = (n: string) => doc.querySelector(`form[data-form="${n}"]`) as HTMLFormElement | null
    const set = (f: HTMLFormElement, v: Record<string, string>) => {
      for (const [k, x] of Object.entries(v)) (f.elements.namedItem(k) as HTMLInputElement).value = x
    }
    const submit = (f: HTMLFormElement) => f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
    await until(() => !!form('login'), 'form đăng nhập')
    set(form('login') as HTMLFormElement, { username, password })
    submit(form('login') as HTMLFormElement)
    await until(() => !!doc.querySelector('button[data-act="tab"][data-v="sigs"]'), 'dashboard')
    ;(doc.querySelector('button[data-act="tab"][data-v="sigs"]') as HTMLElement).click()
    await until(() => text().includes('Dọn dẹp tín hiệu') && text().includes('Đang lưu'), 'thẻ dọn dẹp')
    return { doc, text, until, form, set, submit, confirms, click: (s: string) => (doc.querySelector(s) as HTMLElement).click() }
  }

  it('Admin: chọn 1 tháng → lưu; bấm "Giữ 7 ngày" → xác nhận rồi xóa; "Xóa hết" xóa sạch', async () => {
    addSignal(2 * DAY)
    addSignal(20 * DAY)
    const a = await openAs('admin', 'admin-real-pass-9')
    expect(a.text()).toContain('Đang lưu 2 tín hiệu')
    expect(a.text()).toContain('Chưa chạy lần nào')

    a.set(a.form('retention') as HTMLFormElement, { preset: '30' })
    a.submit(a.form('retention') as HTMLFormElement)
    await a.until(() => sql.all("SELECT v FROM kv WHERE k = 'retention_days'")[0]?.v === '30', 'lưu cấu hình')

    a.click('button[data-act="purgeOlder"][data-days="7"]')
    await a.until(() => a.text().includes('Đang lưu 1 tín hiệu'), 'xóa giữ 7 ngày')
    expect(a.confirms.at(-1)).toContain('7 ngày')
    expect(a.doc.querySelectorAll('.sig').length).toBe(1)

    // tùy chọn sai bị chặn ở phía trình duyệt
    a.set(a.form('retention') as HTMLFormElement, { preset: 'custom', custom: '0' })
    a.submit(a.form('retention') as HTMLFormElement)
    await new Promise((r) => setTimeout(r, 60))
    expect(sql.all("SELECT v FROM kv WHERE k = 'retention_days'")[0]?.v).toBe('30')
    a.set(a.form('retention') as HTMLFormElement, { preset: 'custom', custom: '45' })
    a.submit(a.form('retention') as HTMLFormElement)
    await a.until(() => sql.all("SELECT v FROM kv WHERE k = 'retention_days'")[0]?.v === '45', 'lưu 45 ngày')

    a.click('button[data-act="purgeAll"]')
    await a.until(() => a.text().includes('Đang lưu 0 tín hiệu'), 'xóa hết')
    expect(sql.count('signals')).toBe(0)
  })

  it('Admin: xóa theo khoảng ngày; User không thấy ô cấu hình tự dọn và chỉ xóa của mình', async () => {
    const day = (offset: number) => new Date((now - offset * DAY) * 1000)
    const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    addSignal(30 * DAY, { owner: user.id })
    addSignal(10 * DAY, { owner: null })
    addSignal(1 * DAY, { owner: null })
    const a = await openAs('admin', 'admin-real-pass-9')
    a.set(a.form('purgeRange') as HTMLFormElement, { from: ymd(day(35)), to: ymd(day(5)) })
    a.submit(a.form('purgeRange') as HTMLFormElement)
    await a.until(() => a.text().includes('Đang lưu 1 tín hiệu'), 'xóa khoảng ngày')
    expect(sql.all('SELECT created FROM signals').map((r) => Math.round((now - r.created) / DAY))).toEqual([1])

    addSignal(3 * DAY, { owner: user.id })
    addSignal(3 * DAY, { owner: null })
    const u = await openAs('nam', 'nam-new-pass-1')
    expect(u.form('retention')).toBeNull() // User không có ô đổi cấu hình tự dọn
    expect(u.text()).toContain('Đang lưu 1 tín hiệu')
    u.click('button[data-act="purgeAll"]')
    await u.until(() => u.text().includes('Đang lưu 0 tín hiệu'), 'User xóa của mình')
    expect(u.confirms.at(-1)).toContain('của bạn')
    expect(sql.count('signals')).toBe(2) // tín hiệu của người khác còn nguyên
  })
})
