/**
 * HMAC-SHA256 và so khóa bằng WebCrypto: chạy được trên Node 22 (Server, Gateway) lẫn Cloudflare Worker,
 * nên một bộ mã dùng chung cho cả ba nơi.
 */
const enc = new TextEncoder()

export async function hmacHex(secret: string, msg: string): Promise<string> {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))
    let out = ''
    for (const b of sig) out += b.toString(16).padStart(2, '0')
    return out
}

/** So hai chuỗi bằng thời gian không đổi theo nội dung (độ dài đã bằng nhau). */
export function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let d = 0
    for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return d === 0
}

/** So khóa bí mật: băm cả hai về cùng độ dài trước, nên không lộ độ dài khóa qua thời gian trả lời. */
export async function sameSecret(a: string, b: string): Promise<boolean> {
    if (!a || !b) return false
    return safeEqual(await hmacHex('ocean-cmp', a), await hmacHex('ocean-cmp', b))
}

/** Chữ ký Worker → Server: HMAC(syncKey, `${ts}.${body}`). `ts` là giây Unix, Server chỉ nhận lệch tối đa SKEW_SEC. */
export const SKEW_SEC = 300
export const signBody = (syncKey: string, ts: number, body: string): Promise<string> => hmacHex(syncKey, `${ts}.${body}`)

/** Tín hiệu giao cho Gateway kèm chữ ký (gắn với terminal), để Gateway không nhận tín hiệu bị sửa/giả giữa đường. */
export type WireSignal = {
    id: number
    kind: string
    side: string | null
    symbol: string | null
    tf: string | null
    entry: number | null
    sl: number | null
    tp1: number | null
    tp2: number | null
    tp3: number | null
    tp: number | null
    status: string | null
}

const n = (v: number | null): string => (v === null ? '' : String(v))

export function signalCanon(tid: string, s: WireSignal): string {
    return [tid, s.id, s.kind, s.side ?? '', s.symbol ?? '', s.tf ?? '', n(s.entry), n(s.sl), n(s.tp1), n(s.tp2), n(s.tp3), n(s.tp), s.status ?? ''].join('|')
}

export const signSignal = (eaKey: string, tid: string, s: WireSignal): Promise<string> => hmacHex(eaKey, signalCanon(tid, s))
