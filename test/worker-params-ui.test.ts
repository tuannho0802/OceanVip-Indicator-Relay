import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveServerKey } from '../src/shared/connect'
import { type Env, handle } from '../worker/src/handler'
import { SYNC_KEY, WEBHOOK_KEY, fakeD1 } from './helpers'

/** Form "Tuỳ chỉnh input" trên trang Worker: nhóm Lọc giờ hiện hai thẻ khung + thanh 24 giờ (không còn xếp xen kẽ trong lưới 2 cột). */
const WORKER = 'https://relay.example.workers.dev'
const VPS = 'bot-a21-cabc'
const LOGIN = '6128952'
const windows: { close: () => void }[] = []
afterEach(() => {
  for (const w of windows.splice(0)) w.close()
})
const stubFetch = (async () => new Response('{"ok":true}', { status: 200 })) as typeof fetch
const ctx = { waitUntil: (_p: Promise<unknown>) => {} }

/** Input hiện tại EA báo: khung 1 qua nửa đêm 19:30 → 01:00 (bật), khung 2 07:30 → 08:03 (tắt). */
const SETUP = {
  InpUsePauseFilter: '1', InpFilterTimeSource: '0',
  InpPause1On: '1', InpPause1StartH: '19', InpPause1StartM: '30', InpPause1EndH: '1', InpPause1EndM: '0',
  InpPause2On: '0', InpPause2StartH: '7', InpPause2StartM: '30', InpPause2EndH: '8', InpPause2EndM: '3',
}

async function seed() {
  const env: Env & { DB: ReturnType<typeof fakeD1> } = { DB: fakeD1(readFileSync('worker/schema.sql', 'utf8')), WEBHOOK_KEY, SYNC_KEY, ADMIN_PASSWORD: 'admin-initial-pass' }
  const api = async (method: string, path: string, body?: unknown, cookie = '') => {
    const r = await handle(new Request(`${WORKER}${path}`, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }), env, ctx, { fetchFn: stubFetch })
    return { r, j: (await r.json().catch(() => ({}))) as Record<string, any> }
  }
  const first = await api('POST', '/api/login', { username: 'admin', password: 'admin-initial-pass' })
  const admin = (first.r.headers.get('set-cookie') ?? '').split(';')[0] as string
  await api('POST', '/api/password', { current: 'admin-initial-pass', next: 'admin-real-pass-9' }, admin)
  const key = await deriveServerKey(SYNC_KEY, VPS)
  const rep = await handle(
    new Request(`${WORKER}/api/accounts`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'x-ocean-server': VPS }, body: JSON.stringify({ accounts: [{ login: LOGIN, broker: 'Demo', enabled: true, rev: 0, params_rev: 0, ea_rev: 0, setup: SETUP }] }) }),
    env, ctx, { fetchFn: stubFetch },
  )
  expect(rep.status).toBe(200)
  return { env, api, admin }
}

