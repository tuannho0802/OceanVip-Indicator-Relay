import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../src/server/app'
import { SetupController } from '../src/server/setup'
import type { TunnelStatus } from '../src/server/tunnel'
import { EA_KEY, SYNC_KEY, baseCfg } from './helpers'

/** Giao diện Server luôn hiện đúng tunnel đang chạy: đang tạo → thông (địa chỉ) → rớt (địa chỉ cũ chết) → địa chỉ MỚI, tự cập nhật, không cần F5. */
let dir = ''
let app: App
let base = ''
let st: TunnelStatus
const windows: { close: () => void }[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const status = (o: Partial<TunnelStatus>): TunnelStatus => ({ state: 'starting', url: null, lastUrl: null, since: Date.now(), restarts: 0, error: '', checkedAt: 0, rttMs: null, connections: 0, ...o })

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-tunui-'))
  st = status({})
  const cfg = baseCfg({ settingsFile: path.join(dir, 'settings.json'), workerUrl: 'https://relay.example.workers.dev', syncKey: SYNC_KEY, serverId: 'bot-a21-cabc', quickTunnel: true })
  const ctl = new SetupController({ cfg, env: { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir }, log: { debug() {}, info() {}, warn() {}, error() {} }, apply: async () => ({ ok: true, error: '' }) })
  app = createApp(cfg, { setup: ctl, tunnelUrl: () => st.url, tunnelStatus: () => st })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
  app.close()
  rmSync(dir, { recursive: true, force: true })
})

async function open(hash: string) {
  const html = readFileSync('ui/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `${base}/${hash}`, pretendToBeVisual: true })
  const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void }
  w.fetch = ((u: string, o: RequestInit = {}) => fetch(`${base}${u}`, o)) as typeof fetch
  w.eval(readFileSync('ui/app.js', 'utf8'))
  w.eval(readFileSync('ui/setup.js', 'utf8'))
  windows.push(w)
  const doc = dom.window.document
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 400; i++) {
      if (cond()) return
      await sleep(15)
    }
    throw new Error(`Chờ quá lâu: ${what}\n${doc.getElementById('checks')?.textContent}`)
  }
  return { doc, until, checks: () => doc.getElementById('checks')?.textContent ?? '', pill: () => doc.getElementById('tunnel') as HTMLElement }
}

describe('Server: trạng thái tunnel trên API và giao diện', () => {
  it('/api/info có mục tunnel; baseUrl chỉ là địa chỉ ĐÃ thông (đang tạo hoặc đã rớt thì null)', async () => {
    const info = async () => (await (await fetch(`${base}/api/info`)).json()) as { baseUrl: string | null; tunnel: Record<string, unknown> | null }
    st = status({ state: 'connecting', lastUrl: 'https://new-aaa.trycloudflare.com' })
    expect(await info()).toMatchObject({ baseUrl: null, tunnel: { state: 'connecting', url: null, lastUrl: 'https://new-aaa.trycloudflare.com' } })
    st = status({ state: 'ok', url: 'https://new-aaa.trycloudflare.com', lastUrl: 'https://new-aaa.trycloudflare.com', checkedAt: Date.now() - 3000, rttMs: 85, connections: 4 })
    expect(await info()).toMatchObject({ baseUrl: 'https://new-aaa.trycloudflare.com', tunnel: { state: 'ok', rttMs: 85, connections: 4, checkedAgoSec: 3 } })
    st = status({ state: 'down', lastUrl: 'https://new-aaa.trycloudflare.com', error: 'HTTP 530 từ Cloudflare', restarts: 2 })
    expect(await info()).toMatchObject({ baseUrl: null, tunnel: { state: 'down', restarts: 2 } })
  })

  it('đã có địa chỉ công khai cố định (Named Tunnel): không có mục tunnel', async () => {
    app.close()
    const cfg = baseCfg({ publicUrl: 'https://relay.example.com', workerUrl: 'https://relay.example.workers.dev', syncKey: SYNC_KEY, serverId: 'bot-a21-cabc' })
    app = createApp(cfg, { tunnelStatus: () => st })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
    const info = (await (await fetch(`${base}/api/info`)).json()) as { tunnel: unknown; baseUrl: string }
    expect(info).toMatchObject({ tunnel: null, baseUrl: 'https://relay.example.com' })
  })

  it('trang Cài đặt tự đổi theo tunnel: đang tạo → thông → rớt (địa chỉ cũ chết) → địa chỉ MỚI; có nhãn Tunnel ở đầu trang', async () => {
    st = status({ state: 'connecting', lastUrl: 'https://old-bbb.trycloudflare.com' })
    const p = await open('#setup')
    await p.until(() => p.checks().includes('Đang tạo/kiểm tra tunnel'), 'đang tạo')
    expect(p.checks()).not.toContain('Tunnel đang hoạt động')
    await p.until(() => !p.pill().hidden, 'nhãn tunnel')
    expect(p.pill().textContent).toBe('Tunnel: đang tạo…')

    st = status({ state: 'ok', url: 'https://old-bbb.trycloudflare.com', lastUrl: 'https://old-bbb.trycloudflare.com', checkedAt: Date.now(), rttMs: 120 })
    await p.until(() => p.checks().includes('Tunnel đang hoạt động: https://old-bbb.trycloudflare.com'), 'thông')
    expect(p.checks()).toContain('120 ms')
    expect(p.pill().textContent).toBe('Tunnel: thông')
    expect(p.pill().className).toContain('ok')

    st = status({ state: 'down', lastUrl: 'https://old-bbb.trycloudflare.com', error: 'HTTP 530 từ Cloudflare', restarts: 1 })
    await p.until(() => p.checks().includes('Tunnel đã rớt'), 'rớt')
    expect(p.checks()).toContain('https://old-bbb.trycloudflare.com không còn dùng được')
    expect(p.checks()).not.toContain('Tunnel đang hoạt động')
    expect(p.pill().className).toContain('bad')

    st = status({ state: 'ok', url: 'https://new-ccc.trycloudflare.com', lastUrl: 'https://new-ccc.trycloudflare.com', checkedAt: Date.now(), rttMs: 90, restarts: 1 })
    await p.until(() => p.checks().includes('Tunnel đang hoạt động: https://new-ccc.trycloudflare.com'), 'địa chỉ mới')
    expect(p.checks()).not.toContain('old-bbb')
  }, 30_000)
})
