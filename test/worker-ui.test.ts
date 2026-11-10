import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, fakeD1 } from './helpers'

const WORKER = 'https://relay.example.workers.dev'
const windows: { close: () => void }[] = []
afterEach(() => {
    for (const w of windows.splice(0)) w.close()
})

/** Mở trang quản lý thật của Worker trong jsdom; fetch của trang được nối thẳng vào mã Worker (kèm cookie như trình duyệt). */
async function open(env: Env) {
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) }
    const res = await handle(new Request(`${WORKER}/`), env, ctx)
    expect(res.status).toBe(200)
    const page = await res.text()
    const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page)?.[1] ?? ''
    expect(script.length).toBeGreaterThan(1000)
    const dom = new JSDOM(page.replace(/<script[\s\S]*<\/script>/, ''), { runScripts: 'outside-only', url: `${WORKER}/` })
    const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void; confirm: () => boolean; Event: typeof Event; document: Document }
    let cookie = ''
    w.confirm = () => true
    w.fetch = (async (u: string, o: RequestInit = {}) => {
        const r = await handle(new Request(`${WORKER}${u}`, { ...o, headers: { ...(o.headers as object), origin: WORKER, ...(cookie ? { cookie } : {}) } }), env, ctx)
        const sc = r.headers.get('set-cookie')
        if (sc) cookie = sc.split(';')[0] ?? ''
        if (sc && /Max-Age=0/.test(sc)) cookie = ''
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
        throw new Error(`Chờ quá lâu: ${what}\n${doc.body.textContent?.slice(0, 600)}`)
    }
    const text = () => doc.body.textContent ?? ''
    const submit = (form: Element) => form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
    const fill = (form: Element, values: Record<string, string>) => {
        for (const [k, v] of Object.entries(values)) ((form as HTMLFormElement).elements.namedItem(k) as HTMLInputElement).value = v
    }
    const form = (name: string) => doc.querySelector(`form[data-form="${name}"]`) as HTMLFormElement
    const click = (sel: string) => (doc.querySelector(sel) as HTMLElement).click()
    const tab = (name: string) => click(`button[data-act="tab"][data-v="${name}"]`)
    const secretValues = () => [...doc.querySelectorAll('.secret input')].map((i) => (i as HTMLInputElement).value)
    return { doc, until, text, submit, fill, form, click, tab, secretValues, settle: () => Promise.all(pending.splice(0)) }
}

const fresh = (): Env & { DB: ReturnType<typeof fakeD1> } => ({ DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), SYNC_KEY, ADMIN_PASSWORD: 'admin-initial-pass' })