async function open(env: Env) {
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
  const until = async (cond: () => boolean, what: string) => {
    for (let i = 0; i < 200; i++) {
      if (cond()) return
      await new Promise((r) => setTimeout(r, 15))
    }
    throw new Error(`Chờ quá lâu: ${what}\n${(doc.body.textContent ?? '').slice(0, 500)}`)
  }
  const form = (name: string) => doc.querySelector(`form[data-form="${name}"]`) as HTMLFormElement
  const login = async () => {
    await until(() => !!form('login'), 'form đăng nhập')
    ;(form('login').elements.namedItem('username') as HTMLInputElement).value = 'admin'
    ;(form('login').elements.namedItem('password') as HTMLInputElement).value = 'admin-real-pass-9'
    form('login').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
    await until(() => !form('login'), 'đã đăng nhập')
  }
  const openParams = async () => {
    await login()
    ;(doc.querySelector('button[data-act="tab"][data-v="ea"]') as HTMLElement).click()
    await until(() => !!doc.querySelector('button[data-act="eaParams"]'), 'nút Tuỳ chỉnh input')
    ;(doc.querySelector('button[data-act="eaParams"]') as HTMLElement).click()
    await until(() => !!form('eaParamsSave'), 'form input')
    // nhóm Lọc giờ mặc định gập (chỉ nhóm đầu mở): mở ra để xem
    ;(doc.querySelector('details.pg[data-g="Lọc giờ"]') as HTMLDetailsElement).open = true
  }
  const ctl = (name: string) => form('eaParamsSave').elements.namedItem(name) as HTMLInputElement
  const type = (name: string, v: string) => {
    ctl(name).value = v
    ctl(name).dispatchEvent(new w.Event('input', { bubbles: true }))
  }
  const toggle = (name: string, on: boolean) => {
    ctl(name).checked = on
    ctl(name).dispatchEvent(new w.Event('change', { bubbles: true }))
  }
  const segs = (n: number) => [...doc.querySelectorAll(`.tl-bar[data-n="${n}"] i`)].map((i) => ({ left: Number.parseFloat((i as HTMLElement).style.left), width: Number.parseFloat((i as HTMLElement).style.width) }))
  const desc = (n: number) => doc.querySelector(`.pt[data-n="${n}"] [data-role="desc"]`)?.textContent ?? ''
  const submit = () => form('eaParamsSave').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }))
  return { doc, until, form, openParams, ctl, type, toggle, segs, desc, submit }
}

const approx = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01)

/** Chờ bộ ghi đè của tài khoản trong D1 thoả điều kiện (form gửi bất đồng bộ) rồi trả về. */
async function overrides(env: Env & { DB: ReturnType<typeof fakeD1> }, ok: (v: Record<string, number>) => boolean) {
  let v: Record<string, number> = {}
  for (let i = 0; i < 200; i++) {
    const r = (await env.DB.prepare('SELECT vals FROM account_params WHERE login = ?').bind(LOGIN).first()) as { vals: string } | null
    v = r ? (JSON.parse(r.vals) as Record<string, number>) : {}
    if (ok(v)) return v
    await new Promise((x) => setTimeout(x, 15))
  }
  return v
}

