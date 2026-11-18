import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveServerKey } from '../src/shared/connect'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

const WORKER = 'https://relay.example.workers.dev'
const VPS = 'bot-a21-cabc'
const windows: { close: () => void }[] = []
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
})
const stubFetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch

/** Mở trang quản lý thật của Worker trong jsdom (fetch của trang nối thẳng vào mã Worker, kèm cookie như trình duyệt). */
async function open(env: Env) {
  const ctx = { waitUntil: (_p: Promise<unknown>) => {} }
  const deps = { fetchFn: stubFetch }
  const page = await (await handle(new Request(`${WORKER}/`), env, ctx, deps)).text()
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(page)?.[1] ?? ''
  const dom = new JSDOM(page.replace(/<script[\s\S]*<\/script>/, ''), { runScripts: 'outside-only', url: `${WORKER}/` })
  const w = dom.window as unknown as { fetch: typeof fetch; eval: (s: string) => unknown; close: () => void; confirm: () => boolean; Event: typeof Event }
  let cookie = ''
  w.confirm = () => true
  w.fetch = (async (u: string, o: RequestInit = {}) => {
    const r = await handle(new Request(`${WORKER}${u}`, { ...o, headers: { ...(o.headers as object), origin: WORKER, ...(cookie ? { cookie } : {}) } }), env, ctx, deps)
    const sc = r.headers.get('set-cookie')
    if (sc) cookie = sc.split(';')[0] ?? ''
    return r
  }) as typeof fetch
  w.eval(script)
  windows.push(w)
  const doc = dom.window.document
  const text = () => doc.body.textContent ?? ''
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error(`Chờ quá lâu: ${what}\n${text().slice(0, 700)}`)
  }
  const form = (name: string) => doc.querySelector(`form[data-form="${name}"]`) as HTMLFormElement
  const submit = (f: Element) => f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
  const fill = (f: Element, v: Record<string, string>) => {
    for (const [k, x] of Object.entries(v)) ((f as HTMLFormElement).elements.namedItem(k) as HTMLInputElement).value = x
  }
  const tab = (name: string) => (doc.querySelector(`button[data-act="tab"][data-v="${name}"]`) as HTMLElement).click()
  const tick = (el: HTMLInputElement, on: boolean) => {
    el.checked = on
    el.dispatchEvent(new w.Event('change', { bubbles: true }))
  }
  const signIn = async (user: string, pass: string) => {
    await until(() => !!form('login'), 'form đăng nhập')
    fill(form('login'), { username: user, password: pass })
    submit(form('login'))
    await until(() => !form('login'), 'đã đăng nhập')
  }
  const boxes = (sel: string) => [...doc.querySelectorAll(sel)] as HTMLInputElement[]
  return { doc, text, until, form, submit, fill, tab, tick, signIn, boxes }
}

async function seed() {
  const env: Env & { DB: ReturnType<typeof fakeD1> } = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: 'admin-initial-pass' }
  const ctx = { waitUntil: (_p: Promise<unknown>) => {} }
  const api = async (method: string, path: string, body?: unknown, cookie = '') => {
    const r = await handle(new Request(`${WORKER}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx, { fetchFn: stubFetch })
    return { r, j: (await r.json().catch(() => ({}))) as Record<string, any> }
  }
  const cookieOf = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0] as string
  const first = await api('POST', '/api/login', { username: 'admin', password: 'admin-initial-pass' })
  const admin = cookieOf(first.r)
  await api('POST', '/api/password', { current: 'admin-initial-pass', next: 'admin-real-pass-9' }, admin)
  const created = await api('POST', '/api/users', { username: 'nam' }, admin)
  const tmp = created.j.password as string
  const uc = cookieOf((await api('POST', '/api/login', { username: 'nam', password: tmp })).r)
  await api('POST', '/api/password', { current: tmp, next: 'nam-new-pass-1' }, uc)
  const key = await deriveServerKey(SYNC_KEY, VPS)
  const rep = await handle(
    new Request(`${WORKER}/api/accounts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'x-ocean-server': VPS },
      body: JSON.stringify({ accounts: ['6128952', '8033273', '8039504'].map((l) => ({ login: l, broker: 'OEXNLimited-MT5', enabled: true, rev: 0 })) }),
    }),
    env,
    ctx,
    { fetchFn: stubFetch },
  )
  expect(rep.status).toBe(200)
  return env
}

