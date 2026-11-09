import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { ConfigError, loadConfig, type ServerConfig } from '../src/server/config'
import { Runtime } from '../src/server/runtime'
import { SetupController } from '../src/server/setup'
import { mergeSettings, normalizeSettings, readSettings, writeSettings } from '../src/server/settings'
import { WorkerSync } from '../src/server/worker-sync'
import { deriveServerKey, encodeConnectCode } from '../src/shared/connect'
import { EA_KEY, SYNC_KEY, baseCfg, fakeD1 } from './helpers'
import { handle as workerHandle, type Env } from '../worker/src/handler'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const WORKER = 'https://worker.test'
const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'

const codeFor = async (id = 'user-one', master = SYNC_KEY) => encodeConnectCode({ workerUrl: WORKER, serverId: id, key: await deriveServerKey(master, id) })

describe('settings: kiểm tra dữ liệu người dùng nhập', () => {
  it('mã kết nối: chấp nhận mã dán kèm khoảng trắng/nháy, từ chối mã hỏng', async () => {
    const code = await codeFor()
    const ok = normalizeSettings({ connectCode: `  "${code.slice(0, 20)}\n${code.slice(20)}"  ` })
    expect(ok).toMatchObject({ ok: true, value: { connectCode: code } })
    expect(normalizeSettings({ connectCode: 'ocean1.hong' })).toMatchObject({ ok: false })
    expect(normalizeSettings({ connectCode: 'abc' })).toMatchObject({ ok: false })
    expect(normalizeSettings({ connectCode: '' })).toMatchObject({ ok: true, value: { connectCode: '' } })
  })
  it('tài khoản MT5: chỉ số 3-12 chữ số, bỏ trùng, nhận chuỗi hoặc mảng', () => {
    expect(normalizeSettings({ accounts: '900001, 900002;900001' })).toMatchObject({ ok: true, value: { accounts: ['900001', '900002'] } })
    expect(normalizeSettings({ accounts: ['12'] })).toMatchObject({ ok: false })
    expect(normalizeSettings({ accounts: 'abc123' })).toMatchObject({ ok: false })
  })
  it('symbol map và khung giờ: dạng đúng, ALL = tất cả, null = xóa cài đặt', () => {
    expect(normalizeSettings({ symbolMap: 'xauusd=GOLD, EURUSD=EURUSDm' })).toMatchObject({ ok: true, value: { symbolMap: { XAUUSD: 'GOLD', EURUSD: 'EURUSDm' } } })
    expect(normalizeSettings({ symbolMap: 'XAUUSD' })).toMatchObject({ ok: false })
    expect(normalizeSettings({ symbolMap: 'A B=C' })).toMatchObject({ ok: false })
    expect(normalizeSettings({ tfs: 'm3, M15,h1' })).toMatchObject({ ok: true, value: { tfs: ['M3', 'M15', 'H1'] } })
    expect(normalizeSettings({ tfs: 'ALL' })).toMatchObject({ ok: true, value: { tfs: [] } })
    expect(normalizeSettings({ tfs: 'M7' })).toMatchObject({ ok: false })
    expect(normalizeSettings({ tfs: null, symbolMap: null })).toMatchObject({ ok: true, remove: ['symbolMap', 'tfs'] })
    expect(normalizeSettings('x')).toMatchObject({ ok: false })
  })
  it('trường vắng mặt thì giữ nguyên khi gộp', () => {
    const cur = { accounts: ['900001'], tfs: ['M3'] }
    expect(mergeSettings(cur, { accounts: ['900002'] }, [])).toEqual({ accounts: ['900002'], tfs: ['M3'] })
    expect(mergeSettings(cur, {}, ['tfs'])).toEqual({ accounts: ['900001'] })
  })
})

