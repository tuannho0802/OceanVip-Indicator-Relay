import { deriveServerKey } from '../../src/shared/connect'
import { signBody } from '../../src/shared/hmac'
import type { Ctx, Env } from './handler'

/** Lưu tín hiệu vào hàng đợi D1 rồi đẩy về các VPS được giao. Dùng chung cho webhook thật và nút "Gửi thử". */

/** Mỗi lần gọi VPS chờ tối đa chừng này (ms). Quick Tunnel đôi khi chậm vài giây ở lần gọi đầu. */
export const PUSH_TIMEOUT_MS = 5000
/**
 * Chờ (ms) trước mỗi lần thử đẩy: lần đầu ngay, rồi dày lên dần (1s, 2s, 4s, 6s, 8s) = tối đa 6 lần.
 * Toàn bộ chạy trong `waitUntil` nên không làm chậm phản hồi cho TradingView. Cloudflare chỉ cho `waitUntil` sống ~30 giây sau khi trả lời,
 * nên còn có ngân sách thời gian PUSH_BUDGET_MS: hết ngân sách là dừng, phần còn lại do Cron nền (`flushPending`) và kéo bù đảm nhận.
 */
export const PUSH_RETRY_MS: readonly number[] = [0, 1000, 2000, 4000, 6000, 8000]
export const PUSH_BUDGET_MS = 26_000
/** Cron nền (mỗi phút) chỉ thử lại các tín hiệu chưa giao còn trẻ hơn ngưỡng này; già hơn thì EA cũng bỏ qua (OCEAN_MAX_AGE_SEC mặc định 120s). */
export const FLUSH_WINDOW_SEC = 170
/** Cron nền bỏ qua tín hiệu mới hơn ngưỡng này vì đường đẩy chính (webhook) vẫn đang thử lại. */
export const FLUSH_MIN_AGE_SEC = 20
/** Số lần giao tối đa mỗi lượt cron: giữ dưới hạn mức subrequest (50) của gói Free. */
export const FLUSH_MAX = 8
export const FLUSH_RETRY_MS: readonly number[] = [0, 2000, 5000]
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

/** Kết quả lần đẩy gần nhất tới một VPS (lưu ở bảng kv, khóa `push:<id>`, không cần migration) để trang quản lý chỉ ra VPS hụt vì sao. */
export type PushDiag = { at: number; ok: boolean; tries: number; status: number | null; error: string | null; ms: number }
const diagKey = (id: string): string => `push:${id}`

export async function saveDiag(env: Env, id: string, d: PushDiag): Promise<void> {
    try {
        await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(diagKey(id), JSON.stringify(d)).run()
    } catch {
        /* ghi chẩn đoán lỗi không được làm hỏng việc giao tín hiệu */
    }
}

export async function readDiags(env: Env): Promise<Map<string, PushDiag>> {
    const out = new Map<string, PushDiag>()
    const rows = (await env.DB.prepare("SELECT k, v FROM kv WHERE k LIKE 'push:%'").all<{ k: string; v: string }>()).results
    for (const r of rows) {
        try {
            const d = JSON.parse(r.v) as Partial<PushDiag>
            if (typeof d.at === 'number' && typeof d.ok === 'boolean') out.set(r.k.slice(5), { at: d.at, ok: d.ok, tries: Number(d.tries) || 0, status: typeof d.status === 'number' ? d.status : null, error: typeof d.error === 'string' ? d.error : null, ms: Number(d.ms) || 0 })
        } catch {
            /* dòng hỏng thì bỏ qua */
        }
    }
    return out
}

export async function readDiag(env: Env, id: string): Promise<PushDiag | null> {
    const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(diagKey(id)).first<{ v: string }>()
    if (!row) return null
    try {
        const d = JSON.parse(row.v) as Partial<PushDiag>
        return typeof d.at === 'number' && typeof d.ok === 'boolean' ? { at: d.at, ok: d.ok, tries: Number(d.tries) || 0, status: typeof d.status === 'number' ? d.status : null, error: typeof d.error === 'string' ? d.error : null, ms: Number(d.ms) || 0 } : null
    } catch {
        return null
    }
}

/** Đẩy đang hụt (hoặc Worker chưa có địa chỉ VPS): bảo Server kéo bù dày hơn chu kỳ cấu hình cho tới khi đẩy được lại. */
export const FAST_POLL_SEC = 10
const FAST_POLL_WINDOW_SEC = 900

/**
 * Gợi ý nhịp kéo bù cho một Server (giây), hoặc null = cứ theo cấu hình. Worker là cầu chính nên Worker biết đường đẩy có khỏe không:
 * lần đẩy gần nhất hụt (trong 15 phút) hoặc chưa có địa chỉ để đẩy thì kéo dày để tín hiệu không phải chờ 300 giây rồi quá hạn.
 * Server chỉ nhận gợi ý làm DÀY thêm, không bao giờ thưa hơn cấu hình của nó.
 */
