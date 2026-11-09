import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { EA_KEY, WEBHOOK_KEY, baseCfg } from './helpers'

const SELL =
    'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'

let app: App
let base = ''
let now = 4_000_000
beforeEach(async () => {
    now = 4_000_000
    app = createApp(baseCfg({ workerUrl: 'https://ocean-relay.example.workers.dev', syncKey: 'k'.repeat(40) }), { clock: () => now, workerStatus: () => ({ lastPollOk: now - 5, lastError: '', pulled: 0 }) })
    await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
const windows: { close: () => void }[] = []
afterEach(() => {
    // Đóng cửa sổ jsdom SAU khi đã kiểm tra: close() xóa sạch DOM nên không được gọi trong render().
    for (const w of windows.splice(0)) w.close()
    app.close()
})

async function render(): Promise<Document> {
    const dom = new JSDOM(readFileSync('ui/index.html', 'utf8').replace(/<script[^>]*><\/script>/, ''), { runScripts: 'outside-only', url: `${base}/` })
    const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void }
    w.fetch = ((u: string, o?: RequestInit) => fetch(`${base}${u}`, o)) as typeof fetch
    w.eval(readFileSync('ui/app.js', 'utf8'))
    await new Promise((r) => setTimeout(r, 400))
    windows.push(w)
    return dom.window.document
}

describe('giao diện công khai (không đăng nhập)', () => {
    it('mở thẳng là thấy tín hiệu và terminal; không có ô đăng nhập/token', async () => {
        const gw = new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
        await gw.handlePing('login=900001\nserver=Demo\nbal=1000\neq=1005\nver=0.1.0\npos=555001,XAUUSD,buy,0.10,4100,4092,4116,12.5')
        await fetch(`${base}/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body: SELL })
        const doc = await render()
        const text = doc.body.textContent ?? ''
        expect(text).toContain('SELL ENTRY')
        expect(text).toContain('XAUUSD')
        expect(text).toContain('4,118')
        expect(text).toContain('•••001')
        expect(text).not.toContain('900001')
        expect(text).toContain('Worker: thông')
        expect(doc.querySelector('input[type=password]')).toBeNull()
        expect(doc.getElementById('conn')?.textContent).toBe('kết nối tốt')
    })

    it('body lạ chứa HTML chỉ hiện như chữ, không tạo phần tử (không XSS)', async () => {
        await fetch(`${base}/webhook?key=${WEBHOOK_KEY}`, { method: 'POST', body: '<img src=x onerror=alert(1)> | <script>alert(2)</script>' })
        const doc = await render()
        expect(doc.querySelector('img')).toBeNull()
        expect(doc.querySelector('main script')).toBeNull()
        expect(doc.body.textContent).toContain('<img src=x onerror=alert(1)>')
    })
})