describe('giao diện: Admin giới hạn User chỉ thấy 2/3 tài khoản MT', () => {
  it('cấp một bước (chọn người + tick tài khoản), sửa bằng tick/bỏ tick, rồi User chỉ thấy đúng phần được cấp', async () => {
    const env = await seed()
    const a = await open(env)
    await a.signIn('admin', 'admin-real-pass-9')
    a.tab('ea')
    await a.until(() => !!a.form('eaGrantAdd'), 'form cấp quyền')
    for (const l of ['6128952', '8033273', '8039504']) expect(a.text()).toContain(`#${l}`)

    // Chưa tick tài khoản nào thì không cấp (tránh cấp VPS rỗng gây khó hiểu)
    a.submit(a.form('eaGrantAdd'))
    await a.until(() => (a.doc.getElementById('toast')?.textContent ?? '').includes('ít nhất một'), 'báo phải tick')
    expect(((await env.DB.prepare('SELECT COUNT(*) AS c FROM server_access').first()) as any).c).toBe(0)

    // "Chọn tất cả" bật/tắt cả nhóm
    ;(a.doc.querySelector('[data-act="eaPickAll"]') as HTMLElement).click()
    expect(a.boxes('form[data-form="eaGrantAdd"] input[name="login"]').every((c) => c.checked)).toBe(true)
    ;(a.doc.querySelector('[data-act="eaPickAll"]') as HTMLElement).click()
    expect(a.boxes('form[data-form="eaGrantAdd"] input[name="login"]').some((c) => c.checked)).toBe(false)

    // Tick 2/3 rồi cấp: một lần là xong
    for (const c of a.boxes('form[data-form="eaGrantAdd"] input[name="login"]')) if (c.value !== '8039504') c.checked = true
    a.submit(a.form('eaGrantAdd'))
    await a.until(() => a.text().includes('Thấy 2/3 tài khoản'), 'nhãn 2/3')
    expect(a.form('eaGrantAdd')).toBeNull() // hết người để cấp
    const granted = (await env.DB.prepare('SELECT login FROM account_grants ORDER BY login').all()).results.map((r: any) => r.login)
    expect(granted).toEqual(['6128952', '8033273'])

    // Sửa danh sách ngay ở dòng của User: bỏ 1 → 1/3, tick lại → 2/3
    const mine = () => a.boxes('input[data-change="eaGrant"]')
    a.tick(mine().find((c) => c.getAttribute('data-login') === '8033273') as HTMLInputElement, false)
    await a.until(() => a.text().includes('Thấy 1/3 tài khoản'), 'nhãn 1/3')
    a.tick(mine().find((c) => c.getAttribute('data-login') === '8033273') as HTMLInputElement, true)
    await a.until(() => a.text().includes('Thấy 2/3 tài khoản'), 'nhãn 2/3 lại')
    // Bỏ hết: nhãn cảnh báo chưa chọn gì
    for (const l of ['6128952', '8033273']) {
      a.tick(mine().find((c) => c.getAttribute('data-login') === l) as HTMLInputElement, false)
      await a.until(() => mine().find((c) => c.getAttribute('data-login') === l)?.checked === false && !mine().some((c) => c.disabled), `bỏ ${l}`)
    }
    await a.until(() => a.text().includes('Chưa được chọn tài khoản nào'), 'cảnh báo chưa chọn')
    for (const l of ['6128952', '8033273']) {
      a.tick(mine().find((c) => c.getAttribute('data-login') === l) as HTMLInputElement, true)
      await a.until(() => mine().find((c) => c.getAttribute('data-login') === l)?.checked === true && !mine().some((c) => c.disabled), `tick ${l}`)
    }
    await a.until(() => a.text().includes('Thấy 2/3 tài khoản'), 'nhãn 2/3 cuối')

    // --- User: chỉ thấy 2 tài khoản, bật/tắt được; không có tab quản trị, không lộ tài khoản thứ 3 ---
    const u = await open(env)
    await u.signIn('nam', 'nam-new-pass-1')
    u.tab('ea')
    await u.until(() => u.text().includes('#6128952'), 'User thấy tài khoản được cấp')
    expect(u.text()).toContain('#8033273')
    expect(u.text()).not.toContain('8039504')
    expect(u.doc.querySelector('form[data-form="eaGrantAdd"]')).toBeNull() // User không có công cụ cấp quyền
    expect(u.doc.querySelector('[data-act="eaRevoke"]')).toBeNull()
    const off = u.doc.querySelector('button[data-act="eaToggle"][data-login="6128952"]') as HTMLElement
    off.click()
    await u.until(() => u.text().includes('ĐANG TẮT'), 'tài khoản chuyển sang tắt')
    expect(((await env.DB.prepare("SELECT enabled FROM accounts WHERE login = '6128952'").first()) as any).enabled).toBe(0)
    expect(((await env.DB.prepare("SELECT enabled FROM accounts WHERE login = '8039504'").first()) as any).enabled).toBe(1)
  })
})