export async function pollHint(env: Env, id: string, url: string | null, now: number): Promise<number | null> {
    if (normalizeOrigin(url) === null && !(id === '' && normalizeOrigin(env.VPS_ORIGIN))) return FAST_POLL_SEC
    const d = await readDiag(env, id)
    return d && !d.ok && now - d.at < FAST_POLL_WINDOW_SEC ? FAST_POLL_SEC : null
}

/** 4xx nào thử lại cũng vô ích (sai khóa/lệch giờ/bị từ chối). Còn lại (404 địa chỉ tunnel cũ, 408, 425, 429) là tạm thời nên vẫn thử tiếp. */
const permanent = (status: number): boolean => status >= 400 && status < 500 && ![404, 408, 425, 429].includes(status)

/**
 * Đẩy một tín hiệu về một Server; 2xx thì đánh dấu đã nhận. Lỗi mạng/timeout/5xx/404/429 thì thử lại theo `retryMs` trong giới hạn
 * PUSH_BUDGET_MS; lỗi vĩnh viễn (401/403...) thì dừng ngay. Lỗi nào cũng nuốt: hết lượt thử mà chưa tới thì tín hiệu vẫn nằm trong hàng đợi
 * để Cron nền đẩy lại hoặc Server kéo bù. Chữ ký được ký lại cho mỗi lần thử (ts mới) để không bị Server từ chối vì lệch giờ.
 * Kết quả (số lần, mã HTTP, lỗi) được ghi lại để hiện trên trang quản lý.
 */
export async function push(env: Env, server: string, id: number, created: number, raw: string, now: number, fetchFn: typeof fetch, retryMs: readonly number[] = PUSH_RETRY_MS): Promise<PushDiag | null> {
    if (!env.SYNC_KEY) return null
    const started = Date.now()
    const origin = await serverOrigin(env, server)
    if (!origin) {
        const d: PushDiag = { at: now, ok: false, tries: 0, status: null, error: 'no_url', ms: 0 }
        await saveDiag(env, server, d)
        return d
    }
    const key = await serverKey(env, server)
    let tries = 0
    let status: number | null = null
    let error: string | null = null
    let ok = false
    for (const wait of retryMs) {
        const spent = Date.now() - started
        if (wait > 0) {
            if (spent + wait >= PUSH_BUDGET_MS) break
            await new Promise((r) => setTimeout(r, wait))
        }
        const left = PUSH_BUDGET_MS - (Date.now() - started)
        if (tries > 0 && left < 1000) break
        const ts = now + Math.floor((Date.now() - started) / 1000)
        const body = JSON.stringify({ wid: id, age: Math.max(0, ts - created), raw })
        tries++
        try {
            const res = await fetchFn(`${origin}/api/ingest`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-ocean-ts': String(ts),
                    'x-ocean-sig': await signBody(key, ts, body),
                },
                body,
                signal: AbortSignal.timeout(Math.min(PUSH_TIMEOUT_MS, Math.max(1000, left))),
            })
            status = res.status
            if (res.ok) {
                await res.body?.cancel()
                ok = true
                error = null
                await env.DB.prepare('UPDATE deliveries SET pushed = 1 WHERE sid = ? AND server = ?').bind(id, server).run()
                break
            }
            // Server trả mã lỗi dạng {"error":"bad_time"}: giữ lại để trang quản lý nói đúng nguyên nhân (lệch giờ, sai khóa...).
            error = `http_${res.status}`
            try {
                const j = JSON.parse((await res.text()).slice(0, 400)) as { error?: unknown }
                if (typeof j.error === 'string' && /^[a-z_]{2,40}$/.test(j.error)) error = j.error
            } catch {
                /* không phải JSON: giữ mã HTTP */
            }
            if (permanent(res.status)) break
        } catch (e) {
            status = null
            error = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network'
        }
    }
    const diag: PushDiag = { at: now, ok, tries, status, error, ms: Date.now() - started }
    await saveDiag(env, server, diag)
    return diag
}

/**
 * Worker chủ động: quét các tín hiệu CHƯA giao cho VPS nào và đẩy lại, không đợi VPS kéo bù (chu kỳ 300 giây). Chạy từ Cron Trigger mỗi phút.
 * Chỉ xét ~50 tín hiệu mới nhất (tra theo khóa chính nên rẻ), còn trẻ hơn FLUSH_WINDOW_SEC và đã nằm hàng đợi quá FLUSH_MIN_AGE_SEC.
 * Trả về số tín hiệu đã giao được.
 */
export async function flushPending(env: Env, fetchFn: typeof fetch, now: number, retryMs: readonly number[] = FLUSH_RETRY_MS): Promise<number> {
    if (!env.SYNC_KEY) return 0
    const rows = (
        await env.DB.prepare(
            'SELECT d.sid AS sid, d.server AS server, s.created AS created, s.raw AS raw FROM deliveries d JOIN signals s ON s.id = d.sid ' +
                'WHERE s.id > (SELECT COALESCE(MAX(id), 0) - 50 FROM signals) AND d.pushed = 0 AND s.created >= ? AND s.created <= ? ORDER BY s.id ASC LIMIT ?',
        )
            .bind(now - FLUSH_WINDOW_SEC, now - FLUSH_MIN_AGE_SEC, FLUSH_MAX)
            .all<{ sid: number; server: string; created: number; raw: string }>()
    ).results
    const done = await Promise.all(rows.map((r) => push(env, r.server, r.sid, r.created, r.raw, now, fetchFn, retryMs)))
    return done.filter((d) => d?.ok).length
}