describe('settings: tệp và cấu hình', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-set-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('ghi rồi đọc lại; tệp thiếu hoặc hỏng thì coi như chưa cài đặt (không ném)', () => {
    const f = path.join(dir, 'settings.json')
    expect(readSettings(f)).toEqual({})
    writeFileSync(f, '{hỏng')
    expect(readSettings(f)).toEqual({})
    writeSettings(f, { accounts: ['900001'], tfs: ['M3'] })
    expect(readSettings(f)).toEqual({ accounts: ['900001'], tfs: ['M3'] })
    expect(readFileSync(f, 'utf8').endsWith('\n')).toBe(true)
  })
  it('tệp có BOM (sửa bằng Notepad) vẫn đọc được; giá trị sai dạng bị bỏ', () => {
    const f = path.join(dir, 'settings.json')
    writeFileSync(f, `\uFEFF${JSON.stringify({ accounts: ['900001'] })}`)
    expect(readSettings(f)).toEqual({ accounts: ['900001'] })
    writeFileSync(f, JSON.stringify({ accounts: ['x'] }))
    expect(readSettings(f)).toEqual({})
  })
  it('mã kết nối từ giao diện thắng OCEAN_WORKER_URL/SYNC_KEY đặt tay; "" là ngắt Worker', async () => {
    const env = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir, OCEAN_WORKER_URL: 'https://old.workers.dev', OCEAN_SYNC_KEY: 'a'.repeat(32) }
    expect(loadConfig(env).workerUrl).toBe('https://old.workers.dev')
    const c = loadConfig(env, { connectCode: await codeFor('user-one') })
    expect(c).toMatchObject({ workerUrl: WORKER, serverId: 'user-one' })
    expect(loadConfig(env, { connectCode: '' }).workerUrl).toBe('')
  })
  it('Server đời cũ (không có Server ID) vẫn cấu hình được; ID sai dạng thì báo lỗi rõ', () => {
    const w = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir, OCEAN_WORKER_URL: 'https://w.workers.dev', OCEAN_SYNC_KEY: 'a'.repeat(32) }
    expect(loadConfig(w).serverId).toBe('')
    expect(() => loadConfig({ ...w, OCEAN_SERVER_ID: 'Sai ID!' })).toThrow(ConfigError)
  })
})

