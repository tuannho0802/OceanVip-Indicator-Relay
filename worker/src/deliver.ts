import { deriveServerKey } from '../../src/shared/connect'
import { signBody } from '../../src/shared/hmac'
import type { Ctx, Env } from './handler'

/** Lưu tín hiệu vào hàng đợi D1 rồi đẩy về các VPS được giao. Dùng chung cho webhook thật và nút "Gửi thử". */

const PUSH_TIMEOUT_MS = 4000
/** VPS kéo bù mỗi 30 giây (giãn tối đa 120 giây khi lỗi): quá 150 giây không thấy gì là coi như mất liên lạc. */
export const ONLINE_SEC = 150

export const normalizeOrigin = (u: string | undefined | null): string | null => {
    const v = (u ?? '').trim().replace(/\/+$/, '')
    return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(v) ? v : null
}

/** Khóa của một Server: Server đời cũ (id rỗng) dùng thẳng khóa gốc, Server mới dùng khóa riêng suy ra từ id. */
export const serverKey = (env: Env, id: string): Promise<string> => (id === '' ? Promise.resolve(env.SYNC_KEY ?? '') : deriveServerKey(env.SYNC_KEY ?? '', id))

export async function serverOrigin(env: Env, id: string): Promise<string | null> {
    const row = await env.DB.prepare('SELECT url FROM servers WHERE id = ?').bind(id).first<{ url: string | null }>()
    return normalizeOrigin(row?.url) ?? (id === '' ? normalizeOrigin(env.VPS_ORIGIN) : null)
}

/** VPS đang được phép nhận tín hiệu: bản thân không bị khóa và chủ (nếu có) không bị khóa. `s` là bí danh của bảng servers. */
const ACTIVE = 's.locked = 0 AND (s.owner IS NULL OR NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.owner AND u.locked = 1))'

/** Webhook của một User: chỉ giao cho VPS của chính User đó (hoặc đúng một VPS nếu Webhook gắn với VPS). */
export async function hookTargets(env: Env, hook: { owner: number; server: string | null }): Promise<string[]> {
    const sql = `SELECT s.id FROM servers s WHERE s.owner = ? AND ${ACTIVE}${hook.server ? ' AND s.id = ?' : ''}`
    const st = env.DB.prepare(sql)
    return (await (hook.server ? st.bind(hook.owner, hook.server) : st.bind(hook.owner)).all<{ id: string }>()).results.map((r) => r.id)
}

/** Khóa chung WEBHOOK_KEY (đời cũ): giao cho mọi VPS của Admin và VPS đời cũ, KHÔNG giao cho VPS của User. */
export async function broadcastTargets(env: Env): Promise<string[]> {
    const sql = `SELECT s.id FROM servers s WHERE ${ACTIVE} AND (s.owner IS NULL OR s.owner IN (SELECT id FROM users WHERE role = 'admin'))`
    return (await env.DB.prepare(sql).all<{ id: string }>()).results.map((r) => r.id)
}

/** Trong các ID Server cho trước, ID nào đang bị khóa (do Admin khóa VPS hoặc khóa chủ). */
export async function lockedAmong(env: Env, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set()
    const rows = (await env.DB.prepare(`SELECT s.id FROM servers s WHERE NOT (${ACTIVE})`).all<{ id: string }>()).results
    const bad = new Set(rows.map((r) => r.id))
    return new Set(ids.filter((i) => bad.has(i)))
}

/** Đẩy một tín hiệu về một Server; 2xx thì đánh dấu đã nhận. Lỗi nào cũng nuốt: tín hiệu vẫn nằm trong hàng đợi để Server kéo bù. */
export async function push(env: Env, server: string, id: number, created: number, raw: string, now: number, fetchFn: typeof fetch): Promise<void> {
    if (!env.SYNC_KEY) return
    const origin = await serverOrigin(env, server)
    if (!origin) return
    const body = JSON.stringify({ wid: id, age: Math.max(0, now - created), raw })
    try {
        const res = await fetchFn(`${origin}/api/ingest`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-ocean-ts': String(now),
                'x-ocean-sig': await signBody(await serverKey(env, server), now, body),
            },
            body,
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        })
        await res.body?.cancel()
        if (res.ok) await env.DB.prepare('UPDATE deliveries SET pushed = 1 WHERE sid = ? AND server = ?').bind(id, server).run()
    } catch {
        /* Server không với tới được: chờ kéo bù */
    }
}

/** Lưu + chia cho các Server + đẩy nền. Trả về id tín hiệu (null nếu D1 không lưu được). */
export async function storeAndDeliver(
    env: Env,
    ctx: Ctx,
    fetchFn: typeof fetch,
    a: { raw: string; owner: number | null; hook: number | null; targets: string[]; now: number },
): Promise<number | null> {
    const row = await env.DB.prepare('INSERT INTO signals (created, raw, owner, hook) VALUES (?, ?, ?, ?) RETURNING id').bind(a.now, a.raw, a.owner, a.hook).first<{ id: number }>()
    if (!row) return null
    for (const t of a.targets) await env.DB.prepare('INSERT OR IGNORE INTO deliveries (sid, server, pushed) VALUES (?, ?, 0)').bind(row.id, t).run()
    for (const t of a.targets) ctx.waitUntil(push(env, t, row.id, a.now, a.raw, a.now, fetchFn))
    return row.id
}