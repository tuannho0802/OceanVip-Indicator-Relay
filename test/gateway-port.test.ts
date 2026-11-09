import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import net, { type AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway, loadGatewayConfig } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { ConfigError, loadConfig, type ServerConfig } from '../src/server/config'
import { SetupController } from '../src/server/setup'
import { normalizeSettings, overlayEnv, readSettings } from '../src/server/settings'
import { DEFAULT_GW_PORT } from '../src/shared/defaults'
import { EA_KEY } from './helpers'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

/** Một cổng đang rảnh (mở rồi đóng ngay). */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as AddressInfo).port
      s.close(() => resolve(p))
    })
  })

/** Chiếm một cổng (giả lập chương trình khác, ví dụ Gateway AZ Sentinel) cho tới khi gọi close. */
const holdPort = (): Promise<{ port: number; close: () => Promise<void> }> =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => resolve({ port: (s.address() as AddressInfo).port, close: () => new Promise<void>((r) => s.close(() => r())) }))
  })

/** Gọi HTTP thô để đặt được header tùy ý. */
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

describe('cổng Gateway: mặc định và kiểm tra dữ liệu', () => {
  it('mặc định 47860, KHÔNG phải 47800 (khỏi đụng Gateway khác cùng VPS)', () => {
    expect(DEFAULT_GW_PORT).toBe(47860)
    expect(DEFAULT_GW_PORT).not.toBe(47800)
    expect(loadGatewayConfig({ OCEAN_SERVER_URL: 'http://127.0.0.1:8090', OCEAN_EA_KEY: EA_KEY }).port).toBe(47860)
    expect(loadConfig({ OCEAN_EA_KEY: EA_KEY }).gatewayPort).toBe(47860)
  })
  it('Gateway: OCEAN_GW_PORT sai bị từ chối, đúng thì dùng', () => {
    const base = { OCEAN_SERVER_URL: 'http://127.0.0.1:8090', OCEAN_EA_KEY: EA_KEY }
    expect(loadGatewayConfig({ ...base, OCEAN_GW_PORT: '47901' }).port).toBe(47901)
    for (const bad of ['80', 'abc', '70000', '47.5']) expect(() => loadGatewayConfig({ ...base, OCEAN_GW_PORT: bad })).toThrow(/OCEAN_GW_PORT/)
  })
  it('settings: nhận số hoặc chuỗi số; trống/null = quay về mặc định; sai thì báo lỗi rõ', () => {
    expect(normalizeSettings({ gatewayPort: 47901 })).toMatchObject({ ok: true, value: { gatewayPort: 47901 } })
    expect(normalizeSettings({ gatewayPort: ' 47901 ' })).toMatchObject({ ok: true, value: { gatewayPort: 47901 } })
    expect(normalizeSettings({ gatewayPort: '' })).toMatchObject({ ok: true, remove: ['gatewayPort'] })
    expect(normalizeSettings({ gatewayPort: null })).toMatchObject({ ok: true, remove: ['gatewayPort'] })
    for (const bad of [80, 1023, 65536, 'abc', '47.5', '1e4', -1, 47901.5, true, {}]) {
      const r = normalizeSettings({ gatewayPort: bad })
      expect(r, String(bad)).toMatchObject({ ok: false })
      if (!r.ok) expect(r.error).toContain('1024')
    }
  })
  it('cổng từ trang Cài đặt thắng OCEAN_GW_PORT; Gateway chỉ bị ép cổng khi đã đặt rõ', () => {
    const env = { OCEAN_EA_KEY: EA_KEY }
    expect(loadConfig(env)).toMatchObject({ gatewayPort: 47860, gatewayPortSet: false })
    expect(loadConfig({ ...env, OCEAN_GW_PORT: '47950' })).toMatchObject({ gatewayPort: 47950, gatewayPortSet: true })
    expect(loadConfig({ ...env, OCEAN_GW_PORT: '47950' }, { gatewayPort: 47901 })).toMatchObject({ gatewayPort: 47901, gatewayPortSet: true })
    expect(overlayEnv(env, { gatewayPort: 47901 }).OCEAN_GW_PORT).toBe('47901')
  })
  it('cổng Gateway không được trùng cổng Server', () => {
    expect(() => loadConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_PORT: '8090' }, { gatewayPort: 8090 })).toThrow(ConfigError)
    expect(() => loadConfig({ OCEAN_EA_KEY: EA_KEY, OCEAN_PORT: '47860' })).toThrow(/trùng/)
  })
})