/** Gọi HTTP thô để đặt được Host/Origin/header tùy ý (fetch của trình duyệt không cho). */
function raw(base: string, method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; json: any }> {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: url, method, headers: { host: `127.0.0.1:${u.port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8')
        resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : null })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

describe('trang Cài đặt: API, bảo mật và áp dụng ngay', () => {
  let dir = ''
  let app: App
  let base = ''
  let cfg: ServerConfig
  let runtime: Runtime
  let applied = 0
  let workerEnv: Env & { DB: ReturnType<typeof fakeD1> }
  let now = 3_000_000
  const J = { 'content-type': 'application/json', 'x-ocean-setup': '1' }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-api-'))
    now = 3_000_000
    applied = 0
    workerEnv = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), SYNC_KEY, WEBHOOK_KEY: 'webhook-key-1234567890' }
    const toWorker = (async (input: string | URL | Request, init?: RequestInit) =>
      workerHandle(new Request(String(input), init), workerEnv, { waitUntil() {} }, { now: () => now })) as typeof fetch
    const env = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir }
    cfg = loadConfig(env)
    cfg.dbFile = ':memory:'
    cfg.port = 0
    cfg.uiDir = 'ui'
    cfg.webhookKey = ''
    let ctl: SetupController
    app = createApp(cfg, {
      clock: () => now,
      workerStatus: () => ({ lastPollOk: runtime.sync?.lastPollOk ?? 0, lastError: runtime.sync?.lastError ?? '', pulled: 0 }),
      get setup() {
        return ctl
      },
    })
    runtime = new Runtime(cfg, {
      log: quiet,
      ingest: app.ingestFromWorker,
      fetchFn: toWorker,
      makeSync: (o) => new WorkerSync({ ...o, clock: () => now }),
    })
    ctl = new SetupController({
      cfg,
      env,
      log: quiet,
      apply: async () => {
        applied++
        return runtime.apply()
      },
    })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
  })
  afterEach(() => {
    runtime.stop()
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('chưa cài đặt: GET /api/setup báo chưa kết nối, /api/info báo cần cài đặt', async () => {
    const r = await raw(base, 'GET', '/api/setup')
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ connected: false, source: 'none', accounts: [] })
    expect((await raw(base, 'GET', '/api/info')).json).toMatchObject({ local: true, needsSetup: true })
  })

  it('chỉ máy cục bộ: đi qua tunnel (cf-connecting-ip), Host lạ hoặc Origin lạ đều bị 403', async () => {
    const port = new URL(base).port
    expect((await raw(base, 'GET', '/api/setup', { 'cf-connecting-ip': '1.2.3.4' })).status).toBe(403)
    expect((await raw(base, 'GET', '/api/setup', { 'x-forwarded-for': '1.2.3.4' })).status).toBe(403)
    expect((await raw(base, 'GET', '/api/setup', { host: 'abc.trycloudflare.com' })).status).toBe(403)
    expect((await raw(base, 'GET', '/api/setup', { host: `evil.com:${port}` })).status).toBe(403)
    expect((await raw(base, 'POST', '/api/setup', { ...J, origin: 'https://evil.com' }, '{}')).status).toBe(403)
    // Người xem từ xa vẫn xem được giao diện nhưng không thấy nút Cài đặt.
    expect((await raw(base, 'GET', '/api/info', { 'cf-connecting-ip': '1.2.3.4' })).json).toMatchObject({ local: false })
  })

  it('POST cần header x-ocean-setup và JSON (chống trang web lạ gọi lén)', async () => {
    expect((await raw(base, 'POST', '/api/setup', { 'content-type': 'application/json' }, '{}')).status).toBe(400)
    expect((await raw(base, 'POST', '/api/setup', { 'content-type': 'text/plain', 'x-ocean-setup': '1' }, '{}')).status).toBe(400)
    expect((await raw(base, 'POST', '/api/setup', J, 'không phải json')).status).toBe(400)
    expect(applied).toBe(0)
  })

  it('mã sai bị từ chối, không ghi tệp, không đổi cấu hình đang chạy', async () => {
    const r = await raw(base, 'POST', '/api/setup', J, JSON.stringify({ connectCode: 'ocean1.hong', accounts: '900001' }))
    expect(r.status).toBe(400)
    expect(r.json).toMatchObject({ ok: false })
    expect(r.json.error).toContain('Mã kết nối')
    expect(readSettings(cfg.settingsFile)).toEqual({})
    expect(cfg.accounts).toEqual([])
    expect(applied).toBe(0)
  })

  it('dán mã đúng: lưu, áp dụng ngay, Server đăng ký với Worker và báo đã kết nối', async () => {
    const code = await codeFor('user-one')
    const r = await raw(base, 'POST', '/api/setup', J, JSON.stringify({ connectCode: code, accounts: '900001, 900002' }))
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ ok: true, worker: { ok: true, error: '' }, view: { connected: true, serverId: 'user-one', accounts: ['900001', '900002'], source: 'ui' } })
    // Không lộ mã hay khóa ra ngoài.
    expect(JSON.stringify(r.json)).not.toContain(code)
    expect(JSON.stringify(r.json)).not.toContain(await deriveServerKey(SYNC_KEY, 'user-one'))
    // Đã áp dụng vào cfg đang chạy (không cần khởi động lại) và lưu xuống đĩa.
    expect(cfg).toMatchObject({ workerUrl: WORKER, serverId: 'user-one', accounts: ['900001', '900002'] })
    expect(readSettings(cfg.settingsFile)).toMatchObject({ connectCode: code, accounts: ['900001', '900002'] })
    // Worker đã biết Server này sau lần liên lạc đầu.
    expect(await workerEnv.DB.prepare("SELECT id FROM servers WHERE id = 'user-one'").first()).toEqual({ id: 'user-one' })
    // Khởi động lại Server (đọc settings.json) cho ra cùng cấu hình.
    expect(loadConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir }, readSettings(cfg.settingsFile))).toMatchObject({ workerUrl: WORKER, serverId: 'user-one' })
  })

  it('mã của Worker khác khóa (bị thu hồi / sai) → lưu được nhưng báo rõ lỗi 401', async () => {
    const r = await raw(base, 'POST', '/api/setup', J, JSON.stringify({ connectCode: await codeFor('user-one', 'khoa-goc-khac-0123456789abcdef0123456789') }))
    expect(r.status).toBe(200)
    expect(r.json.worker.ok).toBe(false)
    expect(r.json.worker.error).toContain('401')
  })

  it('đổi tài khoản MT5 có hiệu lực ngay cho Gateway; "Ngắt kết nối" dừng đồng bộ Worker', async () => {
    await raw(base, 'POST', '/api/setup', J, JSON.stringify({ connectCode: await codeFor(), accounts: '900001' }))
    const ping = (login: string) => raw(base, 'POST', '/api/gw/ping', { authorization: `Bearer ${EA_KEY}`, 'content-type': 'application/json' }, JSON.stringify({ tid: `${login}@Demo`, login }))
    expect((await ping('900001')).status).toBe(200)
    expect((await ping('900009')).status).toBe(403)
    await raw(base, 'POST', '/api/setup', J, JSON.stringify({ accounts: '900009' }))
    expect((await ping('900009')).status).toBe(200)
    expect((await ping('900001')).status).toBe(403)
    const off = await raw(base, 'POST', '/api/setup', J, JSON.stringify({ connectCode: '' }))
    expect(off.json).toMatchObject({ ok: true, worker: null, view: { connected: false } })
    expect(runtime.sync).toBeNull()
    expect(cfg.workerUrl).toBe('')
  })

  it('symbol map + khung giờ đặt trên giao diện được Gateway nhận qua ping, null thì quay về gateway.env', async () => {
    const gw = new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: ['M15'], symbolMap: { XAUUSD: 'ENV_GOLD' }, timeoutMs: 1500 }, fetch, () => now)
    const ea = 'login=900001\nserver=Demo\nbal=1\neq=1\nver=0.1.0\nacks='
    await raw(base, 'POST', '/api/setup', J, JSON.stringify({ symbolMap: 'XAUUSD=GOLD', tfs: 'M3' }))
    await gw.handlePing(ea) // ping đầu: Server gửi cấu hình xuống
    expect(gw.tfs).toEqual(['M3'])
    expect(gw.symbolMap).toEqual({ XAUUSD: 'GOLD' })
    // Tín hiệu M3 đi qua và được đổi tên theo cấu hình giao diện.
    const wh = loadConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir, OCEAN_WEBHOOK_KEY: 'webhook-key-1234567890' })
    cfg.webhookKey = wh.webhookKey
    await raw(base, 'POST', '/webhook?key=webhook-key-1234567890', { 'content-type': 'text/plain' }, SELL)
    expect((await gw.handlePing(ea)).text).toMatch(/^OK\nS\|1\|sell\|GOLD\|M3\|/)
    await raw(base, 'POST', '/api/setup', J, JSON.stringify({ symbolMap: null, tfs: null }))
    await gw.handlePing(ea)
    expect(gw.tfs).toEqual(['M15'])
    expect(gw.symbolMap).toEqual({ XAUUSD: 'ENV_GOLD' })
  })

  it('Gateway bỏ qua cấu hình sai dạng, giữ cấu hình cũ', async () => {
    const gw = new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: ['H1'], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
    const fake = (async () => new Response(JSON.stringify({ now, signals: [], config: { tfs: 'M3', symbolMap: [1, 2] } }), { status: 200 })) as typeof fetch
    const gw2 = new Gateway(gw.cfg, fake, () => now)
    await gw2.handlePing('login=900001\nserver=Demo')
    expect(gw2.tfs).toEqual(['H1'])
    expect(gw2.symbolMap).toEqual({})
  })
})
