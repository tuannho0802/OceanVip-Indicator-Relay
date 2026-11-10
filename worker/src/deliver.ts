import { deriveServerKey } from '../../src/shared/connect'
import { signBody } from '../../src/shared/hmac'
import type { Ctx, Env } from './handler'

/** Lưu tín hiệu vào hàng đợi D1 rồi đẩy về các VPS được giao. Dùng chung cho webhook thật và nút "Gửi thử". */

const PUSH_TIMEOUT_MS = 4000
/**
 * Chờ (ms) trước mỗi lần thử đẩy: lần đầu ngay, rồi thử lại sau 1,5 giây và 4 giây. Lỗi thoáng qua của tunnel/VPS tự hết ngay trong
 * `waitUntil` nên không phải đợi Server kéo bù. Gọi ra ngoài (subrequest) không tính vào số request của Worker.
 */
export const PUSH_RETRY_MS: readonly number[] = [0, 1500, 4000]
/**
 * VPS kéo bù mỗi OCEAN_POLL_SEC giây (mặc định 300, tối đa 600; lỗi thì không dày hơn chu kỳ): quá 750 giây không thấy gì là coi như mất liên lạc.
 * Giữ ONLINE_SEC > 600 + dư để chu kỳ tối đa vẫn không bị báo "Mất liên lạc" nhầm.
 */
export const ONLINE_SEC = 750

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

/**
 * Đẩy một tín hiệu về một Server; 2xx thì đánh dấu đã nhận. Lỗi mạng/timeout/5xx thì thử lại theo `retryMs`; 4xx (sai khóa, bị từ chối) thì
 * dừng ngay vì thử lại cũng vô ích. Lỗi nào cũng nuốt: hết lượt thử mà chưa tới thì tín hiệu vẫn nằm trong hàng đợi để Server kéo bù.
 * Chữ ký được ký lại cho mỗi lần thử (ts mới) để không bị Server từ chối vì lệch giờ.
 */
export async function push(env: Env, server: string, id: number, created: number, raw: string, now: number, fetchFn: typeof fetch, retryMs: readonly number[] = PUSH_RETRY_MS): Promise<void> {
    if (!env.SYNC_KEY) return
    const origin = await serverOrigin(env, server)
    if (!origin) return
    const key = await serverKey(env, server)
    let ts = now
    for (const wait of retryMs) {
        if (wait > 0) {
            await new Promise((r) => setTimeout(r, wait))
            ts += Math.ceil(wait / 1000)
        }
        const body = JSON.stringify({ wid: id, age: Math.max(0, ts - created), raw })
        try {
            const res = await fetchFn(`${origin}/api/ingest`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-ocean-ts': String(ts),
                    'x-ocean-sig': await signBody(key, ts, body),
                },
                body,
                signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
            })
            await res.body?.cancel()
            if (res.ok) {
                await env.DB.prepare('UPDATE deliveries SET pushed = 1 WHERE sid = ? AND server = ?').bind(id, server).run()
                return
            }
            if (res.status < 500) return
        } catch {
            /* Server không với tới được: thử lại, hết lượt thì chờ kéo bù */
        }
    }
}

/** Lưu + chia cho các Server + đẩy nền. Trả về id tín hiệu (null nếu D1 không lưu được). */
export async function storeAndDeliver(
    env: Env,
    ctx: Ctx,
    fetchFn: typeof fetch,
    a: { raw: string; owner: number | null; hook: number | null; targets: string[]; now: number; retryMs?: readonly number[] },
): Promise<number | null> {
    const row = await env.DB.prepare('INSERT INTO signals (created, raw, owner, hook) VALUES (?, ?, ?, ?) RETURNING id').bind(a.now, a.raw, a.owner, a.hook).first<{ id: number }>()
    if (!row) return null
    for (const t of a.targets) await env.DB.prepare('INSERT OR IGNORE INTO deliveries (sid, server, pushed) VALUES (?, ?, 0)').bind(row.id, t).run()
    for (const t of a.targets) ctx.waitUntil(push(env, t, row.id, a.now, a.raw, a.now, fetchFn, a.retryMs))
    return row.id
}