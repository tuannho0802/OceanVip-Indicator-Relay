import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../src/server/app'
import { SetupController } from '../src/server/setup'
import { readSettings } from '../src/server/settings'
import { deriveServerKey, encodeConnectCode } from '../src/shared/connect'
import { EA_KEY, SYNC_KEY, baseCfg } from './helpers'

let dir = ''
let app: App
let base = ''
const windows: { close: () => void }[] = []
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-uiset-'))
  const cfg = baseCfg({ settingsFile: path.join(dir, 'settings.json'), webhookKey: '' }) // chưa có Worker lẫn webhook trực tiếp = vừa cài xong
  const ctl = new SetupController({
    cfg,
    env: { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir },
    log: { debug() {}, info() {}, warn() {}, error() {} },
    apply: async () => ({ ok: true, error: '' }),
  })
  app = createApp(cfg, { setup: ctl })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
  app.close()
  rmSync(dir, { recursive: true, force: true })
})

async function open(hash: string, extraHeaders: Record<string, string> = {}) {
  const html = readFileSync('ui/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `${base}/${hash}`, pretendToBeVisual: true })
  const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void; confirm: () => boolean }
  w.fetch = ((u: string, o: RequestInit = {}) => fetch(`${base}${u}`, { ...o, headers: { ...(o.headers as Record<string, string>), ...extraHeaders } })) as typeof fetch
  w.eval(readFileSync('ui/app.js', 'utf8'))
  w.eval(readFileSync('ui/setup.js', 'utf8'))
  await sleep(500)
  windows.push(w)
  return dom.window.document
}

