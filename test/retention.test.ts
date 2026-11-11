import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway'
import { type App, createApp } from '../src/server/app'
import { loadConfig } from '../src/server/config'
import { RetentionJob, isDue, lastRetention, lastSlot, purgeNow } from '../src/server/retention'
import { normalizeSettings } from '../src/server/settings'
import { parseAlert } from '../src/shared/parse'
import { EA_KEY, baseCfg } from './helpers'

const SELL =
  'OCEAN VIP by Duong | SELL ENTRY | XAUUSD | M3 | Entry: 4118.000 | SL: 4125.970 | TP1 40%: 4111.624 | TP2 80%: 4105.248 | TP3 100%: 4102.060'
const DAY = 86400
const NOW = 2_000_000_000

let app: App
let base = ''
let now = NOW

const add = (ageSec: number, raw = SELL) => {
  const r = app.store.insertSignal(parseAlert(raw), raw, null, now - ageSec, 0)
  if (!('id' in r)) throw new Error('trùng')
  return r.id
}
const ids = () => (app.store.db.prepare('SELECT id FROM signals ORDER BY id').all() as { id: number }[]).map((x) => x.id)
const dels = () => (app.store.db.prepare('SELECT COUNT(*) AS c FROM deliveries').get() as { c: number }).c

const purge = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/signals/purge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ocean-setup': '1', ...headers },
    body: JSON.stringify(body),
  })

