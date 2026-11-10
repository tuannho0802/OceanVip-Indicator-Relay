import { SERVER_ID_RE, deriveServerKey, encodeConnectCode } from '../../src/shared/connect'
import { COOKIE, SESSION_SEC, burnPassword, hashPassword, passwordProblem, randomToken, readCookie, sessionCookie, sha256Hex, tempPassword, verifyPassword } from './auth'
import { ONLINE_SEC, hookTargets, normalizeOrigin, storeAndDeliver } from './deliver'
import type { Ctx, Env } from './handler'
import { json } from './http'

/**
 * API quản lý (JSON) cho trang web của Worker. KHÔNG có đăng ký: Admin tạo tài khoản, User tự đổi mật khẩu sau khi được cấp.
 *  - Admin: thấy và thao tác mọi thứ; cấp hạn mức, khóa/mở khóa User, VPS, Webhook, việc thêm mới.
 *  - User : chỉ thấy VPS + Webhook + tín hiệu của chính mình, và chỉ tạo thêm trong hạn mức khi Admin còn mở khóa.
 */
type UserRow = {
  id: number
  username: string
  pass_hash: string
  role: 'admin' | 'user'
  must_change: number
  locked: number
  max_servers: number
  max_hooks: number
  can_add_server: number
  can_add_hook: number
  fails: number
  locked_until: number
  created: number
  last_login: number
}

const USER_COLS = 'id, username, pass_hash, role, must_change, locked, max_servers, max_hooks, can_add_server, can_add_hook, fails, locked_until, created, last_login'
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/
const MAX_FAILS = 5
const LOCK_SEC = 300
const MAX_QUOTA = 1000
const TEST_TEXT = 'OCEAN TEST | ping từ trang quản lý (không phải tín hiệu giao dịch)'

type Deps = { now: number; fetchFn: typeof fetch; retryMs?: readonly number[] }
const err = (code: number, error: string, message: string, extra: Record<string, unknown> = {}): Response => json(code, { error, message, ...extra })

const pub = (u: UserRow) => ({
  id: u.id,
  username: u.username,
  role: u.role,
  must_change: u.must_change === 1,
  max_servers: u.max_servers,
  max_hooks: u.max_hooks,
  can_add_server: u.can_add_server === 1,
  can_add_hook: u.can_add_hook === 1,
})

const int = (v: unknown, min: number, max: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null)
const flag = (v: unknown): 0 | 1 | null => (v === true || v === 1 ? 1 : v === false || v === 0 ? 0 : null)
const cleanName = (v: unknown, fallback: string): string => {
  const t = typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60) : ''
  return t || fallback
}
const slug = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
const hex4 = (): string => [...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, '0')).join('')
const status = (seen: number, now: number): 'never' | 'online' | 'stale' => (seen === 0 ? 'never' : now - seen <= ONLINE_SEC ? 'online' : 'stale')

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const t = await req.text()
  if (t.length > 8192) return null
  if (t.trim() === '') return {}
  try {
    const v: unknown = JSON.parse(t)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Lần đầu chạy (hoặc khi mất hết Admin): chưa có Admin nào mà có secret ADMIN_PASSWORD thì tạo Admin (phải đổi mật khẩu ngay lần đăng nhập đầu). */
export async function ensureAdmin(env: Env, now: number): Promise<'ok' | 'need_admin_password'> {
  const c = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first<{ c: number }>()
  if ((c?.c ?? 0) > 0) return 'ok'
  if (!env.ADMIN_PASSWORD || passwordProblem(env.ADMIN_PASSWORD)) return 'need_admin_password'
  const name = (env.ADMIN_USER ?? '').trim().toLowerCase()
  const username = USERNAME_RE.test(name) ? name : 'admin'
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (username, pass_hash, role, must_change, max_servers, max_hooks, created) VALUES (?, ?, 'admin', 1, ?, ?, ?)",
  )
    .bind(username, await hashPassword(env.ADMIN_PASSWORD), MAX_QUOTA, MAX_QUOTA, now)
    .run()
  return 'ok'
}

