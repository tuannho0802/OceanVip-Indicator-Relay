import { hmacHex } from './hmac'

/**
 * Mã kết nối: chủ Worker phát cho từng người dùng, người dùng dán vào bộ cài. Một chuỗi mang đủ
 * địa chỉ Worker + Server ID + khóa RIÊNG của Server đó, nên người dùng không phải nhập URL, khóa, cổng.
 *
 * Khóa riêng = HMAC(khóa gốc SYNC_KEY của Worker, "server:<id>"): Worker không cần lưu khóa từng Server,
 * chỉ cần tính lại; lộ khóa của một Server không làm lộ khóa gốc hay khóa của Server khác.
 */
export const CONNECT_PREFIX = 'ocean1.'
export const SERVER_ID_RE = /^[a-z0-9][a-z0-9-]{2,39}$/

export type ConnectCode = { workerUrl: string; serverId: string; key: string }

export const deriveServerKey = async (masterKey: string, serverId: string): Promise<string> => (await hmacHex(masterKey, `server:${serverId}`)).slice(0, 48)

const b64u = (s: string): string => {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string): string => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
}

export const encodeConnectCode = (c: ConnectCode): string => CONNECT_PREFIX + b64u(JSON.stringify({ u: c.workerUrl, i: c.serverId, k: c.key }))

/** null nếu mã sai/hỏng. Chấp nhận mã dán kèm khoảng trắng, xuống dòng, dấu nháy. */
export function decodeConnectCode(code: string): ConnectCode | null {
  const t = code.replace(/[\s"'`]/g, '')
  if (!t.startsWith(CONNECT_PREFIX)) return null
  try {
    const o = JSON.parse(unb64u(t.slice(CONNECT_PREFIX.length))) as { u?: unknown; i?: unknown; k?: unknown }
    const workerUrl = typeof o.u === 'string' ? o.u.replace(/\/+$/, '') : ''
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(workerUrl)) return null
    if (typeof o.i !== 'string' || !SERVER_ID_RE.test(o.i)) return null
    if (typeof o.k !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(o.k)) return null
    return { workerUrl, serverId: o.i, key: o.k }
  } catch {
    return null
  }
}
