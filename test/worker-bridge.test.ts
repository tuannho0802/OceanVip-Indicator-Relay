import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../src/server/app'
import { decodeConnectCode } from '../src/shared/connect'
import { Runtime } from '../src/server/runtime'
import { WorkerSync } from '../src/server/worker-sync'
import { flushPending } from '../worker/src/deliver'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, baseCfg, fakeD1 } from './helpers'

/**
 * Worker là cầu nối chính: đẩy lại nhiều lần, tự quét lại mỗi phút (Cron), ghi lại vì sao một lần đẩy hụt, và có nút đo độ trễ Worker → VPS.
 * Server thật (createApp) + Worker thật (handle) + D1 giả; chỉ có đường mạng Worker → VPS được giả để mô phỏng tunnel hỏng.
 */
const WORKER = 'https://relay.example.workers.dev'
const VPS = 'https://vps.test'
const ADMIN_PW = 'admin-initial-pass'
const ALERT = 'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'

let app: App
let base = ''
let now = 7_000_000
let serverSkew = 0
let vpsUp = true
let env: Env & { DB: ReturnType<typeof fakeD1> }
let pending: Promise<unknown>[] = []
let admin = ''
let sid = ''
let hookKey = ''
let calls: string[] = []
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
const settle = async () => {
  const p = pending
  pending = []
  await Promise.all(p)
}

/** Worker → VPS: https://vps.test được nối tới cổng thật của Server thử nghiệm; vpsUp=false mô phỏng tunnel sập. */
const toVps = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push(String(input))
  if (!vpsUp) throw new Error('tunnel sập')
  return fetch(String(input).replace(VPS, base), init)
}) as typeof fetch