async function sessionUser(req: Request, env: Env, now: number): Promise<{ user: UserRow; hash: string } | null> {
  const token = readCookie(req, COOKIE)
  if (!token) return null
  const hash = await sha256Hex(token)
  const row = await env.DB.prepare(
    `SELECT ${USER_COLS.split(', ').map((c) => `u.${c}`).join(', ')} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?`,
  )
    .bind(hash, now)
    .first<UserRow>()
  return row && row.locked !== 1 ? { user: row, hash } : null
}

const origin = (env: Env, url: URL): string => normalizeOrigin(env.PUBLIC_URL) ?? url.origin

async function connectCode(env: Env, workerUrl: string, id: string): Promise<string> {
  return encodeConnectCode({ workerUrl, serverId: id, key: await deriveServerKey(env.SYNC_KEY ?? '', id) })
}

type ServerRow = { id: string; name: string | null; owner: number | null; locked: number; seen: number; has_url: number; created: number; owner_name: string | null; owner_locked: number | null; pending: number }
type HookRow = { id: number; name: string; owner: number; key: string; server: string | null; locked: number; last_used: number; hits: number; created: number; owner_name: string }

const DEFAULT_INSTALLER_URL = 'https://github.com/tuannho0802/OceanVip-Indicator-Relay/releases'

async function overview(env: Env, u: UserRow, workerUrl: string, now: number): Promise<Response> {
  const admin = u.role === 'admin'
  const sSql =
    'SELECT s.id, s.name, s.owner, s.locked, s.seen, (s.url IS NOT NULL) AS has_url, s.created, us.username AS owner_name, us.locked AS owner_locked, ' +
    '(SELECT COUNT(*) FROM deliveries d WHERE d.server = s.id AND d.pushed = 0) AS pending FROM servers s LEFT JOIN users us ON us.id = s.owner' +
    (admin ? '' : ' WHERE s.owner = ?') +
    ' ORDER BY s.created DESC, s.seen DESC LIMIT 500'
  const hSql =
    'SELECT h.id, h.name, h.owner, h.key, h.server, h.locked, h.last_used, h.hits, h.created, us.username AS owner_name FROM hooks h JOIN users us ON us.id = h.owner' +
    (admin ? '' : ' WHERE h.owner = ?') +
    ' ORDER BY h.id DESC LIMIT 500'
  const sSt = env.DB.prepare(sSql)
  const hSt = env.DB.prepare(hSql)
  const servers = (await (admin ? sSt : sSt.bind(u.id)).all<ServerRow>()).results
  const hooks = (await (admin ? hSt : hSt.bind(u.id)).all<HookRow>()).results
  const mine = (o: number | null) => o === u.id
  const body: Record<string, unknown> = {
    now,
    worker_url: workerUrl,
    https_ok: normalizeOrigin(workerUrl) !== null,
    sync_ready: Boolean(env.SYNC_KEY),
    installer_url: /^https:\/\//.test(env.INSTALLER_URL ?? '') ? env.INSTALLER_URL : DEFAULT_INSTALLER_URL,
    user: pub(u),
    usage: { servers: servers.filter((s) => mine(s.owner)).length, hooks: hooks.filter((h) => mine(h.owner)).length },
    servers: servers.map((s) => ({
      id: s.id || '',
      name: s.name || (s.id === '' ? '(VPS đời cũ, khóa gốc)' : s.id),
      owner: s.owner,
      owner_name: s.owner_name,
      locked: s.locked === 1,
      owner_locked: s.owner_locked === 1,
      status: status(s.seen, now),
      seen_ago: s.seen === 0 ? null : Math.max(0, now - s.seen),
      has_url: s.has_url === 1,
      pending: s.pending,
      created: s.created,
    })),
    hooks: hooks.map((h) => ({
      id: h.id,
      name: h.name,
      owner: h.owner,
      owner_name: h.owner_name,
      server: h.server,
      locked: h.locked === 1,
      last_used_ago: h.last_used === 0 ? null : Math.max(0, now - h.last_used),
      hits: h.hits,
      url: `${workerUrl}/webhook?key=${h.key}`,
    })),
  }
  if (admin) {
    // Webhook URL chung đời cũ: chỉ Admin thấy, để không phải nhớ/lưu từ lần setup.
    if (env.WEBHOOK_KEY) body.legacy_hook_url = `${workerUrl}/webhook?key=${env.WEBHOOK_KEY}`
    const users = (
      await env.DB.prepare(
        'SELECT id, username, role, must_change, locked, max_servers, max_hooks, can_add_server, can_add_hook, created, last_login, ' +
          '(SELECT COUNT(*) FROM servers WHERE owner = users.id) AS servers, (SELECT COUNT(*) FROM hooks WHERE owner = users.id) AS hooks FROM users ORDER BY id',
      ).all<UserRow & { servers: number; hooks: number }>()
    ).results
    body.users = users.map((x) => ({ ...pub(x), locked: x.locked === 1, servers: x.servers, hooks: x.hooks, last_login_ago: x.last_login === 0 ? null : Math.max(0, now - x.last_login) }))
  }
  return json(200, body)
}