describe('trang Cài đặt trên giao diện', () => {
  it('chạy lần đầu (chưa có mã): tự mở trang Cài đặt, có mục trạng thái và hướng dẫn MT5', async () => {
    const doc = await open('')
    expect(doc.defaultView?.location.hash).toBe('#setup')
    expect(doc.getElementById('setupView')?.hidden).toBe(false)
    expect(doc.getElementById('app')?.hidden).toBe(true)
    expect(doc.getElementById('checks')?.textContent).toContain('Chưa kết nối Worker')
    expect(doc.getElementById('codeCurrent')?.textContent).toContain('Chưa kết nối')
    expect(doc.getElementById('setupView')?.textContent).toContain('Allow WebRequest')
  })

  it('dán mã + tài khoản rồi Lưu: hiện thông báo thành công, lưu xuống tệp, ô mã được xóa', async () => {
    const doc = await open('#setup')
    const code = encodeConnectCode({ workerUrl: 'https://worker.test', serverId: 'user-one', key: await deriveServerKey(SYNC_KEY, 'user-one') })
    ;(doc.getElementById('fCode') as HTMLInputElement).value = code
    ;(doc.getElementById('fAccounts') as HTMLInputElement).value = '900001, 900002'
    ;(doc.getElementById('btnSave') as HTMLButtonElement).click()
    await sleep(500)
    expect(doc.getElementById('setupMsg')?.textContent).toContain('Đã lưu và kết nối Worker thành công')
    expect((doc.getElementById('fCode') as HTMLInputElement).value).toBe('')
    expect(readSettings(path.join(dir, 'settings.json'))).toMatchObject({ connectCode: code, accounts: ['900001', '900002'] })
    expect(doc.getElementById('codeCurrent')?.textContent).toContain('user-one')
    expect(doc.getElementById('btnDisc')?.hidden).toBe(false)
  })

  it('mã sai: hiện lỗi dễ hiểu, không lưu gì', async () => {
    const doc = await open('#setup')
    ;(doc.getElementById('fCode') as HTMLInputElement).value = 'ocean1.hong'
    ;(doc.getElementById('btnSave') as HTMLButtonElement).click()
    await sleep(400)
    const m = doc.getElementById('setupMsg')
    expect(m?.textContent).toContain('Mã kết nối không đúng')
    expect(m?.className).toContain('bad')
    expect(readSettings(path.join(dir, 'settings.json'))).toEqual({})
  })

  it('xem từ xa (qua tunnel): không có nút Cài đặt, không vào được trang Cài đặt dù gõ #setup', async () => {
    const doc = await open('#setup', { 'cf-connecting-ip': '8.8.8.8' })
    expect(doc.getElementById('setupBtn')?.hidden).toBe(true)
    expect(doc.getElementById('setupView')?.hidden).toBe(true)
    expect(doc.getElementById('app')?.hidden).toBe(false)
    expect(doc.getElementById('banner')?.hidden).toBe(true)
  })
  it('cổng Gateway: mặc định 47860 (không phải 47800), địa chỉ cho MT5 ghi đúng cổng', async () => {
    const doc = await open('#setup')
    const f = doc.getElementById('fPort') as HTMLInputElement
    expect(f.value).toBe('')
    expect(f.placeholder).toContain('47860')
    expect(doc.getElementById('gwUrl')?.textContent).toBe('http://127.0.0.1:47860')
    expect(doc.querySelector('.steps')?.textContent).not.toContain('47800')
    expect(doc.getElementById('setupView')?.textContent).toContain('InpGateway')
  })

  it('đổi cổng Gateway: lưu xuống tệp, địa chỉ MT5 đổi theo, nhắc làm lại bước MT5; để trống = mặc định', async () => {
    const doc = await open('#setup')
    const f = doc.getElementById('fPort') as HTMLInputElement
    f.value = '47901'
    ;(doc.getElementById('btnSave') as HTMLButtonElement).click()
    await sleep(500)
    expect(readSettings(path.join(dir, 'settings.json')).gatewayPort).toBe(47901)
    expect(doc.getElementById('gwUrl')?.textContent).toBe('http://127.0.0.1:47901')
    expect(f.value).toBe('47901')
    expect((doc.getElementById('adv') as HTMLDetailsElement).open).toBe(true)
    const m = doc.getElementById('setupMsg')?.textContent ?? ''
    expect(m).toContain('Cổng Gateway đã đổi sang 47901')
    expect(m).toContain('Allow WebRequest')
    // Để trống: quay về mặc định.
    f.value = ''
    ;(doc.getElementById('btnSave') as HTMLButtonElement).click()
    await sleep(500)
    expect(readSettings(path.join(dir, 'settings.json')).gatewayPort).toBeUndefined()
    expect(doc.getElementById('gwUrl')?.textContent).toBe('http://127.0.0.1:47860')
  })

  it('cổng sai: hiện lỗi dễ hiểu, không lưu gì', async () => {
    const doc = await open('#setup')
    ;(doc.getElementById('fPort') as HTMLInputElement).value = '80'
    ;(doc.getElementById('btnSave') as HTMLButtonElement).click()
    await sleep(400)
    const m = doc.getElementById('setupMsg')
    expect(m?.textContent).toContain('Cổng Gateway phải là số nguyên từ 1024')
    expect(m?.className).toContain('bad')
    expect(readSettings(path.join(dir, 'settings.json'))).toEqual({})
  })

  it('nút \"Trùng cổng? Đổi cổng\" mở mục Nâng cao và đưa con trỏ vào ô cổng', async () => {
    const doc = await open('#setup')
    expect((doc.getElementById('adv') as HTMLDetailsElement).open).toBe(false)
    ;(doc.getElementById('btnPortFocus') as HTMLButtonElement).click()
    expect((doc.getElementById('adv') as HTMLDetailsElement).open).toBe(true)
    expect(doc.activeElement?.id).toBe('fPort')
  })

  it('mục Trạng thái: Gateway chưa báo / đang nghe đúng cổng / không mở được cổng (bị chiếm)', async () => {
    const report = (b: unknown) => fetch(`${base}/api/gw/config`, { method: 'POST', headers: { authorization: `Bearer ${EA_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(b) })
    let doc = await open('#setup')
    expect(doc.getElementById('checks')?.textContent).toContain('Chưa thấy Gateway báo về')
    await report({ port: 47860, error: '' })
    doc = await open('#setup')
    expect(doc.getElementById('checks')?.textContent).toContain('Gateway đang nghe cổng 47860')
    await report({ port: 0, error: 'Cổng 47860 đang bị chương trình khác dùng' })
    doc = await open('#setup')
    const t = doc.getElementById('checks')?.textContent ?? ''
    expect(t).toContain('Gateway chưa mở được cổng 47860')
    expect(t).toContain('đang bị chương trình khác dùng')
    expect(doc.querySelector('#checks li.bad')).not.toBeNull()
  })
})