let fetchFn: typeof fetch = toVps
let retryMs: readonly number[] = [0, 0, 0, 0, 0, 0]
const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init
  const headers = { ...(rest.headers as Record<string, string> | undefined), ...(cookie ? { cookie } : {}) }
  return handle(new Request(`${WORKER}${path}`, { ...rest, headers }), env, ctx, { now: () => now, fetchFn, retryMs })
}
const send = (method: string, path: string, body?: unknown, cookie?: string) =>
  call(path, { method, cookie, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
const j = async (r: Response) => (await r.json()) as Record<string, any>
const fire = () => call(`/webhook?key=${hookKey}`, { method: 'POST', body: ALERT })
const state = async () => (await (await fetch(`${base}/api/state`)).json()) as { signals: { id: number; kind: string }[] }
const overview = async (cookie = admin) => (await j(await call('/api/overview', { cookie }))) as { servers: { id: string; last_push: { ok: boolean; tries: number; status: number | null; error: string | null } | null }[] }

beforeEach(async () => {
  now = 7_000_000
  serverSkew = 0
  vpsUp = true
  pending = []
  calls = []
  fetchFn = toVps
  retryMs = [0, 0, 0, 0, 0, 0]
  env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: ADMIN_PW }
  const c = await send('POST', '/api/login', { username: 'admin', password: ADMIN_PW })
  const tmp = (c.headers.get('set-cookie') ?? '').split(';')[0] as string
  await send('POST', '/api/password', { current: ADMIN_PW, next: 'admin-real-pass-9' }, tmp)
  const l = await send('POST', '/api/login', { username: 'admin', password: 'admin-real-pass-9' })
  admin = (l.headers.get('set-cookie') ?? '').split(';')[0] as string

  // Admin tạo một VPS thật (có Server ID + khóa riêng) và một Webhook URL.
  const created = await j(await send('POST', '/api/servers', { name: 'Test VPS' }, admin))
  sid = created.id as string
  const code = decodeConnectCode(created.code as string)
  expect(code?.serverId).toBe(sid)
  app = createApp(baseCfg({ syncKey: code?.key ?? '', serverId: sid, workerUrl: WORKER }), { clock: () => now + serverSkew })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  const hook = await j(await send('POST', '/api/hooks', { name: 'tv' }, admin))
  hookKey = new URL(hook.url as string).searchParams.get('key') ?? ''
  await tunnel(VPS)
})
afterEach(() => app.close())

/** VPS báo địa chỉ tunnel (đúng như Server thật làm). */
async function tunnel(url: string | null) {
  const code = decodeConnectCode((await j(await send('GET', `/api/servers/${sid}/code`, undefined, admin))).code as string)
  const r = await call('/api/tunnel', { method: 'POST', headers: { authorization: `Bearer ${code?.key}`, 'x-ocean-server': sid, 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
  expect(r.status).toBe(200)
}

describe('Worker đẩy lại nhiều lần', () => {
  it('tunnel chập chờn 5 lần liên tiếp vẫn giao được ở lần thứ 6, không cần VPS kéo bù', async () => {
    let n = 0
    fetchFn = (async (i: string | URL | Request, init?: RequestInit) => {
      if (++n < 6) throw new Error('chập chờn')
      return toVps(i, init)
    }) as typeof fetch
    expect((await fire()).status).toBe(200)
    await settle()
    expect(n).toBe(6)
    expect((await state()).signals).toHaveLength(1)
    const s = (await overview()).servers.find((x) => x.id === sid)
    expect(s?.last_push).toMatchObject({ ok: true, tries: 6 })
  })

  it('404 (địa chỉ tunnel cũ) và 429 được coi là tạm thời nên thử lại; 401 là vĩnh viễn nên dừng ngay', async () => {
    for (const [status, expected] of [[404, 6], [429, 6], [401, 1]] as const) {
      calls = []
      fetchFn = (async (input: string | URL | Request) => {
        calls.push(String(input))
        return new Response('{}', { status })
      }) as typeof fetch
      await fire()
      await settle()
      expect(calls).toHaveLength(expected)
    }
  })

  it('hết lượt thử vẫn hụt: ghi lại nguyên nhân thật Server trả về (lệch giờ VPS → bad_time) để trang quản lý hiển thị', async () => {
    serverSkew = 1000 // VPS lệch giờ > 300 giây: Server từ chối chữ ký
    await fire()
    await settle()
    const s = (await overview()).servers.find((x) => x.id === sid)
    expect(s?.last_push).toMatchObject({ ok: false, tries: 1, status: 401, error: 'bad_time' })
    expect((await state()).signals).toHaveLength(0)
  })

  it('VPS chưa báo địa chỉ tunnel: không gọi ra ngoài, ghi no_url', async () => {
    await tunnel(null)
    calls = []
    await fire()
    await settle()
    expect(calls).toHaveLength(0)
    expect((await overview()).servers.find((x) => x.id === sid)?.last_push).toMatchObject({ ok: false, tries: 0, error: 'no_url' })
  })
})

describe('Worker chủ động quét lại (Cron mỗi phút)', () => {
  it('đẩy hụt lúc webhook, sau đó tunnel sống lại: cron giao ngay mà không đợi VPS kéo bù', async () => {
    vpsUp = false
    await fire()
    await settle()
    expect((await state()).signals).toHaveLength(0)
    vpsUp = true
    now += 30
    expect(await flushPending(env, toVps, now, [0])).toBe(1)
    const st = await state()
    expect(st.signals).toHaveLength(1)
    // đã đánh dấu giao: lượt cron sau không đẩy lại, và VPS kéo bù cũng không còn gì
    calls = []
    expect(await flushPending(env, toVps, now + 60, [0])).toBe(0)
    expect(calls).toHaveLength(0)
  })

  it('bỏ qua tín hiệu quá mới (đường đẩy chính còn đang thử) và quá cũ (EA cũng bỏ qua)', async () => {
    vpsUp = false
    await fire()
    await settle()
    vpsUp = true
    calls = []
    expect(await flushPending(env, toVps, now + 5, [0])).toBe(0) // < 20 giây
    expect(await flushPending(env, toVps, now + 400, [0])).toBe(0) // > 170 giây
    expect(calls).toHaveLength(0)
  })

  it('không có SYNC_KEY thì cron không làm gì', async () => {
    expect(await flushPending({ DB: env.DB }, toVps, now + 30)).toBe(0)
  })
})

describe('Nút “Đo độ trễ” Worker → VPS', () => {
  const probe = (cookie = admin) => send('POST', `/api/servers/${sid}/probe`, undefined, cookie)

  it('đo 5 lần bằng đường đẩy thật (có ký HMAC), trả min/avg/max, giờ VPS và xác nhận khóa đúng; không tạo tín hiệu', async () => {
    const r = await j(await probe())
    expect(r).toMatchObject({ ok: true, verified: true, sent: 5, received: 5, skew: 0, origin: VPS })
    expect(r.samples).toHaveLength(5)
    expect(typeof r.min).toBe('number')
    expect(r.min).toBeLessThanOrEqual(r.avg)
    expect(r.avg).toBeLessThanOrEqual(r.max)
    expect(calls.filter((c) => c.endsWith('/api/ping'))).toHaveLength(5)
    expect((await state()).signals).toHaveLength(0)
    const rows = env.DB.raw.prepare('SELECT COUNT(*) AS c FROM signals').get()
    expect(rows).toEqual({ c: 0 })
  })

  it('bấm liên tiếp bị giãn cách (429), qua vài giây đo lại được', async () => {
    expect((await probe()).status).toBe(200)
    const again = await probe()
    expect(again.status).toBe(429)
    expect((await j(again)).error).toBe('too_fast')
    now += 6
    expect((await probe()).status).toBe(200)
  })

  it('VPS lệch giờ: báo bad_time và dừng ngay (không đo thừa 5 lần)', async () => {
    serverSkew = 1000
    const r = await j(await probe())
    expect(r.ok).toBe(false)
    expect(r.sent).toBe(1)
    expect(r.samples[0]).toMatchObject({ status: 401, error: 'bad_time' })
  })

  it('lệch giờ nhẹ (trong 300 giây): vẫn đo được và cho biết độ lệch', async () => {
    serverSkew = 90
    const r = await j(await probe())
    expect(r).toMatchObject({ ok: true, received: 5 })
    expect(r.skew).toBe(90)
  })

  it('tunnel sập: hai lần đầu hụt thì dừng sớm và báo network', async () => {
    vpsUp = false
    const r = await j(await probe())
    expect(r.ok).toBe(false)
    expect(r.sent).toBe(2)
    expect(r.samples.every((x: { error: string }) => x.error === 'network')).toBe(true)
  })

  it('VPS chưa báo địa chỉ tunnel: báo no_url, không gọi ra ngoài', async () => {
    await tunnel(null)
    calls = []
    const r = await j(await probe())
    expect(r).toMatchObject({ ok: false, error: 'no_url' })
    expect(calls).toHaveLength(0)
  })

  it('Server bản cũ (chưa có /api/ping): đo tạm bằng /api/health và nói rõ chưa kiểm được khóa/giờ', async () => {
    fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/api/ping')) return new Response('{"error":"not_found"}', { status: 404 })
      return toVps(input, init)
    }) as typeof fetch
    const r = await j(await probe())
    expect(r).toMatchObject({ ok: true, verified: false, received: 5, skew: null })
  })

  it('User khác không đo được VPS của người khác; chưa đăng nhập thì 401', async () => {
    const u = await j(await send('POST', '/api/users', { username: 'bob' }, admin))
    const first = await send('POST', '/api/login', { username: 'bob', password: u.password })
    const tmp = (first.headers.get('set-cookie') ?? '').split(';')[0] as string
    await send('POST', '/api/password', { current: u.password, next: 'bob-new-pass-123' }, tmp)
    const l = await send('POST', '/api/login', { username: 'bob', password: 'bob-new-pass-123' })
    const bob = (l.headers.get('set-cookie') ?? '').split(';')[0] as string
    expect((await probe(bob)).status).toBe(404)
    expect((await send('POST', `/api/servers/${sid}/probe`)).status).toBe(401)
  })
})

describe('Tự chữa khi Worker giữ địa chỉ tunnel cũ/đã chết (HTTP 530)', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  const codeOf = async () => decodeConnectCode((await j(await send('GET', `/api/servers/${sid}/code`, undefined, admin))).code as string)
  const storedUrl = () => (env.DB.raw.prepare('SELECT url FROM servers WHERE id = ?').get(sid) as { url: string | null }).url
  const mkSync = async (pollSec: number) => {
    const code = await codeOf()
    const toWorker = (async (input: string | URL | Request, init?: RequestInit) => call(String(input).slice(WORKER.length), init)) as typeof fetch
    return new WorkerSync({ workerUrl: WORKER, syncKey: code?.key ?? '', serverId: sid, pollSec, log: quiet, ingest: app.ingestFromWorker, fetchFn: toWorker, clock: () => now })
  }

  it('Worker giữ địa chỉ chết, VPS có địa chỉ thật: lần kéo kế tiếp Server tự báo lại, không đợi 5 phút', async () => {
    const sync = await mkSync(300)
    sync.setPublicUrl(VPS)
    await new Promise((r) => setTimeout(r, 50))
    expect(storedUrl()).toBe(VPS)
    env.DB.raw.prepare("UPDATE servers SET url = 'https://chet.trycloudflare.com' WHERE id = ?").run(sid) // địa chỉ cũ đã chết
    expect(await sync.pullOnce()).toBe(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(storedUrl()).toBe(VPS)
  })

  it('VPS không còn tunnel (desired = null) mà Worker vẫn giữ địa chỉ cũ: Server báo “không có” để Worker thôi đẩy vào tunnel chết', async () => {
    const sync = await mkSync(300)
    sync.setPublicUrl(null)
    await new Promise((r) => setTimeout(r, 50))
    env.DB.raw.prepare("UPDATE servers SET url = 'https://chet.trycloudflare.com' WHERE id = ?").run(sid)
    await sync.pullOnce()
    await new Promise((r) => setTimeout(r, 50))
    expect(storedUrl()).toBeNull()
  })

  it('Server không bật Quick Tunnel/địa chỉ công khai: Runtime báo null lên Worker thay vì để địa chỉ cũ nằm mãi', async () => {
    const seen: (string | null)[] = []
    const fake = { setPublicUrl: (u: string | null) => seen.push(u), tick: async () => true, start() {}, stop() {}, lastPollOk: 1, lastError: '' } as unknown as WorkerSync
    const rt = new Runtime(baseCfg({ syncKey: 'k'.repeat(32), workerUrl: WORKER, serverId: sid, quickTunnel: false, publicUrl: '' }), { log: quiet, ingest: app.ingestFromWorker, makeSync: () => fake })
    await rt.apply()
    expect(seen).toEqual([null])
  })

  it('đẩy đang hụt → Worker gợi ý kéo mỗi 30 giây; khỏe lại thì thôi gợi ý; Server không bao giờ kéo thưa hơn cấu hình', async () => {
    const pull = async () => j(await call('/api/pull', { headers: { authorization: `Bearer ${(await codeOf())?.key}`, 'x-ocean-server': sid } }))
    expect((await pull()).poll).toBeUndefined() // có địa chỉ, chưa có lần đẩy hụt nào
    serverSkew = 1000
    await fire()
    await settle() // đẩy hụt: bad_time
    expect(await pull()).toMatchObject({ poll: 30, tunnel: VPS })
    const sync = await mkSync(300)
    await sync.pullOnce()
    expect(sync.effectivePollSec()).toBe(30)
    const fast = await mkSync(5)
    await fast.pullOnce()
    expect(fast.effectivePollSec()).toBe(5)
    // khỏe lại
    serverSkew = 0
    now += 20
    await fire()
    await settle()
    expect((await pull()).poll).toBeUndefined()
    await sync.pullOnce()
    expect(sync.effectivePollSec()).toBe(300)
  })

  it('Worker chưa có địa chỉ để đẩy → gợi ý kéo dày ngay', async () => {
    await tunnel(null)
    const r = await j(await call('/api/pull', { headers: { authorization: `Bearer ${(await codeOf())?.key}`, 'x-ocean-server': sid } }))
    expect(r).toMatchObject({ poll: 30, tunnel: null })
  })
})

describe('Server kéo dày khi tunnel rớt (không phụ thuộc Worker đã cập nhật hay chưa)', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  it('mất địa chỉ công khai: kéo NGAY và chuyển sang nhịp 30 giây; có địa chỉ lại thì về chu kỳ cấu hình', async () => {
    const code = decodeConnectCode((await j(await send('GET', `/api/servers/${sid}/code`, undefined, admin))).code as string)
    let pulls = 0
    const toWorker = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input).slice(WORKER.length)
      if (u === '/api/pull') pulls++
      return call(u, init)
    }) as typeof fetch
    const sync = new WorkerSync({ workerUrl: WORKER, syncKey: code?.key ?? '', serverId: sid, pollSec: 300, log: quiet, ingest: app.ingestFromWorker, fetchFn: toWorker, clock: () => now })
    sync.start(false) // nhịp đầu chờ cả chu kỳ: chỉ có thể kéo sớm nếu Server chủ động
    sync.setPublicUrl(VPS)
    await new Promise((r) => setTimeout(r, 60))
    expect(sync.effectivePollSec()).toBe(300)
    const before = pulls
    sync.setPublicUrl(null) // tunnel rớt
    await new Promise((r) => setTimeout(r, 100))
    expect(pulls).toBeGreaterThan(before)
    expect(sync.effectivePollSec()).toBe(30)
    sync.setPublicUrl(VPS) // tunnel mới thông
    await new Promise((r) => setTimeout(r, 60))
    expect(sync.effectivePollSec()).toBe(300)
    sync.stop()
  })
})