async function newServerId(env: Env, base: string): Promise<string> {
  const b = slug(base) || 'vps'
  for (let i = 0; i < 5; i++) {
    const id = `${b}-${hex4()}`
    if (!SERVER_ID_RE.test(id)) continue
    const taken = await env.DB.prepare('SELECT 1 AS x FROM servers WHERE id = ? UNION SELECT 1 FROM revoked_servers WHERE id = ?').bind(id, id).first()
    if (!taken) return id
  }
  return `vps-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`
}

/** Xóa hẳn một VPS: ghi vào danh sách thu hồi để khóa cũ không tự đăng ký lại. */
async function dropServer(env: Env, id: string, now: number): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO revoked_servers (id, at) VALUES (?, ?)').bind(id, now).run()
  await env.DB.prepare('DELETE FROM deliveries WHERE server = ?').bind(id).run()
  await env.DB.prepare('UPDATE hooks SET server = NULL WHERE server = ?').bind(id).run()
  await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run()
}

export async function appRoute(req: Request, env: Env, ctx: Ctx, url: URL, deps: Deps): Promise<Response | null> {
  const p = url.pathname
  if (!p.startsWith('/api/')) return null
  const { now } = deps
  const m = req.method
  const parts = p.split('/').filter(Boolean) // ['api', 'servers', ':id', 'code']
  const head = parts[1] ?? ''
  if (!['session', 'login', 'logout', 'password', 'overview', 'servers', 'hooks', 'users', 'signals'].includes(head)) return null

  // Chống CSRF: yêu cầu ghi từ trình duyệt phải cùng nguồn (cookie còn SameSite=Strict).
  if (m !== 'GET' && m !== 'HEAD') {
    const o = req.headers.get('origin')
    if (o !== null && o !== url.origin) return err(403, 'bad_origin', 'Yêu cầu không cùng nguồn')
  }
  const workerUrl = origin(env, url)

  if (head === 'session' && m === 'GET') {
    const setup = await ensureAdmin(env, now)
    const s = await sessionUser(req, env, now)
    return json(200, { user: s ? pub(s.user) : null, setup, worker_url: workerUrl })
  }

  if (head === 'login' && m === 'POST') {
    if ((await ensureAdmin(env, now)) !== 'ok') return err(503, 'need_admin_password', 'Chưa có tài khoản Admin: đặt secret ADMIN_PASSWORD cho Worker (xem /help).')
    const b = await readBody(req)
    const username = typeof b?.username === 'string' ? b.username.trim().toLowerCase() : ''
    const password = typeof b?.password === 'string' ? b.password : ''
    if (!username || !password || password.length > 256) return err(400, 'bad_request', 'Nhập tên đăng nhập và mật khẩu')
    const u = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?`).bind(username).first<UserRow>()
    if (!u) {
      await burnPassword(password)
      return err(401, 'bad_credentials', 'Sai tên đăng nhập hoặc mật khẩu')
    }
    if (u.locked_until > now) return err(429, 'too_many_attempts', `Sai quá nhiều lần, thử lại sau ${u.locked_until - now} giây`, { retry_after: u.locked_until - now })
    if (!(await verifyPassword(password, u.pass_hash))) {
      const fails = u.fails + 1
      if (fails >= MAX_FAILS) await env.DB.prepare('UPDATE users SET fails = 0, locked_until = ? WHERE id = ?').bind(now + LOCK_SEC, u.id).run()
      else await env.DB.prepare('UPDATE users SET fails = ? WHERE id = ?').bind(fails, u.id).run()
      return err(401, 'bad_credentials', 'Sai tên đăng nhập hoặc mật khẩu')
    }
    if (u.locked === 1) return err(403, 'account_locked', 'Tài khoản đã bị Admin khóa')
    const token = randomToken(32)
    await env.DB.prepare('UPDATE users SET fails = 0, locked_until = 0, last_login = ? WHERE id = ?').bind(now, u.id).run()
    await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)').bind(await sha256Hex(token), u.id, now, now + SESSION_SEC).run()
    await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now).run()
    return json(200, { ok: true, user: pub(u) }, { 'set-cookie': sessionCookie(token, SESSION_SEC) })
  }

  if (head === 'logout' && m === 'POST') {
    const token = readCookie(req, COOKIE)
    if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run()
    return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) })
  }

  // Từ đây trở xuống phải đăng nhập.
  const sess = await sessionUser(req, env, now)
  if (!sess) return err(401, 'unauthenticated', 'Chưa đăng nhập hoặc phiên đã hết hạn')
  const u = sess.user
  const admin = u.role === 'admin'

  if (head === 'password' && m === 'POST') {
    const b = await readBody(req)
    const cur = typeof b?.current === 'string' ? b.current : ''
    const next = b?.next
    if (!(await verifyPassword(cur, u.pass_hash))) return err(403, 'bad_current', 'Mật khẩu hiện tại không đúng')
    const prob = passwordProblem(next)
    if (prob) return err(400, 'weak_password', prob)
    if (next === cur) return err(400, 'same_password', 'Mật khẩu mới phải khác mật khẩu hiện tại')
    await env.DB.prepare('UPDATE users SET pass_hash = ?, must_change = 0 WHERE id = ?').bind(await hashPassword(next as string), u.id).run()
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(u.id, sess.hash).run()
    return json(200, { ok: true })
  }

  if (u.must_change === 1) return err(403, 'must_change_password', 'Hãy đổi mật khẩu trước khi dùng tiếp')

  if (head === 'overview' && m === 'GET') return overview(env, u, workerUrl, now)

  // ---- Tín hiệu gần đây (User: của mình; Admin: tất cả) ----
  if (head === 'signals' && m === 'GET') {
    const sql =
      'SELECT s.id, s.created, s.raw, s.owner, us.username AS owner_name, (SELECT COUNT(*) FROM deliveries d WHERE d.sid = s.id) AS total, ' +
      '(SELECT COUNT(*) FROM deliveries d WHERE d.sid = s.id AND d.pushed = 1) AS pushed FROM signals s LEFT JOIN users us ON us.id = s.owner' +
      (admin ? '' : ' WHERE s.owner = ?') +
      ' ORDER BY s.id DESC LIMIT 30'
    const st = env.DB.prepare(sql)
    const rows = (await (admin ? st : st.bind(u.id)).all<{ id: number; created: number; raw: string; owner: number | null; owner_name: string | null; total: number; pushed: number }>()).results
    return json(200, {
      now,
      signals: rows.map((r) => ({ id: r.id, age: Math.max(0, now - r.created), owner_name: r.owner_name, servers: r.total, delivered: r.pushed, raw: r.raw.slice(0, 400) })),
    })
  }

  // ---- VPS ----
  if (head === 'servers') {
    const id = parts[2] ?? ''
    if (id === '' && m === 'POST') {
      if (!env.SYNC_KEY) return err(503, 'sync_disabled', 'Worker chưa có SYNC_KEY. Admin thêm secret SYNC_KEY ở Cloudflare Dashboard (Settings → Variables and Secrets) hoặc ở GitHub Secrets rồi chạy Deploy Worker.')
      const b = await readBody(req)
      if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
      let owner = u
      if (b.user_id !== undefined && b.user_id !== u.id) {
        if (!admin) return err(403, 'admin_only', 'Chỉ Admin được tạo thay người khác')
        const t = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(b.user_id).first<UserRow>()
        if (!t) return err(404, 'no_user', 'Không có người dùng này')
        owner = t
      }
      const bypass = admin // Admin thêm cho ai cũng không bị hạn mức/khóa
      if (!bypass) {
        if (u.can_add_server !== 1) return err(403, 'add_locked', 'Admin đang khóa việc thêm VPS mới. Liên hệ Admin để mở khóa.')
        const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM servers WHERE owner = ?').bind(u.id).first<{ c: number }>()
        if ((c?.c ?? 0) >= u.max_servers) return err(403, 'limit_reached', `Đã dùng hết hạn mức VPS (${u.max_servers}). Liên hệ Admin để tăng.`)
      }
      const name = cleanName(b.name, `VPS của ${owner.username}`)
      for (let i = 0; i < 3; i++) {
        const sid = await newServerId(env, b.name ? name : owner.username)
        // Kiểm tra hạn mức nằm ngay trong câu INSERT để hai yêu cầu cùng lúc không vượt hạn mức.
        const guard = bypass
          ? ''
          : ' WHERE (SELECT can_add_server FROM users WHERE id = ?) = 1 AND (SELECT COUNT(*) FROM servers WHERE owner = ?) < (SELECT max_servers FROM users WHERE id = ?)'
        const st = env.DB.prepare(`INSERT INTO servers (id, owner, name, seen, created) SELECT ?, ?, ?, 0, ?${guard} RETURNING id`)
        try {
          const row = await (bypass ? st.bind(sid, owner.id, name, now) : st.bind(sid, owner.id, name, now, owner.id, owner.id, owner.id)).first<{ id: string }>()
          if (!row) return err(409, 'limit_reached', 'Không thêm được VPS: hết hạn mức hoặc đang bị khóa')
          return json(200, { ok: true, id: sid, name, code: await connectCode(env, workerUrl, sid) })
        } catch {
          /* trùng ID (hiếm): thử ID khác */
        }
      }
      return err(500, 'store_failed', 'Không tạo được VPS, thử lại')
    }

    if (id !== '' && SERVER_ID_RE.test(id)) {
      const s = await env.DB.prepare('SELECT id, name, owner, locked FROM servers WHERE id = ?').bind(id).first<{ id: string; name: string | null; owner: number | null; locked: number }>()
      if (!s || (!admin && s.owner !== u.id)) return err(404, 'no_server', 'Không có VPS này') // User không phân biệt được "không có" và "của người khác"
      if (parts[3] === 'code' && m === 'GET') {
        if (!env.SYNC_KEY) return err(503, 'sync_disabled', 'Worker chưa có SYNC_KEY')
        return json(200, { id, code: await connectCode(env, workerUrl, id) })
      }
      if (parts[3] === undefined && m === 'PATCH') {
        const b = await readBody(req)
        if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
        if (b.locked !== undefined) {
          if (!admin) return err(403, 'admin_only', 'Chỉ Admin được khóa/mở khóa VPS')
          const f = flag(b.locked)
          if (f === null) return err(400, 'bad_request', 'locked phải là true/false')
          await env.DB.prepare('UPDATE servers SET locked = ? WHERE id = ?').bind(f, id).run()
        }
        if (b.name !== undefined) await env.DB.prepare('UPDATE servers SET name = ? WHERE id = ?').bind(cleanName(b.name, s.name ?? id), id).run()
        return json(200, { ok: true })
      }
      if (parts[3] === undefined && m === 'DELETE') {
        await dropServer(env, id, now)
        return json(200, { ok: true })
      }
    }
    return err(404, 'not_found', 'Không có đường dẫn này')
  }

  // ---- Webhook URL ----
  if (head === 'hooks') {
    const hid = parts[2] === undefined ? 0 : Number(parts[2])
    if (parts[2] === undefined && m === 'POST') {
      const b = await readBody(req)
      if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
      let owner = u
      if (b.user_id !== undefined && b.user_id !== u.id) {
        if (!admin) return err(403, 'admin_only', 'Chỉ Admin được tạo thay người khác')
        const t = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(b.user_id).first<UserRow>()
        if (!t) return err(404, 'no_user', 'Không có người dùng này')
        owner = t
      }
      let server: string | null = null
      if (typeof b.server === 'string' && b.server !== '') {
        const s = await env.DB.prepare('SELECT id FROM servers WHERE id = ? AND owner = ?').bind(b.server, owner.id).first()
        if (!s) return err(400, 'bad_server', 'VPS này không thuộc tài khoản')
        server = b.server
      }
      const bypass = admin
      if (!bypass) {
        if (u.can_add_hook !== 1) return err(403, 'add_locked', 'Admin đang khóa việc tạo Webhook URL mới. Liên hệ Admin để mở khóa.')
        const c = await env.DB.prepare('SELECT COUNT(*) AS c FROM hooks WHERE owner = ?').bind(u.id).first<{ c: number }>()
        if ((c?.c ?? 0) >= u.max_hooks) return err(403, 'limit_reached', `Đã dùng hết hạn mức Webhook (${u.max_hooks}). Liên hệ Admin để tăng.`)
      }
      const name = cleanName(b.name, 'Webhook TradingView')
      const key = `oh_${randomToken(24)}`
      const guard = bypass ? '' : ' WHERE (SELECT can_add_hook FROM users WHERE id = ?) = 1 AND (SELECT COUNT(*) FROM hooks WHERE owner = ?) < (SELECT max_hooks FROM users WHERE id = ?)'
      const st = env.DB.prepare(`INSERT INTO hooks (owner, name, key, server, created) SELECT ?, ?, ?, ?, ?${guard} RETURNING id`)
      const row = await (bypass ? st.bind(owner.id, name, key, server, now) : st.bind(owner.id, name, key, server, now, owner.id, owner.id, owner.id)).first<{ id: number }>()
      if (!row) return err(409, 'limit_reached', 'Không tạo được Webhook: hết hạn mức hoặc đang bị khóa')
      return json(200, { ok: true, id: row.id, url: `${workerUrl}/webhook?key=${key}` })
    }

    if (Number.isInteger(hid) && hid > 0) {
      const h = await env.DB.prepare('SELECT id, name, owner, server, locked FROM hooks WHERE id = ?').bind(hid).first<{ id: number; name: string; owner: number; server: string | null; locked: number }>()
      if (!h || (!admin && h.owner !== u.id)) return err(404, 'no_hook', 'Không có Webhook này')
      if (parts[3] === undefined && m === 'PATCH') {
        const b = await readBody(req)
        if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
        if (b.locked !== undefined) {
          if (!admin) return err(403, 'admin_only', 'Chỉ Admin được khóa/mở khóa Webhook')
          const f = flag(b.locked)
          if (f === null) return err(400, 'bad_request', 'locked phải là true/false')
          await env.DB.prepare('UPDATE hooks SET locked = ? WHERE id = ?').bind(f, hid).run()
        }
        if (b.name !== undefined) await env.DB.prepare('UPDATE hooks SET name = ? WHERE id = ?').bind(cleanName(b.name, h.name), hid).run()
        if (b.server !== undefined) {
          if (b.server === null || b.server === '') await env.DB.prepare('UPDATE hooks SET server = NULL WHERE id = ?').bind(hid).run()
          else {
            const s = typeof b.server === 'string' ? await env.DB.prepare('SELECT id FROM servers WHERE id = ? AND owner = ?').bind(b.server, h.owner).first() : null
            if (!s) return err(400, 'bad_server', 'VPS này không thuộc tài khoản')
            await env.DB.prepare('UPDATE hooks SET server = ? WHERE id = ?').bind(b.server, hid).run()
          }
        }
        return json(200, { ok: true })
      }
      if (parts[3] === 'rotate' && m === 'POST') {
        const key = `oh_${randomToken(24)}`
        await env.DB.prepare('UPDATE hooks SET key = ? WHERE id = ?').bind(key, hid).run()
        return json(200, { ok: true, url: `${workerUrl}/webhook?key=${key}` })
      }
      if (parts[3] === undefined && m === 'DELETE') {
        await env.DB.prepare('DELETE FROM hooks WHERE id = ?').bind(hid).run()
        return json(200, { ok: true })
      }
      if (parts[3] === 'test' && m === 'POST') {
        const ow = await env.DB.prepare('SELECT locked FROM users WHERE id = ?').bind(h.owner).first<{ locked: number }>()
        if (h.locked === 1 || ow?.locked === 1) return err(403, 'hook_locked', 'Webhook hoặc tài khoản đang bị khóa')
        const targets = await hookTargets(env, { owner: h.owner, server: h.server })
        const sid = await storeAndDeliver(env, ctx, deps.fetchFn, { raw: TEST_TEXT, owner: h.owner, hook: h.id, targets, now, retryMs: deps.retryMs })
        if (sid === null) return err(500, 'store_failed', 'Không lưu được tín hiệu thử')
        return json(200, { ok: true, id: sid, servers: targets.length })
      }
    }
    return err(404, 'not_found', 'Không có đường dẫn này')
  }

  // ---- Người dùng (chỉ Admin) ----
  if (head === 'users') {
    if (!admin) return err(403, 'admin_only', 'Chỉ Admin được quản lý người dùng')
    const uid = parts[2] === undefined ? 0 : Number(parts[2])

    if (parts[2] === undefined && m === 'POST') {
      const b = await readBody(req)
      if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
      const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : ''
      if (!USERNAME_RE.test(username)) return err(400, 'bad_username', 'Tên đăng nhập: chữ thường, số, . _ - (3-32 ký tự, bắt đầu bằng chữ/số)')
      const role = b.role === 'admin' ? 'admin' : 'user'
      const given = typeof b.password === 'string' && b.password !== ''
      if (given) {
        const prob = passwordProblem(b.password)
        if (prob) return err(400, 'weak_password', prob)
      }
      const password = given ? (b.password as string) : tempPassword()
      const maxS = b.max_servers === undefined ? 1 : int(b.max_servers, 0, MAX_QUOTA)
      const maxH = b.max_hooks === undefined ? 1 : int(b.max_hooks, 0, MAX_QUOTA)
      const addS = b.can_add_server === undefined ? 1 : flag(b.can_add_server)
      const addH = b.can_add_hook === undefined ? 1 : flag(b.can_add_hook)
      if (maxS === null || maxH === null || addS === null || addH === null) return err(400, 'bad_request', `Hạn mức phải là số nguyên 0-${MAX_QUOTA}, mở khóa phải là true/false`)
      const row = await env.DB.prepare(
        'INSERT OR IGNORE INTO users (username, pass_hash, role, must_change, max_servers, max_hooks, can_add_server, can_add_hook, created) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?) RETURNING id',
      )
        .bind(username, await hashPassword(password), role, maxS, maxH, addS, addH, now)
        .first<{ id: number }>()
      if (!row) return err(409, 'exists', 'Tên đăng nhập này đã có')
      // Mật khẩu chỉ hiện đúng một lần ở đây; người dùng phải đổi ngay lần đăng nhập đầu.
      return json(200, { ok: true, id: row.id, username, password, generated: !given })
    }

    if (Number.isInteger(uid) && uid > 0 && parts[3] === undefined) {
      const t = await env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(uid).first<UserRow>()
      if (!t) return err(404, 'no_user', 'Không có người dùng này')

      if (m === 'PATCH') {
        const b = await readBody(req)
        if (!b) return err(400, 'bad_request', 'Dữ liệu gửi lên không hợp lệ')
        const sets: string[] = []
        const vals: unknown[] = []
        const put = (col: string, v: number | string | null) => {
          sets.push(`${col} = ?`)
          vals.push(v)
        }
        for (const [k, col] of [['max_servers', 'max_servers'], ['max_hooks', 'max_hooks']] as const) {
          if (b[k] === undefined) continue
          const v = int(b[k], 0, MAX_QUOTA)
          if (v === null) return err(400, 'bad_request', `${k} phải là số nguyên 0-${MAX_QUOTA}`)
          put(col, v)
        }
        for (const k of ['can_add_server', 'can_add_hook', 'locked'] as const) {
          if (b[k] === undefined) continue
          const f = flag(b[k])
          if (f === null) return err(400, 'bad_request', `${k} phải là true/false`)
          if (k === 'locked' && f === 1 && t.id === u.id) return err(400, 'self_lock', 'Không thể tự khóa tài khoản của mình')
          put(k, f)
          if (k === 'locked' && f === 0) put('fails', 0)
        }
        if (b.role !== undefined) {
          if (b.role !== 'admin' && b.role !== 'user') return err(400, 'bad_request', 'role phải là admin hoặc user')
          if (t.id === u.id && b.role !== 'admin') return err(400, 'self_demote', 'Không thể tự hạ quyền Admin của mình')
          put('role', b.role)
        }
        let temp: string | null = null
        if (b.reset_password === true) {
          temp = tempPassword()
          put('pass_hash', await hashPassword(temp))
          put('must_change', 1)
          put('fails', 0)
          put('locked_until', 0)
        }
        if (sets.length > 0) await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, uid).run()
        // Khóa hoặc đặt lại mật khẩu: đá văng mọi phiên đang mở của người đó.
        if (b.locked === true || b.locked === 1 || temp !== null) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run()
        return json(200, { ok: true, ...(temp ? { password: temp } : {}) })
      }

      if (m === 'DELETE') {
        if (t.id === u.id) return err(400, 'self_delete', 'Không thể xóa tài khoản của chính mình')
        await env.DB.prepare('INSERT OR IGNORE INTO revoked_servers (id, at) SELECT id, ? FROM servers WHERE owner = ?').bind(now, uid).run()
        await env.DB.prepare('DELETE FROM deliveries WHERE server IN (SELECT id FROM servers WHERE owner = ?) OR sid IN (SELECT id FROM signals WHERE owner = ?)').bind(uid, uid).run()
        await env.DB.prepare('DELETE FROM signals WHERE owner = ?').bind(uid).run()
        await env.DB.prepare('DELETE FROM servers WHERE owner = ?').bind(uid).run()
        await env.DB.prepare('DELETE FROM hooks WHERE owner = ?').bind(uid).run()
        await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(uid).run()
        await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(uid).run()
        return json(200, { ok: true })
      }
    }
    return err(404, 'not_found', 'Không có đường dẫn này')
  }

  return err(405, 'method_not_allowed', 'Sai phương thức')
}