beforeEach(async () => {
  now = NOW
  app = createApp(baseCfg(), { clock: () => now })
  await new Promise<void>((r) => app.server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`
})
afterEach(() => app.close())

describe('xóa tín hiệu đã xong (Store)', () => {
  it('older: xóa tín hiệu cũ hơn N ngày kèm bản ghi giao nhận, giữ tín hiệu mới', () => {
    const old = add(3 * DAY)
    const mid = add(1 * DAY)
    const fresh = add(10)
    app.store.ack('t1', old, 'opened:3', now)
    app.store.ack('t1', mid, 'opened:3', now)
    app.store.ack('t1', fresh, 'received', now)
    const r = app.store.purgeSignals({ kind: 'older', days: 2 }, now, 180)
    expect(r.deleted).toBe(1)
    expect(ids()).toEqual([mid, fresh])
    expect(dels()).toBe(2) // bản ghi giao nhận của tín hiệu đã xóa cũng mất
  })
  it('all: xóa mọi tín hiệu đã xong nhưng KHÔNG đụng tín hiệu còn trong cửa sổ giao cho EA', () => {
    add(5 * DAY)
    add(3600)
    const live = add(100) // 100 giây: còn hạn (maxAge 120)
    const r = app.store.purgeSignals({ kind: 'all' }, now, 180)
    expect(r.deleted).toBe(2)
    expect(r.kept_fresh).toBe(1)
    expect(ids()).toEqual([live])
  })
  it('older cũng không bao giờ xóa tín hiệu còn hạn dù chọn 0 ngày kiểu cực đoan', () => {
    const live = add(30)
    expect(app.store.purgeSignals({ kind: 'older', days: 0 }, now, 180).deleted).toBe(0)
    expect(ids()).toEqual([live])
  })
})

describe('cron tự xóa', () => {
  it('lastSlot/isDue: đến giờ khi lần dọn gần nhất cũ hơn mốc giờ gần nhất đã qua', () => {
    const slot = lastSlot(NOW, 3)
    expect(slot).toBeLessThanOrEqual(NOW)
    expect(NOW - slot).toBeLessThan(DAY + 3600)
    expect(new Date(slot * 1000).getHours()).toBe(3)
    expect(isDue(NOW, null, 3)).toBe(true)
    expect(isDue(NOW, slot - 10, 3)).toBe(true)
    expect(isDue(NOW, slot + 10, 3)).toBe(false)
  })
  it('tick: xóa tín hiệu cũ hơn retentionDays, mỗi mốc giờ chỉ chạy một lần, ghi nhớ lần dọn', () => {
    const cfg = { maxAgeSec: 120, retentionDays: 7, retentionHour: 3 }
    const job = new RetentionJob(app.store, cfg, () => now)
    add(10 * DAY)
    add(8 * DAY)
    const keep = add(2 * DAY)
    expect(job.tick()).toBe(2)
    expect(ids()).toEqual([keep])
    expect(lastRetention(app.store)).toMatchObject({ at: now, deleted: 2, auto: true })
    add(9 * DAY)
    expect(job.tick()).toBeNull() // cùng mốc giờ: chưa chạy lại
    now += DAY + 60 // sang mốc giờ kế tiếp
    expect(job.tick()).toBe(1)
  })
  it('retentionDays = 0: không tự xóa gì cả', () => {
    const job = new RetentionJob(app.store, { maxAgeSec: 120, retentionDays: 0, retentionHour: 3 }, () => now)
    add(100 * DAY)
    expect(job.tick()).toBeNull()
    expect(ids()).toHaveLength(1)
  })
  it('đổi số ngày lúc đang chạy có hiệu lực ngay (cfg là đối tượng sống)', () => {
    const cfg = { maxAgeSec: 120, retentionDays: 30, retentionHour: 3 }
    const job = new RetentionJob(app.store, cfg, () => now)
    add(10 * DAY)
    expect(job.tick()).toBe(0)
    cfg.retentionDays = 5
    now += DAY + 60
    expect(job.tick()).toBe(1)
  })
  it('purgeNow thủ công ghi auto=false', () => {
    purgeNow(app.store, { maxAgeSec: 120, retentionDays: 7, retentionHour: 3 }, { kind: 'all' }, now, false)
    expect(lastRetention(app.store)?.auto).toBe(false)
  })
})

describe('cài đặt retentionDays', () => {
  it('nhận 0..3650, chuỗi số, null/rỗng = về mặc định; từ chối giá trị sai', () => {
    expect(normalizeSettings({ retentionDays: 14 })).toMatchObject({ ok: true, value: { retentionDays: 14 } })
    expect(normalizeSettings({ retentionDays: '0' })).toMatchObject({ ok: true, value: { retentionDays: 0 } })
    expect(normalizeSettings({ retentionDays: '' })).toMatchObject({ ok: true, remove: ['retentionDays'] })
    expect(normalizeSettings({ retentionDays: null })).toMatchObject({ ok: true, remove: ['retentionDays'] })
    for (const bad of [-1, 3651, 1.5, 'abc', '12 ngày']) expect(normalizeSettings({ retentionDays: bad })).toMatchObject({ ok: false })
  })
  it('loadConfig: mặc định 7 ngày/03:00; cài đặt giao diện thắng env', () => {
    const env = { OCEAN_EA_KEY: EA_KEY, OCEAN_DATA: '.' }
    expect(loadConfig(env)).toMatchObject({ retentionDays: 7, retentionHour: 3 })
    expect(loadConfig({ ...env, OCEAN_RETENTION_DAYS: '30' }).retentionDays).toBe(30)
    expect(loadConfig({ ...env, OCEAN_RETENTION_DAYS: '30' }, { retentionDays: 0 }).retentionDays).toBe(0)
  })
})

describe('POST /api/signals/purge', () => {
  it('từ chính VPS: xóa cũ hơn N ngày và xóa tất cả đã xong; /api/info báo số liệu', async () => {
    add(5 * DAY)
    add(3 * DAY)
    const live = add(20)
    const info0 = (await (await fetch(`${base}/api/info`)).json()) as { retention: { count: number; days: number } | null }
    expect(info0.retention).toMatchObject({ count: 3, days: 7 })

    const a = await purge({ mode: 'older', days: 4 })
    expect(a.status).toBe(200)
    expect(await a.json()).toMatchObject({ ok: true, deleted: 1, count: 2 })
    const b = await purge({ mode: 'all' })
    expect(await b.json()).toMatchObject({ ok: true, deleted: 1, kept_fresh: 1, count: 1 })
    expect(ids()).toEqual([live])
    const info = (await (await fetch(`${base}/api/info`)).json()) as { retention: { lastDeleted: number; lastAuto: boolean } }
    expect(info.retention).toMatchObject({ lastDeleted: 1, lastAuto: false })
  })
  it('chặn: qua tunnel (x-forwarded-for / cf-connecting-ip), thiếu header, sai body, sai method', async () => {
    add(5 * DAY)
    expect((await purge({ mode: 'all' }, { 'x-forwarded-for': '1.2.3.4' })).status).toBe(403)
    expect((await purge({ mode: 'all' }, { 'cf-connecting-ip': '1.2.3.4' })).status).toBe(403)
    expect((await fetch(`${base}/api/signals/purge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"all"}' })).status).toBe(400)
    expect((await purge({ mode: 'older', days: 0 })).status).toBe(400)
    expect((await purge({ mode: 'older', days: 'abc' })).status).toBe(400)
    expect((await purge({ mode: 'xoa-het' })).status).toBe(400)
    expect((await fetch(`${base}/api/signals/purge`)).status).toBe(405)
    expect(ids()).toHaveLength(1) // không có yêu cầu nào lọt qua
  })
  it('người xem từ xa không thấy số liệu dọn log trong /api/info', async () => {
    const r = await fetch(`${base}/api/info`, { headers: { 'x-forwarded-for': '1.2.3.4' } })
    expect(((await r.json()) as { retention: unknown }).retention).toBeNull()
  })
})

describe('Gateway: ack kết quả của EA không bị cắt ở dấu ":" thứ hai', () => {
  it('opened:3, failed:10031, partial:2/3_price_dev đến Server nguyên vẹn', async () => {
    const gw = new Gateway({ port: 0, serverUrl: base, key: EA_KEY, tfs: [], symbolMap: {}, timeoutMs: 1500 }, fetch, () => now)
    const ids3 = [add(10), add(11), add(12)] as number[]
    const body = `login=900001\nserver=Demo\nbal=1\neq=1\nver=0.3.0\nacks=${ids3[0]}:opened:3,${ids3[1]}:failed:10031,${ids3[2]}:partial:2/3_price_dev`
    expect((await gw.handlePing(body)).status).toBe(200)
    const got = app.store.deliveriesFor(ids3).map((d) => `${d.signal_id}=${d.result}`)
    expect(got.sort()).toEqual([`${ids3[0]}=opened:3`, `${ids3[1]}=failed:10031`, `${ids3[2]}=partial:2/3_price_dev`].sort())
  })
})
