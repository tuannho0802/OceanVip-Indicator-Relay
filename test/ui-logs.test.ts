import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type App, createApp } from '../src/server/app'
import { SetupController } from '../src/server/setup'
import { parseAlert } from '../src/shared/parse'
import { EA_KEY, baseCfg } from './helpers'

const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let dir = ''
let app: App
let base = ''
const windows: { close: () => void }[] = []

beforeEach(async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'ocean-uilog-'))
  const cfg = baseCfg({ settingsFile: path.join(dir, 'settings.json') })
  const ctl = new SetupController({ cfg, env: { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: dir }, log: { debug() {}, info() {}, warn() {}, error() {} }, apply: async () => null })
  app = createApp(cfg, { setup: ctl })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
  app.close()
  rmSync(dir, { recursive: true, force: true })
})

const nowSec = () => Math.floor(Date.now() / 1000)
const add = (ageSec: number) => app.store.insertSignal(parseAlert(SELL), SELL, null, nowSec() - ageSec, 0)
const count = () => app.store.signalStats().count

async function open(extraHeaders: Record<string, string> = {}, confirmAnswer = true) {
  const html = readFileSync('ui/index.html', 'utf8').replace(/<script[^>]*><\/script>/g, '')
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: `${base}/`, pretendToBeVisual: true })
  const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void; confirm: () => boolean }
  w.fetch = ((u: string, o: RequestInit = {}) => fetch(`${base}${u}`, { ...o, headers: { ...(o.headers as Record<string, string>), ...extraHeaders } })) as typeof fetch
  w.confirm = () => confirmAnswer
  w.eval(readFileSync('ui/app.js', 'utf8'))
  w.eval(readFileSync('ui/setup.js', 'utf8'))
  await sleep(500)
  windows.push(w)
  return dom.window.document
}
const click = (doc: Document, id: string) => (doc.getElementById(id) as HTMLButtonElement).click()

describe('nút xóa log tín hiệu trên giao diện', () => {
  it('xem từ chính VPS: hiện số tín hiệu + lịch tự xóa; "Xóa tất cả đã xong" xóa tín hiệu cũ, giữ tín hiệu còn hạn', async () => {
    add(5 * 86400)
    add(3 * 86400)
    add(10)
    const doc = await open()
    expect(doc.getElementById('logTools')?.hidden).toBe(false)
    expect(doc.getElementById('logInfo')?.textContent).toContain('Đang lưu 3 tín hiệu')
    expect(doc.getElementById('logInfo')?.textContent).toContain('tự xóa sau 7 ngày')
    click(doc, 'btnPurgeAll')
    await sleep(700)
    expect(count()).toBe(1)
    expect(doc.getElementById('logMsg')?.textContent).toContain('Đã xóa 2 tín hiệu')
    expect(doc.getElementById('logMsg')?.textContent).toContain('giữ lại 1')
  })
  it('"Xóa cũ hơn N ngày" chỉ xóa phần cũ; số ngày sai thì báo lỗi, không gọi Server', async () => {
    add(5 * 86400)
    add(3 * 86400)
    add(2 * 86400)
    const doc = await open()
    ;(doc.getElementById('purgeDays') as HTMLInputElement).value = '4'
    click(doc, 'btnPurgeN')
    await sleep(700)
    expect(count()).toBe(2)
    ;(doc.getElementById('purgeDays') as HTMLInputElement).value = '0'
    click(doc, 'btnPurgeN')
    await sleep(200)
    expect(doc.getElementById('logMsg')?.textContent).toContain('1 đến 3650')
    expect(count()).toBe(2)
  })
  it('bấm Hủy ở hộp xác nhận thì không xóa gì', async () => {
    add(5 * 86400)
    const doc = await open({}, false)
    click(doc, 'btnPurgeAll')
    await sleep(300)
    expect(count()).toBe(1)
  })
  it('xem từ xa (qua tunnel): không có thanh dọn log', async () => {
    add(5 * 86400)
    const doc = await open({ 'x-forwarded-for': '1.2.3.4' })
    expect(doc.getElementById('logTools')?.hidden).toBe(true)
  })
  it('trang Cài đặt có ô số ngày tự xóa: lưu 14 rồi để trống về mặc định', async () => {
    const doc = await open()
    doc.defaultView?.eval("location.hash='#setup'")
    await sleep(300)
    const f = doc.getElementById('fRet') as HTMLInputElement
    expect(f.placeholder).toContain('7')
    f.value = '14'
    click(doc, 'btnSave')
    await sleep(600)
    expect(f.value).toBe('14')
    f.value = ''
    click(doc, 'btnSave')
    await sleep(600)
    expect(f.value).toBe('')
  })
})