describe('form input EA: nhóm Lọc giờ', () => {
  it('hai khung thành hai thẻ riêng (mỗi thẻ đủ 5 ô), công tắc chính + nguồn giờ nằm ở hàng thường phía trên', async () => {
    const { env } = await seed()
    const a = await open(env)
    await a.openParams()
    const cards = [...a.doc.querySelectorAll('.pt')] as HTMLElement[]
    expect(cards.map((c) => c.getAttribute('data-n'))).toEqual(['1', '2'])
    for (const [i, c] of cards.entries()) {
      const names = [...c.querySelectorAll('[name]')].map((e) => e.getAttribute('name')).sort()
      const n = i + 1
      expect(names).toEqual([`InpPause${n}EndH`, `InpPause${n}EndM`, `InpPause${n}On`, `InpPause${n}StartH`, `InpPause${n}StartM`])
    }
    // 10 ô của hai khung không còn lẫn trong lưới hàng thường; hai input chung vẫn ở đó
    const gridNames = [...a.doc.querySelectorAll('details.pg[data-g="Lọc giờ"] .pgrid [name]')].map((e) => e.getAttribute('name'))
    expect(gridNames.sort()).toEqual(['InpFilterTimeSource', 'InpUsePauseFilter'])
    // hiển thị đúng giá trị EA đang dùng
    expect(a.ctl('InpPause1StartH').value).toBe('19')
    expect(a.ctl('InpPause1StartM').value).toBe('30')
    expect(a.ctl('InpPause1EndH').value).toBe('1')
    expect(a.ctl('InpPause2StartH').value).toBe('7')
    expect(a.ctl('InpPause1On').checked).toBe(true)
    expect(a.ctl('InpPause2On').checked).toBe(false)
  })

  it('thanh 24 giờ: khung 1 qua nửa đêm vẽ 2 đoạn, khung 2 đang tắt không vẽ; mô tả đúng', async () => {
    const { env } = await seed()
    const a = await open(env)
    await a.openParams()
    const s1 = a.segs(1)
    expect(s1).toHaveLength(2)
    approx(s1[0]!.left, (19 * 60 + 30) / 14.4) // 19:30 → hết ngày
    approx(s1[0]!.left + s1[0]!.width, 100)
    approx(s1[1]!.left, 0) // 00:00 → 01:00
    approx(s1[1]!.width, 60 / 14.4)
    expect(a.desc(1)).toContain('19:30 → 01:00')
    expect(a.desc(1)).toContain('qua nửa đêm')
    expect(a.segs(2)).toHaveLength(0)
    expect(a.desc(2)).toContain('đang tắt')
    expect(a.doc.querySelector('.pt[data-n="2"]')?.classList.contains('off')).toBe(true)
  })

  it('đổi giờ/bật khung: thẻ và thanh cập nhật ngay khi gõ, chưa cần lưu', async () => {
    const { env } = await seed()
    const a = await open(env)
    await a.openParams()
    a.toggle('InpPause2On', true)
    expect(a.segs(2)).toHaveLength(1) // 07:30 → 08:03 trong ngày
    expect(a.desc(2)).toContain('trong ngày')
    a.type('InpPause2EndH', '7')
    a.type('InpPause2EndM', '30')
    expect(a.segs(2)).toHaveLength(0) // bắt đầu trùng kết thúc
    expect(a.desc(2)).toContain('không có tác dụng')
    a.type('InpPause1EndH', '')
    expect(a.desc(1)).toContain('Nhập đủ')
    expect(a.segs(1)).toHaveLength(0)
    a.toggle('InpUsePauseFilter', false)
    expect(a.doc.querySelector('.pfw')?.classList.contains('off')).toBe(true) // tắt lọc giờ: cả khối mờ đi
  })

  it('lưu chỉ gửi ô đã đổi (đổi giờ khung 1 → đúng 1 khóa), và thẻ được đánh dấu chưa lưu', async () => {
    const { env } = await seed()
    const a = await open(env)
    await a.openParams()
    a.type('InpPause1StartH', '20')
    expect(a.doc.querySelector('.pt[data-n="1"]')?.classList.contains('tc')).toBe(true)
    expect(a.doc.querySelector('.pt[data-n="2"]')?.classList.contains('tc')).toBe(false)
    a.submit()
    expect(await overrides(env, (v) => Object.keys(v).length > 0)).toEqual({ InpPause1StartH: 20 })
    const row = (await env.DB.prepare('SELECT rev FROM account_params WHERE login = ?').bind(LOGIN).first()) as { rev: number }
    expect(row.rev).toBe(1)
  })

  it('đã ghi đè: ô viền xanh, nút ↺ ở thẻ bỏ ghi đè đúng các khóa của khung đó (không đụng khung kia)', async () => {
    const { env, api, admin } = await seed()
    const put = await api('PUT', `/api/ea/${VPS}/accounts/${LOGIN}/params`, { values: { InpPause1StartH: 20, InpPause1On: false, InpPause2StartH: 6 } }, admin)
    expect(put.r.status).toBe(200)
    const a = await open(env)
    await a.openParams()
    expect(a.doc.querySelector('.pt[data-n="1"]')?.classList.contains('ov')).toBe(true)
    expect(a.ctl('InpPause1StartH').classList.contains('ov')).toBe(true)
    expect(a.ctl('InpPause1StartM').classList.contains('ov')).toBe(false)
    const rs1 = a.doc.querySelector('.pt[data-n="1"] button[data-act="eaParamReset"]') as HTMLElement
    expect(rs1.getAttribute('data-key')?.split(',').sort()).toEqual(['InpPause1On', 'InpPause1StartH'])
    rs1.click()
    // khung 1 về input của EA, khung 2 giữ nguyên
    expect(await overrides(env, (v) => !('InpPause1StartH' in v))).toEqual({ InpPause2StartH: 6 })
  })
})