describe('cổng Gateway: đổi trên trang Cài đặt, Gateway tự chuyển', () => {
  let dir = ''
  let app: App
  let base = ''
  let cfg: ServerConfig
  let gw: Gateway
  let gwDefault = 0
  let now = 5_000_000
  const J = { 'content-type': 'application/json', 'x-ocean-setup': '1' }
  const AUTH = { authorization: `Bearer ${EA_KEY}`, 'content-type': 'application/json' }
  const save = (body: unknown) => raw(base, 'POST', '/api/setup', J, JSON.stringify(body))
  const info = () => raw(base, 'GET', '/api/info')
  /** Một vòng của Gateway như main.ts: hỏi Server → mở/đổi cổng → báo lại nếu có thay đổi. */
  const round = async () => {
    await gw.syncConfig()
    const before = `${gw.listeningPort}|${gw.portError}`
    const ok = await gw.ensureListening()
    if (`${gw.listeningPort}|${gw.portError}` !== before) await gw.syncConfig()
    return ok
  }
  const statusOf = async (port: number) => (await (await fetch(`http://127.0.0.1:${port}/v1/status`)).json()) as { ok: boolean; port: number }

  beforeEach(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-gwport-'))
    now = 5_000_000
    const env = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir }
    cfg = loadConfig(env)
    cfg.dbFile = ':memory:'
    cfg.port = 0
    cfg.uiDir = 'ui'
    cfg.webhookKey = ''
    const ctl = new SetupController({ cfg, env, log: quiet, apply: async () => null })
    app = createApp(cfg, { clock: () => now, setup: ctl })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    gwDefault = await freePort()
    gw = new Gateway({ port: gwDefault, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now, quiet)
  })
  afterEach(() => {
    gw.stop()
    app.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('/api/gw/config cần khóa EA; chưa đặt cổng thì Server không ép cổng (gatewayPort null)', async () => {
    expect((await raw(base, 'POST', '/api/gw/config', { 'content-type': 'application/json' }, '{}')).status).toBe(401)
    expect((await raw(base, 'POST', '/api/gw/config', { authorization: 'Bearer sai-khoa-0123456789abcdefghij', 'content-type': 'application/json' }, '{}')).status).toBe(401)
    expect((await raw(base, 'POST', '/api/gw/config', AUTH, 'không phải json')).status).toBe(400)
    const r = await raw(base, 'POST', '/api/gw/config', AUTH, JSON.stringify({ port: 0, error: '' }))
    expect(r.status).toBe(200)
    expect(r.json.config).toMatchObject({ gatewayPort: null })
  })

  it('chưa đặt cổng trên giao diện: Gateway giữ cổng trong gateway.env của nó', async () => {
    expect(await round()).toBe(true)
    expect(gw.listeningPort).toBe(gwDefault)
    expect((await statusOf(gwDefault)).ok).toBe(true)
  })

  it('đổi cổng ở trang Cài đặt: Gateway chuyển sang cổng mới trong một vòng, cổng cũ đóng', async () => {
    await round()
    expect(gw.listeningPort).toBe(gwDefault)
    const p2 = await freePort()
    const r = await save({ gatewayPort: p2 })
    expect(r.status).toBe(200)
    expect(r.json.view).toMatchObject({ gatewayPort: p2, defaultGatewayPort: 47860 })
    expect(readSettings(cfg.settingsFile).gatewayPort).toBe(p2)
    expect(await round()).toBe(true)
    expect(gw.listeningPort).toBe(p2)
    expect((await statusOf(p2)).port).toBe(p2)
    await expect(fetch(`http://127.0.0.1:${gwDefault}/v1/status`)).rejects.toThrow()
    // Trang Cài đặt thấy Gateway đã nghe đúng cổng, không lỗi.
    expect((await info()).json.gateway).toMatchObject({ port: p2, listening: p2, error: '', lastSeenAgoSec: 0 })
  })

  it('cổng mới đang bị chương trình khác chiếm: giữ cổng cũ, báo lỗi lên trang Cài đặt; đổi cổng khác thì hết lỗi', async () => {
    await round()
    const other = await holdPort() // ví dụ Gateway AZ Sentinel
    try {
      await save({ gatewayPort: other.port })
      expect(await round()).toBe(false)
      expect(gw.listeningPort).toBe(gwDefault) // vẫn phục vụ EA ở cổng cũ
      expect(gw.portError).toContain('đang bị chương trình khác dùng')
      const g = (await info()).json.gateway
      expect(g).toMatchObject({ port: other.port, listening: gwDefault })
      expect(g.error).toContain(String(other.port))
      // Người dùng chọn cổng khác: Gateway chuyển ngay, lỗi biến mất.
      const p3 = await freePort()
      await save({ gatewayPort: p3 })
      expect(await round()).toBe(true)
      expect(gw.portError).toBe('')
      expect((await info()).json.gateway).toMatchObject({ port: p3, listening: p3, error: '' })
    } finally {
      await other.close()
    }
  })

  it('cổng bị chiếm lúc khởi động: Gateway không chết, báo lỗi và tự nghe được khi cổng rảnh', async () => {
    const other = await holdPort()
    gw.stop()
    gw = new Gateway({ port: other.port, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now, quiet)
    expect(await round()).toBe(false)
    expect(gw.listeningPort).toBe(0)
    expect((await info()).json.gateway).toMatchObject({ listening: 0 })
    expect((await info()).json.gateway.error).toContain('đang bị chương trình khác dùng')
    await other.close()
    expect(await round()).toBe(true)
    expect(gw.listeningPort).toBe(other.port)
  })

  it('bỏ cổng đã đặt (để trống): Gateway quay về cổng trong gateway.env', async () => {
    const p2 = await freePort()
    await save({ gatewayPort: p2 })
    await round()
    expect(gw.listeningPort).toBe(p2)
    const r = await save({ gatewayPort: null })
    expect(r.json.view).toMatchObject({ gatewayPort: 47860 })
    expect(readSettings(cfg.settingsFile).gatewayPort).toBeUndefined()
    await round()
    expect(gw.listeningPort).toBe(gwDefault)
  })

  it('cổng sai bị từ chối ngay, không ghi tệp, không đổi cấu hình đang chạy', async () => {
    for (const bad of [80, 'abc', 70000]) {
      const r = await save({ gatewayPort: bad })
      expect(r.status).toBe(400)
      expect(r.json.error).toContain('1024')
    }
    expect(readSettings(cfg.settingsFile)).toEqual({})
    expect(cfg.gatewayPort).toBe(47860)
  })

  it('cổng Gateway trùng cổng Server bị từ chối với lời nhắn rõ', async () => {
    const r = await save({ gatewayPort: 8090 }) // OCEAN_PORT mặc định 8090
    expect(r.status).toBe(400)
    expect(r.json.error).toContain('trùng cổng Server')
    expect(readSettings(cfg.settingsFile)).toEqual({})
  })

  it('người xem từ xa (qua tunnel) không thấy cổng Gateway cục bộ', async () => {
    await raw(base, 'POST', '/api/gw/config', AUTH, JSON.stringify({ port: 47860, error: '' }))
    expect((await raw(base, 'GET', '/api/info', { 'cf-connecting-ip': '8.8.8.8' })).json.gateway).toBeNull()
    expect((await info()).json.gateway).toMatchObject({ listening: 47860 })
  })

  it('Server chưa đặt cổng, Gateway tự chọn cổng khác (do bộ cài dò): trang Cài đặt hiện đúng cổng thật', async () => {
    expect(await round()).toBe(true)
    const g = (await info()).json.gateway
    expect(g).toMatchObject({ port: gwDefault, listening: gwDefault, error: '' })
  })

  it('Gateway cũ chưa báo về: giao diện biết là chưa thấy (listening null)', async () => {
    expect((await info()).json.gateway).toMatchObject({ listening: null, lastSeenAgoSec: null })
  })
})