describe('Server báo địa chỉ tunnel lên Worker: lỗi thì tự thử lại, không đợi nhịp kéo 300 giây', () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} }
  it('lần báo đầu hụt (mạng/HTTP 5xx) → thử lại sau vài giây tới khi Worker nhận; không bao giờ có hai lần báo chồng nhau', async () => {
    const code = decodeConnectCode((await j(await send('GET', `/api/servers/${sid}/code`, undefined, admin))).code as string)
    let tunnelPosts = 0
    let inflight = 0
    let maxInflight = 0
    const toWorker = (async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input).slice(WORKER.length)
      if (u === '/api/tunnel') {
        tunnelPosts++
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        await new Promise((r) => setTimeout(r, 5))
        inflight--
        if (tunnelPosts === 1) throw new Error('fetch failed')
        if (tunnelPosts === 2) return new Response('bad gateway', { status: 502 })
      }
      return call(u, init)
    }) as typeof fetch
    const sync = new WorkerSync({ workerUrl: WORKER, syncKey: code?.key ?? '', serverId: sid, pollSec: 300, log: quiet, ingest: app.ingestFromWorker, fetchFn: toWorker, clock: () => now, reportRetrySec: [0.02] })
    sync.start(false) // nhịp kéo kế tiếp ở 300 giây nữa: chỉ có thể thành công nếu tự thử lại
    sync.setPublicUrl(VPS)
    sync.setPublicUrl(VPS)
    for (let i = 0; i < 100 && tunnelPosts < 3; i++) await new Promise((r) => setTimeout(r, 20))
    await new Promise((r) => setTimeout(r, 60))
    expect(tunnelPosts).toBe(3) // hụt, hụt, rồi được
    expect(maxInflight).toBe(1)
    const r = await j(await call('/api/pull', { headers: { authorization: `Bearer ${code?.key}`, 'x-ocean-server': sid } }))
    expect(r).toMatchObject({ tunnel: VPS })
    sync.stop()
  })
})