export type ProbeSample = { ms: number | null; status: number | null; error: string | null }
export type ProbeResult = {
    ok: boolean
    /** Lỗi chung khi không đo được (no_url, locked...). */
    error: string | null
    origin: string | null
    /** true = đã kiểm cả chữ ký HMAC qua /api/ping; false = VPS bản cũ chưa có /api/ping nên chỉ gọi /api/health (chưa kiểm khóa/giờ). */
    verified: boolean
    samples: ProbeSample[]
    sent: number
    received: number
    min: number | null
    avg: number | null
    max: number | null
    /** Lần đo đầu (thường chậm hơn: bắt tay TLS, tunnel nguội). */
    first: number | null
    /** Giờ VPS trừ giờ Worker (giây). Lệch hơn ~300 giây là Server từ chối chữ ký (bad_time) và tín hiệu không đẩy được. */
    skew: number | null
}

export const PROBE_SAMPLES = 5
export const PROBE_TIMEOUT_MS = 6000

/**
 * Đo độ trễ Worker → VPS bằng chính đường đẩy thật: gọi `POST <tunnel>/api/ping` có ký HMAC như `/api/ingest` nhưng không tạo tín hiệu.
 * Đo tuần tự PROBE_SAMPLES lần; kèm giờ VPS để phát hiện lệch giờ. VPS bản cũ (chưa có /api/ping, trả 404) thì tạm đo `/api/health`.
 */
export async function probeServer(env: Env, id: string, now: number, fetchFn: typeof fetch, samples = PROBE_SAMPLES): Promise<ProbeResult> {
    const base: ProbeResult = { ok: false, error: null, origin: null, verified: true, samples: [], sent: 0, received: 0, min: null, avg: null, max: null, first: null, skew: null }
    const origin = await serverOrigin(env, id)
    if (!origin) return { ...base, error: 'no_url' }
    if (!env.SYNC_KEY) return { ...base, origin, error: 'sync_disabled' }
    const key = await serverKey(env, id)
    const started = Date.now()
    let legacy = false
    const skews: number[] = []
    const out: ProbeSample[] = []
    for (let i = 0; i < samples; i++) {
        const ts = now + Math.floor((Date.now() - started) / 1000)
        const t0 = Date.now()
        let sample: ProbeSample
        try {
            let res: Response
            if (legacy) {
                res = await fetchFn(`${origin}/api/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
            } else {
                const body = JSON.stringify({ probe: i + 1 })
                res = await fetchFn(`${origin}/api/ping`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-ocean-ts': String(ts), 'x-ocean-sig': await signBody(key, ts, body) },
                    body,
                    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
                })
            }
            let text = ''
            try {
                text = await res.text()
            } catch {
                /* thân phản hồi không đọc được vẫn tính độ trễ */
            }
            const ms = Date.now() - t0
            if (res.status === 404 && !legacy) {
                // VPS bản cũ: không có /api/ping. Đo lại lần này bằng /api/health.
                legacy = true
                i--
                continue
            }
            if (res.ok) {
                sample = { ms, status: res.status, error: null }
                if (!legacy) {
                    try {
                        const j = JSON.parse(text) as { now?: unknown }
                        if (typeof j.now === 'number') skews.push(j.now - ts)
                    } catch {
                        /* không có giờ thì bỏ qua */
                    }
                }
            } else {
                let code = `http_${res.status}`
                try {
                    const j = JSON.parse(text) as { error?: unknown }
                    if (typeof j.error === 'string') code = j.error
                } catch {
                    /* giữ mã HTTP */
                }
                sample = { ms, status: res.status, error: code }
            }
        } catch (e) {
            sample = { ms: null, status: null, error: (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network' }
        }
        out.push(sample)
        // Hai lần liền không có phản hồi: dừng sớm, đo tiếp chỉ tốn thời gian.
        if (out.length === 2 && out.every((x) => x.ms === null || x.error !== null)) break
        // Lỗi vĩnh viễn (sai khóa, lệch giờ): các lần sau cũng y hệt.
        if (sample.status !== null && sample.error !== null && permanent(sample.status)) break
    }
    const okMs = out.filter((x) => x.error === null && x.ms !== null).map((x) => x.ms as number)
    const sorted = [...skews].sort((a, b) => a - b)
    return {
        ok: okMs.length > 0,
        error: null,
        origin,
        verified: !legacy,
        samples: out,
        sent: out.length,
        received: okMs.length,
        min: okMs.length ? Math.min(...okMs) : null,
        avg: okMs.length ? Math.round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
        max: okMs.length ? Math.max(...okMs) : null,
        first: out[0]?.error === null ? (out[0].ms ?? null) : null,
        skew: sorted.length ? (sorted[Math.floor(sorted.length / 2)] ?? null) : null,
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