describe('trang quản lý của Worker (giao diện thật)', () => {
    it('Admin tạo tài khoản → User đổi mật khẩu → tự tạo VPS + Webhook URL → copy/dán, trong hạn mức; không XSS', async () => {
        const env = fresh()

        // --- Admin ---
        const a = await open(env)
        await a.until(() => !!a.form('login'), 'form đăng nhập')
        a.fill(a.form('login'), { username: 'admin', password: 'admin-initial-pass' })
        a.submit(a.form('login'))
        await a.until(() => !!a.form('password'), 'bắt đổi mật khẩu lần đầu')
        expect(a.text()).toContain('Đổi mật khẩu để tiếp tục')
        a.fill(a.form('password'), { current: 'admin-initial-pass', next: 'admin-real-pass-9', again: 'admin-real-pass-8' })
        a.submit(a.form('password'))
        await new Promise((r) => setTimeout(r, 80))
        expect(a.text()).toContain('Đổi mật khẩu để tiếp tục') // hai ô không khớp → chưa đổi
        a.fill(a.form('password'), { again: 'admin-real-pass-9' })
        a.submit(a.form('password'))
        await a.until(() => a.text().includes('Người dùng'), 'dashboard Admin')
        a.tab('users')
        await a.until(() => !!a.form('addUser'), 'form tạo tài khoản')
        a.fill(a.form('addUser'), { username: 'nam', max_servers: '1', max_hooks: '1' })
        a.submit(a.form('addUser'))
        await a.until(() => a.secretValues().length === 2, 'hộp mật khẩu tạm')
        const [uname, temp] = a.secretValues() as [string, string]
        expect(uname).toBe('nam')
        expect(temp.length).toBeGreaterThanOrEqual(12)
        expect(a.text()).toContain('chỉ hiện một lần')

        // --- User ---
        const u = await open(env)
        await u.until(() => !!u.form('login'), 'form đăng nhập user')
        u.fill(u.form('login'), { username: 'nam', password: temp })
        u.submit(u.form('login'))
        await u.until(() => !!u.form('password'), 'user bị bắt đổi mật khẩu')
        u.fill(u.form('password'), { current: temp, next: 'nam-new-pass-1', again: 'nam-new-pass-1' })
        u.submit(u.form('password'))
        await u.until(() => !!u.form('addServer'), 'dashboard user')
        expect(u.doc.querySelector('button[data-act="tab"][data-v="users"]')).toBeNull() // User không có tab quản trị
        expect(u.text()).toContain('0/1')

        u.fill(u.form('addServer'), { name: 'VPS nhà' })
        u.submit(u.form('addServer'))
        await u.until(() => u.secretValues().some((v) => v.startsWith('ocean1.')), 'mã kết nối hiện ra')
        expect(u.text()).toContain('#setup')
        await u.until(() => u.text().includes('Chưa kết nối'), 'thẻ VPS')
        expect((u.form('addServer').querySelector('button') as HTMLButtonElement).disabled).toBe(true) // hết hạn mức 1/1
        expect(u.text()).toContain('hết hạn mức')

        u.fill(u.form('addHook'), { name: '<img src=x onerror=alert(1)>' })
        u.submit(u.form('addHook'))
        await u.until(() => u.doc.querySelector('[data-hook]') !== null, 'thẻ Webhook')
        const url = (u.doc.querySelector('[data-hook] input.url') as HTMLInputElement).value
        expect(url).toMatch(new RegExp(`^${WORKER}/webhook\\?key=oh_[A-Za-z0-9_-]{32}$`))
        expect(u.doc.querySelector('img')).toBeNull() // tên chứa HTML chỉ hiện như chữ
        expect(u.text()).toContain('<img src=x onerror=alert(1)>')

        u.click('[data-act="testHook"]')
        await u.settle()
        u.tab('sigs')
        await u.until(() => u.text().includes('OCEAN TEST'), 'tín hiệu thử')
        expect(u.text()).toContain('chưa có VPS') // VPS chưa liên lạc lần nào nên chưa được giao: báo rõ thay vì im lặng

        u.tab('guide')
        await u.until(() => u.text().includes('Sự cố thường gặp'), 'tab hướng dẫn')
        expect(u.text()).toContain('2FA')
        expect(u.text()).toContain('bad_key')
        expect(u.text()).toContain(WORKER)
    })

    it('chưa có Admin: trang đăng nhập hướng dẫn đặt ADMIN_PASSWORD', async () => {
        const env: Env = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), SYNC_KEY }
        const p = await open(env)
        await p.until(() => p.text().includes('ADMIN_PASSWORD'), 'hướng dẫn đặt ADMIN_PASSWORD')
        expect(p.text()).toContain('wrangler secret put ADMIN_PASSWORD')
    })

    it('sai mật khẩu hiện thông báo rõ ràng, không lộ tên đăng nhập có tồn tại hay không', async () => {
        const p = await open(fresh())
        await p.until(() => !!p.form('login'), 'form đăng nhập')
        p.fill(p.form('login'), { username: 'khong-co', password: 'sai-mat-khau' })
        p.submit(p.form('login'))
        await p.until(() => p.text().includes('Sai tên đăng nhập hoặc mật khẩu'), 'thông báo sai mật khẩu')
    })
})