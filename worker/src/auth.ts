import { safeEqual } from '../../src/shared/hmac'

/**
 * Mật khẩu + phiên đăng nhập cho trang quản lý của Worker (Admin/User).
 *  - Mật khẩu: PBKDF2-SHA256 qua WebCrypto, salt ngẫu nhiên riêng từng người. 100000 vòng là mức TỐI ĐA Cloudflare Workers cho phép.
 *  - Phiên: token ngẫu nhiên 256 bit trong cookie HttpOnly; D1 chỉ lưu SHA-256 của token nên lộ DB cũng không lấy được phiên.
 */
const enc = new TextEncoder()
const ITER = 100_000
export const SESSION_SEC = 7 * 86400
export const COOKIE = 'ocean_session'
export const PASSWORD_MIN = 8
export const PASSWORD_MAX = 128

const b64u = (b: Uint8Array): string => {
  let s = ''
  for (const x of b) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const unb64u = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array<ArrayBuffer>, iter: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256))
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  return `p1$${ITER}$${b64u(salt)}$${b64u(await derive(password, salt, ITER))}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [tag, iter, salt, hash] = stored.split('$')
  if (tag !== 'p1' || !iter || !salt || !hash) return false
  const n = Number(iter)
  if (!Number.isInteger(n) || n < 1000 || n > ITER) return false
  try {
    return safeEqual(b64u(await derive(password, unb64u(salt), n)), hash)
  } catch {
    return false
  }
}

/** Băm giả để thời gian trả lời không tiết lộ tên đăng nhập có tồn tại hay không. */
export async function burnPassword(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), ITER)
}

export const randomToken = (bytes = 32): string => b64u(crypto.getRandomValues(new Uint8Array(bytes)))

export async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))
  let out = ''
  for (const b of d) out += b.toString(16).padStart(2, '0')
  return out
}

/** Mật khẩu tạm dễ đọc (bỏ 0/O, 1/l/I). Lấy mẫu loại bỏ để các ký tự phân bố đều. */
export function tempPassword(len = 12): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const limit = 256 - (256 % alphabet.length)
  let out = ''
  while (out.length < len) {
    for (const b of crypto.getRandomValues(new Uint8Array(len * 2))) {
      if (b < limit && out.length < len) out += alphabet[b % alphabet.length]
    }
  }
  return out
}

export const readCookie = (req: Request, name: string): string => {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

export const sessionCookie = (token: string, maxAge: number): string => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`

export const passwordProblem = (p: unknown): string | null => {
  if (typeof p !== 'string' || p.length < PASSWORD_MIN) return `Mật khẩu tối thiểu ${PASSWORD_MIN} ký tự`
  if (p.length > PASSWORD_MAX) return `Mật khẩu tối đa ${PASSWORD_MAX} ký tự`
  return null
}
